// 영상 본체+포스터의 운영 서버 왕복 계약. 둘 중 하나라도 다르면 op을 완료하지 않는다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { db, type LocalVideo } from '../../src/offline/db';
import { pullVideos, pushPendingVideos, type VideoRemote } from '../../src/services/sync';
import { softDeleteVideo, videoOp } from '../../src/services/videos';
import { videoPosterStoragePath } from '../../src/domain/media/naming';
import type { VideoRow } from '../../src/domain/video/rowmap';

const USER = 'c9ff5188-51a7-4c01-b653-b6e1d73d0790';
const TRIP = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70';
const MOMENT = '22222222-2222-4222-8222-222222222222';
const VIDEO = '33333333-3333-4333-8333-333333333333';
const OP = '44444444-4444-4444-8444-444444444444';

type FakeOptions = {
  posterUploadFails?: boolean;
  missingPosterDownload?: boolean;
  mutateVideoDownload?: boolean;
};

function fakeRemote(options: FakeOptions = {}): VideoRemote & {
  rows: Map<string, VideoRow>;
  objects: Map<string, Blob>;
  uploads: string[];
  removed: string[];
} {
  const rows = new Map<string, VideoRow>();
  const objects = new Map<string, Blob>();
  const uploads: string[] = [];
  const removed: string[] = [];
  return {
    rows, objects, uploads, removed,
    upsert: (row) => { rows.set(row.id, row); return Promise.resolve({}); },
    getById: (id) => Promise.resolve({ data: rows.get(id) ?? null }),
    listAll: () => Promise.resolve({ data: [...rows.values()] }),
    upload: (path, blob) => {
      uploads.push(path);
      if (options.posterUploadFails && path.includes('__video_poster__')) return Promise.resolve({ error: 'poster put failed', status: 503 });
      objects.set(path, blob);
      return Promise.resolve({});
    },
    download: async (path) => {
      if (options.missingPosterDownload && path.includes('__video_poster__')) return { data: null, status: 404 };
      const blob = objects.get(path) ?? null;
      if (options.mutateVideoDownload && blob && !path.includes('__video_poster__')) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (bytes.length) bytes[0] = bytes[0] ^ 0xff;
        return { data: new Blob([bytes], { type: blob.type }) };
      }
      return { data: blob };
    },
    remove: (path) => { removed.push(path); objects.delete(path); return Promise.resolve({}); },
  };
}

async function seed(): Promise<LocalVideo> {
  const now = '2026-08-10T00:00:00.000Z';
  const video: LocalVideo = {
    id: VIDEO, momentId: MOMENT, tripId: TRIP,
    sourceBlob: new Blob([new Uint8Array([9, 9, 9, 9])], { type: 'video/webm' }),
    blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'video/webm' }),
    posterBlob: new Blob([new Uint8Array([5, 6, 7, 8])], { type: 'image/webp' }),
    mime: 'video/webm', durationSec: 1.25, width: 32, height: 24,
    takenAt: now, bytesOriginal: 4, bytesVideo: 4,
    version: 1, baseVersion: 0, createdAt: now, updatedAt: now, deletedAt: null,
    clientOperationId: OP,
  };
  const d = db();
  await d.localTrips.put({ id: TRIP, title: '영상 왕복', startDate: '', endDate: '', status: 'active', version: 1, createdAt: now, updatedAt: now, deletedAt: null });
  await d.transaction('rw', d.localVideos, d.syncQueue, async () => {
    await d.localVideos.put(video);
    await d.syncQueue.put(videoOp(OP, VIDEO, 'insert', now));
  });
  return video;
}

beforeEach(async () => {
  const d = db();
  await Promise.all([d.localTrips.clear(), d.localVideos.clear(), d.syncQueue.clear(), d.purgedIds.clear()]);
});

afterEach(async () => {
  const d = db();
  await Promise.all([d.localTrips.clear(), d.localVideos.clear(), d.syncQueue.clear(), d.purgedIds.clear()]);
});

describe('영상 서버 왕복 — 본체와 포스터는 한 쌍', () => {
  it('경량본과 포스터를 각각 PUT/GET 대조한 뒤에만 op을 지운다', async () => {
    const original = await seed();
    const remote = fakeRemote();
    expect(await pushPendingVideos(remote, USER)).toEqual({ pushed: 1, failed: 0 });
    expect(remote.uploads).toHaveLength(2);
    const path = remote.rows.get(VIDEO)!.storage_path!;
    const posterPath = videoPosterStoragePath(path)!;
    expect(remote.objects.has(path)).toBe(true);
    expect(remote.objects.has(posterPath)).toBe(true);
    expect(new Uint8Array(await remote.objects.get(path)!.arrayBuffer())).toEqual(new Uint8Array(await original.blob.arrayBuffer()));
    expect(await db().syncQueue.count()).toBe(0);
    expect((await db().localVideos.get(VIDEO))!.sourceBlob).toBeUndefined();
  });

  it('같은 길이 영상 변조도 read-back 불일치로 막고 op을 남긴다', async () => {
    await seed();
    const result = await pushPendingVideos(fakeRemote({ mutateVideoDownload: true }), USER);
    expect(result).toEqual({ pushed: 0, failed: 1 });
    expect(await db().syncQueue.count()).toBe(1);
  });

  it('HTTP 성공 뒤 포스터 GET이 없으면 완료하지 않는다', async () => {
    await seed();
    const result = await pushPendingVideos(fakeRemote({ missingPosterDownload: true }), USER);
    expect(result).toEqual({ pushed: 0, failed: 1 });
    expect(await db().syncQueue.count()).toBe(1);
  });

  it('포스터 PUT 실패 시 먼저 올린 본체를 exact path로 정리하고 op을 남긴다', async () => {
    await seed();
    const remote = fakeRemote({ posterUploadFails: true });
    const result = await pushPendingVideos(remote, USER);
    expect(result).toEqual({ pushed: 0, failed: 1 });
    expect(remote.removed).toEqual([remote.uploads[0]]);
    expect(await db().syncQueue.count()).toBe(1);
  });

  it('다른 기기 pull은 서버의 본체와 포스터를 그대로 복원한다', async () => {
    const original = await seed();
    const remote = fakeRemote();
    await pushPendingVideos(remote, USER);
    await db().localVideos.clear();
    const result = await pullVideos(remote, 'merge');
    expect(result.pulled).toBe(1);
    const restored = (await db().localVideos.get(VIDEO))!;
    expect(new Uint8Array(await restored.blob.arrayBuffer())).toEqual(new Uint8Array(await original.blob.arrayBuffer()));
    expect(new Uint8Array(await restored.posterBlob.arrayBuffer())).toEqual(new Uint8Array(await original.posterBlob.arrayBuffer()));
    expect(restored.durationSec).toBe(original.durationSec);
    expect(restored.width).toBe(original.width);
    expect(restored.height).toBe(original.height);
  });

  it('포스터가 없는 서버 자료는 성공으로 반올림하지 않는다', async () => {
    await seed();
    const remote = fakeRemote();
    await pushPendingVideos(remote, USER);
    const poster = videoPosterStoragePath(remote.rows.get(VIDEO)!.storage_path!)!;
    remote.objects.delete(poster);
    await db().localVideos.clear();
    expect((await pullVideos(remote, 'merge')).pulled).toBe(0);
    expect(await db().localVideos.count()).toBe(0);
  });

  it('휴지통 tombstone은 본체와 포스터를 보존하고 다시 올리지 않는다', async () => {
    await seed();
    const remote = fakeRemote();
    await pushPendingVideos(remote, USER);
    const paths = [...remote.uploads];
    await softDeleteVideo(VIDEO);
    await pushPendingVideos(remote, USER);
    expect(remote.uploads).toEqual(paths);
    expect(remote.removed).toEqual([]);
    expect(remote.rows.get(VIDEO)!.deleted_at).not.toBeNull();
    expect(paths.every((path) => remote.objects.has(path))).toBe(true);
  });
});
