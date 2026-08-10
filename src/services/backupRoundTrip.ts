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
//  ④ 사진·소리는 만들지 않는다. 파일 바이트 왕복은 기존 backupRoundtrip 유닛이 맡고,
//     이 도구는 실제 브라우저의 내려받기→파일 선택→파싱→Dexie 병합 경계를 맡는다.

import { db, type JourneyDB, type LocalTrip } from '../offline/db';
import { APP_VERSION } from '../app/changelog';
import { localDate } from '../domain/time';
import {
  assertBackupImportSize,
  BACKUP_VERSION,
  deserializeJson,
  importMergeRows,
  serializeJson,
  type BackupStats,
  type CollectedRows,
} from './backup';

export const BACKUP_ROUND_TRIP_TITLE_PREFIX = '🧪 복원 왕복 시험 · 자동 롤백';
export const BACKUP_ROUND_TRIP_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const PENDING_KEY = 'bugeon:backupRoundTripPending';
const LAST_RUN_KEY = 'bugeon:lastBackupRoundTrip';

interface PendingBackupRoundTrip {
  fixtureId: string;
  title: string;
  digest: string;
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
  if (!value || typeof value.fixtureId !== 'string' || typeof value.digest !== 'string') return null;
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
  return [d.localTrips, d.localMoments, d.localMedia, d.localExpenses, d.localAudio, d.localPlaces, d.syncQueue, d.purgedIds] as const;
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
    places: rows.places.length,
  };
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function filenameAt(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `bugeon-journey_restore-roundtrip_${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}.json`;
}

/**
 * production 직렬화 형식과 같은 **진단 전용 JSON**을 만든다. 고유 시험 trip 한 건만 담으므로
 * 사용자의 사진·소리·위치·메모가 평문 시험 파일로 한 번 더 복제되지 않는다.
 */
export async function createBackupRoundTripFile(): Promise<BackupRoundTripFile> {
  const now = new Date();
  const fixture = fixtureTrip(now);
  const rows = exactFixtureRows(fixture);
  const json = await serializeJson(rows);
  const bytes = new TextEncoder().encode(json);
  const filename = filenameAt(now);
  const pending: PendingBackupRoundTrip = {
    fixtureId: fixture.id,
    title: fixture.title,
    digest: await sha256Hex(bytes.buffer),
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
  return { blob: new Blob([bytes], { type: 'application/json' }), filename, stats: statsOf(rows) };
}

class VerifiedRollback extends Error {
  constructor() {
    super('backup-round-trip-verified-rollback');
    this.name = 'VerifiedRollback';
  }
}

function exactFixtureRows(fixture: LocalTrip): CollectedRows {
  return { trips: [fixture], moments: [], media: [], expenses: [], audio: [], places: [] };
}

function sameFixtureTrip(actual: LocalTrip, expected: LocalTrip): boolean {
  return actual.id === expected.id && actual.title === expected.title &&
    actual.startDate === expected.startDate && actual.endDate === expected.endDate &&
    actual.status === expected.status && actual.createdAt === expected.createdAt &&
    actual.updatedAt === expected.updatedAt && actual.version === expected.version &&
    actual.deletedAt === expected.deletedAt && actual.timeZone === expected.timeZone &&
    actual.updatedByDevice === expected.updatedByDevice && actual.baseVersion === expected.baseVersion &&
    actual.baseCanonicalVersion === expected.baseCanonicalVersion &&
    actual.clientOperationId === expected.clientOperationId;
}

async function artifactIds(id: string): Promise<string[]> {
  const d = db();
  const [trip, queue, purged] = await Promise.all([
    d.localTrips.get(id),
    d.syncQueue.where('entityId').equals(id).toArray(),
    d.purgedIds.get(id),
  ]);
  return [...(trip ? [`trip:${id}`] : []), ...queue.map((q) => `queue:${q.operationId}`), ...(purged ? [`purged:${id}`] : [])];
}

/** 실패 경로에서도 **이 시험 id만** 치운다. 사용자 id를 접두사 검색으로 넓게 지우지 않는다. */
async function cleanupExactFixture(id: string): Promise<string[]> {
  const d = db();
  await d.transaction('rw', [d.localTrips, d.syncQueue], async () => {
    const trip = await d.localTrips.get(id);
    if (trip?.title.startsWith(BACKUP_ROUND_TRIP_TITLE_PREFIX)) await d.localTrips.delete(id);
    const mine = await d.syncQueue.where('entityId').equals(id).primaryKeys();
    if (mine.length) await d.syncQueue.bulkDelete(mine);
  });
  return artifactIds(id);
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
    assertBackupImportSize(file.size);
    const buf = await file.arrayBuffer();
    const digest = await sha256Hex(buf);
    if (digest !== pending.digest) throw new Error('방금 만든 왕복 시험 파일과 바이트가 다릅니다. 올바른 파일을 다시 골라 주세요.');

    const rows = deserializeJson(new TextDecoder().decode(buf));
    const fixture = rows.trips.find((t) => t.id === pending.fixtureId);
    if (!fixture || fixture.title !== pending.title || !fixture.title.startsWith(BACKUP_ROUND_TRIP_TITLE_PREFIX)) {
      throw new Error('시험 표식이 없거나 달라 복원 왕복 파일로 확인할 수 없습니다.');
    }
    if ((await artifactIds(fixture.id)).length) throw new Error('시험을 시작하기 전부터 같은 id의 잔재가 있습니다. 먼저 다시 확인해 주세요.');

    const d = db();
    try {
      importStarted = true;
      await d.transaction('rw', restoreTables(d), async () => {
        const result = await importMergeRows(exactFixtureRows(fixture));
        if (result.skippedEmptyGuard || result.trips !== 1) throw new Error('파일은 읽었지만 시험 기록 한 건을 복원하지 못했습니다.');
        const restored = await d.localTrips.get(fixture.id);
        if (!restored || !sameFixtureTrip(restored, fixture)) {
          throw new Error('복원한 기록을 되읽었더니 원래 파일과 값이 다릅니다.');
        }
        const queued = await d.syncQueue.where('entityId').equals(fixture.id).count();
        if (queued < 2) throw new Error('복원 기록과 서버 원장 되돌리기 의사가 같은 커밋에 남지 않았습니다.');
        throw new VerifiedRollback();
      });
      throw new Error('검증 트랜잭션이 롤백되지 않았습니다.');
    } catch (error) {
      if (!(error instanceof VerifiedRollback)) throw error;
    }

    const leftover = await artifactIds(fixture.id);
    if (leftover.length) throw new Error(`시험 뒤 잔재 ${leftover.length}건이 남았습니다.`);
  } catch (error) {
    failure = error as Error;
  }

  let leftover: string[] = [];
  try {
    // preflight·해시·파싱 실패는 DB를 쓰지 않았다. 그때 보이는 같은 id의 기록·큐·원장은
    // **기존 상태**이므로 절대 지우지 않는다. 실제 import를 시작한 판만 자기 잔재를 치운다.
    leftover = importStarted ? await cleanupExactFixture(pending.fixtureId) : await artifactIds(pending.fixtureId);
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
