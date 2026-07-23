import { describe, it, expect } from 'vitest';
import { buildNominatimUrl, parseNominatimResults } from '../../src/services/geocode';

describe('buildNominatimUrl', () => {
  it('질의를 인코딩하고 필수 파라미터를 넣는다', () => {
    const url = buildNominatimUrl('김포공항');
    expect(url).toContain('nominatim.openstreetmap.org/search');
    expect(url).toContain('format=jsonv2');
    expect(url).toContain('limit=5');
    expect(url).toContain(`q=${encodeURIComponent('김포공항')}`);
  });
  it('앞뒤 공백을 제거한다', () => {
    expect(buildNominatimUrl('  제주  ')).toContain(`q=${encodeURIComponent('제주')}`);
  });
});

describe('parseNominatimResults', () => {
  it('lat/lon(문자열)을 숫자 좌표로 변환하고 이름을 뽑는다', () => {
    const r = parseNominatimResults([
      { lat: '37.5583', lon: '126.7906', name: '김포국제공항', display_name: '김포국제공항, 서울' },
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]).toEqual({ name: '김포국제공항', displayName: '김포국제공항, 서울', lat: 37.5583, lng: 126.7906 });
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
});
