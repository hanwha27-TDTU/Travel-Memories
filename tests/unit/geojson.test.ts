import { describe, it, expect } from 'vitest';
import { momentCoord, toFeatureCollection } from '../../src/domain/place/geojson';

describe('momentCoord', () => {
  it('GPS가 있는 첫 사진의 좌표를 고른다', () => {
    expect(
      momentCoord([
        { gpsLat: null, gpsLng: null },
        { gpsLat: 33.24, gpsLng: 126.41 },
        { gpsLat: 37.5, gpsLng: 127.0 },
      ]),
    ).toEqual({ lat: 33.24, lng: 126.41 });
  });
  it('GPS 없으면 null(대략위치 안 지어냄)', () => {
    expect(momentCoord([{ gpsLat: null, gpsLng: null }])).toBeNull();
    expect(momentCoord([])).toBeNull();
  });
});

describe('toFeatureCollection', () => {
  it('좌표는 [lng, lat] 순서(RFC 7946)', () => {
    const fc = toFeatureCollection([
      { momentId: 'm1', title: '협재 해변', occurredAt: '2026-07-17T09:00:00Z', lat: 33.24, lng: 126.41 },
    ]);
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0]!.geometry.coordinates).toEqual([126.41, 33.24]);
    expect(fc.features[0]!.properties.title).toBe('협재 해변');
  });
  it('빈 목록은 features 0개', () => {
    expect(toFeatureCollection([]).features).toEqual([]);
  });
});
