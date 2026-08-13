import { describe, expect, it } from 'vitest';

import { toJusoMapPoint } from '../../src/domain/place/jusoMap';

describe('정부지도 좌표 변환', () => {
  it('공식 안내서 예시 WGS84 좌표를 EPSG:5179로 바꾼다', () => {
    const point = toJusoMapPoint({ lng: 126.88793748501445, lat: 37.582468731587305 });
    expect(point.x).toBeCloseTo(945959.04, 0);
    expect(point.y).toBeCloseTo(1953851.73, 0);
  });

  it('숫자가 아닌 좌표는 보내지 않는다', () => {
    expect(() => toJusoMapPoint({ lng: Number.NaN, lat: 37.5 })).toThrow(/좌표/);
  });
});
