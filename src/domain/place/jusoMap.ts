// 행정안전부 주소기반산업지원서비스 지도 API는 WGS84가 아니라 EPSG:5179 좌표를 받는다.
// 변환은 화면/SDK 어댑터 밖의 순수 함수로 두어 키가 발급되기 전에도 정확성을 검증한다.
import proj4 from 'proj4';

import type { MapCoordinate } from './mapProvider';

const WGS84 = 'EPSG:4326';
const JUSO_GRS80 = '+proj=tmerc +lat_0=38 +lon_0=127.5 +k=0.9996 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +units=m +no_defs';

export interface JusoMapPoint {
  x: number;
  y: number;
}

export function toJusoMapPoint(coord: MapCoordinate): JusoMapPoint {
  if (!Number.isFinite(coord.lat) || !Number.isFinite(coord.lng)) {
    throw new Error('정부지도에 보낼 좌표가 올바르지 않습니다.');
  }
  const [x, y] = proj4(WGS84, JUSO_GRS80, [coord.lng, coord.lat]);
  return { x, y };
}

