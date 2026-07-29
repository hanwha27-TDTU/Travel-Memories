import { describe, it, expect } from 'vitest';
import {
  adminLabel,
  buildNominatimReverseUrl,
  buildNominatimUrl,
  parseReverseResult,
  parseAddress,
  parseBBox,
  parseNominatimResults,
} from '../../src/services/geocode';

describe('buildNominatimUrl', () => {
  it('질의를 인코딩하고 필수 파라미터를 넣는다', () => {
    const url = buildNominatimUrl('김포공항');
    expect(url).toContain('nominatim.openstreetmap.org/search');
    expect(url).toContain('format=jsonv2');
    expect(url).toContain(`q=${encodeURIComponent('김포공항')}`);
  });
  it('앞뒤 공백을 제거한다', () => {
    expect(buildNominatimUrl('  제주  ')).toContain(`q=${encodeURIComponent('제주')}`);
  });
  it('정밀도 판정의 근거인 addressdetails를 요구한다', () => {
    expect(buildNominatimUrl('대학로')).toContain('addressdetails=1');
  });
  it('편향 좌표가 없으면 viewbox를 붙이지 않는다(전 세계 검색이 기본)', () => {
    const url = buildNominatimUrl('Roma');
    expect(url).not.toContain('viewbox');
    expect(url).not.toContain('bounded');
  });
  it('편향 좌표를 주면 viewbox를 붙이되 bounded=0 — 해외 결과를 **버리지 않는다**', () => {
    const url = buildNominatimUrl('대학로', { near: { lat: 37.58, lng: 127.0 } });
    expect(url).toContain('viewbox=');
    expect(url).toContain('bounded=0');
  });
  it('깨진 편향 좌표는 무시한다(외부 값을 믿지 않는다)', () => {
    expect(buildNominatimUrl('x', { near: { lat: Number.NaN, lng: 127 } })).not.toContain('viewbox');
  });
  it('limit을 조절할 수 있다', () => {
    expect(buildNominatimUrl('제주', { limit: 3 })).toContain('limit=3');
  });
});

describe('parseBBox', () => {
  it('문자열 4개를 숫자 상자로 바꾼다', () => {
    expect(parseBBox(['37.57', '37.58', '126.99', '127.00'])).toEqual([37.57, 37.58, 126.99, 127.0]);
  });
  it('길이가 다르거나 숫자가 아니면 null', () => {
    expect(parseBBox(['1', '2', '3'])).toBeNull();
    expect(parseBBox(['a', '2', '3', '4'])).toBeNull();
    expect(parseBBox(null)).toBeNull();
  });
});

describe('parseAddress / adminLabel', () => {
  it('한국 주소의 여러 키 모양을 흡수한다(구는 borough로 오기도 한다)', () => {
    const a = parseAddress({
      country: '대한민국',
      country_code: 'KR',
      state: '서울특별시',
      borough: '종로구',
      postcode: '03087',
    });
    expect(a.countryCode).toBe('kr'); // 소문자로 정규화
    expect(a.region).toBe('서울특별시');
    expect(a.district).toBe('종로구');
    expect(a.city).toBeNull(); // 없는 것을 지어내지 않는다
  });
  it('광역시 밖은 county가 city 자리로 온다', () => {
    expect(parseAddress({ county: '양평군' }).city).toBe('양평군');
  });
  it('없는 조각은 null이고 빈 문자열로 채우지 않는다', () => {
    expect(parseAddress(null)).toEqual({
      countryCode: null,
      country: null,
      region: null,
      city: null,
      district: null,
      postcode: null,
    });
  });
  it('행정 라벨은 겹치는 조각을 접는다', () => {
    expect(adminLabel(parseAddress({ state: '서울특별시', city: '서울', borough: '종로구' }))).toBe(
      '서울특별시 종로구',
    );
  });
  it('행정 조각이 하나도 없으면 나라 이름으로 물러선다', () => {
    expect(adminLabel(parseAddress({ country: 'Italia' }))).toBe('Italia');
  });
});

describe('parseNominatimResults', () => {
  it('lat/lon(문자열)을 숫자 좌표로 변환하고 이름을 뽑는다', () => {
    const r = parseNominatimResults([
      { lat: '37.5583', lon: '126.7906', name: '김포국제공항', display_name: '김포국제공항, 서울' },
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]!.name).toBe('김포국제공항');
    expect(r[0]!.lat).toBe(37.5583);
    expect(r[0]!.lng).toBe(126.7906);
  });
  it('name이 없으면 display_name 첫 조각을 쓴다', () => {
    const r = parseNominatimResults([{ lat: '33.24', lon: '126.41', display_name: '협재해변, 제주' }]);
    expect(r[0]!.name).toBe('협재해변');
  });
  it('좌표가 유효하지 않은 항목은 버린다', () => {
    expect(parseNominatimResults([{ lat: 'x', lon: 'y', display_name: 'bad' }])).toEqual([]);
  });
  it('배열이 아니면 빈 결과', () => {
    expect(parseNominatimResults({})).toEqual([]);
    expect(parseNominatimResults(null)).toEqual([]);
  });

  it('🔴 신고 사례 — 「대학로」 응답이 **길**로 판정되고 근거가 보존된다', () => {
    // 실제 Nominatim jsonv2가 도로에 대해 주는 모양(osm_type=way·place_rank 26·boundingbox).
    const r = parseNominatimResults([
      {
        osm_type: 'way',
        osm_id: 520_463_101,
        lat: '37.5870',
        lon: '127.0016',
        name: '대학로',
        display_name: '대학로, 종로구, 서울특별시, 대한민국',
        category: 'highway',
        type: 'secondary',
        place_rank: 26,
        boundingbox: ['37.5745', '37.5878', '126.9985', '127.0015'],
        address: { road: '대학로', borough: '종로구', state: '서울특별시', country_code: 'kr' },
      },
    ]);
    expect(r).toHaveLength(1);
    const p = r[0]!;
    expect(p.precision.precision).toBe('street');
    expect(p.precision.pinpoint).toBe(false); // 「위치 지정됨」이라고만 말하면 안 되는 결과
    expect(p.precision.spanMeters).toBeGreaterThan(1_000);
    expect(p.kind).toBe('highway:secondary');
    expect(p.providerId).toBe('way/520463101'); // place_id가 아니라 OSM 원본 id(재색인에도 안 변함)
    expect(p.bbox).toEqual([37.5745, 37.5878, 126.9985, 127.0015]);
    expect(p.address.district).toBe('종로구');
  });

  it('건물 결과는 점으로 판정된다(등급이 실제로 갈린다 — 공허하지 않다)', () => {
    const r = parseNominatimResults([
      {
        osm_type: 'node',
        osm_id: 1,
        lat: '37.5796',
        lon: '126.9770',
        name: '경복궁',
        display_name: '경복궁, 종로구',
        category: 'tourism',
        type: 'attraction',
        place_rank: 30,
        boundingbox: ['37.5794', '37.5798', '126.9768', '126.9772'],
      },
    ]);
    expect(r[0]!.precision.precision).toBe('point');
    expect(r[0]!.precision.pinpoint).toBe(true);
  });

  it('정밀도 근거가 하나도 없어도 좌표는 살리고 등급만 unknown으로 둔다', () => {
    const r = parseNominatimResults([{ lat: '37.5', lon: '127.0', display_name: '어딘가' }]);
    expect(r).toHaveLength(1);
    expect(r[0]!.precision.precision).toBe('unknown');
    expect(r[0]!.providerId).toBeNull();
    expect(r[0]!.bbox).toBeNull();
  });
});

describe('역지오코딩 (좌표 → 그 자리의 이름)', () => {
  it('URL에 좌표와 건물 단위 zoom이 든다', () => {
    const url = buildNominatimReverseUrl(37.5796, 126.977);
    expect(url).toContain('/reverse?');
    expect(url).toContain('lat=37.5796');
    expect(url).toContain('lon=126.977');
    expect(url).toContain('zoom=18'); // 건물 단위 — 낮추면 동네 이름이 나온다
    expect(url).toContain('addressdetails=1');
  });

  it('🔴 응답이 **객체 하나**다(검색은 배열) — 그 차이를 파서가 구분한다', () => {
    const one = {
      osm_type: 'way',
      osm_id: 999,
      lat: '37.5796',
      lon: '126.9770',
      name: '경복궁',
      display_name: '경복궁, 사직로, 종로구, 서울특별시, 대한민국',
      category: 'tourism',
      type: 'attraction',
      place_rank: 30,
      boundingbox: ['37.5794', '37.5798', '126.9768', '126.9772'],
      address: { borough: '종로구', state: '서울특별시', country_code: 'kr' },
    };
    const hit = parseReverseResult(one);
    expect(hit).not.toBeNull();
    expect(hit!.name).toBe('경복궁');
    expect(hit!.precision.precision).toBe('point');
    expect(hit!.address.district).toBe('종로구');
    expect(hit!.providerId).toBe('way/999');
  });

  it('🔴 아무것도 없는 곳(바다 등)은 null — 이름을 지어내지 않는다(§8)', () => {
    expect(parseReverseResult({ error: 'Unable to geocode' })).toBeNull();
  });

  it('배열이 오면 null이다(검색 응답을 역지오코딩으로 오인하지 않는다)', () => {
    expect(parseReverseResult([{ lat: '37.5', lon: '127.0', display_name: 'x' }])).toBeNull();
  });

  it('깨진 응답은 null', () => {
    expect(parseReverseResult(null)).toBeNull();
    expect(parseReverseResult('nope')).toBeNull();
    expect(parseReverseResult({ lat: 'x', lon: 'y' })).toBeNull();
  });
});
