import { db, type LocalVideo, type SyncQueueItem } from '../offline/db';
import { quotaVerdict } from '../domain/media/quota';
import { prepareVideo, type VideoProgress } from '../media/video';

const uuid = (): string => crypto.randomUUID();

export function videoOp(
  operationId: string,
  entityId: string,
  operationType: SyncQueueItem['operationType'],
  createdAt: string,
): SyncQueueItem {
  return { operationId, entityType: 'video', entityId, operationType, state: 'local_only', attempts: 0, createdAt };
}

async function readStorageEstimate(): Promise<{ usage: number | null; quota: number | null }> {
  try {
    if (!navigator.storage?.estimate) return { usage: null, quota: null };
    const e = await navigator.storage.estimate();
    return { usage: e.usage ?? null, quota: e.quota ?? null };
  } catch {
    return { usage: null, quota: null };
  }
}

export async function addVideoToMoment(
  target: { momentId: string; tripId: string },
  file: File,
  onProgress?: (progress: VideoProgress) => void,
): Promise<LocalVideo> {
  const prepared = await prepareVideo(file, onProgress);
  // 변환 중에는 입력+출력, 커밋 뒤에는 source+출력+poster가 잠시 공존한다.
  const needed = file.size + prepared.blob.size * 2 + prepared.posterBlob.size;
  const q = quotaVerdict(needed, await readStorageEstimate());
  if (!q.allow) throw new Error(q.message);

  const now = new Date().toISOString();
  const takenAt = file.lastModified > 0 ? new Date(file.lastModified).toISOString() : now;
  const opId = uuid();
  const row: LocalVideo = {
    id: uuid(),
    momentId: target.momentId,
    tripId: target.tripId,
    sourceBlob: prepared.blob,
    blob: prepared.blob,
    posterBlob: prepared.posterBlob,
    mime: prepared.mime,
    durationSec: prepared.durationSec,
    width: prepared.width,
    height: prepared.height,
    takenAt,
    bytesOriginal: prepared.bytesOriginal,
    bytesVideo: prepared.blob.size,
    version: 1,
    baseVersion: 0,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    clientOperationId: opId,
  };
  const d = db();
  await d.transaction('rw', d.localVideos, d.syncQueue, async () => {
    await d.localVideos.add(row);
    await d.syncQueue.add(videoOp(opId, row.id, 'insert', now));
  });
  const back = await d.localVideos.get(row.id);
  if (!back || back.blob.size !== prepared.blob.size || back.posterBlob.size === 0) {
    throw new Error('내구성 커밋 확인 실패: 영상 read-back 불일치');
  }
  return back;
}

export async function listVideosByTrip(tripId: string): Promise<LocalVideo[]> {
  const rows = await db().localVideos.where('tripId').equals(tripId).toArray();
  return rows.filter((v) => v.deletedAt === null);
}

export async function softDeleteVideo(id: string): Promise<void> {
  const d = db();
  const cur = await d.localVideos.get(id);
  if (!cur || cur.deletedAt !== null) return;
  const now = new Date().toISOString();
  const opId = uuid();
  await d.transaction('rw', d.localVideos, d.syncQueue, async () => {
    await d.localVideos.put({
      ...cur,
      deletedAt: now,
      updatedAt: now,
      version: cur.version + 1,
      baseVersion: cur.baseVersion ?? cur.version,
      clientOperationId: opId,
    });
    await d.syncQueue.add(videoOp(opId, id, 'delete', now));
  });
  const back = await d.localVideos.get(id);
  if (!back || back.deletedAt === null) throw new Error('내구성 커밋 확인 실패: 영상 삭제 read-back 불일치');
}

export async function restoreVideo(id: string): Promise<void> {
  const d = db();
  const cur = await d.localVideos.get(id);
  if (!cur || cur.deletedAt === null) return;
  const now = new Date().toISOString();
  const opId = uuid();
  await d.transaction('rw', d.localVideos, d.syncQueue, async () => {
    await d.localVideos.put({
      ...cur,
      deletedAt: null,
      updatedAt: now,
      version: cur.version + 1,
      baseVersion: cur.baseVersion ?? cur.version,
      clientOperationId: opId,
    });
    await d.syncQueue.add(videoOp(opId, id, 'update', now));
  });
  const back = await d.localVideos.get(id);
  if (!back || back.deletedAt !== null) throw new Error('내구성 커밋 확인 실패: 영상 되살리기 read-back 불일치');
}
