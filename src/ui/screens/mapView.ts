// ui/screens/mapView.ts — 여행 지도 모달. 한국은 Kakao, 그 밖은 MapLibre로 보여준다.
// 규율(map-experience-designer):
//  - 지도는 장식이 아니라 공간적 기억 복원 도구. 마커를 열면 좌표가 아니라 사진·기록.
//  - 팝업에 사용자 텍스트를 문자열로 보간하지 않는다 — DOM 노드(textContent)로 안전하게(§XSS).
//  - 오프라인 우선: 타일을 못 받거나 WebGL이 없으면 지도 대신 '장소 목록'으로 기억에 닿는다.
//  - 사진이 주인공: 팝업/목록에서 썸네일이 먼저.
// 지도 SDK는 서비스 어댑터에서 필요할 때만 로드한다.

import { el } from '../dom';
import { toFeatureCollection, type LocatedPoint } from '../../domain/place/geojson';
import type { PlaceLike } from '../../domain/place/externalMap';
import { displayProviderFallbackOrder, displayProviderForPicker, displayProviderForPoints } from '../../domain/place/mapProvider';
import { renderJourneyMap, renderPickerMap, type MapRendererHandle } from '../../services/mapRenderer';
import { externalMapRow } from '../externalMapRow';

/**
 * 지도 마커 색 — **하드코딩하지 않고 `--a1`(여름 강조색) 토큰에서 읽는다**(색 SSOT는 tokens.css).
 * MapLibre `Marker`는 CSS 변수가 아니라 문자열을 요구하므로 런타임에 계산값을 한 번 뽑는다.
 * 토큰을 못 읽는 극단적 경우(테스트 등)만 그 토큰의 기본값으로 떨어진다.
 */
function markerColor(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--a1').trim();
  return v || '#f0836c'; // color-token-ok: --a1(여름)의 기본값 폴백 — 토큰을 못 읽을 때만. SSOT는 tokens.css.
}

export interface MapPoint extends LocatedPoint {
  placeName: string;
  previewBlob?: Blob; // 미리보기 이미지(표시본 ≤1600 — 썸네일보다 선명)
  /**
   * 팝업에 그대로 붙는 시각 문장(`YYYY.MM.DD HH:mm`). **없으면 빈 문자열.**
   *
   * 🔴 이 화면이 시각을 **계산하지 않는다**(2026-07-30). 예전엔 여기서 `localDateTime`을
   * 불렀고 그건 **보는 기기의 시간대**였다 — 같은 순간이 타임라인에서 19:08, 지도 팝업에서
   * 21:08로 보였다. 시계를 아는 곳(여행 상세)이 문장을 만들어 내려보내면, 이 화면에는
   * 시간대를 틀릴 **방법이 없다**(§7 2층 — 규칙을 한 곳에만 두고 형제가 통과하게).
   */
  whenText: string;
}

/**
 * 「다른 지도에서 열기」 줄. **없으면 만들지 않는다**(열 곳이 없으면 버튼도 없다).
 *
 * 왜 앱 지도 *안*에 두는가(사용자 결정 2026-07-27): 앱 지도가 주(主)다 — 비공개이고
 * 오프라인에서도 뜬다. 바깥 지도는 길찾기·스트리트뷰가 필요할 때 **한 걸음 더 가서** 여는 곳이다.
 *
 * 그리는 일은 `ui/externalMapRow`가 한다 — 장소 검색 실패 자리(`tripDetail`)도 같은 부품을
 * 쓰므로, 동의·`noreferrer`·caveat 규율이 **한 곳에만** 구현된다(§7 2층. 2026-07-30에
 * 여기 인라인이던 것을 뽑았다).
 */
function externalMapButton(place: PlaceLike): HTMLElement | null {
  return externalMapRow(place, { lead: '다른 지도에서 열기' });
}

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
  const meta = p.whenText;
  if (p.placeName) box.appendChild(el('p', 'map-pop-meta', `📍 ${p.placeName}`));
  if (meta) box.appendChild(el('p', 'map-pop-meta', meta));
  return box;
}

/**
 * 위치가 하나도 없을 때의 안내.
 *
 * **장소 칩에서 열었는데 좌표가 없는 경우**와 **여행에 위치가 하나도 없는 경우**는 다른
 * 사정이다. 같은 문장으로 뭉뚱그리면 사용자는 무엇을 해야 할지 알 수 없다 — 앞은
 * "이 장소에 좌표를 넣으려면 검색으로 고르라"이고, 뒤는 "사진에 GPS가 있으면 나타난다"이다.
 */
// 🔴 §7 의도적 차이(감사 후속 2026-08-01): 이 빈 상태는 홈 화면의 `.empty-state`(카드 형태·
// `<h2>`)와 **일부러 다르다.** ① 지도 모달 본문 안에 있어 카드 테두리·그림자를 겹치면 답답하다
// (그래서 `.map-empty`는 뼈대만) ② 모달 제목이 이미 `.map-title`(`<h2>`)이므로 그 아래 제목은
// `<h3>`이라야 제목 계층이 맞다(스크린리더). 이유 없이 통일하지 말 것 — 통일하면 계층이 깨진다.
function emptyState(focusPlace?: PlaceLike): HTMLElement {
  const empty = el('div', 'map-empty');
  if (focusPlace) {
    empty.append(
      el('p', 'empty-emoji', '📍'),
      el('h3', undefined, `"${focusPlace.name}"의 좌표가 저장돼 있지 않아요`),
      el('p', 'muted', '이 장소는 이름만 적혀 있어서 지도에 점으로 찍을 수 없어요. 순간을 편집해 [🔍 검색]으로 장소를 고르면 좌표가 저장됩니다.'),
    );
  } else {
    empty.append(
      el('p', 'empty-emoji', '🗺'),
      el('h3', undefined, '아직 지도에 표시할 위치가 없어요'),
      el('p', 'muted', '사진에 위치정보(GPS)가 있으면 그 순간이 지도에 나타나요.'),
    );
  }
  return empty;
}

interface JourneyMapMountOptions {
  points: MapPoint[];
  mapEl: HTMLElement;
  objectUrls: string[];
  signal: AbortSignal;
  onReady(map: MapRendererHandle): void;
  onFailed(): void;
}

/** 제공자 선택·폴백은 화면 생명주기와 분리해 두 제공자가 같은 종료 계약을 지나게 한다. */
async function mountJourneyMap(options: JourneyMapMountOptions): Promise<void> {
  const kakaoKey = ((import.meta.env.VITE_KAKAO_JAVASCRIPT_KEY as string | undefined) ?? '').trim();
  const mapStyleUrl = ((import.meta.env.VITE_MAP_STYLE_URL as string | undefined) ?? '').trim() || undefined;
  const preferred = displayProviderForPoints(options.points, kakaoKey.length > 0);
  for (const provider of displayProviderFallbackOrder(preferred)) {
    if (options.signal.aborted) return;
    try {
      options.mapEl.replaceChildren();
      const map = await renderJourneyMap({
        provider,
        container: options.mapEl,
        points: options.points,
        kakaoKey,
        mapStyleUrl,
        markerColor: markerColor(),
        popupNode: (point) => pointNode(point as MapPoint, options.objectUrls),
        signal: options.signal,
      });
      if (options.signal.aborted) {
        map.destroy();
        return;
      }
      options.mapEl.dataset.mapProvider = provider;
      options.mapEl.classList.add('is-ready');
      options.onReady(map);
      return;
    } catch (error) {
      if (options.signal.aborted) return;
      options.mapEl.replaceChildren();
      console.warn(`${provider} 지도 표시 실패, 다음 제공자를 시도합니다.`, error);
    }
  }
  options.onFailed();
}

/**
 * 지도 모달을 연다. 위치가 있는 순간(points)을 지도/목록으로 보여준다.
 *
 * @param focusPlace 장소 칩에서 연 경우의 **그 장소**. 있으면 「구글지도로 열기」를 붙인다.
 *   여행 전체 지도에는 붙이지 않는다 — 여러 장소를 링크 하나로 가리킬 수 없고,
 *   억지로 하나를 고르면 앱이 **말하지 않은 선택**을 하는 셈이 된다.
 */
export function openMapView(tripTitle: string, points: MapPoint[], focusPlace?: PlaceLike): void {
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
  const extBox = focusPlace ? externalMapButton(focusPlace) : null;
  modal.appendChild(header);

  const body = el('div', 'map-body');
  modal.appendChild(body);
  overlay.appendChild(modal);

  let map: MapRendererHandle | null = null;
  const renderAbort = new AbortController();
  const close = (): void => {
    renderAbort.abort();
    try {
      map?.destroy();
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
    body.appendChild(emptyState(focusPlace));
    if (extBox) body.appendChild(extBox); // 좌표가 없어도 **이름으로는** 갈 수 있다
    return;
  }

  if (extBox) body.appendChild(extBox);

  // 지도 대신 항상 접근 가능한 '장소 목록'(오프라인 대체·기본 접근 보장).
  const list = el('div', 'map-list');
  for (const p of points) {
    const row = el('button', 'map-list-row') as HTMLButtonElement;
    row.type = 'button';
    row.appendChild(pointNode(p, objectUrls));
    row.addEventListener('click', () => {
      try {
        map?.focus(p.lng, p.lat);
      } catch {
        /* 지도 없으면 목록만 유지 */
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
  const degradeTimer = setTimeout(degradeToList, 17_000); // Kakao 8초 + MapLibre 8초 폴백 뒤 강등

  // 한국 좌표는 Kakao → 실패하면 MapLibre. 그 밖은 처음부터 MapLibre다.
  void mountJourneyMap({
    points,
    mapEl,
    objectUrls,
    signal: renderAbort.signal,
    onReady: (readyMap) => {
      map = readyMap;
      mapLoaded = true;
      clearTimeout(degradeTimer);
    },
    onFailed: () => {
      map = null;
      clearTimeout(degradeTimer);
      degradeToList();
    },
  });
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

    let map: MapRendererHandle | null = null;
    const renderAbort = new AbortController();
    const finish = (result: { lat: number; lng: number } | null): void => {
      if (settled) return;
      settled = true;
      renderAbort.abort();
      try {
        map?.destroy();
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
      const kakaoKey = ((import.meta.env.VITE_KAKAO_JAVASCRIPT_KEY as string | undefined) ?? '').trim();
      const mapStyleUrl = ((import.meta.env.VITE_MAP_STYLE_URL as string | undefined) ?? '').trim() || undefined;
      const preferred = displayProviderForPicker(picked, kakaoKey.length > 0);
      for (const provider of displayProviderFallbackOrder(preferred)) {
        if (renderAbort.signal.aborted) return;
        try {
          mapEl.replaceChildren();
          map = await renderPickerMap({
            provider,
            container: mapEl,
            initial: picked,
            kakaoKey,
            mapStyleUrl,
            markerColor: markerColor(),
            onPick: (coord) => {
              picked = coord;
              confirmBtn.disabled = false;
            },
            signal: renderAbort.signal,
          });
          if (renderAbort.signal.aborted) {
            map.destroy();
            return;
          }
          mapEl.dataset.mapProvider = provider;
          mapEl.classList.add('is-ready');
          return;
        } catch (error) {
          if (renderAbort.signal.aborted) return;
          map = null;
          mapEl.replaceChildren();
          console.warn(`${provider} 지도 선택 실패, 다음 제공자를 시도합니다.`, error);
        }
      }
      mapEl.classList.add('is-failed');
      hint.textContent = '이 기기에서는 지도 선택을 쓸 수 없어요. 장소 이름 검색을 이용해 주세요.';
    })();
  });
}
