// 운영 DB/R2에 합성 영상 하나를 실제로 왕복시키는, 사용자 명시 실행 전용 진단.
import { db, type LocalMoment, type LocalTrip, type LocalVideo, type SyncQueueItem } from '../offline/db';
import { currentUser } from './auth';
import { supabase } from './supabase/client';
import { requestSync, syncStatus } from './autoSync';
import { videoRemote, purgeRemote } from './sync';
import { softDeleteVideo, restoreVideo, videoOp } from './videos';
import { softDeleteTripLocalFirst, purgeTripPermanently } from './trips';
import { purgeChildPermanently } from './trash';
import { createVideoPoster } from '../media/video';
import { fromVideoRow, type VideoRow } from '../domain/video/rowmap';
import { videoPosterStoragePath } from '../domain/media/naming';
import {
  VIDEO_ROUND_TRIP_STEPS,
  sameVideoRoundTripGeneration,
  videoRoundTripR2PairAbsent,
  type VideoRoundTripRun,
  type VideoRoundTripStep,
  type VideoRoundTripStepResult,
} from '../domain/videoRoundTripVerdict';

const LAST_KEY = 'bugeon:lastVideoRoundTrip';
const JOURNAL_KEY = 'bugeon:videoRoundTripJournal';
const LOCK_NAME = 'bugeon:videoRoundTrip';
export const VIDEO_ROUND_TRIP_PREFIX = '[영상 왕복 시험]';

interface Journal {
  runToken: string;
  tripId: string;
  momentId: string;
  videoId: string;
  operationIds: string[];
  title: string;
  canonicalVersion: string;
  videoPath: string | null;
  posterPath: string | null;
  createdAt: string;
}

function readJson<T>(key: string): T | null {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) as T : null; } catch { return null; }
}

function writeJson(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 진단 기록 캐시 불가 */ }
}

function journalIds(journal: Journal): string[] {
  return [journal.tripId, journal.momentId, journal.videoId];
}

export function writeCrashJournal(storage: Pick<Storage, 'getItem' | 'setItem'>, key: string, value: unknown): void {
  const serialized = JSON.stringify(value);
  try {
    storage.setItem(key, serialized);
  } catch (error) {
    throw new Error(`영상 왕복 시험 journal을 저장하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (storage.getItem(key) !== serialized) throw new Error('영상 왕복 시험 journal을 되읽었더니 원래 기록과 다릅니다.');
}

function writeJournal(journal: Journal): void {
  const current = readJson<Journal>(JOURNAL_KEY);
  if (current && current.runToken !== journal.runToken) {
    throw new Error('다른 영상 왕복 시험이 journal을 소유하고 있습니다.');
  }
  writeCrashJournal(localStorage, JOURNAL_KEY, journal);
}

function removeJournal(runToken: string): void {
  const current = readJson<Journal>(JOURNAL_KEY);
  if (current?.runToken !== runToken) return;
  localStorage.removeItem(JOURNAL_KEY);
  if (localStorage.getItem(JOURNAL_KEY) !== null) throw new Error('영상 왕복 시험 journal 삭제를 되읽어 확인하지 못했습니다.');
}

export interface CrossTabLockManager {
  request<T>(
    name: string,
    options: { mode: 'exclusive'; ifAvailable: true },
    callback: (lock: unknown | null) => Promise<T>,
  ): Promise<T>;
}

/**
 * Web Locks가 없는 환경에서는 낙관적 localStorage 락으로 내려가지 않고 실패로 닫는다.
 * journal은 crash 뒤 exact ID를 보존하고, Web Lock은 살아 있는 탭끼리 journal 소유권을 직렬화한다.
 */
export async function withVideoRoundTripLock<T>(
  task: () => Promise<T>,
  locksOverride?: CrossTabLockManager | null,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const locks = locksOverride === undefined
    ? (typeof navigator === 'undefined' ? null : (navigator as Navigator & { locks?: CrossTabLockManager }).locks ?? null)
    : locksOverride;
  if (!locks) return { acquired: false };
  return locks.request(LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
    if (!lock) return { acquired: false } as const;
    return { acquired: true, value: await task() } as const;
  });
}

export function lastVideoRoundTrip(): VideoRoundTripRun | null {
  const run = readJson<VideoRoundTripRun>(LAST_KEY);
  return run && Array.isArray(run.steps) && typeof run.at === 'string' ? run : null;
}

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function canonicalVersion(): Promise<string> {
  const client = supabase();
  if (!client) throw new Error('서버 연결이 설정되지 않았습니다.');
  const result = await client.from('sync_meta').select('canonical_version').maybeSingle();
  if (result.error) throw new Error(`canonical 세대 조회 실패: ${result.error.message}`);
  const value = (result.data as { canonical_version?: unknown } | null)?.canonical_version;
  if (typeof value !== 'string' || !value) throw new Error('canonical 세대를 확인할 수 없습니다.');
  return value;
}

class CanonicalChangedError extends Error {}

async function assertGeneration(expected: string): Promise<void> {
  const actual = await canonicalVersion();
  if (!sameVideoRoundTripGeneration(expected, actual)) throw new CanonicalChangedError(`시험 중 최종본 세대가 바뀌었습니다(${expected} → ${actual}). 추가 쓰기·정리를 멈추고 exact ID를 화면에 남깁니다.`);
}

async function syncInGeneration(expected: string, reason: string): Promise<void> {
  await assertGeneration(expected);
  await syncOrThrow(reason);
  await assertGeneration(expected);
}

async function syncOrThrow(reason: string): Promise<void> {
  await requestSync(reason, { deep: true });
  const status = syncStatus();
  if (status.phase !== 'ok') throw new Error(status.lastError ?? `동기화가 ${status.phase} 상태로 끝났습니다.`);
}

async function syntheticVideo(): Promise<{ blob: Blob; posterBlob: Blob; width: number; height: number; durationSec: number }> {
  if (typeof MediaRecorder === 'undefined') throw new Error('이 브라우저는 합성 영상 녹화를 지원하지 않습니다.');
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (!context || typeof canvas.captureStream !== 'function') throw new Error('영상 시험용 Canvas 스트림을 만들 수 없습니다.');
  const stream = canvas.captureStream(12);
  const mime = ['video/webm;codecs=vp8', 'video/webm'].find((x) => MediaRecorder.isTypeSupported(x));
  if (!mime) { stream.getTracks().forEach((track) => track.stop()); throw new Error('이 브라우저는 WebM 시험 영상을 만들 수 없습니다.'); }
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 180_000 });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
  const stopped = new Promise<void>((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = () => reject(new Error('합성 영상 녹화에 실패했습니다.'));
  });
  recorder.start(80);
  for (let frame = 0; frame < 18; frame += 1) {
    context.fillStyle = `hsl(${frame * 20} 70% 38%)`;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#fff';
    context.font = 'bold 18px sans-serif';
    context.fillText(`BJ ${frame + 1}`, 17, 38);
    await new Promise<void>((resolve) => setTimeout(resolve, 55));
  }
  recorder.stop();
  await stopped;
  stream.getTracks().forEach((track) => track.stop());
  const blob = new Blob(chunks, { type: 'video/webm' });
  if (!blob.size) throw new Error('합성 영상 바이트가 비었습니다.');
  const posterBlob = await createVideoPoster(blob);
  if (!posterBlob.size) throw new Error('합성 영상 포스터가 비었습니다.');
  return { blob, posterBlob, width: 96, height: 64, durationSec: 1 };
}

async function assertPlayable(blob: Blob): Promise<void> {
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.style.cssText = 'position:fixed;width:1px;height:1px;left:-10px;top:-10px;opacity:0';
  document.body.append(video);
  try {
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('영상 디코드가 10초 안에 준비되지 않았습니다.')), 10_000);
      video.onloadeddata = () => { clearTimeout(timer); resolve(); };
      video.onerror = () => { clearTimeout(timer); reject(new Error('영상 바이트를 재생기로 열지 못했습니다.')); };
    });
    await video.play();
    await new Promise<void>((resolve) => setTimeout(resolve, 180));
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) throw new Error('영상 재생 프레임을 확인하지 못했습니다.');
    video.pause();
  } finally {
    video.removeAttribute('src');
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
  }
}

async function serverVideo(id: string): Promise<VideoRow | null> {
  const client = supabase();
  if (!client) throw new Error('서버 연결이 설정되지 않았습니다.');
  const result = await client.from('videos').select('*').eq('id', id).maybeSingle();
  if (result.error) throw new Error(`영상 서버 조회 실패: ${result.error.message}`);
  return (result.data as VideoRow | null) ?? null;
}

async function serverExists(table: 'trips' | 'moments' | 'videos', id: string): Promise<boolean> {
  const client = supabase();
  if (!client) throw new Error('서버 연결이 설정되지 않았습니다.');
  const result = await client.from(table).select('id').eq('id', id).maybeSingle();
  if (result.error) throw new Error(`${table} 서버 조회 실패: ${result.error.message}`);
  return result.data !== null;
}

async function serverPurged(id: string): Promise<boolean> {
  const client = supabase();
  if (!client) throw new Error('서버 연결이 설정되지 않았습니다.');
  const result = await client.from('purged_ids').select('id').eq('id', id).maybeSingle();
  if (result.error) throw new Error(`영구삭제 원장 조회 실패: ${result.error.message}`);
  return result.data !== null;
}

function sameVideoMeta(actual: LocalVideo, expected: LocalVideo): boolean {
  return actual.id === expected.id && actual.tripId === expected.tripId && actual.momentId === expected.momentId &&
    actual.mime === expected.mime && actual.durationSec === expected.durationSec && actual.width === expected.width &&
    actual.height === expected.height && actual.takenAt === expected.takenAt && actual.bytesVideo === expected.bytesVideo;
}

async function forcePurgeFixture(journal: Journal, domain: 'video' | 'trip', bytePath?: string | null): Promise<void> {
  await assertGeneration(journal.canonicalVersion);
  const d = db();
  const id = domain === 'video' ? journal.videoId : journal.tripId;
  const operationId = crypto.randomUUID();
  const at = new Date().toISOString();
  const op: SyncQueueItem = {
    operationId, entityType: domain, entityId: id, operationType: 'purge', state: 'local_only', attempts: 0, createdAt: at,
    ...(bytePath ? { bytePath } : {}),
  };
  await d.transaction('rw', d.syncQueue, d.purgedIds, async () => {
    await d.syncQueue.put(op);
    await d.purgedIds.put({ id, entityType: domain, purgedAt: at });
  });
  await syncInGeneration(journal.canonicalVersion, '영상 왕복 시험 — exact 잔재 정리');
}

/** Web Lock을 이미 가진 호출자만 쓴다. 저장된 exact journal 밖의 id는 절대 만지지 않는다. */
async function cleanupVideoRoundTripLeftoversLocked(): Promise<string[]> {
  const journal = readJson<Journal>(JOURNAL_KEY);
  if (!journal) return [];
  const ids = journalIds(journal);
  // 첫 서버 쓰기 전에 기록한 journal이라도 세대를 모르면 삭제 권한을 만들지 않는다.
  if (!journal.runToken || !journal.canonicalVersion) return ids;
  const client = supabase();
  if (!client) return ids;
  const d = db();
  try {
    await assertGeneration(journal.canonicalVersion);
    let localVideo = await d.localVideos.get(journal.videoId);
    if (!journal.videoPath && localVideo?.storagePath) {
      journal.videoPath = localVideo.storagePath;
      journal.posterPath = videoPosterStoragePath(localVideo.storagePath);
      writeJournal(journal);
    }
    if (localVideo) {
      if (localVideo.deletedAt === null) { await softDeleteVideo(journal.videoId); await syncInGeneration(journal.canonicalVersion, '영상 왕복 시험 — 영상 정리 tombstone'); }
      else await syncInGeneration(journal.canonicalVersion, '영상 왕복 시험 — 영상 정리 선행 동기화');
      localVideo = await d.localVideos.get(journal.videoId);
      if (localVideo) { await assertGeneration(journal.canonicalVersion); await purgeChildPermanently('video', journal.videoId); await syncInGeneration(journal.canonicalVersion, '영상 왕복 시험 — 영상 정리 purge'); }
    } else {
      const row = await serverVideo(journal.videoId);
      if (row && row.trip_id === journal.tripId) {
        if (!journal.videoPath && row.storage_path) {
          journal.videoPath = row.storage_path;
          journal.posterPath = videoPosterStoragePath(row.storage_path);
          writeJournal(journal);
        }
        await forcePurgeFixture(journal, 'video', row.storage_path);
      }
    }

    let localTrip = await d.localTrips.get(journal.tripId);
    if (localTrip) {
      if (!localTrip.title.startsWith(VIDEO_ROUND_TRIP_PREFIX)) throw new Error('시험 id의 로컬 여행 제목이 안전 접두사와 다릅니다.');
      if (localTrip.deletedAt === null) { await assertGeneration(journal.canonicalVersion); await softDeleteTripLocalFirst(journal.tripId); await syncInGeneration(journal.canonicalVersion, '영상 왕복 시험 — 여행 정리 tombstone'); }
      else await syncInGeneration(journal.canonicalVersion, '영상 왕복 시험 — 여행 정리 선행 동기화');
      localTrip = await d.localTrips.get(journal.tripId);
      if (localTrip) { await assertGeneration(journal.canonicalVersion); await purgeTripPermanently(journal.tripId); await syncInGeneration(journal.canonicalVersion, '영상 왕복 시험 — 여행 정리 purge'); }
    } else if (await serverExists('trips', journal.tripId)) {
      const row = await client.from('trips').select('title').eq('id', journal.tripId).maybeSingle();
      const title = (row.data as { title?: unknown } | null)?.title;
      if (typeof title !== 'string' || !title.startsWith(VIDEO_ROUND_TRIP_PREFIX)) throw new Error('시험 id의 서버 여행 제목이 안전 접두사와 다릅니다.');
      await forcePurgeFixture(journal, 'trip');
    }

    if (journal.videoPath || journal.posterPath) {
      if (!journal.videoPath || !journal.posterPath) throw new Error('시험 영상 본체·포스터 exact 경로가 완전하지 않습니다.');
      const remote = videoRemote(client);
      const [body, poster] = await Promise.all([
        remote.download(journal.videoPath),
        remote.download(journal.posterPath),
      ]);
      if (!videoRoundTripR2PairAbsent(body.status, poster.status)) {
        throw new Error('시험 정리 뒤 R2 영상 또는 포스터의 404를 확인하지 못했습니다.');
      }
    }

    const ledger = purgeRemote(client);
    await assertGeneration(journal.canonicalVersion);
    const removed = await ledger.ledgerRemove(ids);
    if (removed.error) throw new Error(`시험 원장 정리 실패: ${removed.error}`);
    await d.transaction('rw', d.localTrips, d.localMoments, d.localVideos, d.syncQueue, d.purgedIds, async () => {
      await Promise.all([
        d.localTrips.delete(journal.tripId), d.localMoments.delete(journal.momentId), d.localVideos.delete(journal.videoId),
        d.syncQueue.filter((op) => ids.includes(op.entityId)).delete(), d.purgedIds.bulkDelete(ids),
      ]);
    });
    const remains = (await Promise.all([
      serverExists('trips', journal.tripId), serverExists('moments', journal.momentId), serverExists('videos', journal.videoId),
      ...ids.map(serverPurged),
    ])).some(Boolean);
    if (remains) throw new Error('서버 행 또는 시험 원장을 되읽었더니 잔재가 남아 있습니다.');
    await assertGeneration(journal.canonicalVersion);
    removeJournal(journal.runToken);
    return [];
  } catch {
    return ids;
  }
}

/** 저장된 고유 journal만 대상으로 하는 멱등 정리. 일반 사용자 id나 제목 prefix 검색은 하지 않는다. */
export async function cleanupVideoRoundTripLeftovers(): Promise<string[]> {
  const journal = readJson<Journal>(JOURNAL_KEY);
  if (!journal) return [];
  const locked = await withVideoRoundTripLock(cleanupVideoRoundTripLeftoversLocked);
  return locked.acquired ? locked.value : journalIds(journal);
}

function result(step: VideoRoundTripStep, state: VideoRoundTripStepResult['state'], ms: number | null, error: string | null, note: string | null = null): VideoRoundTripStepResult {
  return { step, state, ms, error, note };
}

async function commitFixture(input: {
  ids: { tripId: string; momentId: string; videoId: string };
  operationIds: string[];
  title: string;
  at: string;
  prepared: Awaited<ReturnType<typeof syntheticVideo>>;
  videoDigest: string;
  posterDigest: string;
}): Promise<LocalVideo> {
  const { ids, operationIds, title, at, prepared, videoDigest, posterDigest } = input;
  const trip: LocalTrip = { id: ids.tripId, title, startDate: '', endDate: '', status: 'active', version: 1, baseVersion: 0, createdAt: at, updatedAt: at, deletedAt: null, clientOperationId: operationIds[0] };
  const moment: LocalMoment = { id: ids.momentId, tripId: ids.tripId, occurredAt: at, title: '합성 영상 왕복', note: '진단이 만든 기록', emotion: '🔁', placeName: '', version: 1, baseVersion: 0, createdAt: at, updatedAt: at, deletedAt: null, clientOperationId: operationIds[1] };
  const video: LocalVideo = { id: ids.videoId, momentId: ids.momentId, tripId: ids.tripId, sourceBlob: prepared.blob, blob: prepared.blob, posterBlob: prepared.posterBlob, mime: 'video/webm', durationSec: prepared.durationSec, width: prepared.width, height: prepared.height, takenAt: at, bytesOriginal: prepared.blob.size, bytesVideo: prepared.blob.size, version: 1, baseVersion: 0, createdAt: at, updatedAt: at, deletedAt: null, clientOperationId: operationIds[2] };
  const op = (operationId: string, entityType: 'trip' | 'moment', entityId: string): SyncQueueItem => ({ operationId, entityType, entityId, operationType: 'insert', state: 'local_only', attempts: 0, createdAt: at });
  const d = db();
  await d.transaction('rw', d.localTrips, d.localMoments, d.localVideos, d.syncQueue, async () => {
    await d.localTrips.add(trip); await d.localMoments.add(moment); await d.localVideos.add(video);
    await d.syncQueue.bulkAdd([op(operationIds[0]!, 'trip', ids.tripId), op(operationIds[1]!, 'moment', ids.momentId), videoOp(operationIds[2]!, ids.videoId, 'insert', at)]);
  });
  const [tripBack, momentBack, videoBack, queue] = await Promise.all([d.localTrips.get(ids.tripId), d.localMoments.get(ids.momentId), d.localVideos.get(ids.videoId), d.syncQueue.where('entityId').anyOf([ids.tripId, ids.momentId, ids.videoId]).toArray()]);
  if (!tripBack || !momentBack || !videoBack || queue.length !== 3 || await sha256(videoBack.blob) !== videoDigest || await sha256(videoBack.posterBlob) !== posterDigest) throw new Error('여행·순간·영상·큐 원자 저장 read-back이 다릅니다.');
  return videoBack;
}

type StepRunner = (step: VideoRoundTripStep, fn: () => Promise<string | void>) => Promise<void>;

async function runServerLifecycle(runStep: StepRunner, ctx: {
  generation: string;
  ids: { tripId: string; momentId: string; videoId: string };
  operationIds: string[];
  journal: Journal;
  expected: LocalVideo;
  videoDigest: string;
  posterDigest: string;
}): Promise<void> {
  const { generation, ids, operationIds, journal, expected, videoDigest, posterDigest } = ctx;
  await runStep('serverPush', async () => { await syncInGeneration(generation, '영상 왕복 시험 — 생성 전송'); });
  await runStep('serverRead', async () => {
    await assertGeneration(generation);
    const row = await serverVideo(ids.videoId);
    if (!row) throw new Error('서버 videos 행이 없습니다.');
    const mapped = fromVideoRow(row);
    if (mapped.id !== expected.id || mapped.tripId !== expected.tripId || mapped.momentId !== expected.momentId ||
        mapped.mime !== expected.mime || mapped.durationSec !== expected.durationSec || mapped.width !== expected.width ||
        mapped.height !== expected.height || mapped.takenAt !== expected.takenAt || mapped.bytes !== expected.bytesVideo ||
        row.client_operation_id !== operationIds[2] || !row.storage_path) throw new Error('서버 영상 메타·operation·storage_path가 원본과 다릅니다.');
    journal.videoPath = row.storage_path;
    journal.posterPath = videoPosterStoragePath(row.storage_path);
    if (!journal.posterPath) throw new Error('서버 경로에서 포스터 경로를 만들 수 없습니다.');
    writeJournal(journal);
  });
  await runStep('r2Read', async () => {
    const remote = videoRemote(supabase()!);
    const [body, poster] = await Promise.all([remote.download(journal.videoPath!), remote.download(journal.posterPath!)]);
    if (!body.data || body.error || await sha256(body.data) !== videoDigest) throw new Error(body.error ?? 'R2 영상 해시가 다릅니다.');
    if (!poster.data || poster.error || await sha256(poster.data) !== posterDigest) throw new Error(poster.error ?? 'R2 포스터 해시가 다릅니다.');
    await assertPlayable(body.data);
  });
  await runStep('devicePull', async () => {
    await assertGeneration(generation);
    const d = db();
    await d.localVideos.delete(ids.videoId);
    await syncInGeneration(generation, '영상 왕복 시험 — 다른 기기식 pull');
    const restored = await d.localVideos.get(ids.videoId);
    if (!restored || !sameVideoMeta(restored, expected) || restored.sourceBlob || await sha256(restored.blob) !== videoDigest || await sha256(restored.posterBlob) !== posterDigest) throw new Error('다른 기기식 복원 뒤 영상·포스터·메타가 원본과 다릅니다.');
    await assertPlayable(restored.blob);
  });
  await runStep('tombstone', async () => {
    await assertGeneration(generation);
    await softDeleteVideo(ids.videoId); await syncInGeneration(generation, '영상 왕복 시험 — 휴지통');
    const row = await serverVideo(ids.videoId);
    if (!row?.deleted_at) throw new Error('서버 영상이 tombstone이 아닙니다.');
    const remote = videoRemote(supabase()!);
    const [body, poster] = await Promise.all([remote.download(journal.videoPath!), remote.download(journal.posterPath!)]);
    if (!body.data || !poster.data || await sha256(body.data) !== videoDigest || await sha256(poster.data) !== posterDigest) throw new Error('휴지통에서 영상 또는 포스터가 사라졌습니다.');
  });
  await runStep('restore', async () => {
    await assertGeneration(generation);
    await restoreVideo(ids.videoId); await syncInGeneration(generation, '영상 왕복 시험 — 복원');
    const row = await serverVideo(ids.videoId);
    const local = await db().localVideos.get(ids.videoId);
    if (!row || row.deleted_at !== null || !local || local.deletedAt !== null || await sha256(local.blob) !== videoDigest || await sha256(local.posterBlob) !== posterDigest) throw new Error('영상 복원 read-back이 원본과 다릅니다.');
  });
  await runStep('purge', async () => {
    await assertGeneration(generation);
    await softDeleteVideo(ids.videoId); await syncInGeneration(generation, '영상 왕복 시험 — 영구삭제 전 tombstone');
    await assertGeneration(generation);
    await purgeChildPermanently('video', ids.videoId); await syncInGeneration(generation, '영상 왕복 시험 — 영구삭제');
    if (await serverVideo(ids.videoId)) throw new Error('영구삭제 뒤 서버 영상 행이 남았습니다.');
    if (!(await serverPurged(ids.videoId))) throw new Error('영구삭제 원장에 영상 id가 없습니다.');
    const remote = videoRemote(supabase()!);
    const [body, poster] = await Promise.all([remote.download(journal.videoPath!), remote.download(journal.posterPath!)]);
    if (!videoRoundTripR2PairAbsent(body.status, poster.status)) throw new Error('영구삭제 뒤 R2 영상 또는 포스터 부재를 확인하지 못했습니다.');
    await assertGeneration(generation);
  });
}

async function runVideoRoundTripLocked(): Promise<VideoRoundTripRun> {
  const oldLeftovers = await cleanupVideoRoundTripLeftoversLocked();
  if (oldLeftovers.length) {
    const run: VideoRoundTripRun = { at: new Date().toISOString(), steps: VIDEO_ROUND_TRIP_STEPS.map((step, index) => result(step, index === 0 ? 'fail' : 'skipped', null, index === 0 ? '이전 시험 잔재를 먼저 치우지 못했습니다.' : null)), leftoverIds: oldLeftovers, canonicalVersion: null };
    writeJson(LAST_KEY, run);
    return run;
  }
  const user = await currentUser();
  if (!user || !supabase()) {
    const run: VideoRoundTripRun = { at: new Date().toISOString(), steps: VIDEO_ROUND_TRIP_STEPS.map((step, index) => result(step, index === 0 ? 'fail' : 'skipped', null, index === 0 ? '로그인된 서버 연결이 필요합니다.' : null)), leftoverIds: [], canonicalVersion: null };
    writeJson(LAST_KEY, run);
    return run;
  }

  const at = new Date().toISOString();
  const runToken = crypto.randomUUID();
  const ids = { tripId: crypto.randomUUID(), momentId: crypto.randomUUID(), videoId: crypto.randomUUID() };
  const operationIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const title = `${VIDEO_ROUND_TRIP_PREFIX} ${at.slice(0, 19).replace('T', ' ')}`;
  let generation = '';
  const journal: Journal = { runToken, ...ids, operationIds, title, canonicalVersion: '', videoPath: null, posterPath: null, createdAt: at };
  const steps: VideoRoundTripStepResult[] = [];
  let blocked = false;
  let generationChanged = false;
  let prepared: Awaited<ReturnType<typeof syntheticVideo>> | null = null;
  let expected: LocalVideo | null = null;
  let videoDigest = '';
  let posterDigest = '';

  const runStep = async (step: VideoRoundTripStep, fn: () => Promise<string | void>): Promise<void> => {
    if (blocked) { steps.push(result(step, 'skipped', null, null)); return; }
    const started = Date.now();
    try { const note = await fn(); steps.push(result(step, 'pass', Date.now() - started, null, note ?? null)); }
    catch (error) {
      blocked = true;
      generationChanged = error instanceof CanonicalChangedError;
      steps.push(result(step, 'fail', Date.now() - started, error instanceof Error ? error.message : String(error)));
    }
  };

  await runStep('prepare', async () => {
    await syncOrThrow('영상 왕복 시험 — 사전 동기화');
    generation = await canonicalVersion();
    journal.canonicalVersion = generation;
    prepared = await syntheticVideo();
    await assertPlayable(prepared.blob);
    videoDigest = await sha256(prepared.blob);
    posterDigest = await sha256(prepared.posterBlob);
    writeJournal(journal); // 첫 fixture 쓰기 전에 exact id·소유권·세대를 내구성 read-back한다.
    return `합성 WebM ${prepared.blob.size}바이트 · 포스터 ${prepared.posterBlob.size}바이트`;
  });

  await runStep('localCommit', async () => {
    await assertGeneration(generation);
    expected = await commitFixture({ ids, operationIds, title, at, prepared: prepared!, videoDigest, posterDigest });
  });

  if (expected) await runServerLifecycle(runStep, { generation, ids, operationIds, journal, expected, videoDigest, posterDigest });

  // 본 시험이 실패했어도 exact journal 정리는 반드시 별도로 시도한다.
  const cleanupStarted = Date.now();
  const leftovers = generationChanged
    ? [ids.tripId, ids.momentId, ids.videoId]
    : await cleanupVideoRoundTripLeftoversLocked();
  steps.push(generationChanged
    ? result('cleanup', 'skipped', null, null, 'canonical 세대 변경으로 자동 정리를 중단했습니다.')
    : leftovers.length
      ? result('cleanup', 'fail', Date.now() - cleanupStarted, '시험용 여행·순간·영상 중 하나 이상을 치우지 못했습니다.')
      : result('cleanup', 'pass', Date.now() - cleanupStarted, null));
  // 앞에서 막혔다면 아직 추가되지 않은 본 단계만 skipped로 채우고 cleanup을 마지막에 둔다.
  const cleanup = steps.pop()!;
  const existing = new Set(steps.map((step) => step.step));
  for (const step of VIDEO_ROUND_TRIP_STEPS.slice(0, -1)) if (!existing.has(step)) steps.push(result(step, 'skipped', null, null));
  steps.push(cleanup);
  const ordered = VIDEO_ROUND_TRIP_STEPS.map((step) => steps.find((item) => item.step === step)!);
  const run: VideoRoundTripRun = { at, steps: ordered, leftoverIds: leftovers, canonicalVersion: generation || null };
  writeJson(LAST_KEY, run);
  return run;
}

export async function runVideoRoundTrip(): Promise<VideoRoundTripRun> {
  const locked = await withVideoRoundTripLock(runVideoRoundTripLocked);
  if (locked.acquired) return locked.value;
  const journal = readJson<Journal>(JOURNAL_KEY);
  const run: VideoRoundTripRun = {
    at: new Date().toISOString(),
    steps: VIDEO_ROUND_TRIP_STEPS.map((step, index) => result(
      step,
      index === 0 ? 'fail' : 'skipped',
      null,
      index === 0 ? '다른 탭에서 영상 왕복 시험이 실행 중이거나 이 환경이 탭 간 잠금을 지원하지 않습니다.' : null,
    )),
    leftoverIds: journal ? journalIds(journal) : [],
    canonicalVersion: journal?.canonicalVersion || null,
  };
  writeJson(LAST_KEY, run);
  return run;
}
