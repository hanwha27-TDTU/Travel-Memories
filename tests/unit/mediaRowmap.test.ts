// media rowmap 경계 테스트 — 메타만 서버로(원본·GPS·썸네일은 미동기화). 운영 함수 직접 테스트.
import { describe, it, expect } from 'vitest';
import { toMediaRow, fromMediaRow, mediaStoragePath } from '../../src/domain/media/rowmap';
import type { LocalMedia } from '../../src/offline/db';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const b = (s: string) => new Blob([s], { type: 'image/webp' });

const media: LocalMedia = {
  id: '33333333-3333-4333-8333-333333333333',
  momentId: '22222222-2222-4222-8222-222222222222',
  tripId: '11111111-1111-4111-8111-111111111111',
  mime: 'image/jpeg',
  originalBlob: b('original-huge'),
  displayBlob: b('display'),
  thumbBlob: b('thumb'),
  width: 1600,
  height: 1200,
  takenAt: '2026-07-17T06:50:00.000Z',
  gpsLat: 37.5583,
  gpsLng: 126.7906,
  bytesOriginal: 4000000,
  bytesDisplay: 660000,
  version: 2,
  createdAt: '2026-07-22T10:00:00.000Z',
  updatedAt: '2026-07-22T11:30:00.000Z',
  deletedAt: null,
  clientOperationId: '55555555-5555-4555-8555-555555555555',
};

describe('media rowmap 경계', () => {
  it('storage 경로 규약은 {userId}/{id}.webp', () => {
    expect(mediaStoragePath(USER, media.id)).toBe(`${USER}/${media.id}.webp`);
  });

  it('행에는 blob·GPS가 담기지 않는다(원본 로컬 전용·GPS PII 미동기화)', () => {
    const row = toMediaRow(media, USER, mediaStoragePath(USER, media.id));
    // 행에 blob/gps 키 자체가 없다
    expect('displayBlob' in row).toBe(false);
    expect('originalBlob' in row).toBe(false);
    expect('gps_lat' in row).toBe(false);
    expect('gpsLat' in row).toBe(false);
    expect(row.storage_path).toBe(`${USER}/${media.id}.webp`);
    expect(row.user_id).toBe(USER);
    expect(row.bytes_display).toBe(660000);
    expect(row.source).toBe('user');
  });

  it('메타 왕복: toMediaRow → fromMediaRow가 메타 필드를 보존한다', () => {
    const meta = fromMediaRow(toMediaRow(media, USER, mediaStoragePath(USER, media.id)));
    expect(meta.id).toBe(media.id);
    expect(meta.momentId).toBe(media.momentId);
    expect(meta.tripId).toBe(media.tripId);
    expect(meta.width).toBe(1600);
    expect(meta.height).toBe(1200);
    expect(meta.takenAt).toBe(media.takenAt);
    expect(meta.bytesDisplay).toBe(660000);
    expect(meta.version).toBe(2);
    expect(meta.deletedAt).toBe(null);
    expect(meta.clientOperationId).toBe(media.clientOperationId);
    expect(meta.storagePath).toBe(`${USER}/${media.id}.webp`);
  });

  it('tombstone·storage_path null도 왕복 보존', () => {
    const del: LocalMedia = { ...media, deletedAt: '2026-07-22T12:00:00.000Z', version: 3 };
    const meta = fromMediaRow(toMediaRow(del, USER, null));
    expect(meta.deletedAt).toBe('2026-07-22T12:00:00.000Z');
    expect(meta.storagePath).toBe(null);
  });
});
