// services/backupRoundTrip.ts — 실제 파일 경계를 지나는 백업 복원 왕복 시험.
//
// 유닛은 직렬화한 값을 메모리에서 곧바로 되읽는다. 이 시험은 사용자가 내려받은 파일을
// 다시 고르는 경계까지 지난 뒤, **실제 importMergeRows**로 한 건을 복원하고 되읽는다.
//
// 🔴 안전 경계(왕복 시험과 같은 규율)
//  ① 이 모듈이 만든 무작위 trip id 하나만 쓴다. 사용자 기록은 시험 대상으로 쓰지 않는다.
//  ② 복원·큐 생성·read-back은 바깥 Dexie 트랜잭션 안에서 실행하고, 확인 직후 의도적으로
//     abort한다. 따라서 성공해도 엔티티·syncQueue·purgedIds가 한 건도 커밋되지 않는다.
//  ③ abort 뒤 권위 저장소를 다시 읽는다. 남았다면 이 id만 정리하고 `leftover`로 말한다.
//  ④ ZIP 안에 진단용 영상 본체+포스터를 실제 파일로 넣는다. 내려받기→파일 선택→ZIP 파싱→
//     Dexie 병합→두 Blob의 정확 바이트 되읽기까지 지난 뒤 전체를 abort한다.

import Dexie from 'dexie';
import { db, type JourneyDB, type LocalMoment, type LocalTrip, type LocalVideo } from '../offline/db';
import { APP_VERSION } from '../app/changelog';
import { localDate } from '../domain/time';
import {
  backupImportLimitBytes,
  readBackupFileWithinLimit,
  backupFilename,
  BACKUP_VERSION,
  deserializeZip,
  importMergeRows,
  serializeZip,
  type BackupStats,
  type CollectedRows,
} from './backup';
import { androidRuntimeMaxMemory, rendererHeapSizeLimit, shellState } from './capacitorShell';

export const BACKUP_ROUND_TRIP_TITLE_PREFIX = '🧪 복원 왕복 시험 · 자동 롤백';
export const BACKUP_ROUND_TRIP_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const PENDING_KEY = 'bugeon:backupRoundTripPending';
const LAST_RUN_KEY = 'bugeon:lastBackupRoundTrip';

interface PendingBackupRoundTrip {
  fixtureId: string;
  momentId: string;
  videoId: string;
  title: string;
  digest: string;
  videoDigest: string;
  posterDigest: string;
  filename: string;
  createdAt: string;
  appVersion: string;
  backupVersion: number;
}

export interface BackupRoundTripRun {
  at: string;
  state: 'pass' | 'fail';
  filename: string;
  error: string | null;
  leftover: string | null;
  fixtureId: string;
  digest: string;
  appVersion: string;
  backupVersion: number;
}

export interface BackupRoundTripFile {
  blob: Blob;
  filename: string;
  stats: BackupStats;
}

let volatilePending: PendingBackupRoundTrip | null = null;
let volatileLastRun: BackupRoundTripRun | null = null;

function readJson<T>(key: string): T | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 캐시 성격이다. 저장 불가여도 같은 페이지에서는 volatile 사본으로 시험을 이어 간다.
  }
}

function pendingRun(): PendingBackupRoundTrip | null {
  const value = volatilePending ?? readJson<PendingBackupRoundTrip>(PENDING_KEY);
  if (!value || typeof value.fixtureId !== 'string' || typeof value.momentId !== 'string' || typeof value.videoId !== 'string' ||
      typeof value.digest !== 'string' || typeof value.videoDigest !== 'string' || typeof value.posterDigest !== 'string') return null;
  if (value.appVersion !== APP_VERSION || value.backupVersion !== BACKUP_VERSION) return null;
  return value;
}

export function lastBackupRoundTrip(): BackupRoundTripRun | null {
  const value = volatileLastRun ?? readJson<BackupRoundTripRun>(LAST_RUN_KEY);
  const pending = pendingRun();
  if (!value || !pending || (value.state !== 'pass' && value.state !== 'fail') || typeof value.at !== 'string') return null;
  // 새 시험 파일을 만들었으면 옛 초록은 더 이상 그 파일의 증거가 아니다.
  if (value.fixtureId !== pending.fixtureId || value.digest !== pending.digest) return null;
  if (value.appVersion !== APP_VERSION || value.backupVersion !== BACKUP_VERSION) return null;
  const age = Date.now() - Date.parse(value.at);
  if (!Number.isFinite(age) || age < 0 || age > BACKUP_ROUND_TRIP_MAX_AGE_MS) return null;
  return value;
}

function saveLastRun(run: BackupRoundTripRun): void {
  volatileLastRun = run;
  writeJson(LAST_RUN_KEY, run);
}

function restoreTables(d: JourneyDB) {
  return [d.localTrips, d.localMoments, d.localMedia, d.localExpenses, d.localAudio, d.localVideos, d.localPlaces, d.syncQueue, d.purgedIds] as const;
}

function fixtureTrip(now: Date): LocalTrip {
  const at = now.toISOString();
  const day = localDate(at);
  const id = crypto.randomUUID();
  return {
    id,
    title: `${BACKUP_ROUND_TRIP_TITLE_PREFIX} ${at.slice(0, 19).replace('T', ' ')}`,
    startDate: day,
    endDate: day,
    status: 'archived',
    createdAt: at,
    updatedAt: at,
    version: 1,
    deletedAt: null,
    timeZone: 'Asia/Tashkent',
    updatedByDevice: 'backup-round-trip-diagnostic',
    baseVersion: 0,
    baseCanonicalVersion: 'backup-round-trip-canonical-v1',
    clientOperationId: crypto.randomUUID(),
  };
}

function statsOf(rows: CollectedRows): BackupStats {
  return {
    trips: rows.trips.length,
    moments: rows.moments.length,
    media: rows.media.length,
    expenses: rows.expenses.length,
    audio: rows.audio.length,
    videos: rows.videos?.length ?? 0,
    places: rows.places.length,
    missingFiles: 0,
  };
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * production ZIP 형식과 같은 **진단 전용 ZIP**을 만든다. 고유 시험 trip·moment·video 한 건만
 * 담으므로 사용자의 사진·소리·영상·위치·메모가 시험 파일로 한 번 더 복제되지 않는다.
 */
export async function createBackupRoundTripFile(): Promise<BackupRoundTripFile> {
  const now = new Date();
  const fixture = fixtureTrip(now);
  const rows = fixtureRows(fixture, now);
  const blob = await serializeZip(rows, true);
  const bytes = await blob.arrayBuffer();
  const video = rows.videos![0]!;
  const filename = backupFilename(now, 'zip', { suffix: '왕복검사' });
  const pending: PendingBackupRoundTrip = {
    fixtureId: fixture.id,
    momentId: rows.moments[0]!.id,
    videoId: video.id,
    title: fixture.title,
    digest: await sha256Hex(bytes),
    videoDigest: await sha256Hex(await video.blob.arrayBuffer()),
    posterDigest: await sha256Hex(await video.posterBlob.arrayBuffer()),
    filename,
    createdAt: now.toISOString(),
    appVersion: APP_VERSION,
    backupVersion: BACKUP_VERSION,
  };
  volatilePending = pending;
  writeJson(PENDING_KEY, pending);
  // 새 파일은 새 시험이다. 이전 파일의 통과를 현재 파일의 초록으로 재사용하지 않는다.
  volatileLastRun = null;
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(LAST_RUN_KEY);
  } catch {
    /* 캐시 삭제 실패는 시험 파일 생성 자체를 막지 않는다. pending 대조가 옛 결과를 무효화한다. */
  }
  return { blob, filename, stats: statsOf(rows) };
}

class VerifiedRollback extends Error {
  constructor() {
    super('backup-round-trip-verified-rollback');
    this.name = 'VerifiedRollback';
  }
}

function fixtureRows(fixture: LocalTrip, now: Date): CollectedRows {
  const at = now.toISOString();
  const moment: LocalMoment = {
    id: crypto.randomUUID(), tripId: fixture.id, occurredAt: at,
    title: '백업 영상 왕복 검사', note: '', emotion: '', placeName: '',
    createdAt: at, updatedAt: at, version: 1, deletedAt: null,
    updatedByDevice: 'backup-round-trip-diagnostic', clientOperationId: crypto.randomUUID(),
  };
  const videoBytes = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x01, 0x23, 0x45, 0x67]);
  const posterBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x08, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x89, 0xab, 0xcd, 0xef]);
  const video: LocalVideo = {
    id: crypto.randomUUID(), momentId: moment.id, tripId: fixture.id,
    blob: new Blob([videoBytes], { type: 'video/mp4' }),
    posterBlob: new Blob([posterBytes], { type: 'image/webp' }),
    mime: 'video/mp4', durationSec: 1, width: 16, height: 16, takenAt: at,
    bytesOriginal: videoBytes.byteLength, bytesVideo: videoBytes.byteLength,
    createdAt: at, updatedAt: at, version: 1, deletedAt: null,
    updatedByDevice: 'backup-round-trip-diagnostic', clientOperationId: crypto.randomUUID(),
  };
  return { trips: [fixture], moments: [moment], media: [], expenses: [], audio: [], videos: [video], places: [] };
}

function sameRecord(actual: object, expected: object, ignored = new Set<string>()): boolean {
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  for (const key of keys) {
    if (ignored.has(key)) continue;
    if (!Object.is((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key])) return false;
  }
  return true;
}

async function artifactIds(pending: PendingBackupRoundTrip): Promise<string[]> {
  const d = db();
  const ids = [pending.fixtureId, pending.momentId, pending.videoId];
  const [trip, moment, video, queues, purged] = await Promise.all([
    d.localTrips.get(pending.fixtureId),
    d.localMoments.get(pending.momentId),
    d.localVideos.get(pending.videoId),
    Promise.all(ids.map((id) => d.syncQueue.where('entityId').equals(id).toArray())),
    Promise.all(ids.map((id) => d.purgedIds.get(id))),
  ]);
  return [
    ...(trip ? [`trip:${pending.fixtureId}`] : []),
    ...(moment ? [`moment:${pending.momentId}`] : []),
    ...(video ? [`video:${pending.videoId}`] : []),
    ...queues.flat().map((q) => `queue:${q.operationId}`),
    ...purged.flatMap((row, index) => row ? [`purged:${ids[index]}`] : []),
  ];
}

/** 실패 경로에서도 **이 시험의 정확한 세 id만** 치운다. 접두사 검색으로 넓게 지우지 않는다. */
async function cleanupExactFixture(pending: PendingBackupRoundTrip): Promise<string[]> {
  const d = db();
  const ids = [pending.fixtureId, pending.momentId, pending.videoId];
  await d.transaction('rw', [d.localTrips, d.localMoments, d.localVideos, d.syncQueue, d.purgedIds], async () => {
    const trip = await d.localTrips.get(pending.fixtureId);
    if (trip?.title.startsWith(BACKUP_ROUND_TRIP_TITLE_PREFIX)) {
      await d.localVideos.delete(pending.videoId);
      await d.localMoments.delete(pending.momentId);
      await d.localTrips.delete(pending.fixtureId);
      for (const id of ids) {
        const mine = await d.syncQueue.where('entityId').equals(id).primaryKeys();
        if (mine.length) await d.syncQueue.bulkDelete(mine);
        await d.purgedIds.delete(id);
      }
    }
  });
  return artifactIds(pending);
}

/**
 * 사용자가 고른 **그 파일**의 해시를 확인하고, 실제 복원 경로를 돈 뒤 전체를 abort한다.
 * 성공 조건은 import 응답이 아니라 트랜잭션 안 read-back + abort 뒤 잔재 0건이다.
 */
export async function runBackupFileRoundTrip(file: File): Promise<BackupRoundTripRun> {
  const pending = pendingRun();
  if (!pending) throw new Error('먼저 [왕복 시험 파일 만들기]로 시험 파일을 받아 주세요.');
  const at = new Date().toISOString();
  let failure: Error | null = null;
  let importStarted = false;

  try {
    const androidMaxMemory = await androidRuntimeMaxMemory();
    const buf = await readBackupFileWithinLimit(
      file,
      backupImportLimitBytes(shellState() !== 'browser', rendererHeapSizeLimit(), androidMaxMemory),
    );
    const digest = await sha256Hex(buf);
    if (digest !== pending.digest) throw new Error('방금 만든 왕복 시험 파일과 바이트가 다릅니다. 올바른 파일을 다시 골라 주세요.');

    const rows = deserializeZip(buf);
    const fixture = rows.trips.find((t) => t.id === pending.fixtureId);
    const moment = rows.moments.find((m) => m.id === pending.momentId);
    const video = (rows.videos ?? []).find((v) => v.id === pending.videoId);
    if (!fixture || fixture.title !== pending.title || !fixture.title.startsWith(BACKUP_ROUND_TRIP_TITLE_PREFIX)) {
      throw new Error('시험 표식이 없거나 달라 복원 왕복 파일로 확인할 수 없습니다.');
    }
    if (!moment || moment.tripId !== fixture.id || !video || video.tripId !== fixture.id || video.momentId !== moment.id) {
      throw new Error('시험 영상 또는 부모 기록이 없거나 연결이 달라 왕복 파일로 확인할 수 없습니다.');
    }
    if (await sha256Hex(await video.blob.arrayBuffer()) !== pending.videoDigest ||
        await sha256Hex(await video.posterBlob.arrayBuffer()) !== pending.posterDigest) {
      throw new Error('시험 영상 본체 또는 포스터 바이트가 원래 파일과 다릅니다.');
    }
    if ((await artifactIds(pending)).length) throw new Error('시험을 시작하기 전부터 같은 id의 잔재가 있습니다. 먼저 다시 확인해 주세요.');

    const d = db();
    try {
      importStarted = true;
      await d.transaction('rw', restoreTables(d), async () => {
        const result = await importMergeRows(rows);
        if (result.skippedEmptyGuard || result.trips !== 1 || result.moments !== 1 || result.videos !== 1) {
          throw new Error('파일은 읽었지만 시험 여행·순간·영상 한 묶음을 모두 복원하지 못했습니다.');
        }
        const [restored, restoredMoment, restoredVideo] = await Promise.all([
          d.localTrips.get(fixture.id), d.localMoments.get(moment.id), d.localVideos.get(video.id),
        ]);
        if (!restored || !restoredMoment || !restoredVideo ||
            !sameRecord(restored, fixture) || !sameRecord(restoredMoment, moment) ||
            !sameRecord(restoredVideo, video, new Set(['blob', 'posterBlob', 'sourceBlob']))) {
          throw new Error('복원한 기록을 되읽었더니 원래 파일과 값이 다릅니다.');
        }
        // Blob.arrayBuffer/WebCrypto는 Dexie가 추적하지 않는 비-IDB promise다. `waitFor` 없이 await하면
        // 트랜잭션이 먼저 커밋되어 "자동 롤백"이 거짓이 된다. 실제로 영상 검사를 처음 붙였을 때
        // 여행·순간·영상+큐 9건이 남았고 이 좁은 검사가 RED로 잡았다.
        const [restoredVideoDigest, restoredPosterDigest] = await Dexie.waitFor(Promise.all([
          restoredVideo.blob.arrayBuffer().then(sha256Hex),
          restoredVideo.posterBlob.arrayBuffer().then(sha256Hex),
        ]));
        if (restoredVideoDigest !== pending.videoDigest || restoredPosterDigest !== pending.posterDigest) {
          throw new Error('복원한 영상 본체 또는 포스터를 되읽었더니 바이트가 달라졌습니다.');
        }
        const expectedTypes = new Map([
          [fixture.id, 'trip'], [moment.id, 'moment'], [video.id, 'video'],
        ]);
        for (const [id, entityType] of expectedTypes) {
          const queued = await d.syncQueue.where('entityId').equals(id).toArray();
          const entityOps = queued.filter((op) => op.operationType === 'update' && op.entityType === entityType);
          const unpurgeOps = queued.filter((op) => op.operationType === 'unpurge' && op.entityType === 'unpurge:ledger');
          if (queued.length !== 2 || entityOps.length !== 1 || unpurgeOps.length !== 1 ||
              queued.some((op) => op.state !== 'local_only' || op.attempts !== 0)) {
            throw new Error('복원 기록의 update와 서버 원장 unpurge 의사가 정확히 같은 커밋에 남지 않았습니다.');
          }
        }
        throw new VerifiedRollback();
      });
      throw new Error('검증 트랜잭션이 롤백되지 않았습니다.');
    } catch (error) {
      if (!(error instanceof VerifiedRollback)) throw error;
    }

    const leftover = await artifactIds(pending);
    if (leftover.length) throw new Error(`시험 뒤 잔재 ${leftover.length}건이 남았습니다.`);
  } catch (error) {
    failure = error as Error;
  }

  let leftover: string[] = [];
  try {
    // preflight·해시·파싱 실패는 DB를 쓰지 않았다. 그때 보이는 같은 id의 기록·큐·원장은
    // **기존 상태**이므로 절대 지우지 않는다. 실제 import를 시작한 판만 자기 잔재를 치운다.
    leftover = importStarted ? await cleanupExactFixture(pending) : await artifactIds(pending);
  } catch (cleanupError) {
    const message = (cleanupError as Error).message || '알 수 없는 정리 오류';
    failure = failure ?? new Error(`시험 뒤 정리를 확인하지 못했습니다: ${message}`);
    leftover = [`unknown:${pending.fixtureId}`];
  }
  const run: BackupRoundTripRun = {
    at,
    state: failure || leftover.length ? 'fail' : 'pass',
    filename: file.name || pending.filename,
    error: failure?.message ?? (leftover.length ? `시험 잔재 ${leftover.length}건을 치우지 못했습니다.` : null),
    leftover: leftover[0] ?? null,
    fixtureId: pending.fixtureId,
    digest: pending.digest,
    appVersion: APP_VERSION,
    backupVersion: BACKUP_VERSION,
  };
  saveLastRun(run);
  if (run.state === 'fail') throw new Error(run.error ?? '복원 왕복 시험에 실패했습니다.');
  return run;
}
