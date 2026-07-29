import { describe, it, expect } from 'vitest';
import {
  FN_OPS,
  FN_VERSION,
  availableProviders,
  kakaoAddressRank,
  normalizeKakaoAddress,
  normalizeKakaoKeyword,
  normalizeVworld,
  splitKoreanAddress,
} from '../../supabase/functions/geocode/index';
import { parseProxyRows } from '../../src/services/geocode';

describe('Edge Function 계약', () => {
  it('판(version)과 op 목록을 스스로 밝힌다', () => {
    expect(FN_VERSION).toBeGreaterThanOrEqual(1);
    expect([...FN_OPS]).toEqual(['search', 'capabilities']);
  });
  it('시크릿이 있는 제공자만 「쓸 수 있다」고 말한다', () => {
    expect(availableProviders(() => undefined)).toEqual([]);
    expect(availableProviders((k) => (k === 'KAKAO_REST_KEY' ? 'x' : undefined))).toEqual(['kakao']);
    expect(availableProviders((k) => (k === 'VWORLD_KEY' ? 'x' : undefined))).toEqual(['vworld']);
    expect(availableProviders(() => 'x')).toEqual(['kakao', 'vworld']);
  });
});

describe('splitKoreanAddress', () => {
  it('시·도와 시·군·구를 앞 두 토큰에서 뽑는다', () => {
    expect(splitKoreanAddress('서울 종로구 동숭동 1-1')).toEqual({ region: '서울', city: '종로구' });
  });
  it('없으면 null(빈 문자열로 채우지 않는다)', () => {
    expect(splitKoreanAddress(null)).toEqual({ region: null, city: null });
    expect(splitKoreanAddress('서울')).toEqual({ region: '서울', city: null });
  });
});

describe('kakaoAddressRank — 카카오 주소 종류 → 우리 등급 자', () => {
  it('건물번호까지 확정된 주소는 건물 등급', () => {
    expect(kakaoAddressRank('ROAD_ADDR')).toBe(30);
    expect(kakaoAddressRank('REGION_ADDR')).toBe(30);
  });
  it('도로명만이면 길, 지역명만이면 동네', () => {
    expect(kakaoAddressRank('ROAD')).toBe(26);
    expect(kakaoAddressRank('REGION')).toBe(22);
  });
  it('🔴 모르는 값은 null — 정밀한 쪽으로 반올림하지 않는다(§8)', () => {
    expect(kakaoAddressRank('WHATEVER')).toBeNull();
    expect(kakaoAddressRank(null)).toBeNull();
  });
});

describe('normalizeKakaoKeyword', () => {
  const sample = {
    documents: [
      {
        id: '26338954',
        place_name: '스타벅스 종로점',
        address_name: '서울 종로구 종로1가 24',
        road_address_name: '서울 종로구 종로 51',
        category_group_name: '카페',
        category_name: '음식점 > 카페 > 스타벅스',
        x: '126.9829',
        y: '37.5701',
      },
    ],
  };
  it('🔴 x=경도 · y=위도를 뒤집지 않는다(뒤집으면 다른 나라가 나온다)', () => {
    const r = normalizeKakaoKeyword(sample);
    expect(r).toHaveLength(1);
    expect(r[0]!.lat).toBeCloseTo(37.5701, 4);
    expect(r[0]!.lng).toBeCloseTo(126.9829, 4);
  });
  it('키워드 결과는 POI이므로 건물 등급으로 옮긴다', () => {
    expect(normalizeKakaoKeyword(sample)[0]!.placeRank).toBe(30);
  });
  it('행정 조각과 안정 id를 남긴다', () => {
    const r = normalizeKakaoKeyword(sample)[0]!;
    expect(r.address.region).toBe('서울');
    expect(r.address.city).toBe('종로구');
    expect(r.address.countryCode).toBe('kr');
    expect(r.providerId).toBe('kakao/26338954');
  });
  it('경계상자가 없으면 null로 둔다(지어내지 않는다)', () => {
    expect(normalizeKakaoKeyword(sample)[0]!.bbox).toBeNull();
  });
  it('깨진 응답은 빈 결과', () => {
    expect(normalizeKakaoKeyword(null)).toEqual([]);
    expect(normalizeKakaoKeyword({ documents: 'nope' })).toEqual([]);
    expect(normalizeKakaoKeyword({ documents: [{ place_name: '이름만', x: 'a', y: 'b' }] })).toEqual([]);
  });
});

describe('normalizeKakaoAddress', () => {
  it('address_type이 등급을 정한다', () => {
    const rows = normalizeKakaoAddress({
      documents: [
        { address_name: '서울 종로구 대학로', address_type: 'ROAD', x: '127.0016', y: '37.587' },
        { address_name: '서울 종로구 대학로 101', address_type: 'ROAD_ADDR', x: '127.0016', y: '37.579', road_address: { zone_no: '03080' } },
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.placeRank).toBe(26); // 도로명만 → 길
    expect(rows[1]!.placeRank).toBe(30); // 건물번호까지 → 건물
    expect(rows[1]!.address.postcode).toBe('03080');
  });
});

describe('normalizeVworld', () => {
  const sample = {
    response: {
      result: {
        items: [
          {
            id: 'PLACE_1',
            title: '경복궁',
            category: '문화시설',
            address: { zipcode: '03045', road: '서울특별시 종로구 사직로 161', parcel: '서울특별시 종로구 세종로 1-1' },
            point: { x: '126.9770', y: '37.5796' },
          },
        ],
      },
    },
  };
  it('point.x=경도 · point.y=위도', () => {
    const r = normalizeVworld(sample, 'place')[0]!;
    expect(r.lat).toBeCloseTo(37.5796, 4);
    expect(r.lng).toBeCloseTo(126.977, 4);
  });
  it('무엇을 물었는지가 kind에 남는다', () => {
    expect(normalizeVworld(sample, 'place')[0]!.kind).toBe('문화시설');
    expect(normalizeVworld(sample, 'address')[0]!.kind).toBe('address');
  });
  it('도로명 주소를 우선해 행정 조각을 만든다', () => {
    const r = normalizeVworld(sample, 'place')[0]!;
    expect(r.address.region).toBe('서울특별시');
    expect(r.address.city).toBe('종로구');
    expect(r.providerId).toBe('vworld/PLACE_1');
  });
  it('깨진 응답은 빈 결과', () => {
    expect(normalizeVworld(null, 'place')).toEqual([]);
    expect(normalizeVworld({ response: { result: {} } }, 'place')).toEqual([]);
  });
});

describe('parseProxyRows — 🔴 정밀도는 **앱이 다시 판정한다**', () => {
  it('서버가 보낸 랭크를 앱의 자로 재분류한다(등급 규칙은 앱에 한 벌만 있다 — §7)', () => {
    const rows = parseProxyRows(
      { rows: [{ provider: 'kakao', name: '대학로', lat: 37.587, lng: 127.0016, placeRank: 26, address: {} }] },
      'kakao',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.precision.precision).toBe('street'); // 서버가 아니라 우리가 판정한 값
    expect(rows[0]!.precision.pinpoint).toBe(false);
    expect(rows[0]!.provider).toBe('kakao');
  });
  it('랭크·경계상자가 없으면 unknown으로 남는다(모르는 것을 반올림하지 않는다)', () => {
    const rows = parseProxyRows({ rows: [{ name: '어딘가', lat: 37.5, lng: 127.0 }] }, 'vworld');
    expect(rows[0]!.precision.precision).toBe('unknown');
    expect(rows[0]!.provider).toBe('vworld'); // provider가 비면 호출한 쪽 이름으로 채운다
  });
  it('좌표나 이름이 깨진 행은 버린다', () => {
    expect(parseProxyRows({ rows: [{ name: '이름만' }] }, 'kakao')).toEqual([]);
    expect(parseProxyRows({ rows: [{ lat: 1, lng: 2 }] }, 'kakao')).toEqual([]);
    expect(parseProxyRows(null, 'kakao')).toEqual([]);
  });
});
