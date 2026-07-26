// ui/screens/mapView.ts — 여행 지도 모달. 위치가 있는 순간을 MapLibre로 보여준다.
// 규율(map-experience-designer):
//  - 지도는 장식이 아니라 공간적 기억 복원 도구. 마커를 열면 좌표가 아니라 사진·기록.
//  - 팝업에 사용자 텍스트를 문자열로 보간하지 않는다 — DOM 노드(textContent)로 안전하게(§XSS).
//  - 오프라인 우선: 타일을 못 받거나 WebGL이 없으면 지도 대신 '장소 목록'으로 기억에 닿는다.
//  - 사진이 주인공: 팝업/목록에서 썸네일이 먼저.
// MapLibre는 동적 import로 코드 분할(지도를 열 때만 로드).

import { el } from '../dom';
import { toFeatureCollection, type LocatedPoint } from '../../domain/place/geojson';
import { localDateTime } from '../../domain/time';

export interface MapPoint extends LocatedPoint {
  placeName: string;
  previewBlob?: Blob; // 미리보기 이미지(표시본 ≤1600 — 썸네일보다 선명)
}

// 기본 지도 스타일(키 불필요, 귀속표시). VITE_MAP_STYLE_URL로 교체 가능(ADR A-006).
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

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = el('a') as HTMLAnchorElement;
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 팝업/목록에 쓰는 순간 카드(DOM 노드 — 문자열 보간 없음). objectUrls에 썸네일 URL 적재. */
function pointNode(p: MapPoint, objectUrls: string[]): HTMLElement {
  const box = el('div', 'map-pop');
  if (p.previewBlob) {
    const url = URL.createObjectURL(p.previewBlob);
    objectUrls.push(url);
    const img = el('img', 'map-pop-thumb') as HTMLImageElement;
    img.src = url;
    img.alt = '여행 사진';
    box.appendChild(img);
  }
  box.appendChild(el('p', 'map-pop-title', p.title));
  const meta = localDateTime(p.occurredAt);
  if (p.placeName) box.appendChild(el('p', 'map-pop-meta', `📍 ${p.placeName}`));
  if (meta) box.appendChild(el('p', 'map-pop-meta', meta));
  return box;
}

/** 지도 모달을 연다. 위치가 있는 순간(points)을 지도/목록으로 보여준다. */
export function openMapView(tripTitle: string, points: MapPoint[]): void {
  const prevFocus = document.activeElement as HTMLElement | null;
  const objectUrls: string[] = [];

  const overlay = el('div', 'overlay-base map-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', `${tripTitle} 지도`);

  const modal = el('div', 'modal-base map-modal');
  const header = el('div', 'map-header');
  header.appendChild(el('h2', 'map-title', `🗺 ${tripTitle}`));
  const actions = el('div', 'map-header-actions');
  const geoBtn = el('button', 'btn-ghost', '⬇ GeoJSON') as HTMLButtonElement;
  geoBtn.type = 'button';
  geoBtn.disabled = points.length === 0;
  geoBtn.setAttribute('aria-label', '위치를 GeoJSON 파일로 내보내기');
  geoBtn.addEventListener('click', () => {
    const fc = toFeatureCollection(points);
    const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' });
    downloadBlob(blob, 'bugeon-journey-places.geojson');
  });
  const closeBtn = el('button', 'map-close', '✕') as HTMLButtonElement;
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', '지도 닫기');
  actions.append(geoBtn, closeBtn);
  header.appendChild(actions);
  modal.appendChild(header);

  const body = el('div', 'map-body');
  modal.appendChild(body);
  overlay.appendChild(modal);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let map: any = null;
  const close = (): void => {
    try {
      map?.remove();
    } catch {
      /* 이미 정리됨 */
    }
    for (const u of objectUrls) URL.revokeObjectURL(u);
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (prevFocus && document.contains(prevFocus)) prevFocus.focus();
  };
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') close();
  }
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKey);

  document.body.appendChild(overlay);
  closeBtn.focus();

  // 위치 순간이 없으면 안내(빈 상태).
  if (points.length === 0) {
    const empty = el('div', 'map-empty');
    empty.append(
      el('p', 'empty-emoji', '🗺'),
      el('h3', undefined, '아직 지도에 표시할 위치가 없어요'),
      el('p', 'muted', '사진에 위치정보(GPS)가 있으면 그 순간이 지도에 나타나요.'),
    );
    body.appendChild(empty);
    return;
  }

  // 지도 대신 항상 접근 가능한 '장소 목록'(오프라인 대체·기본 접근 보장).
  const list = el('div', 'map-list');
  for (const p of points) {
    const row = el('button', 'map-list-row') as HTMLButtonElement;
    row.type = 'button';
    row.appendChild(pointNode(p, objectUrls));
    row.addEventListener('click', () => {
      if (map) {
        try {
          map.flyTo({ center: [p.lng, p.lat], zoom: 14 });
        } catch {
          /* 지도 없으면 무시 */
        }
      }
    });
    list.appendChild(row);
  }

  const mapEl = el('div', 'map-canvas');
  body.append(mapEl, list);

  // WebGL 없음·타일 차단 등으로 지도가 뜨지 않으면 캔버스를 감추고 목록만 쓴다(오프라인 우선).
  let mapLoaded = false;
  const degradeToList = (): void => {
    if (mapLoaded) return;
    mapEl.classList.add('is-failed');
    if (!body.querySelector('.map-fallback-note')) {
      const note = el('p', 'map-fallback-note', '이 기기·네트워크에서 지도를 표시할 수 없어 장소 목록으로 보여드려요.');
      body.insertBefore(note, list);
    }
  };
  const degradeTimer = setTimeout(degradeToList, 4500); // load가 안 뜨면 강등

  // MapLibre 시도 → 실패(WebGL 없음·타일 차단)면 목록만 남긴다(오프라인 우선).
  void (async () => {
    try {
      const maplibregl = (await import('maplibre-gl')).default;
      await import('maplibre-gl/dist/maplibre-gl.css');
      const styleUrl = import.meta.env.VITE_MAP_STYLE_URL as string | undefined;
      map = new maplibregl.Map({
        container: mapEl,
        style: styleUrl && styleUrl.length > 0 ? styleUrl : (OSM_STYLE as unknown as string),
        center: [points[0]!.lng, points[0]!.lat],
        zoom: 10,
        attributionControl: { compact: true },
      });
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

      map.on('load', () => {
        mapLoaded = true;
        clearTimeout(degradeTimer);
        const bounds = new maplibregl.LngLatBounds();
        for (const p of points) {
          const popup = new maplibregl.Popup({ offset: 24, closeButton: true }).setDOMContent(
            pointNode(p, objectUrls),
          );
          new maplibregl.Marker({ color: '#f0836c' })
            .setLngLat([p.lng, p.lat])
            .setPopup(popup)
            .addTo(map);
          bounds.extend([p.lng, p.lat]);
        }
        if (points.length === 1) map.setCenter([points[0]!.lng, points[0]!.lat]);
        else map.fitBounds(bounds, { padding: 48, maxZoom: 14, duration: 0 });
        mapEl.classList.add('is-ready');
      });
      map.on('error', () => {
        /* 타일/스타일 로드 실패는 조용히 — 목록으로 접근 가능(오프라인 우선) */
      });
    } catch {
      // 라이브러리 로드·WebGL 초기화 실패: 지도 캔버스를 감추고 목록만 쓴다.
      clearTimeout(degradeTimer);
      degradeToList();
    }
  })();
}

/**
 * 지도에서 위치를 골라 좌표를 반환한다(Nominatim에 없는 곳·정확한 지점용).
 * 사용자가 지도를 탭하면 마커가 놓이고, "이 위치로 지정"으로 확정. 취소·닫기는 null.
 * WebGL/타일 불가 기기에서는 안내만 표시(장소 검색으로 대체 가능).
 */
export function openMapPicker(initial: { lat: number; lng: number } | null): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement as HTMLElement | null;
    let picked: { lat: number; lng: number } | null = initial ? { ...initial } : null;
    let settled = false;

    const overlay = el('div', 'overlay-base map-overlay');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', '지도에서 위치 선택');
    const modal = el('div', 'modal-base map-modal');
    const header = el('div', 'map-header');
    header.appendChild(el('h2', 'map-title', '🗺 지도에서 위치 선택'));
    const actions = el('div', 'map-header-actions');
    const confirmBtn = el('button', 'btn-primary map-pick-confirm', '이 위치로 지정') as HTMLButtonElement;
    confirmBtn.type = 'button';
    confirmBtn.disabled = picked === null;
    const closeBtn = el('button', 'map-close', '✕') as HTMLButtonElement;
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', '닫기');
    actions.append(confirmBtn, closeBtn);
    header.appendChild(actions);
    const body = el('div', 'map-body');
    const hint = el('p', 'map-fallback-note', '지도를 눌러 위치를 지정하세요. 마커를 끌어 미세 조정할 수 있어요.');
    const mapEl = el('div', 'map-canvas');
    body.append(hint, mapEl);
    modal.append(header, body);
    overlay.appendChild(modal);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let map: any = null;
    const finish = (result: { lat: number; lng: number } | null): void => {
      if (settled) return;
      settled = true;
      try {
        map?.remove();
      } catch {
        /* 이미 정리됨 */
      }
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      if (prevFocus && document.contains(prevFocus)) prevFocus.focus();
      resolve(result);
    };
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') finish(null);
    }
    closeBtn.addEventListener('click', () => finish(null));
    confirmBtn.addEventListener('click', () => finish(picked));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(null);
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    confirmBtn.focus();

    void (async () => {
      try {
        const maplibregl = (await import('maplibre-gl')).default;
        await import('maplibre-gl/dist/maplibre-gl.css');
        const styleUrl = import.meta.env.VITE_MAP_STYLE_URL as string | undefined;
        const center: [number, number] = picked ? [picked.lng, picked.lat] : [127.8, 36.5];
        map = new maplibregl.Map({
          container: mapEl,
          style: styleUrl && styleUrl.length > 0 ? styleUrl : (OSM_STYLE as unknown as string),
          center,
          zoom: picked ? 14 : 6,
          attributionControl: { compact: true },
        });
        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
        let marker: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
        const place = (lng: number, lat: number): void => {
          picked = { lat, lng };
          confirmBtn.disabled = false;
          if (marker) marker.setLngLat([lng, lat]);
          else {
            marker = new maplibregl.Marker({ color: '#f0836c', draggable: true }).setLngLat([lng, lat]).addTo(map);
            marker.on('dragend', () => {
              const p = marker.getLngLat();
              picked = { lat: p.lat, lng: p.lng };
            });
          }
        };
        map.on('load', () => {
          if (picked) place(picked.lng, picked.lat);
          mapEl.classList.add('is-ready');
        });
        map.on('click', (e: { lngLat: { lng: number; lat: number } }) => place(e.lngLat.lng, e.lngLat.lat));
      } catch {
        mapEl.classList.add('is-failed');
        hint.textContent = '이 기기에서는 지도 선택을 쓸 수 없어요. 장소 이름 검색을 이용해 주세요.';
      }
    })();
  });
}
