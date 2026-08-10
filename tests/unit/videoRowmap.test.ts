import { describe, expect, it } from 'vitest';
import { fromVideoRow, toVideoRow, videoStoragePath, type VideoRow } from '../../src/domain/video/rowmap';
import type { LocalVideo } from '../../src/offline/db';

const id = '11111111-2222-4333-8444-555555555555';
const local: LocalVideo = {
  id,
  momentId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  tripId: '99999999-8888-4777-8666-555555555555',
  blob: new Blob(['video'], { type: 'video/mp4' }),
  posterBlob: new Blob(['poster'], { type: 'image/webp' }),
  mime: 'video/mp4', durationSec: 12.5, width: 1280, height: 720,
  takenAt: '2026-08-10T10:00:00.000Z', bytesOriginal: 100, bytesVideo: 5,
  version: 2, baseVersion: 1, baseCanonicalVersion: 'legacy',
  createdAt: '2026-08-10T10:00:00.000Z', updatedAt: '2026-08-10T10:01:00.000Z', deletedAt: null,
};

describe('영상 rowmap', () => {
  it('blob을 행에 넣지 않고 서버 메타를 왕복한다', () => {
    const path = videoStoragePath('user-id', local, '제주 여행');
    expect(path).toMatch(/__video__[0-9a-f]{32}\.mp4$/);
    const row = toVideoRow(local, 'user-id', path, 'phone#1');
    expect(row.bytes).toBe(local.blob.size);
    expect((row as unknown as { blob?: unknown }).blob).toBeUndefined();
    const back = fromVideoRow(row as VideoRow);
    expect(back).toMatchObject({ id, durationSec: 12.5, width: 1280, height: 720, storagePath: path });
  });
});
