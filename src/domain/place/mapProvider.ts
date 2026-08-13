// domain/place/mapProvider.ts — 지도 **표시** 제공자 판정의 유일한 자리.
// 장소 검색 제공자(provider.ts)와는 다른 축이다: 검색은 Kakao/Nominatim, 표시는 Kakao/MapLibre다.

export type MapDisplayProvider = 'kakao' | 'maplibre';

export interface MapCoordinate {
  lat: number;
  lng: number;
}

interface CoordinateBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/**
 * 대한민국 지도 표시용 작동 경계.
 *
 * 국경을 판정하거나 사용자 기록을 분류하는 데이터가 아니다. 카카오 지도 표시 여부만 고른다.
 * 본토·서남해/제주·울릉/독도를 나눠, 하나의 큰 사각형이 주변 국가를 과하게 삼키지 않게 한다.
 */
const KOREA_MAP_BOXES: readonly CoordinateBox[] = [
  { minLat: 34.0, maxLat: 38.7, minLng: 124.5, maxLng: 130.0 },
  { minLat: 32.8, maxLat: 34.1, minLng: 125.7, maxLng: 127.4 },
  { minLat: 37.0, maxLat: 38.0, minLng: 130.0, maxLng: 132.2 },
];

export function isKoreaMapCoordinate(coord: MapCoordinate): boolean {
  if (!Number.isFinite(coord.lat) || !Number.isFinite(coord.lng)) return false;
  return KOREA_MAP_BOXES.some(
    (box) =>
      coord.lat >= box.minLat &&
      coord.lat <= box.maxLat &&
      coord.lng >= box.minLng &&
      coord.lng <= box.maxLng,
  );
}

/**
 * 여행 지도는 **표시할 점이 전부 한국일 때만** 카카오를 쓴다.
 * 여러 나라가 섞인 여행을 카카오에 억지로 넣지 않고 기존 세계지도(MapLibre)로 보존한다.
 */
export function displayProviderForPoints(
  points: readonly MapCoordinate[],
  kakaoKeyConfigured: boolean,
): MapDisplayProvider {
  if (!kakaoKeyConfigured || points.length === 0) return 'maplibre';
  return points.every(isKoreaMapCoordinate) ? 'kakao' : 'maplibre';
}

/** 좌표가 아직 없으면 지역도 미정이므로 기존 세계지도를 유지한다. */
export function displayProviderForPicker(
  initial: MapCoordinate | null,
  kakaoKeyConfigured: boolean,
): MapDisplayProvider {
  if (!initial || !kakaoKeyConfigured) return 'maplibre';
  return isKoreaMapCoordinate(initial) ? 'kakao' : 'maplibre';
}

/** 카카오 실패 시 기존 MapLibre로 닫히도록 하는 순서도 한 곳에서 파생한다. */
export function displayProviderFallbackOrder(preferred: MapDisplayProvider): readonly MapDisplayProvider[] {
  return preferred === 'kakao' ? ['kakao', 'maplibre'] : ['maplibre'];
}

