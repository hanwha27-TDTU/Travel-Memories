import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '../../src/offline/db';
import { createMomentLocalFirst, searchPhotoTitles } from '../../src/services/moments';

beforeEach(async () => {
  const d = db();
  await Promise.all([d.localMoments.clear(), d.localMedia.clear(), d.localPlaces.clear(), d.syncQueue.clear()]);
});

describe('사진 제목 검색', () => {
  it('사진이 붙은 순간 제목만 대소문자와 공백을 무시해 찾는다', async () => {
    const withPhoto = await createMomentLocalFirst({ tripId: 'trip-a', title: 'Sunset Walk' });
    await createMomentLocalFirst({ tripId: 'trip-b', title: 'Sunset without photo' });
    const now = new Date().toISOString();
    await db().localMedia.add({
      id: 'media-1', momentId: withPhoto.id, tripId: withPhoto.tripId,
      mime: 'image/webp', displayBlob: new Blob(), thumbBlob: new Blob(), width: 1, height: 1,
      takenAt: now, gpsLat: null, gpsLng: null, sortOrder: 0, bytesOriginal: 0, bytesDisplay: 0,
      version: 1, baseVersion: 0, createdAt: now, updatedAt: now, deletedAt: null,
    });

    expect(await searchPhotoTitles('  SUNSET ')).toEqual([
      { momentId: withPhoto.id, tripId: 'trip-a', title: 'Sunset Walk' },
    ]);
  });
});
