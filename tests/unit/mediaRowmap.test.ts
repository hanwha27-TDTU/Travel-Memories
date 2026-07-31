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
  it('storage 경로는 {userId}/{여행폴더}/{읽을 수 있는 이름}.webp', () => {
    const p = mediaStoragePath(USER, media, '제주 여행');
    // 첫 칸은 **반드시** userId — 이게 인가 경계다.
    expect(p.startsWith(`${USER}/`)).toBe(true);
    expect(p.split('/')).toHaveLength(3);
    expect(p).toContain('/제주_여행__'); // 폴더: 제목 + 여행 id 8자
    expect(p.endsWith('.webp')).toBe(true);
  });

  // 🔴 **이 케이스를 뒤집었다**(2026-08-01 · [user-decided] · §11 ②).
  //
  // 전에는 *"행에는 GPS가 담기지 않는다(PII 미동기화)"*를 **정상으로 못박아** 뒀다. 그 계약의
  // 실제 결과는 **폰에서 넣은 사진의 좌표를 태블릿에서 볼 수 없는 것**이었고, 사용자가 정한
  // 원칙(*"모든 기기에서 모든 정보를 확인해야 한다"*)에 정면으로 어긋났다.
  //
  // 사용자 결정: *"사진 GPS도 서버에 올리자. 당연한 거 아냐? 내 개인앱인데."*
  // 통과시키려고 코드를 되돌리지 않고 **케이스를 뒤집는다** — 틀린 계약을 잠근 유닛은
  // 게이트를 결함의 편에 세운다(M-0057이 정확히 그 형태였다).
  it('🔴 행에 blob은 안 담기고 **GPS는 담긴다**(0024 이후 · 파일이 아니라 컬럼으로)', () => {
    const path = mediaStoragePath(USER, media, '제주 여행');
    const row = toMediaRow(media, USER, path);
    expect('displayBlob' in row).toBe(false);
    expect('originalBlob' in row).toBe(false);
    expect(row.gps_lat).toBe(37.5583);
    expect(row.gps_lng).toBe(126.7906);
    expect(row.storage_path).toBe(path);
    expect(row.user_id).toBe(USER);
    expect(row.bytes_display).toBe(660000);
    expect(row.source).toBe('user');
  });

  it('좌표가 없는 사진은 null로 간다 — **0으로 반올림하지 않는다**(M-0057)', () => {
    const row = toMediaRow({ ...media, gpsLat: null, gpsLng: null }, USER, null);
    expect(row.gps_lat).toBeNull();
    expect(row.gps_lng).toBeNull();
  });

  it('옛 서버 행(컬럼 없음)은 **「모름」으로 읽는다** — pull이 로컬 값을 지킬 수 있게', () => {
    const row = toMediaRow(media, USER, null);
    delete (row as Partial<typeof row>).gps_lat;
    delete (row as Partial<typeof row>).gps_lng;
    const meta = fromMediaRow(row);
    expect(meta.gpsLat).toBeNull();
    expect(meta.gpsLng).toBeNull();
  });

  it('메타 왕복: toMediaRow → fromMediaRow가 메타 필드를 보존한다', () => {
    const meta = fromMediaRow(toMediaRow(media, USER, mediaStoragePath(USER, media, '제주 여행')));
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
    expect(meta.storagePath).toBe(mediaStoragePath(USER, media, '제주 여행'));
  });

  it('tombstone·storage_path null도 왕복 보존', () => {
    const del: LocalMedia = { ...media, deletedAt: '2026-07-22T12:00:00.000Z', version: 3 };
    const meta = fromMediaRow(toMediaRow(del, USER, null));
    expect(meta.deletedAt).toBe('2026-07-22T12:00:00.000Z');
    expect(meta.storagePath).toBe(null);
  });
});
