import { describe, it, expect } from 'vitest';
import { toPlaceRow, fromPlaceRow, providerKeyOf, type PlaceRow } from '../../src/domain/place/rowmap';
import type { LocalPlace } from '../../src/offline/db';

const base: LocalPlace = {
  id: 'pl-1',
  name: '대학로',
  formattedAddress: '대학로, 종로구, 서울특별시, 대한민국',
  provider: 'nominatim',
  providerPlaceId: 'way/520463101',
  providerKey: 'nominatim/way/520463101',
  countryCode: 'kr',
  country: '대한민국',
  region: '서울특별시',
  city: null,
  district: '종로구',
  postcode: '03087',
  category: 'highway:secondary',
  memo: '연극 보러 자주 감',
  longitude: 127.0016,
  latitude: 37.587,
  precision: 'street',
  spanMeters: 1480,
  mapPicked: false,
  version: 3,
  baseVersion: 3,
  baseCanonicalVersion: 'legacy',
  createdAt: '2026-07-30T09:20:00.000Z',
  updatedAt: '2026-07-30T09:25:00.000Z',
  deletedAt: null,
  clientOperationId: 'op-1',
};

describe('place rowmap 경계', () => {
  it('toPlaceRow는 snake_case + user_id를 붙인다', () => {
    const row = toPlaceRow(base, 'user-9');
    expect(row.user_id).toBe('user-9');
    expect(row.provider_place_id).toBe('way/520463101');
    expect(row.span_meters).toBe(1480);
    expect(row.map_picked).toBe(false);
    expect(row.longitude).toBe(127.0016);
    expect(row.latitude).toBe(37.587);
    expect(row.base_version).toBe(3);
    expect(row.base_canonical_version).toBe('legacy');
  });

  it('🔴 행에 `location`을 담지 않는다 — 서버 생성 컬럼이라 앱이 쓰면 안 된다(0022)', () => {
    // 경도·위도 순서를 앱이 정하지 않는 것이 이 설계의 요점이다.
    expect(Object.keys(toPlaceRow(base, 'u'))).not.toContain('location');
  });

  it('fromPlaceRow ∘ toPlaceRow = 항등(핵심 필드)', () => {
    expect(fromPlaceRow(toPlaceRow(base, 'user-9'))).toEqual(base);
  });

  it('지도에서 찍은 장소는 제공자 정보가 없고 그것이 정상이다', () => {
    const picked: LocalPlace = {
      ...base,
      provider: null,
      providerPlaceId: null,
      mapPicked: true,
      precision: null,
      spanMeters: null,
    };
    delete (picked as { providerKey?: string }).providerKey;
    const round = fromPlaceRow(toPlaceRow(picked, 'u'));
    expect(round.provider).toBeNull();
    expect(round.providerKey).toBeUndefined(); // 인덱스에서 빠진다 — 이름만으로 중복 판정하지 않는다
    expect(round.mapPicked).toBe(true);
    expect(round.precision).toBeNull();
  });

  it('tombstone도 왕복한다', () => {
    const dead = { ...base, deletedAt: '2026-07-30T10:00:00.000Z' };
    expect(fromPlaceRow(toPlaceRow(dead, 'u')).deletedAt).toBe('2026-07-30T10:00:00.000Z');
  });

  it('🔴 서버 표기(+00:00)를 로컬 정규 표기로 바꾼다(M-0034)', () => {
    // 서버는 ms 끝 0을 생략하고 오프셋을 `+00:00`으로 준다. 문자열로 비교하는 자리가
    // 그 차이를 **시간 차이**로 읽으면 LWW가 동률 판정을 건너뛴다.
    const row: PlaceRow = {
      ...toPlaceRow(base, 'u'),
      created_at: '2026-07-30T09:20:00.34+00:00',
      updated_at: '2026-07-30T09:25:00+00:00',
      deleted_at: '2026-07-30T10:00:00.5+00:00',
    };
    const back = fromPlaceRow(row);
    expect(back.createdAt).toBe('2026-07-30T09:20:00.340Z');
    expect(back.updatedAt).toBe('2026-07-30T09:25:00.000Z');
    expect(back.deletedAt).toBe('2026-07-30T10:00:00.500Z');
  });

  it('이름이 비어 오면 사람이 읽을 값으로 대체한다(빈 줄을 화면에 내보내지 않는다)', () => {
    expect(fromPlaceRow({ ...toPlaceRow(base, 'u'), name: '' }).name).toBe('이름 없음');
  });
});

describe('providerKeyOf', () => {
  it('제공자와 id가 둘 다 있을 때만 키를 만든다', () => {
    expect(providerKeyOf('kakao', '123')).toBe('kakao/123');
    expect(providerKeyOf('kakao', null)).toBeUndefined();
    expect(providerKeyOf(null, '123')).toBeUndefined();
    expect(providerKeyOf(null, null)).toBeUndefined();
  });
});
