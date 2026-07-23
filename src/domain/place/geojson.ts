// domain/place/geojson.ts — 위치가 있는 순간 → GeoJSON(순수, 테스트로 잠금).
// 좌표원: 순간에 딸린 사진의 EXIF GPS(§0 — 압축 전 추출). 없는 위치를 지어내지 않는다.
// GeoJSON 좌표 순서는 [경도(lng), 위도(lat)] (RFC 7946).

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
    if (m.gpsLat !== null && m.gpsLng !== null && Number.isFinite(m.gpsLat) && Number.isFinite(m.gpsLng)) {
      return { lat: m.gpsLat, lng: m.gpsLng };
    }
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
