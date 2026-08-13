// services/mapRenderer.ts — Kakao/MapLibre 지도 SDK 차이를 흡수하는 표시 어댑터.
// 사용자 기록은 읽거나 쓰지 않는다. 실패는 호출자에게 돌려 기존 장소 목록 대체를 보존한다.

import { zoomForSpan } from '../domain/place/precision';
import type { MapCoordinate, MapDisplayProvider } from '../domain/place/mapProvider';
import { toJusoMapPoint } from '../domain/place/jusoMap';

export interface RenderPoint extends MapCoordinate {
  title: string;
}

export interface MapRendererHandle {
  focus(lng: number, lat: number): void;
  destroy(): void;
}

interface JourneyRenderOptions {
  provider: MapDisplayProvider;
  container: HTMLElement;
  points: readonly RenderPoint[];
  kakaoKey: string;
  jusoMapKey: string;
  tomtomKey: string;
  mapStyleUrl: string | undefined;
  markerColor: string;
  popupNode(point: RenderPoint): HTMLElement;
  signal: AbortSignal;
}

interface PickerRenderOptions {
  provider: MapDisplayProvider;
  container: HTMLElement;
  initial: MapCoordinate | null;
  /** 현재 위치는 화면 중심만 옮긴다. 사용자가 누르기 전 선택 마커로 만들지 않는다. */
  center: MapCoordinate | null;
  kakaoKey: string;
  tomtomKey: string;
  mapStyleUrl: string | undefined;
  markerColor: string;
  onPick(coord: MapCoordinate): void;
  signal: AbortSignal;
}

const SINGLE_POINT_ZOOM = zoomForSpan(null);
const KAKAO_SINGLE_POINT_LEVEL = 5;
const LOAD_TIMEOUT_MS = 8_000;

async function renderJusoJourney(options: JourneyRenderOptions): Promise<MapRendererHandle> {
  if (!options.jusoMapKey) throw new Error('정부지도 지도제공 검색 API 키가 설정되지 않았습니다.');
  if (options.signal.aborted) throw abortError();

  const iframe = document.createElement('iframe');
  iframe.className = 'juso-map-frame';
  iframe.title = '행정안전부 주소기반 정부지도';
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  iframe.referrerPolicy = 'origin';
  const sdkUrl = `https://business.juso.go.kr/juso_support_center/js/addrlink/map/jusoro_map_api.min.js?confmKey=${encodeURIComponent(options.jusoMapKey)}&skinType=1`;
  iframe.srcdoc = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#mapWrap{width:100%;height:100%;margin:0;overflow:hidden}</style></head><body><div id="mapWrap" class="mapWrap"></div><script src="${sdkUrl.replaceAll('&', '&amp;')}"></script></body></html>`;
  options.container.replaceChildren(iframe);

  const sendPoints = (): void => {
    const rows = options.points.map((point) => {
      const projected = toJusoMapPoint(point);
      return [point.title, projected.x, projected.y] as const;
    });
    iframe.contentWindow?.postMessage(
      { functionName: 'callJusoroMapApi', params: rows.length === 1 ? [rows[0]![1], rows[0]![2]] : [rows] },
      window.location.origin,
    );
  };

  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('정부지도 SDK 로딩 시간이 초과됐습니다.'));
    }, LOAD_TIMEOUT_MS);
    const cleanup = (): void => {
      window.clearTimeout(timeout);
      options.signal.removeEventListener('abort', abort);
      iframe.removeEventListener('load', loaded);
      iframe.removeEventListener('error', failed);
    };
    const abort = (): void => {
      cleanup();
      reject(abortError());
    };
    const failed = (): void => {
      cleanup();
      reject(new Error('정부지도 SDK를 불러오지 못했습니다.'));
    };
    const loaded = (): void => {
      const sdkWindow = iframe.contentWindow as (Window & { __jusoroMsgBridgeRegistered?: boolean }) | null;
      if (sdkWindow?.__jusoroMsgBridgeRegistered !== true) {
        cleanup();
        reject(new Error('정부지도 SDK가 준비되지 않았습니다.'));
        return;
      }
      cleanup();
      sendPoints();
      resolve();
    };
    options.signal.addEventListener('abort', abort, { once: true });
    iframe.addEventListener('load', loaded, { once: true });
    iframe.addEventListener('error', failed, { once: true });
  });

  return {
    focus(lng, lat) {
      const point = toJusoMapPoint({ lng, lat });
      iframe.contentWindow?.postMessage(
        { functionName: 'callJusoroMapApi', params: [point.x, point.y] },
        window.location.origin,
      );
    },
    destroy() {
      iframe.remove();
    },
  };
}

const OSM_STYLE = {
  version: 8 as const,
  sources: {
    osm: {
      type: 'raster' as const,
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster' as const, source: 'osm' }],
};

function tomtomStyle(key: string) {
  if (!key) throw new Error('TomTom API 키가 설정되지 않았습니다.');
  return {
    version: 8 as const,
    sources: {
      tomtom: {
        type: 'raster' as const,
        tiles: [
          `https://api.tomtom.com/maps/orbis/display/raster/tile/{z}/{x}/{y}?apiVersion=2&key=${encodeURIComponent(key)}&style=street-light&tileSize=256&geopoliticalView=Unified`,
        ],
        tileSize: 256,
        maxzoom: 22,
        attribution: '© TomTom',
      },
    },
    layers: [{ id: 'tomtom', type: 'raster' as const, source: 'tomtom' }],
  };
}

function mapLibreStyle(options: { provider: MapDisplayProvider; tomtomKey: string; mapStyleUrl: string | undefined }) {
  if (options.provider === 'tomtom') return tomtomStyle(options.tomtomKey);
  return options.mapStyleUrl || OSM_STYLE;
}

type KakaoLatLng = { getLat(): number; getLng(): number };
type KakaoMap = {
  setCenter(coord: KakaoLatLng): void;
  setLevel(level: number): void;
  setBounds(bounds: unknown, top?: number, right?: number, bottom?: number, left?: number): void;
};
type KakaoMarker = {
  setMap(map: KakaoMap | null): void;
  setPosition(coord: KakaoLatLng): void;
  getPosition(): KakaoLatLng;
};
type KakaoOverlay = { setMap(map: KakaoMap | null): void };
type KakaoEventTarget = KakaoMap | KakaoMarker;
type KakaoListener = (...args: any[]) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

interface KakaoMaps {
  load(done: () => void): void;
  LatLng: new (lat: number, lng: number) => KakaoLatLng;
  LatLngBounds: new () => { extend(coord: KakaoLatLng): void };
  Map: new (container: HTMLElement, options: { center: KakaoLatLng; level: number }) => KakaoMap;
  Marker: new (options: { map: KakaoMap; position: KakaoLatLng; title?: string; draggable?: boolean }) => KakaoMarker;
  CustomOverlay: new (options: {
    content: HTMLElement;
    position: KakaoLatLng;
    xAnchor: number;
    yAnchor: number;
    clickable: boolean;
  }) => KakaoOverlay;
  event: {
    addListener(target: KakaoEventTarget, name: string, listener: KakaoListener): void;
    removeListener(target: KakaoEventTarget, name: string, listener: KakaoListener): void;
  };
}

declare global {
  interface Window {
    kakao?: { maps?: KakaoMaps };
  }
}

let kakaoPromise: Promise<KakaoMaps> | null = null;

function abortError(): DOMException {
  return new DOMException('지도 로딩이 취소됐습니다.', 'AbortError');
}

function waitForKakaoReady(resolve: (maps: KakaoMaps) => void, reject: (reason?: unknown) => void): void {
  const maps = window.kakao?.maps;
  if (!maps?.load) {
    reject(new Error('카카오 지도 SDK를 읽지 못했습니다.'));
    return;
  }
  maps.load(() => resolve(maps));
}

function loadKakaoMaps(key: string): Promise<KakaoMaps> {
  const ready = window.kakao?.maps;
  if (ready?.Map) return Promise.resolve(ready);
  if (kakaoPromise) return kakaoPromise;
  if (!key) return Promise.reject(new Error('카카오 JavaScript 키가 설정되지 않았습니다.'));

  kakaoPromise = new Promise<KakaoMaps>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-kakao-maps-sdk]');
    const script = existing ?? document.createElement('script');
    const timer = window.setTimeout(() => {
      kakaoPromise = null;
      reject(new Error('카카오 지도 SDK 로딩 시간을 넘겼습니다.'));
    }, LOAD_TIMEOUT_MS);
    const fail = (): void => {
      window.clearTimeout(timer);
      kakaoPromise = null;
      reject(new Error('카카오 지도 SDK를 불러오지 못했습니다.'));
    };
    const load = (): void => {
      window.clearTimeout(timer);
      waitForKakaoReady(resolve, (error) => {
        kakaoPromise = null;
        reject(error);
      });
    };
    script.addEventListener('load', load, { once: true });
    script.addEventListener('error', fail, { once: true });
    if (!existing) {
      script.dataset.kakaoMapsSdk = 'true';
      // 카카오의 등록 도메인 확인에는 출처가 필요하다. 전체 경로는 보내지 않고 origin만 보낸다.
      script.referrerPolicy = 'origin';
      script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&autoload=false`;
      document.head.appendChild(script);
    }
  });
  return kakaoPromise;
}

function waitForKakaoTiles(maps: KakaoMaps, map: KakaoMap, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (): void => {
      cleanup();
      resolve();
    };
    const abort = (): void => {
      cleanup();
      reject(abortError());
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('카카오 지도 타일을 불러오지 못했습니다.'));
    }, LOAD_TIMEOUT_MS);
    const cleanup = (): void => {
      window.clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      maps.event.removeListener(map, 'tilesloaded', done);
    };
    signal.addEventListener('abort', abort, { once: true });
    maps.event.addListener(map, 'tilesloaded', done);
  });
}

async function renderKakaoJourney(options: JourneyRenderOptions): Promise<MapRendererHandle> {
  const maps = await loadKakaoMaps(options.kakaoKey);
  if (options.signal.aborted) throw abortError();
  const first = options.points[0]!;
  const map = new maps.Map(options.container, {
    center: new maps.LatLng(first.lat, first.lng),
    level: options.points.length === 1 ? KAKAO_SINGLE_POINT_LEVEL : 8,
  });
  const tilesReady = waitForKakaoTiles(maps, map, options.signal);
  const bounds = new maps.LatLngBounds();
  for (const point of options.points) bounds.extend(new maps.LatLng(point.lat, point.lng));
  if (options.points.length === 1) {
    map.setCenter(new maps.LatLng(first.lat, first.lng));
    map.setLevel(KAKAO_SINGLE_POINT_LEVEL);
  } else {
    map.setBounds(bounds, 48, 48, 48, 48);
  }
  await tilesReady;

  const cleanups: Array<() => void> = [];
  let activeOverlay: KakaoOverlay | null = null;
  for (const point of options.points) {
    const position = new maps.LatLng(point.lat, point.lng);
    const marker = new maps.Marker({ map, position, title: point.title });
    const overlay = new maps.CustomOverlay({
      content: options.popupNode(point),
      position,
      xAnchor: 0.5,
      yAnchor: 1.15,
      clickable: true,
    });
    const open = (): void => {
      activeOverlay?.setMap(null);
      overlay.setMap(map);
      activeOverlay = overlay;
    };
    maps.event.addListener(marker, 'click', open);
    cleanups.push(() => {
      maps.event.removeListener(marker, 'click', open);
      marker.setMap(null);
      overlay.setMap(null);
    });
  }

  return {
    focus(lng, lat) {
      map.setCenter(new maps.LatLng(lat, lng));
      map.setLevel(KAKAO_SINGLE_POINT_LEVEL);
    },
    destroy() {
      for (const cleanup of cleanups) cleanup();
      options.container.replaceChildren();
    },
  };
}

async function mapLibreModule() {
  const maplibregl = (await import('maplibre-gl')).default;
  await import('maplibre-gl/dist/maplibre-gl.css');
  return maplibregl;
}

async function renderMapLibreJourney(options: JourneyRenderOptions): Promise<MapRendererHandle> {
  const maplibregl = await mapLibreModule();
  if (options.signal.aborted) throw abortError();
  const first = options.points[0]!;
  const map = new maplibregl.Map({
    container: options.container,
    style: mapLibreStyle(options) as unknown as string,
    center: [first.lng, first.lat],
    zoom: options.points.length === 1 ? SINGLE_POINT_ZOOM : 10,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  await new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      map.remove();
      reject(abortError());
    };
    const timeout = window.setTimeout(() => {
      options.signal.removeEventListener('abort', abort);
      map.remove();
      reject(new Error('MapLibre 지도 타일을 불러오지 못했습니다.'));
    }, LOAD_TIMEOUT_MS);
    options.signal.addEventListener('abort', abort, { once: true });
    map.once('load', () => {
      window.clearTimeout(timeout);
      options.signal.removeEventListener('abort', abort);
      resolve();
    });
  });

  const bounds = new maplibregl.LngLatBounds();
  for (const point of options.points) {
    const popup = new maplibregl.Popup({ offset: 24, closeButton: true }).setDOMContent(options.popupNode(point));
    new maplibregl.Marker({ color: options.markerColor }).setLngLat([point.lng, point.lat]).setPopup(popup).addTo(map);
    bounds.extend([point.lng, point.lat]);
  }
  if (options.points.length === 1) {
    map.setCenter([first.lng, first.lat]);
    map.setZoom(SINGLE_POINT_ZOOM);
  } else {
    map.fitBounds(bounds, { padding: 48, maxZoom: 14, duration: 0 });
  }
  return {
    focus(lng, lat) {
      map.flyTo({ center: [lng, lat], zoom: SINGLE_POINT_ZOOM });
    },
    destroy() {
      map.remove();
    },
  };
}

async function renderKakaoPicker(options: PickerRenderOptions): Promise<MapRendererHandle> {
  const maps = await loadKakaoMaps(options.kakaoKey);
  if (options.signal.aborted) throw abortError();
  const center = options.center ?? options.initial ?? { lat: 36.5, lng: 127.8 };
  const map = new maps.Map(options.container, {
    center: new maps.LatLng(center.lat, center.lng),
    level: options.center || options.initial ? KAKAO_SINGLE_POINT_LEVEL : 9,
  });
  await waitForKakaoTiles(maps, map, options.signal);

  let marker: KakaoMarker | null = options.initial
    ? new maps.Marker({ map, position: new maps.LatLng(options.initial.lat, options.initial.lng), draggable: true })
    : null;
  const markerDrag = (): void => {
    if (!marker) return;
    const position = marker.getPosition();
    options.onPick({ lat: position.getLat(), lng: position.getLng() });
  };
  if (marker) maps.event.addListener(marker, 'dragend', markerDrag);
  const click = (event: { latLng: KakaoLatLng }): void => {
    const coord = { lat: event.latLng.getLat(), lng: event.latLng.getLng() };
    if (!marker) {
      marker = new maps.Marker({ map, position: event.latLng, draggable: true });
      maps.event.addListener(marker, 'dragend', markerDrag);
    } else {
      marker.setPosition(event.latLng);
    }
    options.onPick(coord);
  };
  maps.event.addListener(map, 'click', click);
  return {
    focus(lng, lat) {
      map.setCenter(new maps.LatLng(lat, lng));
      map.setLevel(KAKAO_SINGLE_POINT_LEVEL);
    },
    destroy() {
      maps.event.removeListener(map, 'click', click);
      if (marker) {
        maps.event.removeListener(marker, 'dragend', markerDrag);
        marker.setMap(null);
      }
      options.container.replaceChildren();
    },
  };
}

async function renderMapLibrePicker(options: PickerRenderOptions): Promise<MapRendererHandle> {
  const maplibregl = await mapLibreModule();
  if (options.signal.aborted) throw abortError();
  const centerCoord = options.center ?? options.initial;
  const center: [number, number] = centerCoord ? [centerCoord.lng, centerCoord.lat] : [127.8, 36.5];
  const map = new maplibregl.Map({
    container: options.container,
    style: mapLibreStyle(options) as unknown as string,
    center,
    zoom: centerCoord ? SINGLE_POINT_ZOOM : 6,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      map.remove();
      reject(abortError());
    };
    const timeout = window.setTimeout(() => {
      options.signal.removeEventListener('abort', abort);
      map.remove();
      reject(new Error('MapLibre 지도 타일을 불러오지 못했습니다.'));
    }, LOAD_TIMEOUT_MS);
    options.signal.addEventListener('abort', abort, { once: true });
    map.once('load', () => {
      window.clearTimeout(timeout);
      options.signal.removeEventListener('abort', abort);
      resolve();
    });
  });
  let marker: InstanceType<typeof maplibregl.Marker> | null = null;
  const place = (lng: number, lat: number): void => {
    options.onPick({ lat, lng });
    if (marker) marker.setLngLat([lng, lat]);
    else {
      marker = new maplibregl.Marker({ color: options.markerColor, draggable: true }).setLngLat([lng, lat]).addTo(map);
      marker.on('dragend', () => {
        const coord = marker!.getLngLat();
        options.onPick({ lat: coord.lat, lng: coord.lng });
      });
    }
  };
  if (options.initial) place(options.initial.lng, options.initial.lat);
  map.on('click', (event: { lngLat: { lng: number; lat: number } }) => place(event.lngLat.lng, event.lngLat.lat));
  return {
    focus(lng, lat) {
      map.flyTo({ center: [lng, lat], zoom: SINGLE_POINT_ZOOM });
    },
    destroy() {
      map.remove();
    },
  };
}

export async function renderJourneyMap(options: JourneyRenderOptions): Promise<MapRendererHandle> {
  if (options.provider === 'kakao') return renderKakaoJourney(options);
  if (options.provider === 'juso') return renderJusoJourney(options);
  return renderMapLibreJourney(options);
}

export async function renderPickerMap(options: PickerRenderOptions): Promise<MapRendererHandle> {
  return options.provider === 'kakao' ? renderKakaoPicker(options) : renderMapLibrePicker(options);
}
