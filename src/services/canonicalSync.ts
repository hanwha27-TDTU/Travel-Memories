// services/canonicalSync.ts — 일반 병합과 사용자 지정 최종본 교체의 경계.
// docs/SYNC_PROTOCOL.md의 canonical transaction을 구현한다. 세대 변경을 본 기기는 push하지
// 않고 클라우드 정확집합만 원자 반영하며, 게시 기기는 작업 상태를 Dexie에 남겨 재시작한다.

import type { Table } from 'dexie';
import {
  db,
  type LocalAudio,
  type LocalMedia,
  type PendingCanonicalSnapshot,
  type PurgedId,
  type SyncMeta,
} from '../offline/db';
import { toRow, fromRow, type TripRow } from '../domain/trip/rowmap';
import { toMomentRow, fromMomentRow, type MomentRow } from '../domain/moment/rowmap';
import { toExpenseRow, fromExpenseRow, type ExpenseRow } from '../domain/expense/rowmap';
import { toMediaRow, fromMediaRow, mediaStoragePath, type MediaRow } from '../domain/media/rowmap';
import { toAudioRow, fromAudioRow, audioStoragePath, type AudioRow } from '../domain/audio/rowmap';
import { toPlaceRow, fromPlaceRow, type PlaceRow } from '../domain/place/rowmap';
import { operationStoragePath } from '../domain/media/naming';
import type { SyncProgress } from '../domain/syncProgress';
import { compressForStorage } from '../media/compress';
import { deviceStamp } from '../app/deviceId';
import type { JourneyClient } from './supabase/client';
import { r2BlobStore } from './r2';

export const LEGACY_CANONICAL_VERSION = 'legacy';
const PAGE_SIZE = 1000;

export interface CanonicalMeta {
  canonicalVersion: string;
  canonicalOperationId: string | null;
  canonicalDeviceId: string | null;
  updatedAt: string;
}

interface RemoteResult<T> {
  data: T;
  error?: string | undefined;
  /** PostgREST의 기계 판정 코드. 메시지 문구로 배포 상태를 추측하지 않는다. */
  errorCode?: string | undefined;
}

export interface CanonicalRemote {
  ensureMeta(): Promise<RemoteResult<CanonicalMeta | null>>;
  listTrips(): Promise<RemoteResult<TripRow[]>>;
  listPlaces(): Promise<RemoteResult<PlaceRow[]>>;
  listMoments(): Promise<RemoteResult<MomentRow[]>>;
  listMedia(): Promise<RemoteResult<MediaRow[]>>;
  listExpenses(): Promise<RemoteResult<ExpenseRow[]>>;
  listAudio(): Promise<RemoteResult<AudioRow[]>>;
  listPurgedIds(): Promise<RemoteResult<string[]>>;
  publish(snapshot: PendingCanonicalSnapshot): Promise<RemoteResult<unknown>>;
  upload(path: string, blob: Blob, contentType: string): Promise<{ error?: string | undefined }>;
  download(path: string): Promise<{ data: Blob | null; error?: string | undefined }>;
  remove(path: string): Promise<{ error?: string | undefined }>;
}

interface RemoteSnapshot {
  trips: TripRow[];
  places: PlaceRow[];
  moments: MomentRow[];
  media: MediaRow[];
  expenses: ExpenseRow[];
  audio: AudioRow[];
  purgedIds: string[];
}

type CanonicalProgress = (progress: SyncProgress) => void;

export interface CanonicalPreflight {
  mode: 'legacy' | 'normal' | 'applied';
  version: string;
  pulled: number;
}

export interface CanonicalPublishResult {
  version: string;
  rows: number;
  purgedIds: number;
}

function stateId(userId: string): string {
  return `canonical:${userId}`;
}

/** PostgREST 행 전체집합. updated_at 내림차순 + 페이지네이션은 모든 도메인이 공유한다. */
export async function fetchAllRows<T>(
  client: JourneyClient,
  table: string,
): Promise<RemoteResult<T[]>> {
  const out: T[] = [];
  let from = 0;
  for (let page = 0; page < 100; page += 1) {
    try {
      const r = await client
        .from(table)
        .select('*')
        .order('updated_at', { ascending: false })
        .range(from, from + PAGE_SIZE - 1);
      if (r.error) return { data: out, error: r.error.message };
      const rows = (r.data as T[] | null) ?? [];
      out.push(...rows);
      if (rows.length < PAGE_SIZE) return { data: out };
      from += PAGE_SIZE;
    } catch (e) {
      return { data: out, error: (e as Error).message };
    }
  }
  return { data: out, error: '목록이 상한(10만 행)을 넘었습니다 — 페이지네이션 상한 도달' };
}

/** updated_at이 없는 영구삭제 원장은 id 안정 정렬로 같은 페이지 계약을 지킨다. */
export async function fetchAllIds(
  client: JourneyClient,
  table: string,
): Promise<RemoteResult<string[]>> {
  const out: string[] = [];
  let from = 0;
  for (let page = 0; page < 100; page += 1) {
    try {
      const r = await client
        .from(table)
        .select('id')
        .order('id', { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (r.error) return { data: out, error: r.error.message };
      const rows = (r.data as { id: string }[] | null) ?? [];
      out.push(...rows.map((x) => x.id));
      if (rows.length < PAGE_SIZE) return { data: out };
      from += PAGE_SIZE;
    } catch (e) {
      return { data: out, error: (e as Error).message };
    }
  }
  return { data: out, error: '영구삭제 원장이 상한(10만 건)을 넘었습니다 — 페이지네이션 상한 도달' };
}

function parseMeta(value: unknown): CanonicalMeta | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['canonical_version'] !== 'string') return null;
  return {
    canonicalVersion: r['canonical_version'],
    canonicalOperationId: typeof r['canonical_operation_id'] === 'string' ? r['canonical_operation_id'] : null,
    canonicalDeviceId: typeof r['canonical_device_id'] === 'string' ? r['canonical_device_id'] : null,
    updatedAt: typeof r['updated_at'] === 'string' ? r['updated_at'] : '',
  };
}

/** 실제 Supabase/R2 어댑터. 테스트는 CanonicalRemote fake를 주입한다. */
export function canonicalRemote(client: JourneyClient): CanonicalRemote {
  const blobs = r2BlobStore(client);
  return {
    async ensureMeta() {
      try {
        const r = await client.rpc('ensure_sync_meta');
        if (r.error?.code === 'PGRST202') {
          // RPC schema cache만 뒤처진 경우를 "migration 미적용"으로 오판하지 않는다. 0027의
          // SELECT-only RLS 표를 직접 읽어 non-legacy 세대가 있으면 canonical 경로를 유지한다.
          // 표 자체도 확인할 수 없을 때만 호출자가 server-read-only 전환 모드로 내려간다.
          const probe = await client
            .from('sync_meta')
            .select('canonical_version,canonical_operation_id,canonical_device_id,updated_at')
            .maybeSingle();
          if (!probe.error) {
            const found = parseMeta(probe.data);
            // 0행은 "legacy"의 증명이 아니다. 아직 생성 전일 수도, RLS가 숨긴 것일 수도 있다.
            // 관측한 행이 있을 때만 일반/canonical 경로로 복귀하고 나머지는 read-only로 둔다.
            if (found) return { data: found };
          }
        }
        return { data: parseMeta(r.data), error: r.error?.message, errorCode: r.error?.code };
      } catch (e) {
        return { data: null, error: (e as Error).message };
      }
    },
    listTrips: () => fetchAllRows<TripRow>(client, 'trips'),
    listPlaces: () => fetchAllRows<PlaceRow>(client, 'places'),
    listMoments: () => fetchAllRows<MomentRow>(client, 'moments'),
    listMedia: () => fetchAllRows<MediaRow>(client, 'media'),
    listExpenses: () => fetchAllRows<ExpenseRow>(client, 'expenses'),
    listAudio: () => fetchAllRows<AudioRow>(client, 'audio'),
    listPurgedIds: () => fetchAllIds(client, 'purged_ids'),
    async publish(s) {
      try {
        const r = await client.rpc('publish_canonical_snapshot', {
          p_expected_version: s.expectedVersion,
          p_next_version: s.nextVersion,
          p_operation_id: s.operationId,
          p_device: s.device,
          p_trips: s.trips,
          p_places: s.places,
          p_moments: s.moments,
          p_media: s.media,
          p_expenses: s.expenses,
          p_audio: s.audio,
          p_purged_ids: s.purgedIds,
        });
        return { data: r.data, error: r.error?.message };
      } catch (e) {
        return { data: null, error: (e as Error).message };
      }
    },
    upload: (path, blob, contentType) => blobs.upload(path, blob, contentType),
    download: (path) => blobs.download(path),
    remove: (path) => blobs.remove(path),
  };
}

function requireRemote<T>(result: RemoteResult<T>, label: string): T {
  if (result.error) throw new Error(`${label}: ${result.error}`);
  return result.data;
}

function requireMeta(result: RemoteResult<CanonicalMeta | null>): CanonicalMeta {
  const meta = requireRemote(result, 'canonical 메타 조회 실패');
  if (!meta) throw new Error('canonical 메타 응답이 비었습니다. migration 0027 적용 상태를 확인해 주세요.');
  return meta;
}

async function readMeta(remote: CanonicalRemote): Promise<CanonicalMeta> {
  return requireMeta(await remote.ensureMeta());
}

async function readStableSnapshot(remote: CanonicalRemote, expected: string): Promise<RemoteSnapshot> {
  const [trips, places, moments, media, expenses, audio, purged] = await Promise.all([
    remote.listTrips(),
    remote.listPlaces(),
    remote.listMoments(),
    remote.listMedia(),
    remote.listExpenses(),
    remote.listAudio(),
    remote.listPurgedIds(),
  ]);
  const snapshot: RemoteSnapshot = {
    trips: requireRemote(trips, '여행 스냅샷 조회 실패'),
    places: requireRemote(places, '장소 스냅샷 조회 실패'),
    moments: requireRemote(moments, '순간 스냅샷 조회 실패'),
    media: requireRemote(media, '사진 스냅샷 조회 실패'),
    expenses: requireRemote(expenses, '비용 스냅샷 조회 실패'),
    audio: requireRemote(audio, '소리 스냅샷 조회 실패'),
    purgedIds: requireRemote(purged, '영구삭제 원장 조회 실패'),
  };
  const after = await readMeta(remote);
  if (after.canonicalVersion !== expected) {
    throw new Error('스냅샷을 읽는 동안 최종본 세대가 다시 바뀌었습니다. 로컬은 바꾸지 않고 재시도합니다.');
  }
  return snapshot;
}

/**
 * 🔴 M-0101(2026-08-05) — 죽은 tombstone 사진 하나가 새 기기 전체 최종본 소비를 막았다.
 * `materializeMedia`/`materializeAudio`가 바이트 다운로드 실패를 활성/휴지통 구분 없이
 * throw했고, `replaceLocalSnapshot`은 모든 미디어를 먼저 다 받아야 트립 하나라도 반영한다
 * (line 383+ 트랜잭션). M-0100이 서버에 남긴 storage_path-없는-바이트 tombstone 행 하나가
 * 계정 전체(트립 8개)를 새 기기에서 0건으로 만들었다 — "동기화됨"이라 표시하면서.
 *
 * 활성 자료는 여전히 막는다(기존 계약 유지 — 활성 사진이 안 보이는 채로 최종본을 받으면
 * 그게 더 나쁜 거짓이다). tombstone만 최선노력으로 낮춘다: ADR-0029가 이미 "휴지통 바이트는
 * 있으면 좋고 없어도 자료구조는 온전해야 한다"고 정했으므로, 빈 자리를 `bytesMissing`으로
 * **정직하게 적고**(추측이 아니라 확인한 사실 — M-0059와 같은 규율) 계속 진행한다.
 */
async function fetchOrMissing(
  remote: CanonicalRemote,
  storagePath: string | null | undefined,
  deletedAt: string | null,
  entityLabel: string,
  id: string,
): Promise<{ data: Blob | null; missing: boolean }> {
  if (storagePath) {
    const dl = await remote.download(storagePath);
    if (!dl.error && dl.data) return { data: dl.data, missing: false };
    if (deletedAt === null) throw new Error(`${entityLabel} ${id} 다운로드 실패: ${dl.error ?? '빈 응답'}`);
    return { data: null, missing: true };
  }
  if (deletedAt === null) throw new Error(`${entityLabel} ${id}: 최종본에 바이트 경로가 없습니다.`);
  return { data: null, missing: true };
}

async function materializeMedia(
  rows: MediaRow[],
  remote: CanonicalRemote,
  version: string,
  onItem?: ((completed: number) => void) | undefined,
): Promise<LocalMedia[]> {
  const d = db();
  const local = new Map((await d.localMedia.toArray()).map((x) => [x.id, x]));
  const out: LocalMedia[] = [];
  for (const row of rows) {
    const server = fromMediaRow(row);
    const old = local.get(server.id);
    let display = old?.storagePath === server.storagePath ? old.displayBlob : undefined;
    let bytesMissing = false;
    if (!display || display.size === 0) {
      const fetched = await fetchOrMissing(remote, server.storagePath, server.deletedAt, '사진', server.id);
      bytesMissing = fetched.missing;
      display = fetched.data ?? new Blob([], { type: 'image/webp' });
    }
    let thumb = display;
    if (!bytesMissing) {
      try { thumb = (await compressForStorage(display)).thumb.blob; } catch { /* 표시본 폴백 */ }
    }
    const sameObject = old?.storagePath === server.storagePath;
    out.push({
      id: server.id,
      momentId: server.momentId,
      tripId: server.tripId,
      mime: 'image/webp',
      // canonical은 **서버가 정본**인 경로다 — 로컬 순서로 되돌리지 않는다.
      sortOrder: server.sortOrder ?? null,
      displayBlob: display,
      thumbBlob: thumb,
      width: server.width,
      height: server.height,
      takenAt: server.takenAt,
      gpsLat: server.gpsLat,
      gpsLng: server.gpsLng,
      bytesOriginal: sameObject && old ? old.bytesOriginal : display.size,
      bytesDisplay: display.size,
      ...(server.storagePath ? { storagePath: server.storagePath } : {}),
      version: server.version,
      baseVersion: server.version,
      baseCanonicalVersion: version,
      createdAt: server.createdAt,
      updatedAt: server.updatedAt,
      deletedAt: server.deletedAt,
      ...(bytesMissing ? { bytesMissing: true as const } : {}),
      // canonical 소비 뒤 표시본이 편집 기준이다. 옛 원본 좌표계의 editState는 승계하지 않는다.
      ...(server.clientOperationId ? { clientOperationId: server.clientOperationId } : {}),
    });
    onItem?.(out.length);
  }
  return out;
}

async function materializeAudio(
  rows: AudioRow[],
  remote: CanonicalRemote,
  version: string,
  onItem?: ((completed: number) => void) | undefined,
): Promise<LocalAudio[]> {
  const d = db();
  const local = new Map((await d.localAudio.toArray()).map((x) => [x.id, x]));
  const out: LocalAudio[] = [];
  for (const row of rows) {
    const server = fromAudioRow(row);
    const old = local.get(server.id);
    let blob = old?.storagePath === server.storagePath ? old.blob : undefined;
    let bytesMissing = false;
    if (!blob || blob.size === 0) {
      const fetched = await fetchOrMissing(remote, server.storagePath, server.deletedAt, '소리', server.id);
      bytesMissing = fetched.missing;
      blob = fetched.data ?? new Blob([], { type: 'audio/webm' });
    }
    out.push({
      id: server.id,
      momentId: server.momentId,
      tripId: server.tripId,
      blob,
      mime: server.mime || old?.mime || 'audio/webm',
      durationSec: server.durationSec,
      recordedAt: server.recordedAt,
      ...(server.storagePath ? { storagePath: server.storagePath } : {}),
      version: server.version,
      baseVersion: server.version,
      baseCanonicalVersion: version,
      createdAt: server.createdAt,
      updatedAt: server.updatedAt,
      deletedAt: server.deletedAt,
      ...(bytesMissing ? { bytesMissing: true as const } : {}),
      ...(server.clientOperationId ? { clientOperationId: server.clientOperationId } : {}),
    });
    onItem?.(out.length);
  }
  return out;
}

async function stampTable<T extends SyncMeta>(table: Table<T, string>, version: string): Promise<void> {
  const rows = await table.toArray();
  const changed = rows.filter((x) => x.baseCanonicalVersion !== version);
  if (changed.length) await table.bulkPut(changed.map((x) => ({ ...x, baseCanonicalVersion: version })) as T[]);
}

async function stampAllTables(version: string): Promise<void> {
  const d = db();
  await Promise.all([
    stampTable(d.localTrips, version),
    stampTable(d.localPlaces, version),
    stampTable(d.localMoments, version),
    stampTable(d.localMedia, version),
    stampTable(d.localExpenses, version),
    stampTable(d.localAudio, version),
  ]);
}

async function setLegacyBaseline(userId: string, version: string): Promise<void> {
  const d = db();
  await d.transaction(
    'rw',[d.localTrips,d.localPlaces,d.localMoments,d.localMedia,d.localExpenses,d.localAudio,d.syncState],
    async () => {
      await stampAllTables(version);
      await d.syncState.put({ id: stateId(userId), userId, canonicalVersion: version, updatedAt: new Date().toISOString() });
    },
  );
}

async function replaceLocalSnapshot(
  userId: string,
  meta: CanonicalMeta,
  snapshot: RemoteSnapshot,
  remote: CanonicalRemote,
  onProgress?: CanonicalProgress | undefined,
): Promise<number> {
  const d = db();
  // 파일 수 + 원자 반영 + 로컬 read-back. 시간으로 만든 가짜 퍼센트가 아니라 실제 완료 단위다.
  const total = snapshot.media.length + snapshot.audio.length + 2;
  if (snapshot.media.length > 0) {
    onProgress?.({
      phase: 'canonical-media', completed: 0, total,
      phaseCompleted: 0, phaseTotal: snapshot.media.length,
    });
  }
  const media = await materializeMedia(snapshot.media, remote, meta.canonicalVersion, (completed) => {
    onProgress?.({
      phase: 'canonical-media', completed, total,
      phaseCompleted: completed, phaseTotal: snapshot.media.length,
    });
  });
  if (snapshot.audio.length > 0) {
    onProgress?.({
      phase: 'canonical-audio', completed: media.length, total,
      phaseCompleted: 0, phaseTotal: snapshot.audio.length,
    });
  }
  const audio = await materializeAudio(snapshot.audio, remote, meta.canonicalVersion, (completed) => {
    onProgress?.({
      phase: 'canonical-audio', completed: media.length + completed, total,
      phaseCompleted: completed, phaseTotal: snapshot.audio.length,
    });
  });
  const beforeCommit = await readMeta(remote);
  if (beforeCommit.canonicalVersion !== meta.canonicalVersion) {
    throw new Error('바이트를 받는 동안 최종본 세대가 다시 바뀌었습니다. 로컬은 바꾸지 않고 재시도합니다.');
  }
  const trips = snapshot.trips.map((r) => ({ ...fromRow(r), baseCanonicalVersion: meta.canonicalVersion }));
  const places = snapshot.places.map((r) => ({ ...fromPlaceRow(r), baseCanonicalVersion: meta.canonicalVersion }));
  const moments = snapshot.moments.map((r) => ({ ...fromMomentRow(r), baseCanonicalVersion: meta.canonicalVersion }));
  const expenses = snapshot.expenses.map((r) => ({ ...fromExpenseRow(r), baseCanonicalVersion: meta.canonicalVersion }));
  const oldPurged = new Map((await d.purgedIds.toArray()).map((x) => [x.id, x]));
  const purged: PurgedId[] = snapshot.purgedIds.map((id) => ({
    id,
    entityType: oldPurged.get(id)?.entityType ?? 'unknown',
    purgedAt: new Date().toISOString(),
  }));

  const filesDone = media.length + audio.length;
  onProgress?.({
    phase: 'canonical-applying', completed: filesDone, total,
    phaseCompleted: 0, phaseTotal: 1,
  });
  await d.transaction(
    'rw',[d.localTrips,d.localPlaces,d.localMoments,d.localMedia,d.localExpenses,d.localAudio,
    d.syncQueue,d.purgedIds,d.syncState],
    async () => {
      await Promise.all([
        d.localTrips.clear(),d.localPlaces.clear(),d.localMoments.clear(),d.localMedia.clear(),
        d.localExpenses.clear(),d.localAudio.clear(),d.syncQueue.clear(),d.purgedIds.clear(),
      ]);
      await d.localTrips.bulkPut(trips);
      await d.localPlaces.bulkPut(places);
      await d.localMoments.bulkPut(moments);
      await d.localMedia.bulkPut(media);
      await d.localExpenses.bulkPut(expenses);
      await d.localAudio.bulkPut(audio);
      await d.purgedIds.bulkPut(purged);
      await d.syncState.put({
        id: stateId(userId),userId,canonicalVersion: meta.canonicalVersion,updatedAt: new Date().toISOString(),
      });
    },
  );
  onProgress?.({
    phase: 'canonical-verifying', completed: filesDone + 1, total,
    phaseCompleted: 0, phaseTotal: 1,
  });

  // Dexie transaction resolve만 성공 영수증으로 쓰지 않는다. 이 기기에서 다시 세어야
  // "동기화 종료 + 홈 0건"을 성공으로 반올림하지 않는다(M-0095의 로컬 적용판).
  const [tripCount, placeCount, momentCount, mediaCount, expenseCount, audioCount, state] = await Promise.all([
    d.localTrips.count(), d.localPlaces.count(), d.localMoments.count(), d.localMedia.count(),
    d.localExpenses.count(), d.localAudio.count(), d.syncState.get(stateId(userId)),
  ]);
  const expected = [trips.length, places.length, moments.length, media.length, expenses.length, audio.length];
  const actual = [tripCount, placeCount, momentCount, mediaCount, expenseCount, audioCount];
  if (actual.some((count, index) => count !== expected[index]) || state?.canonicalVersion !== meta.canonicalVersion) {
    throw new Error(
      `받은 기록의 이 기기 반영 확인 실패: 여행·장소·순간·사진·비용·소리 ` +
      `${actual.join('/')} (정상 ${expected.join('/')})`,
    );
  }
  onProgress?.({
    phase: 'canonical-verifying', completed: total, total,
    phaseCompleted: 1, phaseTotal: 1,
  });
  return expected.reduce((sum, count) => sum + count, 0);
}

async function clearPending(userId: string, canonicalVersion: string): Promise<void> {
  await db().syncState.put({
    id: stateId(userId),userId,canonicalVersion,updatedAt: new Date().toISOString(),
  });
}

async function cleanupPaths(remote: CanonicalRemote, paths: string[]): Promise<void> {
  for (const path of [...new Set(paths)]) {
    const r = await remote.remove(path);
    if (r.error) console.warn(`canonical 임시 바이트 정리 실패(${path}): ${r.error}`);
  }
}

/** 일반 동기화의 첫 문. applied이면 이번 실행은 여기서 끝내고 절대 push하지 않는다. */
export async function ensureCanonicalBeforeSync(
  remote: CanonicalRemote,
  userId: string,
  onProgress?: CanonicalProgress | undefined,
): Promise<CanonicalPreflight> {
  const state = await db().syncState.get(stateId(userId));
  const metaResult = await remote.ensureMeta();
  if (metaResult.errorCode === 'PGRST202') {
    // 앱을 먼저 배포하고 migration 0027을 나중에 적용하는 전환 구간은 정상 상태다.
    // 다만 PGRST202만으로 DB가 legacy라고 증명할 수 없으므로 일반 병합이 아니라 서버
    // read-only 모드만 연다. 이미 새 세대를 소비했거나 게시가 미완료인 기기는 fail-closed다.
    const legacySafe = !state?.pendingCanonical &&
      (state?.canonicalVersion === undefined || state.canonicalVersion === LEGACY_CANONICAL_VERSION);
    if (legacySafe) {
      console.warn('canonical capability를 확인할 수 없어 서버 read-only 동기화로 계속합니다.');
      return { mode: 'legacy', version: LEGACY_CANONICAL_VERSION, pulled: 0 };
    }
    throw new Error(
      `canonical 메타 조회 실패: ${metaResult.error ?? 'ensure_sync_meta RPC 없음'} — ` +
      '이미 canonical 상태가 있어 legacy 모드로 낮출 수 없습니다.',
    );
  }
  const meta = requireMeta(metaResult);
  const pending = state?.pendingCanonical;
  if (pending) {
    if (meta.canonicalVersion === pending.nextVersion && meta.canonicalOperationId === pending.operationId) {
      await finalizePublishedSnapshot(remote, userId, pending);
      return ensureCanonicalBeforeSync(remote, userId, onProgress);
    }
    if (meta.canonicalVersion === pending.expectedVersion) {
      throw new Error('이 기기의 최종본 게시가 미완료입니다. 데이터 관리에서 같은 작업을 재개해 주세요.');
    }
    await cleanupPaths(remote, pending.stagedPaths);
    await clearPending(userId, state?.canonicalVersion ?? LEGACY_CANONICAL_VERSION);
  }

  if (!state && meta.canonicalVersion === LEGACY_CANONICAL_VERSION) {
    await setLegacyBaseline(userId, meta.canonicalVersion);
    const after = await readMeta(remote);
    return after.canonicalVersion === meta.canonicalVersion
      ? { mode: 'normal', version: meta.canonicalVersion, pulled: 0 }
      : ensureCanonicalBeforeSync(remote, userId, onProgress);
  }
  if (state?.canonicalVersion === meta.canonicalVersion) {
    await setLegacyBaseline(userId, meta.canonicalVersion);
    const after = await readMeta(remote);
    return after.canonicalVersion === meta.canonicalVersion
      ? { mode: 'normal', version: meta.canonicalVersion, pulled: 0 }
      : ensureCanonicalBeforeSync(remote, userId, onProgress);
  }

  const snapshot = await readStableSnapshot(remote, meta.canonicalVersion);
  const pulled = await replaceLocalSnapshot(userId, meta, snapshot, remote, onProgress);
  return { mode: 'applied', version: meta.canonicalVersion, pulled };
}

function asRecord<T extends object>(rows: T[]): Record<string, unknown>[] {
  return rows as unknown as Record<string, unknown>[];
}

async function capturePending(
  remote: CanonicalRemote,
  userId: string,
  meta: CanonicalMeta,
): Promise<PendingCanonicalSnapshot> {
  const [oldMediaResult, oldAudioResult] = await Promise.all([remote.listMedia(), remote.listAudio()]);
  const oldMedia = requireRemote(oldMediaResult, '기존 사진 경로 조회 실패');
  const oldAudio = requireRemote(oldAudioResult, '기존 소리 경로 조회 실패');
  const check = await readMeta(remote);
  if (check.canonicalVersion !== meta.canonicalVersion) throw new Error('최종본 캡처 전에 서버 세대가 바뀌었습니다.');

  const d = db();
  return d.transaction(
    'rw',[d.localTrips,d.localPlaces,d.localMoments,d.localMedia,d.localExpenses,d.localAudio,
    d.syncQueue,d.purgedIds,d.syncState],
    async () => {
      const [trips,places,moments,media,expenses,audio,queue,purged] = await Promise.all([
        d.localTrips.toArray(),d.localPlaces.toArray(),d.localMoments.toArray(),d.localMedia.toArray(),
        d.localExpenses.toArray(),d.localAudio.toArray(),d.syncQueue.toArray(),d.purgedIds.toArray(),
      ]);
      const operationId = crypto.randomUUID();
      const nextVersion = crypto.randomUUID();
      const device = deviceStamp();
      const titles = new Map(trips.map((x) => [x.id, x.title]));
      const mediaRows = media.map((x) => {
        if (!x.displayBlob || x.displayBlob.size === 0) throw new Error(`사진 ${x.id}: 표시본 바이트가 비었습니다.`);
        const stable = x.storagePath ?? mediaStoragePath(userId, x, titles.get(x.tripId));
        const path = operationStoragePath(stable, x.id, operationId);
        return toMediaRow({ ...x, baseCanonicalVersion: nextVersion }, userId, path, device);
      });
      const audioRows = audio.map((x) => {
        if (!x.blob || x.blob.size === 0) throw new Error(`소리 ${x.id}: 원본 바이트가 비었습니다.`);
        const stable = x.storagePath ?? audioStoragePath(userId, x, titles.get(x.tripId));
        if (!stable) throw new Error(`소리 ${x.id}: 지원하지 않는 MIME(${x.mime})이라 최종본을 게시할 수 없습니다.`);
        const path = operationStoragePath(stable, x.id, operationId);
        return toAudioRow({ ...x, baseCanonicalVersion: nextVersion }, userId, path, device);
      });
      const ids = new Set([...trips,...places,...moments,...media,...expenses,...audio].map((x) => x.id));
      const overlap = purged.find((x) => ids.has(x.id));
      if (overlap) throw new Error(`최종본 행과 영구삭제 원장이 같은 id를 가리킵니다: ${overlap.id}`);
      const snapshot: PendingCanonicalSnapshot = {
        expectedVersion: meta.canonicalVersion,nextVersion,operationId,device,stage:'uploading',
        createdAt:new Date().toISOString(),queuedOperationIds:queue.map((x) => x.operationId),
        stagedPaths:[...mediaRows,...audioRows].flatMap((x) => x.storage_path ? [x.storage_path] : []),
        previousPaths:[...oldMedia,...oldAudio].flatMap((x) => x.storage_path ? [x.storage_path] : []),
        trips:asRecord(trips.map((x) => toRow({ ...x, baseCanonicalVersion: nextVersion },userId,device))),
        places:asRecord(places.map((x) => toPlaceRow({ ...x, baseCanonicalVersion: nextVersion },userId,device))),
        moments:asRecord(moments.map((x) => toMomentRow({ ...x, baseCanonicalVersion: nextVersion },userId,device))),
        media:asRecord(mediaRows),
        expenses:asRecord(expenses.map((x) => toExpenseRow({ ...x, baseCanonicalVersion: nextVersion },userId,device))),
        audio:asRecord(audioRows),purgedIds:purged.map((x) => x.id),
      };
      await d.syncState.put({
        id:stateId(userId),userId,canonicalVersion:meta.canonicalVersion,pendingCanonical:snapshot,
        updatedAt:new Date().toISOString(),
      });
      return snapshot;
    },
  );
}

async function updatePendingStage(
  userId: string,
  pending: PendingCanonicalSnapshot,
  stage: PendingCanonicalSnapshot['stage'],
): Promise<PendingCanonicalSnapshot> {
  const next = { ...pending, stage };
  const current = await db().syncState.get(stateId(userId));
  if (current?.pendingCanonical?.operationId !== pending.operationId) throw new Error('최종본 작업 상태가 바뀌었습니다.');
  await db().syncState.put({ ...current, pendingCanonical: next, updatedAt: new Date().toISOString() });
  return next;
}

class CanonicalSnapshotChangedError extends Error {}

async function uploadPending(remote: CanonicalRemote, pending: PendingCanonicalSnapshot): Promise<void> {
  const d = db();
  const mediaTasks: { row: MediaRow; blob: Blob }[] = [];
  for (const row of pending.media as unknown as MediaRow[]) {
    if (!row.storage_path) throw new CanonicalSnapshotChangedError(`사진 ${row.id}: staging 경로가 없습니다.`);
    const local = await d.localMedia.get(row.id);
    if (!local?.displayBlob) throw new CanonicalSnapshotChangedError(`사진 ${row.id}: 게시할 로컬 표시본을 찾지 못했습니다.`);
    if (local.updatedAt !== row.updated_at || local.displayBlob.size !== row.bytes_display) {
      throw new CanonicalSnapshotChangedError(`사진 ${row.id}: 최종본 캡처 뒤 내용이 바뀌었습니다. 작업을 다시 시작해 주세요.`);
    }
    mediaTasks.push({ row, blob: local.displayBlob });
  }
  const audioTasks: { row: AudioRow; blob: Blob }[] = [];
  for (const row of pending.audio as unknown as AudioRow[]) {
    if (!row.storage_path) throw new CanonicalSnapshotChangedError(`소리 ${row.id}: staging 경로가 없습니다.`);
    const local = await d.localAudio.get(row.id);
    if (!local?.blob) throw new CanonicalSnapshotChangedError(`소리 ${row.id}: 게시할 로컬 바이트를 찾지 못했습니다.`);
    if (local.updatedAt !== row.updated_at || local.blob.size !== row.bytes) {
      throw new CanonicalSnapshotChangedError(`소리 ${row.id}: 최종본 캡처 뒤 내용이 바뀌었습니다. 작업을 다시 시작해 주세요.`);
    }
    audioTasks.push({ row, blob: local.blob });
  }
  for (const { row, blob } of mediaTasks) {
    const r = await remote.upload(row.storage_path!, blob, 'image/webp');
    if (r.error) throw new Error(`사진 ${row.id} 업로드 실패: ${r.error}`);
  }
  for (const { row, blob } of audioTasks) {
    const r = await remote.upload(row.storage_path!, blob, row.mime);
    if (r.error) throw new Error(`소리 ${row.id} 업로드 실패: ${r.error}`);
  }
}

async function finalizePublishedSnapshot(
  remote: CanonicalRemote,
  userId: string,
  pending: PendingCanonicalSnapshot,
): Promise<void> {
  const d = db();
  await d.transaction(
    'rw',[d.localTrips,d.localPlaces,d.localMoments,d.localMedia,d.localExpenses,d.localAudio,
    d.syncQueue,d.syncState],
    async () => {
      for (const row of pending.media as unknown as MediaRow[]) {
        const current = await d.localMedia.get(row.id);
        if (current?.updatedAt === row.updated_at && row.storage_path) {
          const { bytesMissing: _bytesMissing, ...kept } = current;
          await d.localMedia.put({
            ...kept,
            storagePath: row.storage_path,
            baseCanonicalVersion: pending.nextVersion,
          });
        }
      }
      for (const row of pending.audio as unknown as AudioRow[]) {
        const current = await d.localAudio.get(row.id);
        if (current?.updatedAt === row.updated_at && row.storage_path) {
          const { bytesMissing: _bytesMissing, ...kept } = current;
          await d.localAudio.put({
            ...kept,
            storagePath: row.storage_path,
            baseCanonicalVersion: pending.nextVersion,
          });
        }
      }
      await stampAllTables(pending.nextVersion);
      await d.syncQueue.bulkDelete(pending.queuedOperationIds);
      await d.syncState.put({
        id:stateId(userId),userId,canonicalVersion:pending.nextVersion,updatedAt:new Date().toISOString(),
      });
    },
  );
  const staged = new Set(pending.stagedPaths);
  await cleanupPaths(remote, pending.previousPaths.filter((x) => !staged.has(x)));
}

async function resolvePublishReadBack(
  remote: CanonicalRemote,
  userId: string,
  pending: PendingCanonicalSnapshot,
  publishError?: string,
): Promise<PendingCanonicalSnapshot> {
  const meta = await readMeta(remote);
  if (meta.canonicalVersion === pending.nextVersion && meta.canonicalOperationId === pending.operationId) {
    return updatePendingStage(userId, pending, 'local-commit');
  }
  if (meta.canonicalVersion === pending.expectedVersion) {
    await updatePendingStage(userId, pending, 'publishing');
    throw new Error(publishError ?? '최종본 RPC가 서버 read-back에 나타나지 않았습니다. 같은 작업을 재시도합니다.');
  }
  await cleanupPaths(remote, pending.stagedPaths);
  await clearPending(userId, pending.expectedVersion);
  throw new Error('다른 기기가 먼저 최종본을 바꿨습니다. 이 기기의 staging은 폐기했고 클라우드를 다시 받아야 합니다.');
}

/** 테스트 가능한 핵심 오케스트레이션. 실제 UI는 아래 client 어댑터를 호출한다. */
export async function publishCanonicalWithRemote(
  remote: CanonicalRemote,
  userId: string,
): Promise<CanonicalPublishResult> {
  const meta = await readMeta(remote);
  const state = await db().syncState.get(stateId(userId));
  let pending = state?.pendingCanonical ?? await capturePending(remote,userId,meta);
  if (state?.pendingCanonical) {
    const ownCommit = meta.canonicalVersion === pending.nextVersion && meta.canonicalOperationId === pending.operationId;
    if (ownCommit) pending = await updatePendingStage(userId,pending,'local-commit');
    else if (meta.canonicalVersion !== pending.expectedVersion) {
      await cleanupPaths(remote,pending.stagedPaths);
      await clearPending(userId,pending.expectedVersion);
      throw new Error('다른 기기가 먼저 최종본을 바꿨습니다. 새 클라우드 최종본을 받은 뒤 다시 선택해 주세요.');
    }
  }

  if (pending.stage === 'uploading') {
    try {
      await uploadPending(remote,pending);
    } catch (error) {
      if (error instanceof CanonicalSnapshotChangedError) {
        await cleanupPaths(remote,pending.stagedPaths);
        await clearPending(userId,pending.expectedVersion);
      }
      throw error;
    }
    pending = await updatePendingStage(userId,pending,'publishing');
  }
  if (pending.stage === 'publishing') {
    const result = await remote.publish(pending);
    pending = await updatePendingStage(userId,pending,'read-back');
    pending = await resolvePublishReadBack(remote,userId,pending,result.error);
  } else if (pending.stage === 'read-back') {
    pending = await resolvePublishReadBack(remote,userId,pending);
  }
  if (pending.stage === 'local-commit') await finalizePublishedSnapshot(remote,userId,pending);

  return {
    version:pending.nextVersion,
    rows:pending.trips.length+pending.places.length+pending.moments.length+pending.media.length+
      pending.expenses.length+pending.audio.length,
    purgedIds:pending.purgedIds.length,
  };
}

/** 명시적 사용자 액션: 현재 기기의 스냅샷을 클라우드 정확집합으로 게시한다. */
export async function publishDeviceAsCanonical(
  client: JourneyClient,
  userId: string,
): Promise<CanonicalPublishResult> {
  return publishCanonicalWithRemote(canonicalRemote(client), userId);
}
