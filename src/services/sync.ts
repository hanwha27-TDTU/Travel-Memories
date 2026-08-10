// services/sync.ts — 동기화 push/pull 오케스트레이션 (docs/SYNC_PROTOCOL.md).
// 핵심 불변식을 코드로: 멱등 upsert(operation) + 정확한 read-back + LWW 서버시각 반영
// + 빈-클라우드 가드 + 병합(교체 아님). 네트워크는 TripsRemote 포트 뒤로 격리해
// 순수 결정 로직(sync/merge.ts)을 직접 테스트할 수 있게 한다(LESSONS §6).

import type { Table } from 'dexie';
import { db, type SyncQueueItem, type LocalMedia, type LocalAudio, type LocalVideo, type SyncMeta } from '../offline/db';
// 시각 표기의 SSOT — rowmap(서버 경계)·백업 복원과 **같은 함수**를 쓴다(§7: 규율은 한 곳에).
import { withCanonicalStamps } from '../domain/time';
import { toRow, fromRow, type TripRow } from '../domain/trip/rowmap';
import { toMomentRow, fromMomentRow, type MomentRow } from '../domain/moment/rowmap';
import { toExpenseRow, fromExpenseRow, type ExpenseRow } from '../domain/expense/rowmap';
import { toMediaRow, fromMediaRow, mediaStoragePath, type MediaRow } from '../domain/media/rowmap';
import { toAudioRow, fromAudioRow, audioStoragePath, type AudioRow } from '../domain/audio/rowmap';
import { toVideoRow, fromVideoRow, videoStoragePath, type VideoRow } from '../domain/video/rowmap';
import { createVideoPoster } from '../media/video';
import { operationStoragePath } from '../domain/media/naming';
import { toPlaceRow, fromPlaceRow, type PlaceRow } from '../domain/place/rowmap';
import { isRealCoord } from '../domain/place/coordInput';
import { compressForStorage } from '../media/compress';
import { mergeDecision, isEmptyCloudAnomaly, classifyError, retryDelayMs, isRetryDue, mustUploadBytes, writeLanded } from '../sync/merge';
import type { JourneyClient } from './supabase/client';
import { r2BlobStore, r2ListObjects } from './r2';
// 바이트 대조가 「이 기기에 사본이 있는 id」를 물어본다. `storeState`는 Dexie만 읽는
// 하위 모듈이라 순환이 생기지 않는다(그쪽은 sync를 모른다).
import { localBytesIds } from './storeState';
import { deviceStamp } from '../app/deviceId';
import { canonicalRemote, ensureCanonicalBeforeSync, fetchAllRows } from './canonicalSync';
import { PULL_SYNC_PLAN, PUSH_SYNC_PLAN, SYNC_DOMAINS, runSyncPlan } from './syncPlan';
import type { SyncDomain } from './syncPlan';
import type { SyncProgress } from '../domain/syncProgress';
import {
  applyPurgedLedger,
  purgedIdSet,
  purgeDomainOf,
  DOMAIN_PURGE,
  PURGE_DOMAINS,
  cascadeChildDomains,
  asPurgeParent,
  sweepPurgedOrphans,
  PARENT_KEY,
  type PurgeDomain,
  type PurgeParent,
  type PurgeTarget,
} from './purge';

export interface SyncResult {
  pushed: number;
  failed: number;
  pulled: number;
  skippedEmptyCloud: boolean;
  /** true면 canonical 세대 변경을 클라우드 기준으로 반영했고, 이 실행에서는 push하지 않았다. */
  canonicalApplied: boolean;
}

/** 원격 저장소 포트 — 네트워크 격리(테스트 시 fake 주입). */
export interface TripsRemote {
  upsert(row: TripRow): Promise<{ error?: string | undefined; status?: number | undefined }>;
  getById(id: string): Promise<{ data: TripRow | null; error?: string | undefined; status?: number | undefined }>;
  listAll(): Promise<{ data: TripRow[]; error?: string | undefined }>;
}

/** JourneyClient를 TripsRemote로 감싸는 얇은 어댑터(untested glue). */
export function tripsRemote(client: JourneyClient): TripsRemote {
  return {
    async upsert(row) {
      try {
        const r = await client.from('trips').upsert(row, { onConflict: 'id' });
        return { error: r.error?.message, status: r.status };
      } catch (e) {
        return { error: (e as Error).message }; // 네트워크 throw → status undefined(재시도)
      }
    },
    async getById(id) {
      try {
        const r = await client.from('trips').select('*').eq('id', id).maybeSingle();
        return { data: (r.data as TripRow | null) ?? null, error: r.error?.message, status: r.status };
      } catch (e) {
        return { data: null, error: (e as Error).message };
      }
    },
    async listAll() {
      return fetchAllRows<TripRow>(client, 'trips'); // 끝까지 받는다(잘림 없음 — M-10)
    },
  };
}

/** 순간 원격 포트 — 네트워크 격리(trips와 대칭). */
export interface MomentsRemote {
  upsert(row: MomentRow): Promise<{ error?: string | undefined; status?: number | undefined }>;
  getById(id: string): Promise<{ data: MomentRow | null; error?: string | undefined; status?: number | undefined }>;
  listAll(): Promise<{ data: MomentRow[]; error?: string | undefined }>;
}

export function momentsRemote(client: JourneyClient): MomentsRemote {
  return {
    async upsert(row) {
      try {
        const r = await client.from('moments').upsert(row, { onConflict: 'id' });
        return { error: r.error?.message, status: r.status };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    async getById(id) {
      try {
        const r = await client.from('moments').select('*').eq('id', id).maybeSingle();
        return { data: (r.data as MomentRow | null) ?? null, error: r.error?.message, status: r.status };
      } catch (e) {
        return { data: null, error: (e as Error).message };
      }
    },
    async listAll() {
      return fetchAllRows<MomentRow>(client, 'moments'); // 끝까지 받는다(잘림 없음 — M-10)
    },
  };
}

/** 비용 원격 포트 — 네트워크 격리(moments와 대칭). */
export interface ExpensesRemote {
  upsert(row: ExpenseRow): Promise<{ error?: string | undefined; status?: number | undefined }>;
  getById(id: string): Promise<{ data: ExpenseRow | null; error?: string | undefined; status?: number | undefined }>;
  listAll(): Promise<{ data: ExpenseRow[]; error?: string | undefined }>;
}

export function expensesRemote(client: JourneyClient): ExpensesRemote {
  return {
    async upsert(row) {
      try {
        const r = await client.from('expenses').upsert(row, { onConflict: 'id' });
        return { error: r.error?.message, status: r.status };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    async getById(id) {
      try {
        const r = await client.from('expenses').select('*').eq('id', id).maybeSingle();
        return { data: (r.data as ExpenseRow | null) ?? null, error: r.error?.message, status: r.status };
      } catch (e) {
        return { data: null, error: (e as Error).message };
      }
    },
    async listAll() {
      return fetchAllRows<ExpenseRow>(client, 'expenses'); // 끝까지 받는다(잘림 없음 — M-10)
    },
  };
}

/** 사진 원격 포트 — 메타(테이블) + 태블릿 감상용 클라우드 정본(WebP). */
export interface MediaRemote {
  upsert(row: MediaRow): Promise<{ error?: string | undefined; status?: number | undefined }>;
  getById(id: string): Promise<{ data: MediaRow | null; error?: string | undefined; status?: number | undefined }>;
  listAll(): Promise<{ data: MediaRow[]; error?: string | undefined }>;
  uploadDisplay(path: string, blob: Blob): Promise<{ error?: string | undefined; status?: number | undefined }>;
  download(path: string): Promise<{ data: Blob | null; error?: string | undefined; status?: number | undefined }>;
  remove(path: string): Promise<{ error?: string | undefined }>;
}

export function mediaRemote(client: JourneyClient): MediaRemote {
  // 바이트 3종은 **R2 하나뿐**이다(v0.86). 메타·RLS·병합 규율은 저장소와 무관하게 동일하다.
  // 옛 Supabase Storage 경로는 이관을 마치고 제거했다 — 사진 8장을 옮기고 되읽어 확인한 뒤였다.
  const blobs = r2BlobStore(client);
  return {
    async upsert(row) {
      try {
        const r = await client.from('media').upsert(row, { onConflict: 'id' });
        return { error: r.error?.message, status: r.status };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    async getById(id) {
      try {
        const r = await client.from('media').select('*').eq('id', id).maybeSingle();
        return { data: (r.data as MediaRow | null) ?? null, error: r.error?.message, status: r.status };
      } catch (e) {
        return { data: null, error: (e as Error).message };
      }
    },
    async listAll() {
      return fetchAllRows<MediaRow>(client, 'media'); // 끝까지 받는다(잘림 없음 — M-10)
    },
    uploadDisplay: (path, blob) => blobs.uploadDisplay(path, blob),
    download: (path) => blobs.download(path),
    remove: (path) => blobs.remove(path),
  };
}

/**
 * 소리 원격 포트 — 메타(journey.audio) + **원본 바이트**(R2).
 *
 * 사진과 하나만 다르다: 사진은 재인코딩한 WebP를 클라우드 정본으로 삼고,
 * 소리는 **녹음 바이트 자체가 정본**이라 그대로 올린다. 그래서 `uploadDisplay`가 아니라 `upload`다 —
 * 이름이 다른 것 자체가 그 차이를 말한다.
 */
export interface AudioRemote {
  upsert(row: AudioRow): Promise<{ error?: string | undefined; status?: number | undefined }>;
  getById(id: string): Promise<{ data: AudioRow | null; error?: string | undefined; status?: number | undefined }>;
  listAll(): Promise<{ data: AudioRow[]; error?: string | undefined }>;
  upload(path: string, blob: Blob, contentType: string): Promise<{ error?: string | undefined; status?: number | undefined }>;
  download(path: string): Promise<{ data: Blob | null; error?: string | undefined; status?: number | undefined }>;
  remove(path: string): Promise<{ error?: string | undefined }>;
}

export function audioRemote(client: JourneyClient): AudioRemote {
  const blobs = r2BlobStore(client); // 사진과 **같은 버킷·같은 인가 모델**(첫 칸은 검증된 sub)
  return {
    async upsert(row) {
      try {
        const r = await client.from('audio').upsert(row, { onConflict: 'id' });
        return { error: r.error?.message, status: r.status };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    async getById(id) {
      try {
        const r = await client.from('audio').select('*').eq('id', id).maybeSingle();
        return { data: (r.data as AudioRow | null) ?? null, error: r.error?.message, status: r.status };
      } catch (e) {
        return { data: null, error: (e as Error).message };
      }
    },
    async listAll() {
      return fetchAllRows<AudioRow>(client, 'audio'); // 끝까지 받는다(잘림 없음 — M-10)
    },
    upload: (path, blob, contentType) => blobs.upload(path, blob, contentType),
    download: (path) => blobs.download(path),
    remove: (path) => blobs.remove(path),
  };
}

export interface VideoRemote {
  upsert(row: VideoRow): Promise<{ error?: string | undefined; status?: number | undefined }>;
  getById(id: string): Promise<{ data: VideoRow | null; error?: string | undefined; status?: number | undefined }>;
  listAll(): Promise<{ data: VideoRow[]; error?: string | undefined }>;
  upload(path: string, blob: Blob, contentType: string): Promise<{ error?: string | undefined; status?: number | undefined }>;
  download(path: string): Promise<{ data: Blob | null; error?: string | undefined; status?: number | undefined }>;
  remove(path: string): Promise<{ error?: string | undefined }>;
}

export function videoRemote(client: JourneyClient): VideoRemote {
  const blobs = r2BlobStore(client);
  return {
    async upsert(row) {
      try {
        const r = await client.from('videos').upsert(row, { onConflict: 'id' });
        return { error: r.error?.message, status: r.status };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    async getById(id) {
      try {
        const r = await client.from('videos').select('*').eq('id', id).maybeSingle();
        return { data: (r.data as VideoRow | null) ?? null, error: r.error?.message, status: r.status };
      } catch (e) {
        return { data: null, error: (e as Error).message };
      }
    },
    async listAll() { return fetchAllRows<VideoRow>(client, 'videos'); },
    upload: (path, blob, contentType) => blobs.upload(path, blob, contentType),
    download: (path) => blobs.download(path),
    remove: (path) => blobs.remove(path),
  };
}

/**
 * 실패를 큐에 적는다. **왜 실패했는지도 함께 적는다**(2026-08-05 · M-0107).
 *
 * 🔴 왜 사유를 남기나: 사용자 기기에 `permanent_failed` 13건이 박혀 있었는데 화면도 진단도
 * **이유를 말할 수 없었다** — 큐가 사유를 안 갖고 있었기 때문이다. 원인(순간 영구삭제가 자식을
 * 남겨 FK 위반)을 알아내는 데 **실서버를 직접 조회**해야 했다. 앱이 아는 것을 사람에게 대신
 * 시킨 자리다(§12). 상태 코드 하나만 있어도 갈래가 갈린다: 401/403은 권한, 409는 관계 충돌,
 * 400은 스키마 — 사용자가 할 일이 각각 다르다.
 */
async function markFail(op: SyncQueueItem, status: number | undefined, reason?: string): Promise<void> {
  const kind = classifyError(status);
  const attempts = (op.attempts ?? 0) + 1;
  await db().syncQueue.update(op.operationId, {
    state: kind === 'retryable' ? 'retryable_failed' : 'permanent_failed',
    attempts,
    ...(status === undefined ? {} : { lastStatus: status }),
    // 사유가 없으면 **비운다**(옛 사유를 남겨 두면 이번 실패를 지난번 이유로 설명하게 된다).
    lastError: reason ?? '',
    // **다음 시도 시각을 적는다**(2026-07-27). 예전엔 `attempts`만 올리고 아무도 읽지 않아,
    // 실패한 op이 `autoSync` 트리거(online·visibilitychange·5분 주기)마다 **즉시** 재시도됐다.
    // 계약은 `docs/SYNC_PROTOCOL.md:31`에 처음부터 있었다 — 코드가 따라가지 않았을 뿐이다.
    nextRetryAt: new Date(Date.now() + retryDelayMs(attempts)).toISOString(),
  });
}

type SyncEntityType = 'trip' | 'moment' | 'media' | 'expense' | 'audio' | 'video' | 'place';

/**
 * `merge`는 평상시 양방향 동기화다. `server-read-only`는 서버 capability를 확인할 수 없는
 * 배포 전환 구간 전용이며, 서버 쓰기뿐 아니라 기존 로컬 작업 큐를 pull이 지우는 것도 금지한다.
 */
export type PullMode = 'merge' | 'server-read-only';

export interface SyncAttempt {
  /** 이 엔티티의 최신 의사. 네트워크에는 이것 하나만 보낸다. */
  op: SyncQueueItem;
  /** 최신 의사가 완전히 포함하므로 안전하게 접을 수 있는 옛 작업들. */
  supersededOperationIds: string[];
}

/**
 * 같은 엔티티의 연속 편집을 최신 작업 하나로 접는다.
 *
 * push는 큐의 각 op 시점 payload가 아니라 **현재 로컬 행**을 읽는다. 따라서 v2 op와 v3 op이
 * 함께 있으면 둘 다 v3 payload를 보내게 된다. 첫 요청 뒤 서버시각이 전진하므로 둘째 요청은
 * stale guard에 막히고 영원히 재시도될 수 있다. 최신 op 하나가 현재 행 전체를 대표하게 하고,
 * 옛 op은 최신 op을 남긴 뒤에만 지운다(중간 crash에도 보낼 의사는 하나 남는다).
 *
 * 최신 op이 백오프 중이거나 permanent면 옛 op으로 우회하지 않는다. 그랬다간 최신 payload를
 * 옛 작업의 재시도 정책으로 조기에 보내게 된다.
 */
export function collapseSyncAttempts(
  items: SyncQueueItem[],
  entityType: SyncEntityType,
  nowIso = new Date().toISOString(),
): SyncAttempt[] {
  const grouped = new Map<string, { op: SyncQueueItem; operationIds: string[] }>();
  for (const op of items) {
    if (op.entityType !== entityType || op.operationType === 'purge' || op.operationType === 'unpurge') continue;
    const found = grouped.get(op.entityId);
    if (found) {
      found.op = op; // createdAt 순으로 읽었으므로 마지막이 최신 의사다.
      found.operationIds.push(op.operationId);
    } else {
      grouped.set(op.entityId, { op, operationIds: [op.operationId] });
    }
  }
  return [...grouped.values()]
    .filter(({ op }) =>
      (op.state === 'local_only' || op.state === 'retryable_failed') && isRetryDue(op, nowIso),
    )
    .map(({ op, operationIds }) => ({
      op,
      supersededOperationIds: operationIds.filter((id) => id !== op.operationId),
    }));
}

/** 최신 로컬 snapshot이 어느 큐 작업을 대표하는지 row에 명시한다. 옛 cascade/backfill도 보정된다. */
function withSyncOperation<T extends SyncMeta>(entity: T, operationId: string): T {
  return { ...entity, clientOperationId: operationId };
}

/** 네트워크 전에 옛 op만 접는다. 최신 op은 성공 read-back 전까지 반드시 남긴다. */
async function removeSuperseded(attempt: SyncAttempt): Promise<void> {
  if (attempt.supersededOperationIds.length) {
    await db().syncQueue.bulkDelete(attempt.supersededOperationIds);
  }
}

/** push 중 새 편집이 생겼으면 그 최신 로컬 행에는 옛 서버 stamp를 씌우지 않는다. */
function isSameSnapshot(cur: SyncMeta | undefined, expected: SyncMeta): boolean {
  return Boolean(
    cur &&
      cur.version === expected.version &&
      cur.updatedAt === expected.updatedAt &&
      cur.clientOperationId === expected.clientOperationId,
  );
}

/** pull이 이긴 snapshot만 교체하고, 그 snapshot을 만들었던 도메인 op을 같은 트랜잭션에서 걷는다. */
async function applyServerWinner<T extends SyncMeta>(
  table: Table<T, string>,
  entityType: SyncEntityType,
  expected: T | undefined,
  server: T,
  mode: PullMode,
): Promise<boolean> {
  const d = db();
  return d.transaction('rw', table, d.syncQueue, async () => {
    const cur = await table.get(server.id);
    const unchanged = expected
      ? Boolean(
          cur &&
            cur.version === expected.version &&
            cur.updatedAt === expected.updatedAt &&
            cur.deletedAt === expected.deletedAt &&
            cur.clientOperationId === expected.clientOperationId,
        )
      : cur === undefined;
    if (!unchanged) return false;

    const queued = await d.syncQueue.where('entityId').equals(server.id).toArray();
    const staleIds = queued
      .filter(
        (q) =>
          q.entityType === entityType && q.operationType !== 'purge' && q.operationType !== 'unpurge',
      )
      .map((q) => q.operationId);
    // capability가 불명확한 동안에는 로컬 의사를 서버 snapshot으로 덮거나 큐에서 지우지 않는다.
    if (mode === 'server-read-only' && staleIds.length) return false;

    await table.put(server);
    if (mode === 'merge' && staleIds.length) await d.syncQueue.bulkDelete(staleIds);
    return true;
  });
}

/**
 * 조건부 쓰기가 거절됐지만 LWW상 로컬이 이겨야 하면, 서버의 현재 version을 새 기준선으로 삼는다.
 * 같은 로컬 snapshot일 때만 고쳐 push 도중 생긴 더 최신 편집을 건드리지 않는다.
 */
async function rebaseRejectedLocal<T extends SyncMeta>(
  table: Table<T, string>,
  expected: T,
  operationId: string,
  server: SyncMeta,
): Promise<boolean> {
  if (mergeDecision(expected, server) !== 'keep-local') return false;

  const d = db();
  return d.transaction('rw', table, async () => {
    const cur = await table.get(expected.id);
    const unchanged = Boolean(
      cur &&
        cur.version === expected.version &&
        cur.updatedAt === expected.updatedAt &&
        cur.deletedAt === expected.deletedAt &&
        cur.clientOperationId === expected.clientOperationId,
    );
    if (!cur || !unchanged) return false;

    await table.put({
      ...cur,
      baseVersion: server.version,
      version: Math.max(cur.version, server.version + 1),
      clientOperationId: operationId,
    });
    return true;
  });
}

/** DB가 가리키지 않는 작업별 R2 키만 걷는다. 삭제 실패는 기억보다 고아 사본을 택해 재시도에 맡긴다. */
async function removeUnreferencedBytes(
  remote: Pick<MediaRemote, 'remove'> | Pick<AudioRemote, 'remove'>,
  candidate: string | undefined,
  referenced: string | null | undefined,
): Promise<void> {
  if (!candidate || candidate === referenced) return;
  try {
    const removed = await remote.remove(candidate);
    if (removed.error) console.warn(`동기화 고아 바이트 정리 보류: ${removed.error}`);
  } catch (e) {
    console.warn(`동기화 고아 바이트 정리 보류: ${(e as Error).message}`);
  }
}

/** R2에서 되읽은 바이트가 로컬 표시본과 정확히 같은지 확인한다. 크기만 같다고 통과시키지 않는다. */
async function sameBlobBytes(left: Blob, right: Blob): Promise<boolean> {
  if (left.size !== right.size || left.size === 0) return false;
  const [a, b] = await Promise.all([left.arrayBuffer(), right.arrayBuffer()]);
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  for (let i = 0; i < av.length; i += 1) if (av[i] !== bv[i]) return false;
  return true;
}

/**
 * 서버에서 검증된 표시본이 유일한 정본이 된 뒤 로컬의 큰 입력 원본 복사본을 비운다.
 * `editState`도 원본 좌표계에 묶인 값이라 함께 걷는다. 이후 재편집은 현재 표시본에서 새로 시작한다.
 */
async function discardVerifiedLocalOriginal(expected: LocalMedia, verified: Blob): Promise<boolean> {
  if (!expected.originalBlob || expected.originalBlob.size === 0) return false;
  if (!(await sameBlobBytes(expected.displayBlob, verified))) return false;
  const d = db();
  return d.transaction('rw', d.localMedia, async () => {
    const cur = await d.localMedia.get(expected.id);
    if (!cur || !isSameSnapshot(cur, expected) || cur.storagePath !== expected.storagePath) return false;
    const { originalBlob: _staged, editState: _sourceState, ...keep } = cur;
    await d.localMedia.put(keep);
    return true;
  });
}

/**
 * 옛 정책으로 이미 저장된 사진을 데려오는 1회성·멱등 정리다.
 * 경로 기억만 믿지 않고 R2에서 바이트를 되읽어 같은 표시본임을 확인한 사진만 정리한다.
 */
export async function pruneVerifiedMediaOriginals(
  remote: Pick<MediaRemote, 'download'>,
): Promise<{ pruned: number; kept: number }> {
  const rows = (await db().localMedia.toArray()).filter((m) => (m.originalBlob?.size ?? 0) > 0 && !!m.storagePath);
  let pruned = 0;
  let kept = 0;
  for (const media of rows) {
    const dl = await remote.download(media.storagePath!);
    if (dl.error || !dl.data || !(await discardVerifiedLocalOriginal(media, dl.data))) kept += 1;
    else pruned += 1;
  }
  return { pruned, kept };
}

/**
 * 대기열의 로컬 작업을 서버에 반영. 각 작업마다:
 * upsert(멱등) → 별도 read-back으로 일치 확인 → 서버시각/version 로컬 반영 → 작업 제거.
 * HTTP 성공/upsert 표현만으로 완료 처리하지 않는다(불변식 5).
 */
export async function pushPending(remote: TripsRemote, userId: string): Promise<{ pushed: number; failed: number }> {
  const d = db();
  const attempts = collapseSyncAttempts(await d.syncQueue.orderBy('createdAt').toArray(), 'trip');
  let pushed = 0;
  let failed = 0;

  for (const attempt of attempts) {
    const { op } = attempt;
    await removeSuperseded(attempt);
    const trip = await d.localTrips.get(op.entityId);
    if (!trip) {
      await d.syncQueue.delete(op.operationId); // 로컬에 없는 고아 작업 폐기
      continue;
    }

    const sent = withSyncOperation(trip, op.operationId);
    const up = await remote.upsert(toRow(sent, userId, deviceStamp()));
    if (up.error) {
      await markFail(op, up.status, up.error);
      failed++;
      continue;
    }

    // 정확한 read-back: 같은 레코드를 별도 조회해 확인(불변식 5).
    const back = await remote.getById(trip.id);
    const serverTrip = back.data ? fromRow(back.data) : null;
    if (back.error || !serverTrip) {
      await markFail(op, back.status, back.error);
      failed++;
      continue;
    }
    if (!writeLanded(serverTrip, sent.version, op.operationId)) {
      await rebaseRejectedLocal(d.localTrips, trip, op.operationId, serverTrip);
      await markFail(op, undefined, '다른 기기의 변경과 겹쳐 내 쓰기가 착지하지 못했어요 — 다음 동기화에서 다시 시도합니다');
      failed++;
      continue;
    }

    // LWW 서버시각 반영 + 작업 원자 제거.
    await d.transaction('rw', d.localTrips, d.syncQueue, async () => {
      const cur = await d.localTrips.get(trip.id);
      if (isSameSnapshot(cur, trip)) {
        await d.localTrips.put({
          ...cur!,
          updatedAt: serverTrip.updatedAt,
          version: serverTrip.version,
          baseVersion: serverTrip.version,
          clientOperationId: op.operationId,
        });
      }
      await d.syncQueue.delete(op.operationId);
    });
    pushed++;
  }
  return { pushed, failed };
}

/**
 * 서버의 내 여행을 로컬에 병합(교체 아님). 빈-클라우드 가드로 로컬을 지키고,
 * 각 행은 LWW/tombstone 결정으로만 반영한다. 서버에 없는 로컬 행은 지우지 않는다
 * (아직 push 안 된 로컬 전용일 수 있음).
 */
export async function pullTrips(remote: TripsRemote, mode: PullMode): Promise<{ pulled: number; skippedEmptyCloud: boolean }> {
  const d = db();
  const res = await remote.listAll();
  if (res.error) throw new Error(res.error);
  const serverRows = res.data;

  const purged = await purgedIdSet();
  const localActive = (await d.localTrips.toArray()).filter((t) => t.deletedAt === null).length;
  if (isEmptyCloudAnomaly(serverRows.length, localActive)) {
    return { pulled: 0, skippedEmptyCloud: true }; // 로컬 보존
  }

  let pulled = 0;
  for (const r of serverRows) {
    // 영구삭제된 것은 **서버에 행 자체가 없다**(ADR-0030) — 여기서 볼 일이 없다.
    // 다른 기기의 영구삭제는 pull이 아니라 **서버 원장**(`applyPurgedLedger`)이 알려준다.
    if (purged.has(r.id)) continue; // 이 기기에서 영구히 치운 것 — 되살리지 않는다
    const server = fromRow(r);
    const local = await d.localTrips.get(server.id);
    if (mergeDecision(local, server) === 'take-server') {
      if (await applyServerWinner(d.localTrips, 'trip', local, server, mode)) pulled++;
    } else {
      await requeueIfServerStillActive('trip', local, server, mode);
    }
  }
  return { pulled, skippedEmptyCloud: false };
}

/** 순간 대기열 push(trips와 대칭: 멱등 upsert → read-back → 서버시각 반영 → 작업 제거). */
export async function pushPendingMoments(
  remote: MomentsRemote,
  userId: string,
): Promise<{ pushed: number; failed: number }> {
  const d = db();
  const attempts = collapseSyncAttempts(await d.syncQueue.orderBy('createdAt').toArray(), 'moment');
  let pushed = 0;
  let failed = 0;

  for (const attempt of attempts) {
    const { op } = attempt;
    await removeSuperseded(attempt);
    const moment = await d.localMoments.get(op.entityId);
    if (!moment) {
      await d.syncQueue.delete(op.operationId);
      continue;
    }

    const sent = withSyncOperation(moment, op.operationId);
    const up = await remote.upsert(toMomentRow(sent, userId, deviceStamp()));
    if (up.error) {
      await markFail(op, up.status, up.error);
      failed++;
      continue;
    }

    const back = await remote.getById(moment.id);
    const serverMoment = back.data ? fromMomentRow(back.data) : null;
    if (back.error || !serverMoment) {
      await markFail(op, back.status, back.error);
      failed++;
      continue;
    }
    if (!writeLanded(serverMoment, sent.version, op.operationId)) {
      await rebaseRejectedLocal(d.localMoments, moment, op.operationId, serverMoment);
      await markFail(op, undefined, '다른 기기의 변경과 겹쳐 내 쓰기가 착지하지 못했어요 — 다음 동기화에서 다시 시도합니다');
      failed++;
      continue;
    }

    await d.transaction('rw', d.localMoments, d.syncQueue, async () => {
      const cur = await d.localMoments.get(moment.id);
      if (isSameSnapshot(cur, moment)) {
        await d.localMoments.put({
          ...cur!,
          updatedAt: serverMoment.updatedAt,
          version: serverMoment.version,
          baseVersion: serverMoment.version,
          clientOperationId: op.operationId,
        });
      }
      await d.syncQueue.delete(op.operationId);
    });
    pushed++;
  }
  return { pushed, failed };
}

/** 서버의 내 순간을 로컬에 병합(교체 아님, 빈-클라우드 가드, LWW/tombstone). */
export async function pullMoments(remote: MomentsRemote, mode: PullMode): Promise<{ pulled: number; skippedEmptyCloud: boolean }> {
  const d = db();
  const res = await remote.listAll();
  if (res.error) throw new Error(res.error);
  const serverRows = res.data;

  const purged = await purgedIdSet();
  const localActive = (await d.localMoments.toArray()).filter((m) => m.deletedAt === null).length;
  if (isEmptyCloudAnomaly(serverRows.length, localActive)) {
    return { pulled: 0, skippedEmptyCloud: true };
  }

  let pulled = 0;
  for (const r of serverRows) {
    // 영구삭제된 것은 **서버에 행 자체가 없다**(ADR-0030) — 여기서 볼 일이 없다.
    // 다른 기기의 영구삭제는 pull이 아니라 **서버 원장**(`applyPurgedLedger`)이 알려준다.
    if (purged.has(r.id)) continue; // 이 기기에서 영구히 치운 것 — 되살리지 않는다
    const server = fromMomentRow(r);
    const local = await d.localMoments.get(server.id);
    if (mergeDecision(local, server) === 'take-server') {
      if (await applyServerWinner(d.localMoments, 'moment', local, server, mode)) pulled++;
    } else {
      await requeueIfServerStillActive('moment', local, server, mode);
    }
  }
  return { pulled, skippedEmptyCloud: false };
}

/** 비용 대기열 push(moments와 대칭: 멱등 upsert → read-back → 서버시각 반영 → 작업 제거). */
export async function pushPendingExpenses(
  remote: ExpensesRemote,
  userId: string,
): Promise<{ pushed: number; failed: number }> {
  const d = db();
  const attempts = collapseSyncAttempts(await d.syncQueue.orderBy('createdAt').toArray(), 'expense');
  let pushed = 0;
  let failed = 0;

  for (const attempt of attempts) {
    const { op } = attempt;
    await removeSuperseded(attempt);
    const expense = await d.localExpenses.get(op.entityId);
    if (!expense) {
      await d.syncQueue.delete(op.operationId);
      continue;
    }

    const sent = withSyncOperation(expense, op.operationId);
    const up = await remote.upsert(toExpenseRow(sent, userId, deviceStamp()));
    if (up.error) {
      await markFail(op, up.status, up.error);
      failed++;
      continue;
    }

    const back = await remote.getById(expense.id);
    const serverExpense = back.data ? fromExpenseRow(back.data) : null;
    if (back.error || !serverExpense) {
      await markFail(op, back.status, back.error);
      failed++;
      continue;
    }
    if (!writeLanded(serverExpense, sent.version, op.operationId)) {
      await rebaseRejectedLocal(d.localExpenses, expense, op.operationId, serverExpense);
      await markFail(op, undefined, '다른 기기의 변경과 겹쳐 내 쓰기가 착지하지 못했어요 — 다음 동기화에서 다시 시도합니다');
      failed++;
      continue;
    }

    await d.transaction('rw', d.localExpenses, d.syncQueue, async () => {
      const cur = await d.localExpenses.get(expense.id);
      if (isSameSnapshot(cur, expense)) {
        await d.localExpenses.put({
          ...cur!,
          updatedAt: serverExpense.updatedAt,
          version: serverExpense.version,
          baseVersion: serverExpense.version,
          clientOperationId: op.operationId,
        });
      }
      await d.syncQueue.delete(op.operationId);
    });
    pushed++;
  }
  return { pushed, failed };
}

/** 서버의 내 비용을 로컬에 병합(교체 아님, 빈-클라우드 가드, LWW/tombstone). */
export async function pullExpenses(remote: ExpensesRemote, mode: PullMode): Promise<{ pulled: number; skippedEmptyCloud: boolean }> {
  const d = db();
  const res = await remote.listAll();
  if (res.error) throw new Error(res.error);
  const serverRows = res.data;

  const purged = await purgedIdSet();
  const localActive = (await d.localExpenses.toArray()).filter((e) => e.deletedAt === null).length;
  if (isEmptyCloudAnomaly(serverRows.length, localActive)) {
    return { pulled: 0, skippedEmptyCloud: true };
  }

  let pulled = 0;
  for (const r of serverRows) {
    // 영구삭제된 것은 **서버에 행 자체가 없다**(ADR-0030) — 여기서 볼 일이 없다.
    // 다른 기기의 영구삭제는 pull이 아니라 **서버 원장**(`applyPurgedLedger`)이 알려준다.
    if (purged.has(r.id)) continue; // 이 기기에서 영구히 치운 것 — 되살리지 않는다
    const server = fromExpenseRow(r);
    const local = await d.localExpenses.get(server.id);
    if (mergeDecision(local, server) === 'take-server') {
      if (await applyServerWinner(d.localExpenses, 'expense', local, server, mode)) pulled++;
    } else {
      await requeueIfServerStillActive('expense', local, server, mode);
    }
  }
  return { pulled, skippedEmptyCloud: false };
}

/**
 * 사진 push: 표시본을 R2에 올리고 메타 행을 upsert → 행 read-back → R2 바이트 read-back →
 * 로컬 원본 임시본 정리 → 작업 제거. 어느 확인이든 실패하면 원본과 op을 남겨 재시도한다.
 */
export async function pushPendingMedia(remote: MediaRemote, userId: string): Promise<{ pushed: number; failed: number }> {
  const d = db();
  const attempts = collapseSyncAttempts(await d.syncQueue.orderBy('createdAt').toArray(), 'media');
  let pushed = 0;
  let failed = 0;

  for (const attempt of attempts) {
    const { op } = attempt;
    await removeSuperseded(attempt);
    const media = await d.localMedia.get(op.entityId);
    if (!media) {
      await d.syncQueue.delete(op.operationId);
      continue;
    }
    // **기억한 경로를 안정적인 이름의 바탕으로 쓴다.** 제목에서 다시 계산하지는 않되, 실제 PUT은
    // 아래에서 operation 토큰을 바꾼 새 키로 격리한다. DB read-back이 승인한 키만 다시 기억한다.
    const trip = await d.localTrips.get(media.tripId);
    const previousPath = media.storagePath;
    const stablePath = previousPath ?? mediaStoragePath(userId, media, trip?.title ?? null);
    // 🔴 판정은 **공용 문**을 지난다(§7 2층 — M-0059). 예전엔 여기가 `deletedAt === null`
    // 한 줄이었고, 형제(소리)만 고쳐지면서 **휴지통 사진의 바이트가 영영 못 올라갔다.**
    // 사진은 `false` — 옛 키 형식 행은 경로를 기억하지 않으면서 바이트는 서버에 있으므로,
    // 「경로 기억 없음」을 「올라간 적 없음」으로 읽으면 고아 사본을 만든다.
    const uploadsBytes = mustUploadBytes(media, false);
    // 🔴 DB guard보다 R2 PUT이 먼저다. 작업별 새 키가 아니면 stale 기기가 최신 사진 바이트를
    // 먼저 덮은 뒤 DB 행만 거절되는 분리 상태가 된다(M-0087).
    const path = uploadsBytes ? operationStoragePath(stablePath, media.id, op.operationId) : stablePath;
    if (uploadsBytes) {
      const up = await remote.uploadDisplay(path, media.displayBlob); // 표시본만(원본 미업로드)
      if (up.error) {
        await markFail(op, up.status, up.error);
        failed++;
        continue;
      }
    }
    const sent = withSyncOperation(media, op.operationId);
    const res = await remote.upsert(toMediaRow(sent, userId, path, deviceStamp()));
    if (res.error) {
      await markFail(op, res.status, res.error);
      failed++;
      continue;
    }
    const back = await remote.getById(media.id);
    if (back.error || !back.data) {
      await markFail(op, back.status, back.error);
      failed++;
      continue;
    }
    const server = fromMediaRow(back.data);
    // 🔴 내 쓰기가 실제로 착지했는가 — 경합으로 남의 행을 받았으면 덮지 않고 재시도(M-3).
    if (!writeLanded(server, sent.version, op.operationId, path)) {
      await removeUnreferencedBytes(remote, uploadsBytes ? path : undefined, server.storagePath);
      await rebaseRejectedLocal(d.localMedia, media, op.operationId, server);
      await markFail(op, undefined, '다른 기기의 변경과 겹쳐 내 쓰기가 착지하지 못했어요 — 다음 동기화에서 다시 시도합니다');
      failed++;
      continue;
    }
    // HTTP 200과 DB 경로만으로는 바이트 존재를 증명하지 못한다(M-0048). 실제 R2 GET 바이트가
    // 방금 보낸 표시본과 같아야만 아래 트랜잭션에서 원본 임시본을 버릴 수 있다.
    const verified = await remote.download(path);
    if (verified.error || !verified.data || !(await sameBlobBytes(media.displayBlob, verified.data))) {
      await markFail(op, verified.status, verified.error);
      failed++;
      continue;
    }
    await d.transaction('rw', d.localMedia, d.syncQueue, async () => {
      const cur = await d.localMedia.get(media.id);
      // 경로도 **같은 커밋에** 기억한다(M-0033의 교훈 — "곧 이어서 쓸 것"은 없는 것과 같다).
      // 「서버에 없다」 표시도 **같은 커밋에** 걷는다 — 방금 올렸으므로 더는 참이 아니다.
      if (isSameSnapshot(cur, media)) {
        const {
          bytesMissing: _done,
          originalBlob: _staged,
          editState: _sourceState,
          ...keep
        } = cur!;
        await d.localMedia.put({
          ...keep,
          storagePath: path,
          updatedAt: server.updatedAt,
          version: server.version,
          baseVersion: server.version,
          clientOperationId: op.operationId,
        });
      }
      await d.syncQueue.delete(op.operationId);
    });
    // DB read-back과 로컬 커밋 뒤에만 옛 표시본을 걷는다. 실패하면 고아 사본만 남고 기억은 남는다.
    if (uploadsBytes) await removeUnreferencedBytes(remote, previousPath, path);
    // ⚠️ 여기서 바이트를 지우지 않는다(정책 변경 2026-07-26, 사용자 결정).
    //
    // 예전에는 tombstone을 밀면서 곧바로 `remote.remove(path)`로 서버 사진을 지웠다. 그러면
    // **휴지통에 있는 동안 사진이 이미 서버에 없다.** 복원은 "사본을 아직 가진 기기가 다시
    // 올리는" 방식이라, 그 기기에서 사이트데이터를 지웠거나 애초에 그 사진을 안 받은 기기에서만
    // 복원하면 **사진이 영영 안 돌아왔다.** 휴지통이 사진에 대해서는 휴지통이 아니었다
    // (비타협 원칙 #1과 정면으로 어긋난다).
    //
    // 이제 바이트는 **영구삭제(휴지통 비우기) 시점에만** 지운다 — `pushPurges`가 담당한다.
    // 대가는 휴지통에 머무는 동안의 저장 공간뿐이고, R2 무료 한도 10GB에서 무시할 수준이다.
    pushed++;
  }
  return { pushed, failed };
}

/**
 * 사진 pull(비파괴): 서버가 더 최신일 때만 반영. tombstone은 로컬 blob을 지우지 않고 deletedAt만 세팅
 * (로컬에 없으면 skip). 활성은 표시본을 다운로드해 재구성하되 다운로드 실패 시 로컬을 그대로 둔다.
 * 표시본이 클라우드 정본이므로 소비 기기는 별도 원본 복사본을 만들지 않는다.
 */
export async function pullMedia(remote: MediaRemote, mode: PullMode): Promise<{ pulled: number; skippedEmptyCloud: boolean }> {
  const d = db();
  const res = await remote.listAll();
  if (res.error) throw new Error(res.error);
  const rows = res.data;

  const purged = await purgedIdSet();
  const localActive = (await d.localMedia.toArray()).filter((m) => m.deletedAt === null).length;
  if (isEmptyCloudAnomaly(rows.length, localActive)) {
    return { pulled: 0, skippedEmptyCloud: true };
  }

  let pulled = 0;
  let swept = 0; // 로컬에 없는 서버 고아를 정리한 수(진단·로그용)
  for (const r of rows) {
    // 영구삭제된 것은 **서버에 행 자체가 없다**(ADR-0030) — 여기서 볼 일이 없다.
    // 다른 기기의 영구삭제는 pull이 아니라 **서버 원장**(`applyPurgedLedger`)이 알려준다.
    if (purged.has(r.id)) continue; // 이 기기에서 영구히 치운 것 — 되살리지 않는다
    const server = fromMediaRow(r);
    const local = await d.localMedia.get(server.id);
    if (mergeDecision(local, server) !== 'take-server') {
      await requeueIfServerStillActive('media', local, server, mode);
      continue;
    }

    // ── 서버 기준 고아 스윕 ──────────────────────────────────────────────
    // **로컬에 행 자체가 없는데** 서버는 활성이고, 그 여행이 이 기기에서 영구삭제된 경우.
    // 로컬 행이 없으므로 대기열 op를 만들 수도, `pushPendingMedia`가 처리할 수도 없다 —
    // 재큐잉으로는 **원리적으로 닿지 않는 사각지대**다(사용자가 겪은 바로 그 상태).
    // 여기서만 직접 tombstone을 밀고 바이트를 지운다. 되살려 로컬에 만들지 않는다.
    if (!local && server.deletedAt === null && purged.has(r.trip_id)) {
      // 전환 모드는 서버 cleanup을 시도하지도, 이미 영구삭제한 부모 아래로 다시 받지도 않는다.
      if (mode === 'server-read-only') continue;
      const tombstoneAt = new Date().toISOString();
      const res = await remote.upsert({
        ...r,
        deleted_at: tombstoneAt,
        updated_at: tombstoneAt,
        version: r.version + 1,
        base_version: r.version,
        client_operation_id: crypto.randomUUID(),
      });
      if (!res.error) {
        if (server.storagePath) await remote.remove(server.storagePath);
        swept++;
      }
      continue; // 되살리지 않는다
    }

    if (server.deletedAt !== null) {
      // tombstone — blob 파괴 없이 삭제 표시만. 로컬에 없으면 만들 blob이 없고 필요도 없어 skip.
      if (local) {
        const next = {
          ...local,
          deletedAt: server.deletedAt,
          version: server.version,
          updatedAt: server.updatedAt,
          baseVersion: server.version,
          ...(server.clientOperationId ? { clientOperationId: server.clientOperationId } : {}),
        };
        if (await applyServerWinner(d.localMedia, 'media', local, next, mode)) pulled++;
      }
      continue;
    }

    if (!server.storagePath) continue; // 아직 표시본 업로드 전 → skip(다음 sync)
    const dl = await remote.download(server.storagePath);
    if (dl.error || !dl.data) continue; // 다운로드 실패 → 로컬 보존(비파괴), 다음에 재시도
    const display = dl.data;
    let thumbBlob: Blob = display;
    try {
      thumbBlob = (await compressForStorage(display)).thumb.blob;
    } catch {
      /* 썸네일 재생성 실패 시 표시본으로 폴백 */
    }
    const next: LocalMedia = {
      id: server.id,
      momentId: server.momentId,
      tripId: server.tripId,
      mime: 'image/webp',
      displayBlob: display,
      thumbBlob,
      width: server.width,
      height: server.height,
      takenAt: server.takenAt,
      // 🔴 **서버가 정본이되, 「모름」은 정본이 아니다**(2026-08-01 · 마이그레이션 0024).
      //
      // 서버 값이 있으면 그것을 쓴다(그게 이 변경의 목적이다 — 다른 기기에서도 보이게).
      // 없으면(`null`) **로컬 값을 지킨다.** 옛 서버 행에는 이 컬럼이 아예 없고, 백필이
      // 돌기 전에 pull이 먼저 오면 **멀쩡한 좌표가 null로 덮인다** — 빈-클라우드 가드와
      // 같은 규율을 필드 수준에 적용한 것이다(불변식 #4·#8: pull은 비파괴).
      //
      // 「그럼 사용자가 좌표를 지울 수는 있나?」 — 지금은 지우는 UI가 없다. 생기면 그때는
      // 「지웠음」을 null이 아니라 **명시적 표시**로 보내야 한다(§8 — 모름과 없음은 다르다).
      gpsLat: server.gpsLat ?? local?.gpsLat ?? null,
      // 옛 서버 행에는 `sort_order`가 없다 → `null`(모름)이 **로컬의 진짜 순서를 덮지 않게** 한다.
      // gps와 같은 규율이다(0024) — 「모름」과 「비었음」을 같게 읽으면 사용자 배열이 사라진다.
      sortOrder: server.sortOrder ?? local?.sortOrder ?? null,
      gpsLng: server.gpsLng ?? local?.gpsLng ?? null,
      bytesOriginal: local?.bytesOriginal ?? display.size,
      bytesDisplay: display.size,
      version: server.version,
      baseVersion: server.version,
      ...(server.clientOperationId ? { clientOperationId: server.clientOperationId } : {}),
      createdAt: server.createdAt,
      updatedAt: server.updatedAt,
      deletedAt: null,
      // 서버 표시본을 받은 뒤에는 그 표시본에서 새 편집을 시작한다. 옛 원본 좌표계 editState는 버린다.
    };
    if (await applyServerWinner(d.localMedia, 'media', local, next, mode)) pulled++;
  }
  if (swept) console.info(`서버 고아 정리: 사진 ${swept}건(로컬에 없어 재큐잉이 닿지 못하던 것)`);
  return { pulled, skippedEmptyCloud: false };
}

/**
 * 소리 push — 사진과 **같은 순서·같은 규율**이다:
 * 활성이면 원본 바이트를 올리고 → 메타 upsert → read-back → 서버시각 반영 → 작업 제거.
 * tombstone이면 업로드 없이 메타만(바이트는 영구삭제 때만 지운다 — `pushPurges`).
 *
 * 🔴 확장자를 모르는 형식(`audioStoragePath`가 null)은 **올리지 않고 op을 남긴다.** 지우면
 * 그 소리는 영영 서버에 못 가면서 아무도 그 사실을 모른다. 남겨 두면 진단의 「서버에 없는
 * 소리」가 그걸 말한다(모르는 것을 처리한 척하지 않는다 — 비타협 원칙 #4).
 */
/**
 * 장소 라이브러리 포트.
 *
 * 형제 중 **가장 단순하다** — 바이트가 없어 업로드/다운로드가 없고(좌표와 이름뿐),
 * 부모가 없어 push 순서 제약도 없다. 그 두 가지가 곧 장소가 형제와 다른 점이다.
 */
export interface PlacesRemote {
  upsert(row: PlaceRow): Promise<{ error?: string | undefined; status?: number | undefined }>;
  getById(id: string): Promise<{ data: PlaceRow | null; error?: string | undefined; status?: number | undefined }>;
  listAll(): Promise<{ data: PlaceRow[]; error?: string | undefined }>;
}

export function placesRemote(client: JourneyClient): PlacesRemote {
  return {
    async upsert(row) {
      try {
        const r = await client.from('places').upsert(row, { onConflict: 'id' });
        return { error: r.error?.message, status: r.status };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    async getById(id) {
      try {
        const r = await client.from('places').select('*').eq('id', id).maybeSingle();
        return { data: (r.data as PlaceRow | null) ?? null, error: r.error?.message, status: r.status };
      } catch (e) {
        return { data: null, error: (e as Error).message };
      }
    },
    async listAll() {
      return fetchAllRows<PlaceRow>(client, 'places'); // 끝까지 받는다(잘림 없음 — M-10)
    },
  };
}

/**
 * 장소 push — upsert → **되읽기** → 서버시각 반영 → 큐 op 제거.
 *
 * 되읽기에서 **좌표를 대조한다**(비용이 금액을 대조하는 것과 같은 자리). 200 응답은 "받았다"
 * 이지 "그 값으로 있다"가 아니다 — 그리고 장소에서 틀리면 안 되는 값은 좌표다.
 */
export async function pushPendingPlaces(
  remote: PlacesRemote,
  userId: string,
): Promise<{ pushed: number; failed: number }> {
  const d = db();
  const attempts = collapseSyncAttempts(await d.syncQueue.orderBy('createdAt').toArray(), 'place');
  let pushed = 0;
  let failed = 0;

  for (const attempt of attempts) {
    const { op } = attempt;
    await removeSuperseded(attempt);
    const place = await d.localPlaces.get(op.entityId);
    if (!place) {
      await d.syncQueue.delete(op.operationId);
      continue;
    }

    const sent = withSyncOperation(place, op.operationId);
    const up = await remote.upsert(toPlaceRow(sent, userId, deviceStamp()));
    if (up.error) {
      await markFail(op, up.status, up.error);
      failed++;
      continue;
    }

    const back = await remote.getById(place.id);
    const serverPlace = back.data ? fromPlaceRow(back.data) : null;
    if (back.error || !serverPlace) {
      await markFail(op, back.status, back.error);
      failed++;
      continue;
    }
    if (!writeLanded(serverPlace, sent.version, op.operationId)) {
      await rebaseRejectedLocal(d.localPlaces, place, op.operationId, serverPlace);
      await markFail(op, undefined, '다른 기기의 변경과 겹쳐 내 쓰기가 착지하지 못했어요 — 다음 동기화에서 다시 시도합니다');
      failed++;
      continue;
    }

    await d.transaction('rw', d.localPlaces, d.syncQueue, async () => {
      const cur = await d.localPlaces.get(place.id);
      if (isSameSnapshot(cur, place)) {
        await d.localPlaces.put({
          ...cur!,
          updatedAt: serverPlace.updatedAt,
          version: serverPlace.version,
          baseVersion: serverPlace.version,
          clientOperationId: op.operationId,
        });
      }
      await d.syncQueue.delete(op.operationId);
    });
    pushed++;
  }
  return { pushed, failed };
}

/** 서버의 내 장소를 로컬에 병합(교체 아님, 빈-클라우드 가드, LWW/tombstone). */
export async function pullPlaces(remote: PlacesRemote, mode: PullMode): Promise<{ pulled: number; skippedEmptyCloud: boolean }> {
  const d = db();
  const res = await remote.listAll();
  if (res.error) throw new Error(res.error);
  const serverRows = res.data;

  const purged = await purgedIdSet();
  const localActive = (await d.localPlaces.toArray()).filter((p) => p.deletedAt === null).length;
  if (isEmptyCloudAnomaly(serverRows.length, localActive)) {
    return { pulled: 0, skippedEmptyCloud: true };
  }

  let pulled = 0;
  for (const r of serverRows) {
    if (purged.has(r.id)) continue; // 이 기기에서 영구히 치운 것 — 되살리지 않는다
    const server = fromPlaceRow(r);
    const local = await d.localPlaces.get(server.id);
    if (mergeDecision(local, server) === 'take-server') {
      if (await applyServerWinner(d.localPlaces, 'place', local, server, mode)) pulled++;
    } else {
      await requeueIfServerStillActive('place', local, server, mode);
    }
  }
  return { pulled, skippedEmptyCloud: false };
}

export async function pushPendingAudio(remote: AudioRemote, userId: string): Promise<{ pushed: number; failed: number }> {
  const d = db();
  const attempts = collapseSyncAttempts(await d.syncQueue.orderBy('createdAt').toArray(), 'audio');
  let pushed = 0;
  let failed = 0;

  for (const attempt of attempts) {
    const { op } = attempt;
    await removeSuperseded(attempt);
    const audio = await d.localAudio.get(op.entityId);
    if (!audio) {
      await d.syncQueue.delete(op.operationId);
      continue;
    }
    // 기억한 경로를 이름의 바탕으로 쓴다(사진과 같은 이유 — 제목 변경으로 폴더가 움직이지 않음).
    const trip = await d.localTrips.get(audio.tripId);
    const previousPath = audio.storagePath;
    const stablePath = previousPath ?? audioStoragePath(userId, audio, trip?.title ?? null);
    if (!stablePath) {
      await markFail(op, 400, '이 형식은 서버가 받지 않아요(확장자를 알 수 없음)'); // 형식이 바뀌지 않는 한 같다
      failed++;
      continue;
    }
    // 🔴 **바이트가 아직 서버에 없으면 tombstone이어도 올린다**(2026-07-28, M-0046).
    //
    // 처음엔 사진을 그대로 베껴 `deletedAt === null`일 때만 올렸다. 사진에서 그 조건이 옳은
    // 이유는 *지우기 전에 이미 올라가 있었기 때문*이지 "지운 건 안 올린다"가 규칙이어서가
    // 아니다 — ADR-0029의 규칙은 그 반대다: **휴지통에 있는 동안 바이트는 서버에 있어야 한다.**
    // 그래야 사본이 없는 다른 기기에서도 복원된다.
    //
    // 백필이 그 전제를 깼다: v1.14~v1.19에 지운 녹음은 **한 번도 올라간 적이 없다.** 그런데
    // 아래 upsert는 경로를 적었다 — 파일이 없는데 「여기 있다」고 주장하는 행이 3건 생겼고,
    // 진단은 그걸 「지운 소리의 남은 기록 · 소리 자체는 없습니다」로 띄우며 **정리를 권했다.**
    // 로컬 휴지통엔 멀쩡히 있는데도. 누르면 로컬 행까지 지워져 기억을 잃는 자리였다.
    //
    // 판정은 **사진과 같은 문**을 지난다(§7 2층 — M-0059). 소리에 `true`를 주는 이유:
    // 키 형식이 하나뿐이라 「경로 기억 없음 = 올라간 적 없음」이 성립한다(사진은 옛 형식이
    // 있어 성립하지 않는다 — 그 비대칭은 `mustUploadBytes`의 인자 하나로 드러나 있다).
    const uploadsBytes = mustUploadBytes(audio, true);
    // 현재 소리는 편집 불가지만 사진과 같은 불변 작업 키를 쓴다. 다음 바이트 형제가 생겨도
    // 같은 fence를 자동으로 물려받게 하는 §7의 구조적 대칭이다.
    const path = uploadsBytes ? operationStoragePath(stablePath, audio.id, op.operationId) : stablePath;
    if (uploadsBytes) {
      const up = await remote.upload(path, audio.blob, audio.mime || 'application/octet-stream');
      if (up.error) {
        await markFail(op, up.status, up.error);
        failed++;
        continue;
      }
    }
    const sent = withSyncOperation(audio, op.operationId);
    const res = await remote.upsert(toAudioRow(sent, userId, path, deviceStamp()));
    if (res.error) {
      await markFail(op, res.status, res.error);
      failed++;
      continue;
    }
    const back = await remote.getById(audio.id);
    if (back.error || !back.data) {
      await markFail(op, back.status, back.error);
      failed++;
      continue;
    }
    const server = fromAudioRow(back.data);
    // 🔴 내 쓰기가 실제로 착지했는가 — 경합으로 남의 행을 받았으면 덮지 않고 재시도(M-3, 사진과 같은 문).
    if (!writeLanded(server, sent.version, op.operationId, path)) {
      await removeUnreferencedBytes(remote, uploadsBytes ? path : undefined, server.storagePath);
      await rebaseRejectedLocal(d.localAudio, audio, op.operationId, server);
      await markFail(op, undefined, '다른 기기의 변경과 겹쳐 내 쓰기가 착지하지 못했어요 — 다음 동기화에서 다시 시도합니다');
      failed++;
      continue;
    }
    await d.transaction('rw', d.localAudio, d.syncQueue, async () => {
      const cur = await d.localAudio.get(audio.id);
      // 경로도 **같은 커밋에** 기억한다(M-0033 — "곧 이어서 쓸 것"은 없는 것과 같다).
      // 표시를 걷는 것도 사진과 **같은 자리·같은 방식**이다(§7).
      if (isSameSnapshot(cur, audio)) {
        const { bytesMissing: _done, ...keep } = cur!;
        await d.localAudio.put({
          ...keep,
          storagePath: path,
          updatedAt: server.updatedAt,
          version: server.version,
          baseVersion: server.version,
          clientOperationId: op.operationId,
        });
      }
      await d.syncQueue.delete(op.operationId);
    });
    if (uploadsBytes) await removeUnreferencedBytes(remote, previousPath, path);
    pushed++;
  }
  return { pushed, failed };
}

/**
 * 소리 pull(비파괴) — 사진과 같은 규율. 서버가 더 최신일 때만 반영하고, tombstone은 로컬
 * blob을 지우지 않고 `deletedAt`만 세운다(로컬에 없으면 skip). 활성은 바이트를 내려받아
 * 재구성하되 **다운로드 실패 시 로컬을 그대로 둔다**(비파괴, 불변식 #8).
 */
export async function pullAudio(remote: AudioRemote, mode: PullMode): Promise<{ pulled: number; skippedEmptyCloud: boolean }> {
  const d = db();
  const res = await remote.listAll();
  if (res.error) throw new Error(res.error);
  const rows = res.data;

  const purged = await purgedIdSet();
  const localActive = (await d.localAudio.toArray()).filter((a) => a.deletedAt === null).length;
  if (isEmptyCloudAnomaly(rows.length, localActive)) {
    return { pulled: 0, skippedEmptyCloud: true };
  }

  let pulled = 0;
  for (const r of rows) {
    if (purged.has(r.id)) continue; // 이 기기에서 영구히 치운 것 — 되살리지 않는다
    const server = fromAudioRow(r);
    const local = await d.localAudio.get(server.id);
    if (mergeDecision(local, server) !== 'take-server') {
      await requeueIfServerStillActive('audio', local, server, mode);
      continue;
    }
    if (server.deletedAt !== null) {
      // tombstone — blob 파괴 없이 삭제 표시만. 로컬에 없으면 만들 바이트가 없고 필요도 없다.
      if (local) {
        const next = {
          ...local,
          deletedAt: server.deletedAt,
          version: server.version,
          updatedAt: server.updatedAt,
          baseVersion: server.version,
          ...(server.clientOperationId ? { clientOperationId: server.clientOperationId } : {}),
        };
        if (await applyServerWinner(d.localAudio, 'audio', local, next, mode)) pulled++;
      }
      continue;
    }
    if (!server.storagePath) continue; // 아직 업로드 전 → 다음 동기화에서
    // 로컬에 이미 바이트가 있으면 **다시 받지 않는다.** 같은 바이트를 매번 내려받는 것은
    // 낭비이고(egress), 소리는 편집되지 않으므로 키가 같으면 내용도 같다.
    let blob = local?.blob;
    if (!blob || blob.size === 0 || local?.storagePath !== server.storagePath) {
      const dl = await remote.download(server.storagePath);
      if (dl.error || !dl.data) continue; // 실패 → 로컬 보존(비파괴), 다음에 재시도
      blob = dl.data;
    }
    const next: LocalAudio = {
      id: server.id,
      momentId: server.momentId,
      tripId: server.tripId,
      blob,
      mime: server.mime || local?.mime || 'audio/webm',
      durationSec: server.durationSec,
      recordedAt: server.recordedAt,
      version: server.version,
      baseVersion: server.version,
      ...(server.clientOperationId ? { clientOperationId: server.clientOperationId } : {}),
      createdAt: server.createdAt,
      updatedAt: server.updatedAt,
      deletedAt: null,
      storagePath: server.storagePath,
    };
    if (await applyServerWinner(d.localAudio, 'audio', local, next, mode)) pulled++;
  }
  return { pulled, skippedEmptyCloud: false };
}

export async function pushPendingVideos(remote: VideoRemote, userId: string): Promise<{ pushed: number; failed: number }> {
  const d = db();
  const attempts = collapseSyncAttempts(await d.syncQueue.orderBy('createdAt').toArray(), 'video');
  let pushed = 0;
  let failed = 0;
  for (const attempt of attempts) {
    const { op } = attempt;
    await removeSuperseded(attempt);
    const video = await d.localVideos.get(op.entityId);
    if (!video) {
      await d.syncQueue.delete(op.operationId);
      continue;
    }
    const trip = await d.localTrips.get(video.tripId);
    const previousPath = video.storagePath;
    const stablePath = previousPath ?? videoStoragePath(userId, video, trip?.title ?? null);
    if (!stablePath) {
      await markFail(op, 400, '이 영상 형식은 서버가 받지 않아요.');
      failed++;
      continue;
    }
    const uploadsBytes = mustUploadBytes(video, true);
    const path = uploadsBytes ? operationStoragePath(stablePath, video.id, op.operationId) : stablePath;
    if (uploadsBytes) {
      const up = await remote.upload(path, video.sourceBlob ?? video.blob, video.mime);
      if (up.error) {
        await markFail(op, up.status, up.error);
        failed++;
        continue;
      }
    }
    const sent = withSyncOperation(video, op.operationId);
    const res = await remote.upsert(toVideoRow(sent, userId, path, deviceStamp()));
    if (res.error) {
      await markFail(op, res.status, res.error);
      failed++;
      continue;
    }
    const back = await remote.getById(video.id);
    if (back.error || !back.data) {
      await markFail(op, back.status, back.error);
      failed++;
      continue;
    }
    const server = fromVideoRow(back.data);
    if (!writeLanded(server, sent.version, op.operationId, path)) {
      await removeUnreferencedBytes(remote, uploadsBytes ? path : undefined, server.storagePath);
      await rebaseRejectedLocal(d.localVideos, video, op.operationId, server);
      await markFail(op, undefined, '다른 기기의 변경과 겹쳐 내 영상 쓰기가 착지하지 못했어요.');
      failed++;
      continue;
    }
    const verified = await remote.download(path);
    if (verified.error || !verified.data || !(await sameBlobBytes(video.blob, verified.data))) {
      await markFail(op, verified.status, verified.error ?? '영상 바이트 read-back 불일치');
      failed++;
      continue;
    }
    await d.transaction('rw', d.localVideos, d.syncQueue, async () => {
      const cur = await d.localVideos.get(video.id);
      if (isSameSnapshot(cur, video)) {
        const { bytesMissing: _missing, sourceBlob: _staged, ...keep } = cur!;
        await d.localVideos.put({
          ...keep,
          storagePath: path,
          updatedAt: server.updatedAt,
          version: server.version,
          baseVersion: server.version,
          clientOperationId: op.operationId,
        });
      }
      await d.syncQueue.delete(op.operationId);
    });
    if (uploadsBytes) await removeUnreferencedBytes(remote, previousPath, path);
    pushed++;
  }
  return { pushed, failed };
}

export async function pullVideos(remote: VideoRemote, mode: PullMode): Promise<{ pulled: number; skippedEmptyCloud: boolean }> {
  const d = db();
  const res = await remote.listAll();
  if (res.error) throw new Error(res.error);
  const rows = res.data;
  const purged = await purgedIdSet();
  const localActive = (await d.localVideos.toArray()).filter((v) => v.deletedAt === null).length;
  if (isEmptyCloudAnomaly(rows.length, localActive)) return { pulled: 0, skippedEmptyCloud: true };

  let pulled = 0;
  for (const row of rows) {
    if (purged.has(row.id)) continue;
    const server = fromVideoRow(row);
    const local = await d.localVideos.get(server.id);
    if (mergeDecision(local, server) !== 'take-server') {
      await requeueIfServerStillActive('video', local, server, mode);
      continue;
    }
    if (server.deletedAt !== null) {
      if (local) {
        const next = {
          ...local,
          deletedAt: server.deletedAt,
          version: server.version,
          updatedAt: server.updatedAt,
          baseVersion: server.version,
          ...(server.clientOperationId ? { clientOperationId: server.clientOperationId } : {}),
        };
        if (await applyServerWinner(d.localVideos, 'video', local, next, mode)) pulled++;
      }
      continue;
    }
    if (!server.storagePath) continue;
    let blob = local?.blob;
    let posterBlob = local?.posterBlob;
    if (!blob || blob.size === 0 || local?.storagePath !== server.storagePath) {
      const dl = await remote.download(server.storagePath);
      if (dl.error || !dl.data) continue;
      blob = dl.data;
      try {
        posterBlob = await createVideoPoster(blob);
      } catch {
        continue;
      }
    }
    if (!posterBlob?.size) {
      try { posterBlob = await createVideoPoster(blob); } catch { continue; }
    }
    const next: LocalVideo = {
      id: server.id,
      momentId: server.momentId,
      tripId: server.tripId,
      blob,
      posterBlob,
      mime: server.mime === 'video/mp4' ? 'video/mp4' : 'video/webm',
      durationSec: server.durationSec,
      width: server.width,
      height: server.height,
      takenAt: server.takenAt,
      bytesOriginal: local?.bytesOriginal ?? blob.size,
      bytesVideo: blob.size,
      version: server.version,
      baseVersion: server.version,
      ...(server.clientOperationId ? { clientOperationId: server.clientOperationId } : {}),
      createdAt: server.createdAt,
      updatedAt: server.updatedAt,
      deletedAt: null,
      storagePath: server.storagePath,
    };
    if (await applyServerWinner(d.localVideos, 'video', local, next, mode)) pulled++;
  }
  return { pulled, skippedEmptyCloud: false };
}

/**
 * 로그인/온라인 시 전체 동기화. push 먼저(로컬 우선 전송) → pull 병합.
 * push 순서: 여행 → 순간 → 사진·비용·소리(자식의 복합 FK가 서버의 부모 존재를 요구).
 */
/**
 * **소리를 처음으로 서버에 올려보내기 위한 백필**(2026-07-27, 일회성).
 *
 * 왜 필요한가(§9 4단계 — *"옛 방식으로 만들어진 것을 누가 데려오는가?"*): v1.14~v1.19 동안
 * 만들어진 오디오 노트에는 **큐 op가 애초에 존재한 적이 없다.** 코드에 push/pull을 붙이는
 * 것만으로는 그 행들이 영원히 로컬에만 남는다 — 앱은 조용하고 사용자는 "소리도 이제 동기화된다"는
 * 말을 믿는다. M-0023이 정확히 그 형태였다(방식을 바꿨는데 옛것을 아무도 데려오지 않았다).
 *
 * 대상은 큐에 audio op이 없고, 서버 대조 결과 **로컬 의사를 아직 보내야 하는 행**이다.
 * 서버에 이미 같은/더 최신 행이 있거나 tombstone이 확인됐거나 영구삭제 원장에 있으면 건드리지
 * 않는다. 서버 행이 없는 로컬 tombstone도 새 행·바이트를 만들 이유가 없으므로 건너뛴다.
 *
 * 안전성: **서버 evidence 없이는 실행하지 않는다**(M-0095). 이미 반영된 tombstone을 새 작업번호로
 * 다시 밀면 `storagePath`가 없는 옛 소리는 R2 바이트까지 재업로드한다. 비용 문제를 넘어 진단의
 * read-back 판정을 일반 동기화가 곧바로 뒤집는 결함이므로, 메타+원장 조회가 실패하면 표식도
 * 남기지 않고 다음 실행으로 미룬다.
 *
 * @returns 이번에 새로 큐에 넣은 수.
 */
export async function backfillAudioOps(
  serverRows: AudioRow[],
  serverPurgedIds: ReadonlySet<string>,
): Promise<number> {
  const d = db();
  const serverById = new Map(serverRows.map((row) => [row.id, fromAudioRow(row)]));
  const queued = new Set(
    (await d.syncQueue.toArray()).filter((q) => q.entityType === 'audio').map((q) => q.entityId),
  );
  const now = new Date().toISOString();
  let added = 0;
  for (const a of await d.localAudio.toArray()) {
    if (queued.has(a.id)) continue;
    const server = serverById.get(a.id);
    if (!server) {
      // 서버에 없는 활성 옛 녹음만 최초 전송한다. tombstone은 보낼 대상 자체가 없고,
      // 원장 id는 영구삭제 의도이므로 어느 경우에도 재삽입하지 않는다.
      if (a.deletedAt !== null || serverPurgedIds.has(a.id)) continue;
    } else {
      // 서버 tombstone이면 삭제는 끝났다. 그 밖에는 서버가 이기거나 같은 snapshot이면 백필 0건.
      if (a.deletedAt !== null && server.deletedAt !== null) continue;
      if (mergeDecision(a, server) === 'take-server') continue;
      const sameSnapshot =
        a.deletedAt === server.deletedAt &&
        a.version === server.version &&
        a.updatedAt === server.updatedAt;
      if (sameSnapshot) continue;
    }
    await d.syncQueue.add({
      operationId: crypto.randomUUID(),
      entityType: 'audio',
      entityId: a.id,
      // tombstone이면 'delete', 아니면 'insert' — push는 둘을 같은 upsert로 처리하지만
      // 큐 화면·진단이 이 값을 사람에게 보여주므로 **사실대로** 적는다.
      operationType: a.deletedAt === null ? 'insert' : 'delete',
      state: 'local_only',
      attempts: 0,
      createdAt: now,
    });
    added++;
  }
  return added;
}

/**
 * **좌표를 가진 사진의 행을 한 번 다시 올린다**(2026-08-01 · 마이그레이션 0024 백필).
 *
 * 왜 필요한가(§9 4단계 · M-0023의 근본형): 마이그레이션은 **컬럼을 만들 뿐 값을 채우지 않는다.**
 * 이미 있는 사진 수십 장의 좌표는 이 기기 안에만 있고, 그 행들은 이미 서버에 올라가 있어
 * `syncQueue`에 op이 없다 — **아무도 데려오지 않으면 영원히 로컬에만 남는다.** 그러면
 * "다른 기기에서도 보이게 하자"는 이 변경이 **앞으로 찍는 사진에만** 적용된다.
 *
 * 이 앱의 활성 사진 push는 편집된 표시본을 반영하려고 operation 전용 키에 바이트도 올린다.
 * 따라서 백필은 **서버에 좌표가 이미 같은 사진·영구삭제 id·tombstone을 먼저 제외**해야 한다.
 * 서버 evidence 없이 전부 큐에 넣으면 정상 사진 바이트까지 다시 올리고, 원장 id면 DB 거절 전에
 * R2 고아를 만들 수 있다(M-0095).
 *
 * 대상은 **좌표가 있는 것만**이다. 없는 사진까지 큐에 넣으면 서버에 보낼 새 정보가 없는데
 * 왕복만 늘어난다(그리고 `0,0`은 애초에 좌표가 아니다 — M-0057).
 *
 * @returns 큐에 넣은 수.
 */
export async function backfillMediaGpsOps(
  serverRows: MediaRow[],
  serverPurgedIds: ReadonlySet<string>,
): Promise<number> {
  const d = db();
  const serverById = new Map(serverRows.map((row) => [row.id, fromMediaRow(row)]));
  const queued = new Set(
    (await d.syncQueue.toArray()).filter((q) => q.entityType === 'media').map((q) => q.entityId),
  );
  const now = new Date().toISOString();
  let added = 0;
  for (const m of await d.localMedia.toArray()) {
    if (queued.has(m.id)) continue;
    if (m.deletedAt !== null || serverPurgedIds.has(m.id)) continue;
    if (!isRealCoord(m.gpsLat, m.gpsLng)) continue; // 진짜 좌표만 백필(H-3 · 단일 판정)
    const server = serverById.get(m.id);
    if (server) {
      if (mergeDecision(m, server) === 'take-server') continue;
      if (
        server.deletedAt === null &&
        server.gpsLat === m.gpsLat &&
        server.gpsLng === m.gpsLng
      ) continue;
    }
    await d.syncQueue.add({
      operationId: crypto.randomUUID(),
      entityType: 'media',
      entityId: m.id,
      operationType: 'update',
      state: 'local_only',
      attempts: 0,
      createdAt: now,
    });
    added++;
  }
  return added;
}

/**
 * **서버에 파일이 없는 기록의 바이트를 다시 올린다**(2026-07-28, M-0046 복구 경로).
 *
 * 언제 쓰나: 진단이 「서버에 없는 사진/소리/영상」을 짚었을 때. 그 상태는 *서버 행은 경로를 적어
 * 놓았는데 그 자리에 파일이 없다*는 뜻이고, **이 기기에 사본이 남아 있으면 고칠 수 있다.**
 *
 * 어떻게: 이 기기가 기억하는 착지 키(`storagePath`)를 **잊게 한다.** 그 기억이 곧 push의
 * "이미 올렸다" 근거이므로, 지우면 다음 동기화가 바이트를 다시 올린다. 자료는 건드리지 않는다 —
 * 잊는 것은 *키의 기억*이지 녹음이 아니다.
 *
 * 🔴 **왜 「정리」가 아니라 「다시 올리기」인가**: 같은 상태를 보고 예전 화면은 *"자료는 이미
 * 없으니 기록 줄을 치우세요"*라고 말했다. 로컬에 사본이 있으면 그건 **거짓이고, 그 조언을
 * 따르면 되살릴 수 있던 기억이 사라진다**(`purgeServerOnly`는 로컬 행도 지운다).
 * 사본이 있는지 **묻고 나서** 말해야 한다 — 그게 이 함수가 생긴 이유다.
 *
 * @returns 이번에 다시 올리기로 큐에 넣은 수(로컬에 사본이 없는 id는 건너뛴다).
 */
export async function requeueMissingBytes(domain: PurgeDomain, ids: string[]): Promise<number> {
  if (!ids.length || !DOMAIN_PURGE[domain].hasRemoteBytes) return 0;
  const d = db();
  const table = DOMAIN_PURGE[domain].table() as unknown as Table<
    { id: string; storagePath?: string; bytesMissing?: true },
    string
  >;
  const queued = new Set(
    (await d.syncQueue.toArray()).filter((q) => q.entityType === domain).map((q) => q.entityId),
  );
  const now = new Date().toISOString();
  let added = 0;

  for (const id of ids) {
    const cur = await table.get(id);
    // 로컬에 사본이 없으면 올릴 것이 없다 — 이 경로로는 고칠 수 없는 상태다(조용히 건너뛴다).
    if (!cur) continue;
    const { storagePath: _forget, ...rest } = cur;
    await d.transaction('rw', table, d.syncQueue, async () => {
      // 🔴 **잊는 것만으로는 부족하다**(M-0059). 경로 기억의 부재는 사진에서 「옛 키 형식」과도
      // 구별되지 않으므로, push가 그걸 「올라간 적 없음」으로 읽어 주리라 **기대할 수 없다**.
      // 확인한 사실을 **적는다** — 그리고 표시와 op을 **한 트랜잭션**에 담는다(M-0033).
      await table.put({ ...rest, bytesMissing: true } as { id: string });
      if (!queued.has(id)) {
        await d.syncQueue.add({
          operationId: crypto.randomUUID(),
          entityType: domain,
          entityId: id,
          operationType: 'update',
          state: 'local_only',
          attempts: 0,
          createdAt: now,
        });
      }
    });
    // read-back — 성공 반환을 믿지 않고 되읽어 확인한다. **둘 다 본다**: 기억을 잊었는가,
    // 그리고 확인한 사실을 적었는가. 표시가 없으면 tombstone 자료는 조용히 안 올라간다(M-0059).
    const after = await table.get(id);
    if (after?.storagePath) throw new Error(`다시 올리기 준비 실패: 경로 기억이 남아 있음 ${id}`);
    if (after?.bytesMissing !== true) throw new Error(`다시 올리기 준비 실패: 표시가 남지 않음 ${id}`);
    added++;
  }
  return added;
}

// ── 바이트 대조(자기 점검) ────────────────────────────────────────────────────
//
// 🔴 **왜 이게 동기화의 일인가**(2026-07-28 사용자 지적: *"이거 신경 안 쓰도록 설계를 수정해야
// 할 거 같은데…"*)
//
// 헌법의 데이터 안전 불변식은 *"정확한 read-back으로 확인 — HTTP 200/성공 토스트가 아니라
// 같은 레코드를 되읽어 확인한 뒤에만 완료 처리"*라고 말한다. 그런데 그 규율이 **행(row)에만**
// 걸려 있었다. 행은 upsert 뒤 되읽는데 **바이트(R2 파일)는 올린 뒤 아무도 안 봤다.**
// 형제 비대칭이다(§7).
//
// 그래서 어긋남이 생기면 **사람이 진단을 열어 버튼을 눌러야만** 고쳐졌다. 실제로 그렇게 됐고,
// 더 나빴던 것은 **기기마다 정반대 판정**이 나온 것이다 — 사본이 있는 기기는 「자료는
// 안전합니다」, 없는 기기는 「치우세요」. 사용자가 *어느 기기를 믿을지*까지 판단해야 했다.
// §12가 묻는 그 질문의 답이 「바이트 대조와 복구」였다.
//
// 대칭: 바이트를 가진 도메인 **전부**를 돈다(`hasRemoteBytes` 등록부). 손으로 'media'라고
// 적지 않으므로 **다음 형제가 자동으로 따라온다**.

/** 마지막 바이트 대조 시각(ISO). 자동 동기화는 하루 한 번만 목록을 부른다. */
const BYTES_RECONCILE_KEY = 'bj.repair.bytesReconcile.v1';
/** 자동 동기화의 대조 주기. 사용자가 직접 부른 동기화(`deep`)는 이 값과 무관하게 항상 돈다. */
export const BYTES_RECONCILE_EVERY_MS = 24 * 60 * 60 * 1000;

/** 지금 대조할 때인가 — 순수 함수라 유닛이 직접 잰다(경계값 포함). */
export function reconcileDue(lastAt: string | null, now: number, deep: boolean): boolean {
  if (deep) return true;
  if (!lastAt) return true;
  const t = Date.parse(lastAt);
  if (Number.isNaN(t)) return true; // 표식이 깨졌으면 **재는 쪽**으로 기운다(안 재고 넘기지 않는다)
  return now - t >= BYTES_RECONCILE_EVERY_MS;
}

/**
 * **로컬에 사본이 있는데 서버에 파일이 없는 것**을 찾아 다시 올리기로 큐에 넣는다.
 *
 * 이 함수는 **고치기만 하고 지우지 않는다.** 반대 방향(서버에 파일이 있는데 기록이 없음)은
 * 손대지 않는다 — 그건 자료를 **버리는** 방향이고, 자동으로 할 일이 아니다(비타협 원칙 #1·#5).
 * 진단이 사람에게 보여 주고 사람이 정한다.
 *
 * **모르면 손대지 않는다**(§8): 목록이 잘렸으면(`truncated`) 「없다」고 단정할 수 없고,
 * 서버 함수가 소리 목록을 안 주면(`audioIds === undefined`) 소리는 **확인 불가**다.
 * 그 경우 전부 다시 올리는 쪽으로 반올림하면 멀쩡한 파일을 다시 올려 요금만 쓴다.
 */
export async function reconcileMissingBytes(
  client: JourneyClient,
): Promise<{ requeued: Record<string, number>; note: string | null }> {
  const requeued: Record<string, number> = {};
  const listing = await r2ListObjects(client);
  if (listing.error) return { requeued, note: listing.error };
  if (listing.truncated) {
    return { requeued, note: '서버 파일 목록이 잘려서 대조하지 않았어요(뒤쪽 페이지에 있을 수 있어요).' };
  }
  const local = await localBytesIds();
  // 도메인 → 서버 파일 id 집합. `undefined`는 「빈 집합」이 아니라 **확인 불가**다.
  const serverIds: Partial<Record<PurgeDomain, ReadonlySet<string> | undefined>> = {
    media: new Set(listing.ids),
    audio: listing.audioIds === undefined ? undefined : new Set(listing.audioIds),
  };
  const unknown: string[] = [];

  for (const domain of PURGE_DOMAINS) {
    if (!DOMAIN_PURGE[domain].hasRemoteBytes) continue;
    const server = serverIds[domain];
    if (server === undefined) {
      unknown.push(domain);
      continue;
    }
    const missing = [...local[domain]].filter((id) => !server.has(id));
    if (!missing.length) continue;
    const n = await requeueMissingBytes(domain, missing);
    if (n) requeued[domain] = n;
  }

  const note = unknown.length
    ? `서버 함수가 아직 ${unknown.join('·')} 파일 목록을 알려주지 않아 그 부분은 대조하지 못했어요 — 함수를 최신으로 배포하면 됩니다.`
    : null;
  return { requeued, note };
}

/** 대조 단계 — 실패해도 동기화를 멈추지 않는다(못 고친 대가는 「어긋남이 조금 더 남는다」뿐). */
async function reconcileBytesIfDue(client: JourneyClient, deep: boolean): Promise<void> {
  let lastAt: string | null = null;
  try {
    lastAt = localStorage.getItem(BYTES_RECONCILE_KEY);
  } catch {
    // localStorage 불가 — 주기를 못 재므로 **자동은 건너뛰고** 사용자가 부른 것만 돈다.
    // (매 동기화마다 목록을 부르는 쪽으로 기울면 요금이 조용히 샌다.)
    if (!deep) return;
  }
  if (!reconcileDue(lastAt, Date.now(), deep)) return;
  try {
    const { requeued, note } = await reconcileMissingBytes(client);
    const total = Object.values(requeued).reduce((a, b) => a + b, 0);
    if (total) {
      const detail = Object.entries(requeued).map(([d, n]) => `${d} ${n}건`).join(' · ');
      console.info(`바이트 대조: 서버에 없는 자료를 다시 올리기로 큐에 넣었어요(${detail}).`);
    }
    if (note) console.warn(`바이트 대조: ${note}`);
  } catch (e) {
    console.error(`바이트 대조 실패 — ${(e as Error).message}`);
    return; // 🔴 표식을 남기지 않는다. 못 쟀으면 **다음에 다시 재야** 한다(SKIP≠PASS).
  }
  try {
    localStorage.setItem(BYTES_RECONCILE_KEY, new Date().toISOString());
  } catch {
    /* 표식 저장 실패는 무해 — 다음 동기화에서 한 번 더 돌 뿐이고 이 작업은 멱등이다. */
  }
}

/** 소리 백필 1회 실행 표식. 되돌려야 하면 `.v2`로 올려 전 기기가 한 번 더 돌게 한다. */
const AUDIO_BACKFILL_KEY = 'bj.repair.audioSync.v1';
/** 사진 GPS 백필 1회 실행 표식(마이그레이션 0024). 같은 규율 — 형제와 같은 자리에 둔다(§7). */
const MEDIA_GPS_BACKFILL_KEY = 'bj.repair.mediaGps.v1';

export async function backfillAudioOnce(
  remote: AudioRemote,
  ledgerRemote: Pick<PurgeRemote, 'ledgerAll'>,
): Promise<void> {
  try {
    if (localStorage.getItem(AUDIO_BACKFILL_KEY)) return;
  } catch {
    return; // localStorage 불가 — 진단의 「서버에 없는 소리」가 대신 말한다.
  }
  const server = await remote.listAll();
  if (server.error) return; // 못 쟀으면 표식을 남기지 않는다(SKIP≠PASS).
  const ledger = await ledgerRemote.ledgerAll();
  if (ledger.error) return;
  const n = await backfillAudioOps(server.data, new Set(ledger.ids));
  if (n) console.info(`소리 동기화 백필: ${n}건을 큐에 넣었어요(로컬에만 있던 녹음).`);
  try {
    localStorage.setItem(AUDIO_BACKFILL_KEY, new Date().toISOString());
  } catch {
    /* 표식 저장 실패는 무해 — 다음 동기화에서 한 번 더 돌 뿐이고 이 작업은 멱등이다. */
  }
}

export async function backfillMediaGpsOnce(
  remote: MediaRemote,
  ledgerRemote: Pick<PurgeRemote, 'ledgerAll'>,
): Promise<void> {
  try {
    if (localStorage.getItem(MEDIA_GPS_BACKFILL_KEY)) return;
  } catch {
    return; // localStorage 불가 — 다음 사진 저장이 자연스럽게 op을 만든다.
  }
  const server = await remote.listAll();
  if (server.error) return;
  const ledger = await ledgerRemote.ledgerAll();
  if (ledger.error) return;
  const n = await backfillMediaGpsOps(server.data, new Set(ledger.ids));
  if (n) console.info(`사진 위치 백필: ${n}건을 큐에 넣었어요(좌표가 로컬에만 있던 사진).`);
  try {
    localStorage.setItem(MEDIA_GPS_BACKFILL_KEY, new Date().toISOString());
  } catch {
    /* 표식 저장 실패는 무해 — 멱등이다. */
  }
}

/**
 * **서버가 아직 살아 있는데 로컬은 지운 상태**면 삭제를 다시 대기열에 올린다.
 *
 * 왜 pull에 두나: pull은 이미 서버 상태를 받아왔으므로 **추가 비용 0으로 정확히** 판정할 수
 * 있다. "로컬 tombstone + 서버 활성" = 그 삭제가 서버에 도달하지 못했다는 **직접 증거**다.
 *
 * ⚠️ 설계 이력(2026-07-25): 처음에는 `requeueOrphanTombstones`를 **1회만** 실행했다("완료된
 * tombstone까지 매번 다시 밀지 않도록"). 그 대가로 **표식이 찍힌 뒤에 생긴 고아는 영영 잡히지
 * 않았고**, 사용자는 지운 사진이 R2에 남는 것을 계속 봤다. 로컬만 보면 "이미 서버에 갔는지"를
 * 알 수 없다는 게 뿌리였다 — 서버와 대조하면 그 모호함이 사라진다.
 */
async function requeueIfServerStillActive(
  entityType: SyncEntityType,
  local: { id: string; deletedAt: string | null } | undefined,
  server: { deletedAt: string | null },
  mode: PullMode,
): Promise<void> {
  // capability 불명 전환 모드는 서버뿐 아니라 **로컬 큐도 read-only**다(M-0095).
  // 서버 active를 봤다는 이유로 새 delete op을 만들면 "큐 보존" 계약이 거짓이 된다.
  if (mode === 'server-read-only') return;
  if (!local || local.deletedAt === null || server.deletedAt !== null) return;
  const d = db();
  const already = (await d.syncQueue.where('entityId').equals(local.id).toArray()).some(
    (q) => q.entityType === entityType,
  );
  if (already) return;
  await d.syncQueue.add({
    operationId: crypto.randomUUID(),
    entityType,
    entityId: local.id,
    operationType: 'delete',
    state: 'local_only',
    attempts: 0,
    createdAt: new Date().toISOString(),
  });
}


/** 시각 표기 1회 정리 표식(M-0034). 되돌려야 하면 `.v2`로 올려 전 기기가 한 번 더 돌게 한다. */
const STAMP_KEY = 'bj.repair.stampFormat.v1';

/**
 * 실패로 박힌 작업을 다시 시도 가능한 상태로 되돌린다(진단 화면의 [실패 재시도]).
 *
 * ⚠️ push는 `local_only`·`retryable_failed`만 처리하므로 `permanent_failed`는 **영원히 큐에
 * 남아 아무 일도 하지 않으면서**, 영구삭제 사전 조건까지 막는다(대기 작업으로 세어진다).
 * 사용자가 스스로 풀 수단이 없던 자리다. 데이터를 바꾸지 않고 상태만 되돌린다.
 */
/**
 * 영구삭제 전파 포트 — **행을 실제로 지우고, 지운 id만 원장에 남긴다**(ADR-0030).
 *
 * 왜 바뀌었나(사용자 결정 2026-07-26): *"의도를 가지고 삭제하는건데 서버에 왜 살려두나요?
 * … 2번 이상 클릭으로 삭제한거라면 영원히 복구가 안되도록 기록줄까지도 삭제시켜야."*
 *
 * ADR-0027이 행을 남긴 **유일한 이유는 좀비 방지**였다("사정 모르는 다른 기기가 다시 올린다").
 * 그런데 그건 "행을 남긴다"가 아니라 **"서버가 재삽입을 거부한다"**로 푸는 게 옳다 —
 * `journey.purged_ids` 원장 + BEFORE INSERT 트리거(마이그레이션 0012)가 그 일을 한다.
 * 그러면 자료를 살려둘 이유가 사라진다. 원장엔 **id·소유자·시각만** 남고 제목·메모·좌표·금액은
 * 서버에서 사라진다.
 *
 * 도메인별 함수를 네 벌 만들지 않는다 — 등록부(DOMAIN_PURGE)의 테이블 이름만 갈아끼운다
 * (CLAUDE.md §7 "규칙을 한 곳에만 구현한다").
 */
export interface PurgeRemote {
  /**
   * 원장에 id를 적는다(멱등 — 이미 있으면 무시). **자료를 지우기 전에** 적어야 한다:
   * 지운 뒤에 적으면 그 사이에 다른 기기가 자기 사본을 다시 올릴 수 있다.
   */
  ledgerAdd(ids: string[]): Promise<{ error?: string | undefined }>;
  /** read-back — 성공 응답이 아니라 **되읽어** 확인한다(데이터 안전 불변식). */
  ledgerHas(id: string): Promise<{ found: boolean; error?: string | undefined }>;
  /** 서버 원장 전체. 다른 기기의 영구삭제는 pull이 아니라 **여기서** 배운다(행이 없으므로). */
  ledgerAll(): Promise<{ ids: string[]; error?: string | undefined }>;
  /**
   * **백업 복원 전용** — 원장에서 id를 뺀다(0017의 `journey.unpurge_ids`).
   *
   * 왜 필요한가(2026-07-26 사용자 실기기): 백업을 복원했는데 서버 원장이 그대로라
   * BEFORE INSERT 트리거가 push를 거부했고, 이어서 원장 pull이 **로컬 행까지 지웠다.**
   * 사용자에겐 아무 오류도 안 보였다 — 복원이 조용히 무효화됐다.
   *
   * 로컬 표식만 걷어내고 서버는 그대로 둔 **한쪽만 구현한 규칙**이 원인이다(§7 비대칭).
   * 테이블 DELETE 권한은 여전히 없다 — 이 좁은 문으로만 지난다.
   */
  ledgerRemove(ids: string[]): Promise<{ removed: number; error?: string | undefined }>;
  /**
   * 그 여행에 딸린 **서버의 자식 id 전부**(`trip_id = X`).
   *
   * 왜 서버에 묻는가(실제 결함 M-0016, 2026-07-26 사용자 신고에서 발견): `purgeTripPermanently`는
   * 자식을 **로컬 Dexie에서만** 찾는다. tombstone된 사진은 그 기기에 로컬 행이 없을 수 있다 —
   * `pullMedia`가 "로컬에 없는 tombstone은 만들지 않는다"(비파괴 규율)로 건너뛰기 때문이다.
   * 그래서 여행 "R2 테스트"를 영구삭제했을 때 **사진 하나만 서버에 남았다.**
   * 로컬이 못 보는 자식은 **서버가 안다.**
   */
  familyIds(parent: PurgeParent, id: string): Promise<{ ids: string[]; error?: string | undefined }>;
  /**
   * 그 여행에 딸린 **바이트를 가진 모든 자식**의 서버 경로들. **행을 지우기 전에** 물어야
   * 한다 — 행이 사라지면 경로도 사라진다.
   *
   * 🔴 예전엔 `familyMediaPaths`(사진 전용)였다. 소리가 R2로 가면서 그 이름이 곧 결함이 됐다 —
   * 여행을 영구삭제하면 사진 파일만 지워지고 **소리 파일은 R2에 영영 남는다.** 그래서 등록부
   * (`DOMAIN_PURGE[d].hasRemoteBytes`)를 도는 형태로 바꿨다: 다음 형제가 자동으로 따라온다(§7).
   */
  familyBytePaths(parent: PurgeParent, id: string): Promise<{ paths: string[]; error?: string | undefined }>;
  /** 자식 하나의 서버 경로. 위와 같은 이유로 **지우기 전에** 묻는다. */
  bytePath(domain: PurgeDomain, id: string): Promise<{ path: string | null; error?: string | undefined }>;
  /** 행을 **하드 삭제**한다(§0의 "하드 삭제 없음"에 대한 유일한 예외 — ADR-0030). */
  hardDelete(domain: PurgeDomain, id: string): Promise<{ error?: string | undefined }>;
  /** 그 부모의 자식 행 전부를 하드 삭제한다(등록부를 돌므로 새 도메인이 자동으로 따라온다). */
  hardDeleteFamily(parent: PurgeParent, id: string): Promise<{ error?: string | undefined }>;
  /** read-back — 그 행이 아직 서버에 있는가(false여야 완료). */
  stillThere(domain: PurgeDomain, id: string): Promise<{ found: boolean; error?: string | undefined }>;
  /** read-back — 그 가족에 남은 행 수(0이어야 완료). */
  remainingInFamily(parent: PurgeParent, id: string): Promise<{ count: number; error?: string | undefined }>;
}

/** 원장 테이블 이름 — 문자열을 여러 곳에 손으로 적지 않는다. */
const LEDGER = 'purged_ids';

/**
 * 원장(`purged_ids`) 접근만 모은 조각. `purgeRemote`가 120줄 상한(`check-fn-size`)에 걸려
 * 쪼갰는데, 결과적으로 경계가 맞아떨어졌다 — **원장은 "무엇을 지웠나"의 기록**이고
 * 나머지(familyIds·mediaPath·hardDelete)는 **"무엇을 지울까"의 조회·실행**이다. 다른 관심사다.
 */
function ledgerOps(client: JourneyClient): Pick<PurgeRemote, 'ledgerAdd' | 'ledgerHas' | 'ledgerAll' | 'ledgerRemove'> {
  return {
    async ledgerAdd(ids) {
      if (!ids.length) return {};
      try {
        // ON CONFLICT DO NOTHING — 멱등. user_id는 서버 기본값(auth.uid())이 채운다.
        const r = await client
          .from(LEDGER)
          .upsert(ids.map((id) => ({ id })), { onConflict: 'id', ignoreDuplicates: true });
        return { error: r.error?.message };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    async ledgerHas(id) {
      try {
        const r = await client.from(LEDGER).select('id').eq('id', id).maybeSingle();
        return { found: r.data !== null, error: r.error?.message };
      } catch (e) {
        return { found: false, error: (e as Error).message };
      }
    },
    async ledgerRemove(ids) {
      if (!ids.length) return { removed: 0 };
      try {
        const r = await client.rpc('unpurge_ids', { p_ids: ids });
        if (r.error) return { removed: 0, error: r.error.message };
        return { removed: typeof r.data === 'number' ? r.data : 0 };
      } catch (e) {
        return { removed: 0, error: (e as Error).message };
      }
    },
    async ledgerAll() {
      try {
        const r = await client.from(LEDGER).select('id');
        if (r.error) return { ids: [], error: r.error.message };
        return { ids: ((r.data ?? []) as { id: string }[]).map((x) => x.id) };
      } catch (e) {
        return { ids: [], error: (e as Error).message };
      }
    },
  };
}

export function purgeRemote(client: JourneyClient): PurgeRemote {
  /**
   * 부모의 자식 도메인만 훑는다 — **그 부모의 키로 묶어 지울 수 있는 것만**(`cascadeParents`).
   *
   * 🔴 장소는 어느 부모의 자식도 아니다(C-1). `PURGE_DOMAINS.filter(d => d !== 'trip')`로 뽑던
   * 것이 장소까지 넣어 `trip_id` 없는 테이블에 질의했고, 여행 영구삭제가 서버에 영영 전파되지
   * 않았다. 이제 등록부의 `cascadeParents` 선언으로 뽑으므로 새 형제가 자기 사정을 밝히지
   * 않으면 컴파일이 안 된다.
   *
   * 🔴 그리고 **부모는 여행만이 아니다**(M-0107). 서버 FK는 순간에도 `ON DELETE CASCADE`가
   * 걸려 있는데 이 파일은 `tripId`라는 이름으로 여행만 상정하고 있었다 — 이름이 곧 사각이었다.
   */
  const childDomains = cascadeChildDomains;

  return {
    ...ledgerOps(client),
    async familyIds(parent, id) {
      try {
        const ids: string[] = [];
        const col = PARENT_KEY[parent].column;
        for (const d of childDomains(parent)) {
          const r = await client.from(DOMAIN_PURGE[d].remoteTable).select('id').eq(col, id);
          if (r.error) return { ids: [], error: `${DOMAIN_PURGE[d].remoteTable}: ${r.error.message}` };
          for (const x of (r.data ?? []) as { id: string }[]) ids.push(x.id);
        }
        return { ids };
      } catch (e) {
        return { ids: [], error: (e as Error).message };
      }
    },
    async familyBytePaths(parent, id) {
      try {
        const paths: string[] = [];
        // 바이트를 가졌고 **이 부모의 자식인** 도메인만(그 부모의 키로 질의하므로 — C-1).
        // 손으로 'media'라 적지 않는다.
        const col = PARENT_KEY[parent].column;
        for (const dm of childDomains(parent).filter((x) => DOMAIN_PURGE[x].hasRemoteBytes)) {
          const t = DOMAIN_PURGE[dm].remoteTable;
          const r = await client.from(t).select('storage_path').eq(col, id).not('storage_path', 'is', null);
          if (r.error) return { paths: [], error: `${t}: ${r.error.message}` };
          for (const x of (r.data ?? []) as { storage_path: string | null }[]) {
            if (x.storage_path) paths.push(x.storage_path);
          }
        }
        return { paths };
      } catch (e) {
        return { paths: [], error: (e as Error).message };
      }
    },
    async bytePath(domain, id) {
      if (!DOMAIN_PURGE[domain].hasRemoteBytes) return { path: null }; // 바이트가 없는 도메인
      try {
        const r = await client.from(DOMAIN_PURGE[domain].remoteTable).select('storage_path').eq('id', id).maybeSingle();
        const row = r.data as { storage_path: string | null } | null;
        return { path: row?.storage_path ?? null, error: r.error?.message };
      } catch (e) {
        return { path: null, error: (e as Error).message };
      }
    },
    async hardDelete(domain, id) {
      try {
        const r = await client.from(DOMAIN_PURGE[domain].remoteTable).delete().eq('id', id);
        return { error: r.error?.message };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    async hardDeleteFamily(parent, id) {
      try {
        const col = PARENT_KEY[parent].column;
        for (const d of childDomains(parent)) {
          const r = await client.from(DOMAIN_PURGE[d].remoteTable).delete().eq(col, id);
          if (r.error) return { error: `${DOMAIN_PURGE[d].remoteTable}: ${r.error.message}` };
        }
        return {};
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    async stillThere(domain, id) {
      try {
        const r = await client.from(DOMAIN_PURGE[domain].remoteTable).select('id').eq('id', id).maybeSingle();
        return { found: r.data !== null, error: r.error?.message };
      } catch (e) {
        return { found: false, error: (e as Error).message };
      }
    },
    async remainingInFamily(parent, id) {
      try {
        let count = 0;
        const col = PARENT_KEY[parent].column;
        for (const d of childDomains(parent)) {
          const r = await client
            .from(DOMAIN_PURGE[d].remoteTable)
            .select('id', { count: 'exact', head: true })
            .eq(col, id);
          if (r.error) return { count: -1, error: `${DOMAIN_PURGE[d].remoteTable}: ${r.error.message}` };
          count += r.count ?? 0;
        }
        return { count };
      } catch (e) {
        return { count: -1, error: (e as Error).message };
      }
    },
  };
}

/** 영구삭제 뒤 사용자에게 보여 줄 서버 read-back 영수증. 응답 성공이 아니라 원장과 행 부재를 모두 센다. */
export interface PurgeVerification {
  targets: number;
  ledgerConfirmed: number;
  rowsAbsent: number;
  fullyConfirmed: number;
  unverified: number;
}

/**
 * 방금 영구삭제한 대상이 서버에서도 끝났는지 다시 읽는다.
 *
 * `pushPurges`도 같은 read-back을 수행하지만 그 결과는 동기화 전체 결과에 섞인다. 이 함수는
 * 사용자가 고른 대상만 따로 영수증으로 집계한다. 각 대상은 서로 독립적이므로 병렬로 확인하고,
 * 부모 대상은 가족 잔여 행도 함께 본다. 조회 오류는 성공으로 반올림하지 않고 `unverified`에 남긴다.
 */
export async function verifyPurgeReceipt(
  remote: PurgeRemote,
  targets: readonly Pick<PurgeTarget, 'id' | 'domain' | 'underRoot'>[],
  onSettled?: (completed: number, total: number) => void,
): Promise<PurgeVerification> {
  const unique = [...new Map(targets.map((target) => [`${target.domain}:${target.id}`, target])).values()];
  let settled = 0;
  const checks = await Promise.all(unique.map(async (target) => {
    try {
      const parent = target.underRoot ? null : asPurgeParent(target.domain);
      const familyCheck: Promise<{ count: number; error?: string | undefined }> = parent
        ? remote.remainingInFamily(parent, target.id)
        : Promise.resolve({ count: 0 });
      const [ledger, row, family] = await Promise.all([
        remote.ledgerHas(target.id),
        remote.stillThere(target.domain, target.id),
        familyCheck,
      ]);
      const unknown = !!ledger.error || !!row.error || !!family.error;
      return {
        ledgerConfirmed: !ledger.error && ledger.found,
        rowAbsent: !row.error && !row.found && !family.error && family.count === 0,
        fullyConfirmed: !unknown && ledger.found && !row.found && family.count === 0,
        unknown,
      };
    } finally {
      settled += 1;
      onSettled?.(settled, unique.length);
    }
  }));
  return {
    targets: unique.length,
    ledgerConfirmed: checks.filter((check) => check.ledgerConfirmed).length,
    rowsAbsent: checks.filter((check) => check.rowAbsent).length,
    fullyConfirmed: checks.filter((check) => check.fullyConfirmed).length,
    unverified: checks.filter((check) => check.unknown).length,
  };
}

/** 사진 바이트를 지우는 최소 포트 — 영구삭제가 쓰는 유일한 파괴 경로. */
export interface BytesRemote {
  remove(path: string): Promise<{ error?: string | undefined }>;
}

/**
 * 영구삭제 작업을 서버로 밀어 **자료를 실제로 지운다**(ADR-0030).
 *
 * 기존 도메인 push 루프가 이걸 처리하면 안 된다 — 영구삭제는 로컬 행을 이미 지웠으므로
 * 그 루프들은 "로컬에 없는 고아 작업"으로 보고 **조용히 폐기**한다(그러면 전파가 영영 안 된다).
 * entityType을 `purge:*`로 두어 기존 루프(`if (op.entityType !== 'trip') continue`)가
 * 구조적으로 건너뛰게 했다 — 네 곳에 "purge는 빼라"를 손으로 적지 않는다.
 *
 * **순서가 곧 안전이다.** 되돌릴 수 없는 일을 하기 전에 필요한 것을 먼저 읽는다:
 *   ① 지우기 전에 묻는다(자식 id·사진 경로) — 행이 사라지면 함께 사라지는 정보다.
 *   ② 원장 먼저 적는다 — 지운 뒤에 적으면 그 틈에 다른 기기가 다시 올린다.
 *   ③ 행을 지운다(자식 → 부모).
 *   ④ 되읽어 확인한다 — 200 응답이 아니라 **없어졌는지**를 본다.
 *   ⑤ 사진 바이트를 지운다(최선노력 — 실패해도 남는 건 잉여 파일일 뿐 기억 손실이 아니다).
 */
export async function pushPurges(remote: PurgeRemote, bytes?: BytesRemote): Promise<{ pushed: number; failed: number }> {
  const d = db();
  const items = (await d.syncQueue.orderBy('createdAt').toArray()).filter(
    (q) => (q.state === 'local_only' || q.state === 'retryable_failed') && purgeDomainOf(q.entityType) !== null,
  );
  let pushed = 0;
  let failed = 0;

  for (const op of items) {
    const domain = purgeDomainOf(op.entityType);
    if (!domain) continue;

    // ① 지우기 **전에** 묻는다. 부모 여부는 **등록부가 답한다** — 예전엔 `domain === 'trip'`을
    //    손으로 적어 순간을 잎처럼 다뤘고, 그게 M-0107이었다(서버 FK는 순간도 부모로 안다).
    // 뿌리 op이 가족을 쓸어 가는 대상이면 여기서 또 쓸지 않는다(`purgeUnderRoot` — 요청 낭비).
    const parent = op.purgeUnderRoot ? null : asPurgeParent(domain);
    const paths: string[] = [];
    // 🔴 **행이 사라지기 전에 적어 둔 경로**를 먼저 넣는다. 부모 cascade가 이미 데려간 자식은
    //    서버에 행이 없어 물어볼 곳이 없다 — 그때 이 경로가 R2 고아를 막는 유일한 근거다.
    if (op.bytePath) paths.push(op.bytePath);
    const ledgerIds: string[] = [op.entityId];
    if (parent) {
      const fam = await remote.familyIds(parent, op.entityId);
      if (fam.error) {
        await markFail(op, undefined, `자식 목록 조회 실패: ${fam.error}`);
        failed++;
        continue;
      }
      ledgerIds.push(...fam.ids);
      const fp = await remote.familyBytePaths(parent, op.entityId);
      if (fp.error) {
        await markFail(op, undefined, `파일 경로 조회 실패: ${fp.error}`);
        failed++;
        continue;
      }
      paths.push(...fp.paths);
    } else if (DOMAIN_PURGE[domain].hasRemoteBytes) {
      // 사진이든 소리든 **바이트를 가진 도메인이면** 경로를 먼저 묻는다(도메인 이름을 적지 않는다).
      const mp = await remote.bytePath(domain, op.entityId);
      if (mp.error) {
        await markFail(op, undefined, `파일 경로 조회 실패: ${mp.error}`);
        failed++;
        continue;
      }
      if (mp.path) paths.push(mp.path);
    }

    // ② 원장 먼저. 여행이면 자식 id까지 함께 — 자식도 재삽입이 막혀야 한다.
    const led = await remote.ledgerAdd(ledgerIds);
    if (led.error) {
      await markFail(op, undefined, `영구삭제 원장 기록 실패: ${led.error}`);
      failed++;
      continue;
    }
    const back = await remote.ledgerHas(op.entityId);
    if (back.error || !back.found) {
      await markFail(op, undefined, back.error ?? '원장을 되읽었더니 기록이 없어요');
      failed++;
      continue;
    }

    // ③ 행을 지운다. 자식 먼저 — FK가 있어도 순서가 맞는다.
    if (parent) {
      const fd = await remote.hardDeleteFamily(parent, op.entityId);
      if (fd.error) {
        await markFail(op, undefined, `자식 행 삭제 실패: ${fd.error}`);
        failed++;
        continue;
      }
    }
    const hd = await remote.hardDelete(domain, op.entityId);
    if (hd.error) {
      await markFail(op, undefined, `서버 행 삭제 실패: ${hd.error}`);
      failed++;
      continue;
    }

    // ④ read-back. 서버에 애초에 행이 없었어도(한 번도 동기화 안 된 기록) 여기서 통과한다 —
    //    실패로 두면 그 작업이 영원히 큐에 남아 다음 영구삭제의 사전조건까지 막는다.
    const left = await remote.stillThere(domain, op.entityId);
    if (left.error || left.found) {
      await markFail(op, undefined, left.error ?? '지웠는데 되읽으니 행이 남아 있어요');
      failed++;
      continue;
    }
    if (parent) {
      const lf = await remote.remainingInFamily(parent, op.entityId);
      if (lf.error || lf.count > 0) {
        await markFail(op, undefined, lf.error ?? `지웠는데 자식 ${lf.count}건이 서버에 남아 있어요`);
        failed++;
        continue;
      }
    }

    // ⑤ **여기가 사진·소리·영상 바이트를 지우는 유일한 자리다**(정책 2026-07-26).
    //    휴지통에 있는 동안은 서버에 남겨 두었다가, 휴지통을 비울 때 지운다 —
    //    그래야 휴지통이 진짜 휴지통이고, 어느 기기에서 복원해도 사진이 돌아온다.
    if (bytes) {
      for (const p of new Set(paths)) {
        const rm = await bytes.remove(p);
        if (rm.error) console.error(`영구삭제: 저장소 파일 삭제 실패 ${p} — ${rm.error}`);
      }
    }

    await d.syncQueue.delete(op.operationId);
    pushed++;
  }
  return { pushed, failed };
}

export async function retryFailedOps(): Promise<number> {
  const d = db();
  const stuck = (await d.syncQueue.toArray()).filter((q) => q.state === 'permanent_failed');
  for (const q of stuck) await d.syncQueue.update(q.operationId, { state: 'local_only', attempts: 0 });
  return stuck.length;
}

/**
 * **이미 저장된 행의 시각 표기를 정규형으로 맞춘다**(M-0034, 2026-07-27).
 *
 * 왜 코드 수정만으로 부족한가: `isoInstant()`는 *앞으로* 들어올 값을 막을 뿐이고, 서버 표기
 * (`…48.34+00:00`)로 **이미 박힌 행은 그대로 남는다.** 사용자 기기에 사진 9건이 그 상태였고
 * 진단이 그걸 「시간 역전」으로 띄웠다. 방식을 바꾸는 커밋의 필수 질문 — *"옛 방식으로 만들어진
 * 것을 누가 데려오는가?"* — 의 답이 이 함수다(§9 4단계).
 *
 * 안전성: **같은 순간, 다른 표기**다. version·deletedAt 유무·LWW 결과가 바뀌지 않으므로
 * 사용자 편집이 아니고 **sync op를 만들지 않는다**(만들면 전 기기가 무의미한 push를 돈다).
 * blob은 건드리지 않는다 — `update()`로 시각 3칸만 다시 쓴다.
 */
async function normalizeTableStamps(table: Table<SyncMeta & { id: string }, string>): Promise<number> {
  // ⚠️ **읽기와 쓰기가 한 트랜잭션 안이어야 한다**(자기점검 2026-07-27). 처음엔 `each`로 다
  // 훑은 뒤 트랜잭션 **밖에서** `update`를 돌렸다. 그 사이에 복원·동기화가 같은 행을 고치면
  // 내 `update`가 **읽던 시점의 옛 값**으로 되돌린다(읽기-수정-쓰기의 고전적 창).
  //
  // 이건 M-0033과 **같은 부류**다 — 이 세션에서 그 사고를 직접 기록해 놓고 같은 형태를 또
  // 만들었다. 그리고 §1-B가 이미 말한다: *"이 함수가 `await`에서 멈춘 사이에 동기화가 돌면,
  // 지금 커밋된 상태는 어떻게 보이는가?"* — 읽기-수정-쓰기에는 언제나 이 질문이 걸린다.
  return table.db.transaction('rw', table, async () => {
    const patches: { id: string; patch: Partial<SyncMeta> }[] = [];
    // `each`는 커서라 blob을 한 행씩만 들고 있는다(사진 테이블을 통째로 메모리에 올리지 않는다).
    await table.each((r) => {
      const next = withCanonicalStamps(r);
      if (next.createdAt === r.createdAt && next.updatedAt === r.updatedAt && next.deletedAt === r.deletedAt) return;
      patches.push({ id: r.id, patch: { createdAt: next.createdAt, updatedAt: next.updatedAt, deletedAt: next.deletedAt } });
    });
    for (const p of patches) await table.update(p.id, p.patch);
    return patches.length;
  });
}

/** 로컬 테이블 전부 — 형제를 손으로 세지 않는다(§7). 고친 행 수를 돌려준다. */
export async function normalizeStamps(): Promise<number> {
  const d = db();
  const tables = [d.localTrips, d.localMoments, d.localMedia, d.localExpenses, d.localAudio, d.localVideos, d.localPlaces] as unknown as Table<SyncMeta & { id: string }, string>[];
  let fixed = 0;
  for (const t of tables) fixed += await normalizeTableStamps(t);
  return fixed;
}

async function normalizeStampsOnce(): Promise<void> {
  try {
    if (localStorage.getItem(STAMP_KEY)) return;
  } catch {
    return; // localStorage 불가 — 건너뛴다. 진단의 「시각 표기가 표준형이 아님」이 대신 말한다.
  }
  const n = await normalizeStamps();
  if (n) console.info(`시각 표기 정리: ${n}건을 표준 표기로 다시 적음(같은 순간, 다른 표기)`);
  try {
    localStorage.setItem(STAMP_KEY, new Date().toISOString());
  } catch {
    /* 표식 저장 실패는 무해 — 다음 동기화에서 한 번 더 돌 뿐이고 이 변환은 멱등이다. */
  }
}

/**
 * **복원이 되살린 id를 서버 원장에서 뺀다.** 다른 push·pull보다 **먼저** 돌아야 한다 —
 * 원장이 남아 있으면 ① BEFORE INSERT 트리거가 복원 push를 거부하고 ② 이어지는 원장 pull이
 * 로컬 행까지 지운다. 2026-07-26에 정확히 그 순서로 사용자의 복원이 무효화됐다.
 *
 * 실패하면 **op을 남긴다**(지우지 않는다). 남겨야 다음 동기화가 다시 시도하고, 그동안
 * `applyPurgedLedger`가 이 id들을 건너뛴다. 조용히 포기하면 복원이 또 사라진다.
 */
export async function pushUnpurges(remote: PurgeRemote): Promise<{ pushed: number; failed: number }> {
  const d = db();
  const ops = (await d.syncQueue.toArray()).filter((q) => q.operationType === 'unpurge');
  if (!ops.length) return { pushed: 0, failed: 0 };

  const ids = [...new Set(ops.map((o) => o.entityId))];
  const r = await remote.ledgerRemove(ids);
  if (r.error) {
    console.error(`복원: 영구삭제 원장 되돌리기 실패 — ${r.error}`);
    return { pushed: 0, failed: ops.length };
  }

  // read-back — 지웠다는 응답이 아니라 **원장을 다시 읽어** 확인한다(데이터 안전 불변식).
  const after = await remote.ledgerAll();
  if (after.error) {
    console.error(`복원: 원장 되읽기 실패 — ${after.error}`);
    return { pushed: 0, failed: ops.length };
  }
  const still = new Set(after.ids);
  const done = ops.filter((o) => !still.has(o.entityId));
  for (const o of done) await d.syncQueue.delete(o.operationId);
  await revivePushOps(done.map((o) => o.entityId));
  return { pushed: done.length, failed: ops.length - done.length };
}

/**
 * **원장에 막혀 죽은 전파 op을 되살린다.**
 *
 * 왜 필요한가: 트리거가 거부한 응답은 4xx라 `classifyError`가 **'permanent'**로 본다 →
 * op이 `permanent_failed`가 되고 push는 그 상태를 **영원히 건너뛴다.** 그래서 나중에 원장을
 * 되돌리는 데 성공해도 **그 행은 두 번 다시 올라가지 않는다** — 사용자에겐 여전히 아무 일도
 * 일어나지 않는 것처럼 보인다.
 *
 * 그 판정은 그 순간에는 옳았다. 틀린 것은 **판정을 영구로 굳힌 것**이다: 거부의 사유가
 * 방금 사라졌으므로 이건 재시도 가능한 실패가 된다. 사유가 사라진 것을 아는 곳이 여기뿐이라
 * 되살리는 일도 여기서 한다(§7 — 규칙을 아는 한 곳이 책임진다).
 *
 * 되살리기는 **이번 동기화 안에서** 효과가 있다 — `pushUnpurges`가 다른 push보다 먼저 돌기
 * 때문이다. 즉 원장을 푼 그 자리에서 복원한 행이 바로 올라간다.
 */
async function revivePushOps(ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const d = db();
  const target = new Set(ids);
  const dead = (await d.syncQueue.toArray()).filter(
    (q) => target.has(q.entityId) && (q.state === 'permanent_failed' || q.state === 'retryable_failed'),
  );
  for (const q of dead) await d.syncQueue.update(q.operationId, { state: 'local_only', attempts: 0 });
  if (dead.length) console.info(`복원: 원장에 막혀 있던 전파 작업 ${dead.length}건을 다시 큐에 넣었어요.`);
  return dead.length;
}

/**
 * 동기화 실행 옵션.
 *
 * `deep` — **사용자가 직접 부른 동기화**인가. 자동(주기·화면 복귀·저장 직후)과 구별한다.
 * 이름이 아니라 **호출자의 의도**로 판정한다: 이유 문자열을 훑어 「수동」인지 맞히는 방식은
 * 새 진입점이 생기면 조용히 빠진다(M-0040 — 이름으로 판정하면 새 형제를 정확히 놓친다).
 */
export interface SyncOptions {
  deep?: boolean;
  /** 진행률은 관찰용이다. 알림 실패가 실제 동기화를 중단시키면 안 된다. */
  onProgress?: (progress: SyncProgress) => void;
}

function reportProgress(opts: SyncOptions, progress: SyncProgress): void {
  try {
    opts.onProgress?.(progress);
  } catch {
    // UI 구독자가 실패해도 동기화의 read-back/정산을 방해하지 않는다.
  }
}

interface EntityRemotes {
  trips: TripsRemote;
  places: PlacesRemote;
  moments: MomentsRemote;
  media: MediaRemote;
  expenses: ExpensesRemote;
  audio: AudioRemote;
  video: VideoRemote;
}

/** 부모→자식 순서를 한 곳에 둔다. pull이 만든 삭제 op의 안전한 후행 전송도 같은 문을 지난다. */
async function pushEntityOps(
  remotes: EntityRemotes,
  userId: string,
  onDomainSettled?: (domain: SyncDomain) => void,
): Promise<{ pushed: number; failed: number }> {
  const result = await runSyncPlan(PUSH_SYNC_PLAN, {
    trip: () => pushPending(remotes.trips, userId),
    place: () => pushPendingPlaces(remotes.places, userId),
    moment: () => pushPendingMoments(remotes.moments, userId),
    media: () => pushPendingMedia(remotes.media, userId),
    expense: () => pushPendingExpenses(remotes.expenses, userId),
    audio: () => pushPendingAudio(remotes.audio, userId),
    video: () => pushPendingVideos(remotes.video, userId),
  }, onDomainSettled ? { onDomainSettled } : {});
  return {
    pushed: SYNC_DOMAINS.reduce((sum, domain) => sum + result[domain].pushed, 0),
    failed: SYNC_DOMAINS.reduce((sum, domain) => sum + result[domain].failed, 0),
  };
}

async function pullEntityRows(
  remotes: EntityRemotes,
  mode: PullMode,
  onDomainSettled?: (domain: SyncDomain) => void,
) {
  return runSyncPlan(PULL_SYNC_PLAN, {
    trip: () => pullTrips(remotes.trips, mode),
    place: () => pullPlaces(remotes.places, mode),
    moment: () => pullMoments(remotes.moments, mode),
    media: () => pullMedia(remotes.media, mode),
    expense: () => pullExpenses(remotes.expenses, mode),
    audio: () => pullAudio(remotes.audio, mode),
    video: () => pullVideos(remotes.video, mode),
  }, onDomainSettled ? { onDomainSettled } : {});
}

function summarizePulls(result: Awaited<ReturnType<typeof pullEntityRows>>) {
  return {
    pulled: SYNC_DOMAINS.reduce((sum, domain) => sum + result[domain].pulled, 0),
    skippedEmptyCloud: SYNC_DOMAINS.some((domain) => result[domain].skippedEmptyCloud),
  };
}

/**
 * canonical capability를 증명할 수 없는 짧은 배포 전환 구간의 안전 경로.
 * 서버에는 SELECT/R2 GET만 수행한다. 로컬 purge·unpurge·편집 큐는 그대로 두고, 서버 고아
 * tombstone 같은 정리 쓰기도 하지 않는다. capability가 돌아오면 다음 동기화가 큐를 처리한다.
 */
async function runServerReadOnlySync(client: JourneyClient, opts: SyncOptions): Promise<SyncResult> {
  let completed = 0;
  const total = SYNC_DOMAINS.length;
  reportProgress(opts, { phase: 'pulling', completed, total, phaseCompleted: completed, phaseTotal: total });
  const pulls = summarizePulls(
    await pullEntityRows(
      {
        trips: tripsRemote(client),
        places: placesRemote(client),
        moments: momentsRemote(client),
        media: mediaRemote(client),
        expenses: expensesRemote(client),
        audio: audioRemote(client),
        video: videoRemote(client),
      },
      'server-read-only',
      () => {
        completed += 1;
        reportProgress(opts, { phase: 'pulling', completed, total, phaseCompleted: completed, phaseTotal: total });
      },
    ),
  );
  return {
    pushed: 0,
    failed: 0,
    pulled: pulls.pulled,
    skippedEmptyCloud: pulls.skippedEmptyCloud,
    canonicalApplied: false,
  };
}

export async function runSync(
  client: JourneyClient,
  userId: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  // Push six domains + pull six domains + final read-back/follow-up settlement.
  // Do not show 100% before that last safety boundary has finished.
  const totalStages = SYNC_DOMAINS.length * 2 + 1;
  reportProgress(opts, { phase: 'preparing', completed: 0, total: totalStages, phaseCompleted: 0, phaseTotal: 0 });
  // 🔴 어떤 로컬 repair/push보다 먼저 canonical 세대를 본다. 바뀌었으면 클라우드 정확집합만
  // 반영하고 여기서 끝낸다 — 병합 결과를 다시 올리면 사용자가 고른 최종본이 즉시 오염된다.
  const canonical = await ensureCanonicalBeforeSync(
    canonicalRemote(client),
    userId,
    (progress) => reportProgress(opts, progress),
  );
  if (canonical.mode === 'applied') {
    return {
      pushed: 0,
      failed: 0,
      pulled: canonical.pulled,
      skippedEmptyCloud: false,
      canonicalApplied: true,
    };
  }
  if (canonical.mode === 'legacy') return runServerReadOnlySync(client, opts);
  const remote = tripsRemote(client);
  const mRemote = momentsRemote(client);
  const eRemote = expensesRemote(client);
  const dRemote = mediaRemote(client);
  const aRemote = audioRemote(client);
  const vRemote = videoRemote(client);
  const plRemote = placesRemote(client);
  const pRemote0 = purgeRemote(client);
  const entityRemotes: EntityRemotes = {
    trips: remote,
    places: plRemote,
    moments: mRemote,
    media: dRemote,
    expenses: eRemote,
    audio: aRemote,
    video: vRemote,
  };
  // 옛 cascade 복구는 로컬 tombstone만 보고 재큐잉하지 않는다(M-0095). 각 pull이 이미
  // 서버 active를 직접 본 뒤에만 `requeueIfServerStillActive`로 삭제 op을 만든다.
  // 표기 정리도 **병합보다 먼저**다(M-0034). 아래 pull이 `mergeDecision`으로 승부를 내는데,
  // 로컬에 옛 표기가 남아 있으면 같은 순간을 두 표기로 재게 된다.
  await normalizeStampsOnce();
  // 소리는 v1.20 이전에 만들어진 것에 큐 op이 **아예 없다** — 코드만 고치면 그 행들은 영원히
  // 안 올라간다. push보다 먼저 돌아 이번 동기화에서 바로 처리되게 한다.
  await backfillAudioOnce(aRemote, pRemote0);
  // 사진 GPS도 같은 형태의 빚이다(마이그레이션 0024) — 컬럼은 생겼는데 **이미 있는 사진의
  // 좌표는 아무도 데려오지 않는다.** 형제와 같은 자리에서 같은 규율로 돈다(§7).
  await backfillMediaGpsOnce(dRemote, pRemote0);
  // 바이트 대조도 **push보다 먼저** — 다시 올릴 것을 찾으면 이번 동기화에서 바로 올라간다.
  // 자동은 하루 한 번, 사용자가 직접 부른 동기화(`deep`)는 항상(사람이 의심할 때 누르는
  // 버튼이 곧 확실한 경로여야 한다 — §12).
  await reconcileBytesIfDue(client, opts.deep === true);
  // **복원 되돌리기가 가장 먼저다.** 원장이 남아 있으면 아래 push가 트리거에 막힌다.
  const pu = await pushUnpurges(pRemote0);
  // 🔴 **장소는 순간보다 먼저다.** 0023의 `moments.place_id`가 복합 FK로 `journey.places`를
  // 참조하므로, 순간이 먼저 가면 아직 서버에 없는 장소를 가리켜 거부당한다(H-02와 같은 규율 —
  // 다만 여기서는 **장소가 부모 쪽**이다). 장소 자신은 부모가 없어 여행보다 앞에 둬도 되지만,
  // 「부모 먼저」 목록을 읽는 사람이 순서를 한 줄로 이해하도록 여행 다음에 놓는다.
  // 소리는 **순간 뒤**여야 한다 — 복합 FK `(moment_id,user_id)`가 서버의 부모를 요구한다.
  let pushedDomains = 0;
  reportProgress(opts, { phase: 'pushing', completed: pushedDomains, total: totalStages, phaseCompleted: pushedDomains, phaseTotal: SYNC_DOMAINS.length });
  const entities = await pushEntityOps(entityRemotes, userId, () => {
    pushedDomains += 1;
    reportProgress(opts, { phase: 'pushing', completed: pushedDomains, total: totalStages, phaseCompleted: pushedDomains, phaseTotal: SYNC_DOMAINS.length });
  });
  // 영구삭제 전파는 **pull보다 먼저** — 이번 동기화에서 다른 기기가 바로 알 수 있게.
  const pRemote = pRemote0;
  const pp = await pushPurges(pRemote, dRemote);

  // 다른 기기의 영구삭제를 배운다(ADR-0030). 행이 서버에서 사라졌으므로 pull은 그 사실을
  // 볼 수 없다 — **원장만이** 알려준다. pull보다 먼저 적용해 이 기기의 사본을 먼저 치운다.
  //
  // 원장 조회 실패는 동기화를 멈추지 않는다: 못 배운 대가는 "이 기기에 사본이 잠시 더 남는다"
  // 뿐이고, 서버 행은 이미 없으므로 되살아나지 않는다. 다만 조용히 넘기지 않고 남긴다.
  const ledger = await pRemote.ledgerAll();
  if (ledger.error) console.error(`영구삭제 원장 조회 실패 — ${ledger.error}`);
  else await applyPurgedLedger(ledger.ids);

  // 🔴 **부모가 영구삭제된 자식을 데려간다**(M-0107). 원장은 id만 담으므로 원장 적용은 그 id의
  // 행만 지운다 — 그런데 서버 FK는 자식까지 지웠다. 남은 자식은 되살릴 곳도 없고, 그 delete op은
  // FK 위반으로 영원히 막힌다. 원장을 적용한 **직후**에 훑어야 방금 배운 영구삭제도 함께 잡힌다.
  // 새로 만든 전파 op은 이번 동기화 안에서 내보낸다 — 다음 번을 기다리면 R2 고아가 하루 더 산다.
  const swept = await sweepPurgedOrphans();
  const sweepPush = swept ? await pushPurges(pRemote, dRemote) : { pushed: 0, failed: 0 };

  reportProgress(opts, { phase: 'finalizing', completed: SYNC_DOMAINS.length, total: totalStages, phaseCompleted: 0, phaseTotal: 0 });
  let pulledDomains = 0;
  reportProgress(opts, { phase: 'pulling', completed: SYNC_DOMAINS.length, total: totalStages, phaseCompleted: pulledDomains, phaseTotal: SYNC_DOMAINS.length });
  const pulls = summarizePulls(await pullEntityRows(entityRemotes, 'merge', () => {
    pulledDomains += 1;
    reportProgress(opts, { phase: 'pulling', completed: SYNC_DOMAINS.length + pulledDomains, total: totalStages, phaseCompleted: pulledDomains, phaseTotal: SYNC_DOMAINS.length });
  }));
  // 옛 정책의 로컬 원본은 서버 표시본을 정확히 되읽은 뒤에만 정리한다. 실패한 사진은 다음
  // 동기화에서 다시 확인하며, 사용자 기록이나 큐에는 손대지 않는다.
  await pruneVerifiedMediaOriginals(dRemote);
  // pull이 "서버 active + 로컬 tombstone"을 직접 확인해 만든 delete op은 같은 버튼에서
  // 끝낸다(M-0095). 첫 실행이 큐만 만들고 "동기화했어요"라고 말한 뒤 두 번째 클릭을 요구하면
  // 해소 동작이 실제 판정을 해소하지 못한다. 새 delete가 있을 때만 한 번, 같은 부모→자식 문으로.
  reportProgress(opts, { phase: 'finalizing', completed: totalStages - 1, total: totalStages, phaseCompleted: 0, phaseTotal: 0 });
  const followupNeeded = (await db().syncQueue.toArray()).some(
    (op) => op.state === 'local_only' && op.operationType === 'delete',
  );
  const followup = followupNeeded
    ? await pushEntityOps(entityRemotes, userId)
    : { pushed: 0, failed: 0 };
  reportProgress(opts, { phase: 'finalizing', completed: totalStages, total: totalStages, phaseCompleted: 0, phaseTotal: 0 });
  return {
    pushed: pu.pushed + entities.pushed + pp.pushed + sweepPush.pushed + followup.pushed,
    failed: pu.failed + entities.failed + pp.failed + sweepPush.failed + followup.failed,
    pulled: pulls.pulled,
    skippedEmptyCloud: pulls.skippedEmptyCloud,
    canonicalApplied: false,
  };
}
