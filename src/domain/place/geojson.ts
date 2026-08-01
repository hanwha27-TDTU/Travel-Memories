// domain/place/geojson.ts — 위치가 있는 순간 → GeoJSON(순수, 테스트로 잠금).
// 좌표원: 순간에 딸린 사진의 EXIF GPS(§0 — 압축 전 추출). 없는 위치를 지어내지 않는다.
// GeoJSON 좌표 순서는 [경도(lng), 위도(lat)] (RFC 7946).

import { isRealCoord } from './coordInput';

export interface MediaGps {
  gpsLat: number | null;
  gpsLng: number | null;
}

export interface LocatedPoint {
  momentId: string;
  title: string;
  occurredAt: string;
  lat: number;
  lng: number;
}

/** 순간의 대표 좌표 = GPS가 있는 첫 사진. 없으면 null(대략위치를 지어내지 않음). */
export function momentCoord(mediaList: readonly MediaGps[]): { lat: number; lng: number } | null {
  for (const m of mediaList) {
    // 🔴 「진짜 좌표인가」는 단 하나의 함수가 판정한다(H-3 · isRealCoord — NaN·범위밖·0,0을
    // 한꺼번에 거른다). 지도에 기니만 앞바다 핀을 찍지 않는다(M-0057).
    // isRealCoord가 유한·범위·비-0,0을 보장하므로 여기 값은 실수다(두 인자라 타입가드는 못 된다).
    if (isRealCoord(m.gpsLat, m.gpsLng)) return { lat: m.gpsLat as number, lng: m.gpsLng as number };
  }
  return null;
}

export interface GeoFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: { momentId: string; title: string; occurredAt: string };
}
export interface GeoFeatureCollection {
  type: 'FeatureCollection';
  features: GeoFeature[];
}

/** 위치 순간 목록 → GeoJSON FeatureCollection. 좌표는 [lng, lat]. */
export function toFeatureCollection(points: readonly LocatedPoint[]): GeoFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: points.map((p) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      properties: { momentId: p.momentId, title: p.title, occurredAt: p.occurredAt },
    })),
  };
}
