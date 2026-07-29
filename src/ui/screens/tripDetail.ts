// ui/screens/tripDetail.ts — 여행 상세 + 타임라인 + 순간 기록(로컬우선).
// 자유 텍스트는 textContent만 사용. 서버 동기화(순간)는 후속 — 지금은 이 기기에 내구성 저장.

import { el, setNote } from '../dom';
import { audioChip, recordButton } from '../audioNote';
import { listAudioByTrip, addAudioToMoment, softDeleteAudio, restoreAudio } from '../../services/audio';
import type { LocalAudio } from '../../offline/db';
import { showUndoToast } from '../toast';
import {
  getTrip,
  updateTripLocalFirst,
  softDeleteTripLocalFirst,
  restoreTripLocalFirst,
} from '../../services/trips';
import { guessOccurredAt, outsideTripWarning, latestOccurredAt, type WhenGuess } from '../../domain/moment/whenDefault';
import { readPhotoMeta } from '../../services/media';
import {
  createMomentLocalFirst,
  listMoments,
  updateMomentLocalFirst,
  type UpdateMomentPatch,
  softDeleteMomentLocalFirst,
  restoreMomentLocalFirst,
} from '../../services/moments';
import {
  addPhotoToMoment,
  listMediaByTrip,
  softDeleteMediaLocalFirst,
  restoreMediaLocalFirst,
  // 회전·재편집은 전체보기 뷰어(ui/photoViewer.ts)가 소유한다 — 여기선 부르지 않는다.
} from '../../services/media';
import {
  createExpenseLocalFirst,
  updateExpenseLocalFirst,
  softDeleteExpenseLocalFirst,
  restoreExpenseLocalFirst,
  listExpensesByTrip,
} from '../../services/expenses';
import { CURRENCIES, DEFAULT_CURRENCY, currencyLabel, formatMoney, sumByCurrency, formatTotals } from '../../domain/expense/format';
import { convertAmount, formatRate, fxDateFor, fxKey, unitRate, type FxRateTable } from '../../domain/expense/fx';
import { ensureTable, fxBase, todayDate } from '../../services/fx';
import { momentCoord } from '../../domain/place/geojson';
// 보조 화면은 반드시 lazyScreens를 거친다(정적 import 금지 — check-lazy-screens).
import { openMapView, openMapPicker, openDiagnosticsHub } from '../lazyScreens';
import type { MapPoint } from './mapView';
import { ensureProviders, reverseGeocode, searchPlaces, type PlaceResult } from '../../services/geocode';
import { providerLabel } from '../../domain/place/provider';
import { coordInputLabel, parseCoordinateInput, swapCoord, type ParsedCoord } from '../../domain/place/coordInput';
import { listPlaces, savePlace } from '../../services/places';
import { supabase } from '../../services/supabase/client';
import { needsRefine, precisionGlyph, precisionLabel, verdictFromStored, type PrecisionVerdict } from '../../domain/place/precision';

/** 장소 입력 + 🔍 검색(Nominatim) + 결과 선택. 결과 텍스트는 textContent로만(외부 데이터·XSS 방지). */
interface PlaceField {
  el: HTMLElement;
  getName: () => string;
  getCoords: () => { lat: number; lng: number } | null;
  /**
   * 장소 라이브러리 링크(있을 때만). 검색 결과나 「내 장소」에서 고르면 라이브러리에 담기고
   * 그 id가 여기로 나온다. 자유 입력·지도 직접 지정은 **null이 정상**이다(0023).
   */
  getPlaceId: () => string | null;
  reset: () => void;
}
/**
 * 선택 확인 배지 + 정밀도 안내 줄.
 *
 * `buildPlaceField`에서 떼어낸 이유는 래칫(`check-fn-size`)이지만, 떼고 보니 이게 맞다 —
 * 「무엇을 골랐는지 사용자에게 말하는 일」은 「장소를 고르는 일」과 다른 관심사다(§11의
 * *게이트가 설계를 밀어준다*).
 *
 * `set(detail, precision)`이 `precision`을 받으면 **정밀하지 않다는 사실을 숨기지 않는다.**
 * 예전엔 무엇을 골랐든 「📍 위치 지정됨」 한 문장이었고, 그래서 「대학로」(길이 1.1km인 길)를
 * 고른 사용자는 자기가 *점*을 골랐다고 믿었다. 그게 2026-07-30 실기기 신고의 본체였다(§8·§12).
 */
interface PickedBadge {
  badge: HTMLElement;
  hint: HTMLElement;
  set: (detail: string | null, precision?: PrecisionVerdict | null) => void;
}
function buildPickedBadge(onClear: () => void): PickedBadge {
  const badge = el('div', 'place-picked');
  badge.setAttribute('role', 'status');
  // 해제 버튼 — **선택했으면 해제할 수 있어야 한다**(결함군, 2026-07-26 사용자 지적).
  // 지도로 찍은 좌표는 이름을 지워도 유지되는데(의도된 동작), 그러면 되돌릴 길이 없었다.
  const clearBtn = el('button', 'chip-clear', '✕') as HTMLButtonElement;
  clearBtn.type = 'button';
  clearBtn.setAttribute('aria-label', '지정한 위치 해제');
  clearBtn.title = '위치 해제';
  const text = el('span', 'place-picked-text');
  badge.append(text, clearBtn);
  clearBtn.addEventListener('click', onClear);

  // 정밀도 안내는 배지에 욱여넣지 않고 아래 줄로 뺀다(길어지면 읽히지 않는다).
  const hint = el('p', 'place-picked-hint muted small');
  hint.hidden = true;

  const set = (detail: string | null, precision?: PrecisionVerdict | null): void => {
    if (detail === null) {
      badge.hidden = true;
      text.textContent = '';
      hint.hidden = true;
      hint.textContent = '';
      return;
    }
    badge.hidden = false;
    text.textContent = detail ? `📍 위치 지정됨 · ${detail}` : '📍 위치 지정됨';
    const coarse = precision != null && needsRefine(precision);
    hint.hidden = !coarse;
    hint.textContent = coarse
      ? `${precisionGlyph(precision)} ${precisionLabel(precision)} — 정확한 지점은 [🗺 지도]로 찍어 주세요.`
      : '';
  };
  return { badge, hint, set };
}




/**
 * 장소 필드 → 순간 입력의 **장소 네 칸**.
 *
 * 왜 한 곳에서 만드나(§7 2층): 이름·위도·경도·링크는 **함께 움직여야** 한다. 손으로 네 줄을
 * 적는 자리가 둘(생성 폼·편집 폼)이면 언젠가 한쪽만 필드를 늘린다 — 그리고 링크만 빠지면
 * 「저장은 됐는데 장소별 모아보기에 안 나오는」 조용한 결함이 된다.
 */
function placeInputOf(field: PlaceField): {
  placeName: string;
  placeId: string | null;
  placeLat: number | null;
  placeLng: number | null;
} {
  const coords = field.getCoords();
  return {
    placeName: field.getName(),
    placeId: field.getPlaceId(),
    placeLat: coords?.lat ?? null,
    placeLng: coords?.lng ?? null,
  };
}

/** `runPlaceSearch`가 고른 결과를 폼에 되돌려 주는 모양. 한 곳으로 모아 누락을 막는다. */
interface PickedPlace {
  name: string;
  lat: number;
  lng: number;
  detail: string;
  precision: PrecisionVerdict | null;
  placeId: string | null;
  mapPicked: boolean;
}

interface PlaceSearchContext {
  results: HTMLElement;
  near: { lat: number; lng: number } | null;
  apply: (picked: PickedPlace) => void;
  /** 라이브러리 저장이 **나중에** 끝났을 때 링크만 늦게 붙인다(저장을 기다리게 하지 않는다). */
  linkPlace: (id: string | null) => void;
}

/**
 * 장소 검색 한 번 — 「내 장소」를 먼저 그리고, 지오코더 결과를 그 아래 그린다.
 *
 * `buildPlaceField`에서 떼어낸 이유는 래칫(`check-fn-size`)이지만 떼고 보니 이게 맞다:
 * *검색해서 고르는 일*과 *폼의 상태를 들고 있는 일*은 다른 관심사다(§11 「게이트가 설계를
 * 밀어준다」). 상태는 `apply`로만 되돌아가므로, 새 결과 종류를 더해도 폼이 알 필요가 없다.
 */
async function runPlaceSearch(q: string, ctx: PlaceSearchContext): Promise<void> {
  const { results } = ctx;
  try {
    const client = supabase();
    const available = await ensureProviders(client);
    // **담아 둔 장소를 먼저 본다.** 네트워크보다 빠르고, 오프라인에서도 답이 나온다.
    const needle = q.toLowerCase();
    const saved = (await listPlaces()).filter((p) => p.name.toLowerCase().includes(needle)).slice(0, 5);
    const places = await searchPlaces(q, { client, available, near: ctx.near });
    results.innerHTML = '';
    renderSavedPlaces(results, saved, (p) =>
      ctx.apply({
        name: p.name,
        lat: p.latitude,
        lng: p.longitude,
        detail: p.formattedAddress || p.name,
        // 라이브러리에 등급을 적어 뒀으므로 **그대로 다시 말한다.** 두 번째로 고를 때
        // 조용해지면 같은 사실에 대해 앱이 두 번 다르게 말하는 셈이다(§7·§8).
        precision: verdictFromStored(p.precision, p.spanMeters),
        placeId: p.id,
        mapPicked: p.mapPicked,
      }),
    );
    if (places.length === 0) {
      if (!saved.length) {
        // 🔴 **막다른 길을 만들지 않는다.** 검색이 못 찾는 곳은 반드시 있다(신축·골목·해외 소도시).
        // 그때 사용자가 쓸 수 있는 두 길을 여기서 알려 준다 — 지도로 직접 찍기, 그리고
        // 다른 지도에서 찾아 **좌표를 붙여넣기**(사용자 제안 2026-07-30).
        const none = el('div', 'place-none');
        none.append(
          el('p', undefined, '결과가 없어요.'),
          el('p', 'muted small', '[🗺 지도]로 직접 찍거나, 네이버·카카오·구글 지도에서 찾은 좌표(또는 링크)를 여기에 붙여넣어 보세요.'),
        );
        results.appendChild(none);
      }
      return;
    }
    renderPlaceResults(results, places, (p) => {
      ctx.apply({
        name: p.name,
        lat: p.lat,
        lng: p.lng,
        detail: p.displayName,
        precision: p.precision,
        placeId: null, // 아직 안 담겼다 — 담기면 아래 linkPlace가 붙인다
        mapPicked: false, // 검색 좌표는 이름과 묶임
      });
      // 라이브러리에 담는다(멱등 — 같은 곳을 열 번 골라도 행은 하나).
      // **실패해도 순간 저장을 막지 않는다**: 링크는 부가정보이고, 좌표·이름은 이미 순간에
      // 적혔다. 여기서 throw하면 부가기능이 기억 저장을 막는 셈이 된다.
      void savePlace({
        name: p.name,
        latitude: p.lat,
        longitude: p.lng,
        formattedAddress: p.displayName,
        provider: p.provider,
        providerPlaceId: p.providerId,
        countryCode: p.address.countryCode,
        country: p.address.country,
        region: p.address.region,
        city: p.address.city,
        district: p.address.district,
        postcode: p.address.postcode,
        category: p.kind,
        precision: p.precision.precision,
        spanMeters: p.precision.spanMeters,
      })
        .then((savedPlace) => ctx.linkPlace(savedPlace.id))
        .catch(() => ctx.linkPlace(null)); // 못 담았으면 링크도 없다 — 지어내지 않는다
    });
  } catch (err) {
    results.textContent = `검색 실패: ${err instanceof Error ? err.message : String(err)}`;
  }
}





/**
 * 🗺 지도 버튼 — 지도에서 지점을 찍고, **이름이 비어 있으면 그 자리의 주소를 물어 채운다**.
 *
 * 예전엔 좌표만 남고 이름은 사용자가 전부 타이핑해야 했다. 앱이 알 수 있는 것을 사람에게
 * 시키고 있던 자리다(§12 — *"지금 이 앱은 사람에게 무엇을 대신 시키고 있는가?"*).
 */
function wireMapPickButton(
  mapBtn: HTMLButtonElement,
  results: HTMLElement,
  ctx: CoordApplyContext,
  current: () => { lat: number; lng: number } | null,
): void {
  mapBtn.addEventListener('click', () => {
    mapBtn.disabled = true;
    void openMapPicker(current())
      .then((coords) => {
        if (!coords) return;
        ctx.commit(coords.lat, coords.lng);
        results.hidden = true;
        const name = ctx.input.value.trim();
        ctx.setPicked(name || '지도에서 지정'); // 이름을 안 적었으면 안내만
        if (!name) void fillNameFromReverse(ctx, coords.lat, coords.lng);
      })
      .finally(() => {
        mapBtn.disabled = false;
      });
  });
}

/** 장소 필드의 뼈대(입력칸 + 검색·지도 버튼 + 결과 상자). 상태가 없는 순수 DOM 조립이다. */
interface PlaceFieldShell {
  wrap: HTMLElement;
  row: HTMLElement;
  input: HTMLInputElement;
  searchBtn: HTMLButtonElement;
  mapBtn: HTMLButtonElement;
  results: HTMLElement;
}
function buildPlaceFieldShell(initialName: string): PlaceFieldShell {
  const wrap = el('div', 'place-field');
  const row = el('div', 'place-row');
  const input = el('input', 'edit-input place-input') as HTMLInputElement;
  input.type = 'text';
  input.value = initialName;
  input.maxLength = 80;
  input.placeholder = '📍 장소 · 좌표 · 지도 링크';
  input.setAttribute('aria-label', '장소(선택) — 이름·좌표·지도 링크를 붙여넣을 수 있어요');
  const searchBtn = el('button', 'btn-ghost place-search', '🔍 검색') as HTMLButtonElement;
  searchBtn.type = 'button';
  searchBtn.setAttribute('aria-label', '장소 검색(지도)');
  // 지도에서 직접 위치 지정 — Nominatim에 없는 곳(등록되지 않은 장소)도 좌표로 남길 수 있다.
  const mapBtn = el('button', 'btn-ghost place-map', '🗺 지도') as HTMLButtonElement;
  mapBtn.type = 'button';
  mapBtn.setAttribute('aria-label', '지도에서 위치 지정');
  row.append(input, searchBtn, mapBtn);
  const results = el('div', 'place-results');
  results.hidden = true;
  return { wrap, row, input, searchBtn, mapBtn, results };
}

/** 좌표를 적용할 때 필요한 최소한 — 필드의 나머지 상태를 밖으로 흘리지 않는다. */
interface CoordApplyContext {
  input: HTMLInputElement;
  setPicked: (detail: string | null, precision?: PrecisionVerdict | null) => void;
  /** 좌표 확정을 필드 상태에 반영한다(지도 픽과 같은 성격 — 이름과 독립). */
  commit: (lat: number, lng: number) => void;
}

/**
 * 붙여넣은 좌표를 적용한다 — 지도로 찍은 것과 **같은 성격**이라 이름과 독립이다.
 *
 * 입력칸에 좌표 문자열이 그대로 남아 있으면 그건 장소 이름이 아니다. 비우고 **그 자리의
 * 이름을 대신 물어봐 준다**(역지오코딩) — 앱이 알 수 있는 것을 사람에게 타이핑시키지 않는다(§12).
 */
function applyPastedCoord(ctx: CoordApplyContext, c: ParsedCoord): void {
  ctx.commit(c.lat, c.lng);
  const typed = ctx.input.value.trim();
  const looksLikeCoords = parseCoordinateInput(typed) !== null;
  ctx.setPicked(looksLikeCoords ? '좌표로 지정' : typed || '좌표로 지정');
  if (!looksLikeCoords) return;
  ctx.input.value = '';
  void fillNameFromReverse(ctx, c.lat, c.lng);
}

/**
 * 좌표 → 그 자리의 이름. **비어 있을 때만** 채운다(사용자가 쓴 것을 덮지 않는다).
 *
 * 실패하면 조용히 비워 둔다 — 좌표는 이미 확정됐고 이름은 사용자가 적으면 된다.
 * 편의 기능이 기억 저장을 막으면 안 된다(§0의 정신 — 앱이 사용자를 이기지 않는다).
 */
async function fillNameFromReverse(ctx: CoordApplyContext, lat: number, lng: number): Promise<void> {
  const hit = await reverseGeocode(lat, lng);
  if (!hit || ctx.input.value.trim()) return; // 그 사이 사용자가 적었으면 건드리지 않는다
  ctx.input.value = hit.name;
  ctx.setPicked(hit.displayName);
}

/**
 * 붙여넣은 좌표를 확인시키는 줄 — **읽은 값과 출처를 말하고, 틀렸으면 뒤바꿀 수 있게** 한다.
 *
 * 🔴 왜 즉시 적용하지 않고 보여주는가: 좌표를 잘못 읽으면 **기억이 엉뚱한 곳에 찍힌다.**
 * 특히 위·경도 순서는 두 값이 모두 ±90 안이면 원리적으로 모호하다(로마 41.9, 12.5).
 * 그래서 적용은 하되 **무엇으로 읽었는지 화면에 남기고**, 모호했으면 [바꾸기]를 준다(§8).
 * 한국 좌표는 경도가 90을 넘어 언제나 명확하므로 이 버튼이 뜨지 않는다 — 정상은 조용하다.
 */
function renderCoordInput(host: HTMLElement, parsed: ParsedCoord, onUse: (c: ParsedCoord) => void): void {
  const box = el('div', 'place-coord');
  const text = el('p', 'place-coord-text');
  text.textContent = coordInputLabel(parsed);
  box.appendChild(text);
  if (parsed.ambiguous) {
    box.classList.add('is-ambiguous');
    const swapBtn = el('button', 'btn-ghost place-coord-swap', '↔ 위·경도 바꾸기') as HTMLButtonElement;
    swapBtn.type = 'button';
    swapBtn.addEventListener('click', () => {
      const swapped = swapCoord(parsed);
      host.innerHTML = '';
      renderCoordInput(host, swapped, onUse);
      onUse(swapped);
    });
    box.appendChild(swapBtn);
  }
  host.appendChild(box);
  onUse(parsed);
}

/**
 * 「내 장소」 — 이미 담아 둔 장소 중 질의에 맞는 것.
 *
 * 검색 결과보다 **위에** 그린다. 두 번째 방문부터는 네트워크가 답을 주기 전에 이미 옳은
 * 답이 화면에 있고, 비행기 모드에서도 그렇다(로컬 우선). 원래 신고가 *"같은 곳을 다시
 * 찾을 때마다 부정확한 검색을 반복한다"*는 문제이기도 했다.
 */
function renderSavedPlaces(host: HTMLElement, saved: readonly LocalPlace[], onPick: (p: LocalPlace) => void): void {
  if (!saved.length) return;
  host.appendChild(el('div', 'place-source muted small', '내 장소'));
  for (const p of saved) {
    const b = el('button', 'place-result is-saved') as HTMLButtonElement;
    b.type = 'button';
    const where = [p.region, p.city].filter(Boolean).join(' ');
    b.append(el('b', 'place-result-name', `⭐ ${p.name}`), el('span', 'place-result-full', p.formattedAddress || where || ''));
    b.addEventListener('click', () => onPick(p));
    host.appendChild(b);
  }
}

/**
 * 검색 결과 목록을 그린다.
 *
 * 두 가지를 **결과마다** 말한다: 무엇인지(이름·주소)와 **얼마나 정밀한지**. 예전엔 뒤가
 * 없어서 도(道) 중심점과 건물 출입구가 화면에서 구별되지 않았다(2026-07-30 신고).
 * 어느 제공자가 답했는지는 목록 위에 **한 번만** 적는다 — 행마다 붙이면 소음이 된다.
 */
function renderPlaceResults(
  host: HTMLElement,
  places: readonly PlaceResult[],
  onPick: (p: PlaceResult) => void,
): void {
  const src = places[0]!.provider;
  host.appendChild(el('div', 'place-source muted small', `${providerLabel(src)} 검색 결과`));
  for (const p of places) {
    const b = el('button', 'place-result') as HTMLButtonElement;
    b.type = 'button';
    b.append(el('b', 'place-result-name', p.name), el('span', 'place-result-full', p.displayName));
    const grade = el('span', 'place-result-grade', `${precisionGlyph(p.precision)} ${precisionLabel(p.precision)}`);
    if (needsRefine(p.precision)) grade.classList.add('is-coarse');
    b.appendChild(grade);
    b.addEventListener('click', () => onPick(p));
    host.appendChild(b);
  }
}

function buildPlaceField(initial: { name: string; lat: number | null; lng: number | null }): PlaceField {
  const { wrap, row, input, searchBtn, mapBtn, results } = buildPlaceFieldShell(initial.name);

  let lat: number | null = initial.lat;
  let lng: number | null = initial.lng;
  // 좌표를 지도에서 직접 찍었는지 여부. 지도로 찍은 좌표는 이름을 나중에 적어도 유지한다
  // (사용자가 이름과 위치를 따로 입력하는 흐름). 검색 결과 좌표는 이름과 묶여 있으므로 손편집 시 무효화한다.
  let mapPicked = false;
  // 라이브러리 링크. 좌표가 무효화되면 함께 사라진다 — 링크만 남으면 엉뚱한 장소를 가리킨다.
  let placeId: string | null = null;

  // 해제는 배지 자신이 그릴 수 있으므로 `picked.set`을 직접 부른다(선언 전 참조를 만들지 않는다).
  const picked: PickedBadge = buildPickedBadge(() => {
    lat = null;
    lng = null;
    mapPicked = false;
    placeId = null;
    picked.set(null);
  });
  const setPicked = picked.set;
  wrap.append(row, results, picked.badge, picked.hint);
  setPicked(lat !== null && lng !== null ? '' : null); // 기존 좌표가 있으면 배지 표시
  // 손으로 텍스트를 바꾸면 이전 검색 좌표는 다른 장소일 수 있으니 무효화한다.
  // 단, 지도에서 직접 찍은 좌표는 이름과 독립적이므로 유지한다(이름만 갱신).
  input.addEventListener('input', () => {
    results.hidden = true;
    if (mapPicked) {
      // 지도 좌표는 유지 — 배지의 이름만 갱신.
      const name = input.value.trim();
      setPicked(name ? name : '지도에서 지정');
      return;
    }
    lat = null;
    lng = null;
    placeId = null; // 좌표가 무효면 링크도 무효다 — 링크만 남으면 엉뚱한 곳을 가리킨다
    setPicked(null);
  });

  const coordCtx: CoordApplyContext = {
    input,
    setPicked: (d, p) => setPicked(d, p),
    commit: (la, ln) => {
      lat = la;
      lng = ln;
      mapPicked = true; // 사용자가 확정한 지점 — 이름을 나중에 적어도 유지된다
      placeId = null; // 라이브러리 항목이 아니다(담기면 그때 링크가 생긴다)
    },
  };
  const useCoord = (c: ParsedCoord): void => applyPastedCoord(coordCtx, c);

  const doSearch = (): void => {
    const q = input.value.trim();
    if (!q) return;
    // 🔴 **좌표 먼저 본다.** 네이버·카카오·구글에서 찾은 좌표를 그대로 붙여넣는 흐름
    //    (사용자 제안 2026-07-30) — 앱이 못 찾는 곳을 사람이 뚫는 탈출구다.
    //    지오코더에 「37.587, 127.0016」을 물어봐야 좋은 답이 나올 리 없다.
    const coord = parseCoordinateInput(q);
    if (coord) {
      results.hidden = false;
      results.innerHTML = '';
      renderCoordInput(results, coord, useCoord);
      return;
    }
    searchBtn.disabled = true;
    results.hidden = false;
    results.textContent = '검색 중…';
    void runPlaceSearch(q, {
      results,
      // 이미 좌표가 있으면 그 근처를 우선한다 — 「대학로」가 전국에 여럿일 때 지금 보고 있는
      // 도시가 먼저 나오는 것이 맞다. 경계 밖을 **버리지는 않는다**(해외 검색을 막지 않게).
      near: lat !== null && lng !== null ? { lat, lng } : null,
      apply: (picked) => {
        input.value = picked.name;
        lat = picked.lat;
        lng = picked.lng;
        placeId = picked.placeId;
        mapPicked = picked.mapPicked;
        results.hidden = true;
        setPicked(picked.detail, picked.precision);
      },
      linkPlace: (id) => {
        placeId = id;
      },
    }).finally(() => {
      searchBtn.disabled = false;
    });
  };
  searchBtn.addEventListener('click', doSearch);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault(); // 폼 제출 대신 검색
      doSearch();
    }
  });

  // 🗺 지도에서 위치 지정 — 장소 이름은 사용자가 직접 적고, 좌표만 지도로 찍는다.
  // (등록되지 않은 곳일 수 있으므로 이름은 검색 결과에 의존하지 않는다.)
  wireMapPickButton(mapBtn, results, coordCtx, () => (lat !== null && lng !== null ? { lat, lng } : null));

  return {
    el: wrap,
    getName: () => input.value,
    getCoords: () => (lat !== null && lng !== null ? { lat, lng } : null),
    getPlaceId: () => placeId,
    reset: () => {
      input.value = '';
      lat = null;
      lng = null;
      mapPicked = false;
      placeId = null;
      results.hidden = true;
      results.innerHTML = '';
      setPicked(null);
    },
  };
}
import { openPhotoEditor, type EditorResult } from '../photoEditor';
import { openPhotoViewer } from '../photoViewer';
import { localTime } from '../../domain/time';
import { groupMomentsByDay, type DayGroup } from '../../domain/moment/timeline';
import { requestSync } from '../../services/autoSync';
import type { Route } from '../../app/router';
import type { LocalMoment, LocalTrip, LocalMedia, LocalExpense, LocalPlace } from '../../offline/db';

/** 금액 입력(콤마·공백 허용) → 양수 숫자 또는 null. */
function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/[,\s]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 통화 선택 select 요소 생성(현재값 반영). */
function currencySelect(current: string): HTMLSelectElement {
  const sel = el('select', 'edit-input moment-currency') as HTMLSelectElement;
  sel.setAttribute('aria-label', '통화');
  for (const c of CURRENCIES) {
    const opt = el('option', undefined, currencyLabel(c)) as HTMLOptionElement;
    opt.value = c.code;
    if (c.code === current) opt.selected = true;
    sel.appendChild(opt);
  }
  return sel;
}

type Navigate = (route: Route, param?: string) => void;

const STATUS_LABELS: Record<LocalTrip['status'], string> = {
  planned: '계획 중',
  active: '진행 중',
  completed: '완료',
  archived: '보관',
};
const STATUS_ORDER: LocalTrip['status'][] = ['planned', 'active', 'completed', 'archived'];

/** 로그인·설정된 경우 백그라운드 동기화(순간 push/pull 포함). 실패는 다음 트리거에서 재시도. */
/**
 * 동기화 요청 — 규칙은 `services/autoSync.ts` **한 곳**에 있다.
 *
 * 예전엔 이 함수가 여기와 home.ts에 **손으로 두 벌** 있었고, 둘 다 오류를 조용히 삼켰으며
 * 겹쳐 호출되면 runSync가 중복 실행됐다(§7 — 같은 규율을 두 곳에 구현하면 갈라진다).
 */
async function trySync(): Promise<void> {
  await requestSync('저장/변경');
}

const EMOTIONS = ['😍', '😌', '🥹', '😆', '🤔'] as const;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** id → 안정적 커버 인덱스(0..2). */
function coverIndex(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 3;
}

/**
 * **발생 시각 필드** — 입력칸 + 근거 한 줄 + 여행 기간 밖 경고.
 *
 * 생성 폼과 편집 폼이 **이 한 곳**을 쓴다(§7). 예전엔 편집에만 시각 칸이 있고 생성엔 없어서,
 * 소급 입력이 주 흐름인 사용자가 *"저장하고 → 다시 열어서 → 고친다"*를 매번 해야 했다.
 * 두 폼에 손으로 각각 만들면 그 비대칭이 다시 자란다.
 *
 * 규율 둘:
 *  · **근거를 말한다.** 앱이 값을 골라 줬으면 무엇을 보고 골랐는지 화면에 적는다 —
 *    안 적으면 사용자는 그게 추측인지 모르고, 틀렸을 때 고칠 생각을 못 한다.
 *  · **사용자가 손댄 값을 덮지 않는다.** 시각을 고친 뒤 사진을 더 고르면 추측이 다시
 *    돌지만, 그때 사용자의 입력을 밀어내면 그건 앱이 사용자를 이기는 것이다.
 */
interface WhenField {
  el: HTMLElement;
  /** 현재 값(ISO). 비었거나 무효면 undefined. */
  value(): string | undefined;
  /** 고른 사진에서 추측해 채운다. 사용자가 이미 손댔으면 **아무 일도 하지 않는다**. */
  suggestFromFiles(files: File[]): Promise<void>;
  /** 값을 그대로 넣고 근거 줄은 비운다(편집 폼 — 이미 정해진 값이라 추측이 아니다). */
  set(iso: string): void;
}

function buildWhenField(
  trip: { startDate: string | null; endDate: string | null; timeZone?: string } | null,
  /** 이 여행에서 가장 늦은 순간의 시각 — 사진이 없을 때 물려받는다. 편집 폼은 넘기지 않는다. */
  latestMomentAt: () => string | null = () => null,
): WhenField {
  const wrap = el('div', 'when-field');
  const input = el('input', 'edit-input when-input') as HTMLInputElement;
  input.type = 'datetime-local';
  input.setAttribute('aria-label', '발생 시각');
  const note = el('p', 'when-note', '');
  const warn = el('p', 'when-warn', '');
  warn.setAttribute('role', 'status');
  wrap.append(input, note, warn);

  let touched = false;
  const refreshWarn = (): void => {
    const iso = fromLocalInputValue(input.value);
    const w = iso ? outsideTripWarning(iso, trip?.startDate ?? null, trip?.endDate ?? null) : null;
    warn.textContent = w ?? '';
    warn.hidden = w === null; // 기간 안이면 **사라진다**(침묵이 정상)
  };
  // 사용자가 한 번이라도 고치면 그 뒤로 추측이 값을 건드리지 않는다.
  input.addEventListener('input', () => {
    touched = true;
    note.textContent = '';
    note.hidden = true;
    refreshWarn();
  });
  refreshWarn();

  const apply = (g: WhenGuess): void => {
    if (touched) return;
    input.value = toLocalInputValue(g.at);
    note.textContent = g.label;
    note.hidden = false;
    refreshWarn();
  };

  return {
    el: wrap,
    value: () => fromLocalInputValue(input.value),
    async suggestFromFiles(files) {
      // 앞 256KB만 읽는다 — 9장을 고른 순간 전체를 읽으면 수십 MB가 한꺼번에 뜬다(저메모리 기기).
      // **EXIF가 없는 사진은 세지 않는다**(null 제거): 스크린샷의 파일 수정시각을 근거로 쓰면
      // 화면이 「📷 사진에서」라고 말하면서 실은 *앱에 넣은 시각*을 보여주게 된다 — 거짓 근거다.
      const metas = await Promise.all(files.map((f) => readPhotoMeta(f, trip?.timeZone ?? '')));
      const photoTakenAts = metas.map((m) => m.takenAt).filter((t): t is string => t !== null);
      apply(
        guessOccurredAt({
          photoTakenAts,
          previousOccurredAt: latestMomentAt(),
          tripStartDate: trip?.startDate ?? null,
          now: new Date().toISOString(),
        }),
      );
    },
    set(iso) {
      input.value = toLocalInputValue(iso);
      note.textContent = '';
      note.hidden = true;
      refreshWarn();
    },
  };
}

/**
 * **감정 선택 줄** — 생성 폼과 편집 폼이 같은 구현을 쓴다(§7).
 * 같은 위젯을 두 곳에 손으로 만들면 한쪽만 고쳐지는 날이 온다.
 */
function buildEmotionRow(initial: string): { el: HTMLElement; value(): string; reset(): void } {
  let picked = initial;
  const row = el('div', 'emo-row');
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', '감정 선택(선택)');
  const buttons = new Map<string, HTMLButtonElement>();
  const sync = (): void => {
    for (const [key, btn] of buttons) btn.setAttribute('aria-pressed', String(key === picked));
  };
  for (const e of EMOTIONS) {
    const b = el('button', 'emo', e) as HTMLButtonElement;
    b.type = 'button';
    b.addEventListener('click', () => {
      picked = picked === e ? '' : e;
      sync();
    });
    buttons.set(e, b);
    row.appendChild(b);
  }
  sync();
  return { el: row, value: () => picked, reset: () => { picked = initial; sync(); } };
}

/** ISO(UTC) → datetime-local 입력값('YYYY-MM-DDTHH:mm', 로컬시각). */
function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 장소 칩 — **탭하면 그 장소의 지도가 열린다.**
 *
 * 왜 앱 지도인가(사용자 결정 2026-07-27): 앱 지도(MapLibre+OSM)는 비공개이고 오프라인에서도
 * 뜬다. 구글은 길찾기·스트리트뷰가 필요할 때 **거기서 한 걸음 더** 가는 곳이다. 그래서 칩은
 * 늘 앱 지도를 열고, 「🌐 구글지도로 열기」는 그 안에 둔다 — 좌표가 조용히 밖으로 나가지 않는다.
 *
 * 좌표가 없어도 **누를 수 있다.** 지도는 빈 상태로 열려 "좌표가 없다"고 말하고, 이름으로
 * 검색해 갈 길을 준다. 누를 수 없게 두면 *왜* 안 눌리는지 사용자가 알 방법이 없다(§12).
 */
function placeChip(m: { id: string; placeName: string; placeLat?: number | null; placeLng?: number | null }): HTMLElement {
  const chip = el('button', 'chip gps chip-tap', `📍 ${m.placeName}`) as HTMLButtonElement;
  chip.type = 'button';
  chip.setAttribute('aria-label', `${m.placeName} 지도에서 보기`);
  const lat = m.placeLat ?? null;
  const lng = m.placeLng ?? null;
  const place = { name: m.placeName, lat, lng };
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    const pts =
      lat !== null && lng !== null
        ? [{ momentId: m.id, lat, lng, title: m.placeName, occurredAt: '', placeName: m.placeName }]
        : [];
    void openMapView(m.placeName, pts, place);
  });
  return chip;
}

/**
 * 소리 칩을 칩 줄에 붙인다. **사진 격자가 아니라 칩 줄**이다 — 격자는 훑는 곳인데
 * 소리는 재생해야 내용을 알아서 훑기를 나쁘게 한다. 장소·비용과 같은 한 줄 정보다(§7 화면 대칭).
 */
function appendAudioChips(chips: HTMLElement, list: LocalAudio[], refresh: () => void): void {
  for (const a of list) {
    chips.appendChild(
      audioChip(a, () => {
        void (async () => {
          await softDeleteAudio(a.id);
          refresh();
          // **사진과 같은 실행취소**(§7 사용자 대면 대칭). 2026-07-27 사용자 실기기:
          // *"이미 녹음된 걸 삭제할 땐 바로 삭제가 되네요."* — 사진에는 이 토스트가 있는데
          // 소리에만 없었다. 되돌릴 수 있다는 사실을 **그 자리에서** 말하지 않으면,
          // 사용자에게는 되돌릴 수 없는 것과 구별되지 않는다(휴지통까지 가야 안다).
          showUndoToast('소리를 삭제했어요', async () => {
            await restoreAudio(a.id);
            refresh();
          });
        })();
      }),
    );
  }
}

/**
 * 🎙 녹음 버튼 — 저장까지 책임진다. 결과 문장을 `status` 요소에 그대로 쓴다.
 *
 * 실패를 **조용히 넘기지 않는다**: 저장 공간 부족·형식 미지원·너무 짧은 녹음은 전부 사람이
 * 읽는 문장으로 나온다(§12 — 앱이 아는 것을 말하지 않으면 사용자가 대신 알아내야 한다).
 * 그리고 성공 문장이 **어디에 저장됐는지**를 말한다 — 오디오는 서버에 안 가므로 그 사실이
 * 사용자에게 보여야 한다(계층이 ①③ 둘뿐이라는 것은 앱이 아는 정보다).
 */
function buildRecordButton(
  momentId: string,
  tripId: string,
  status: HTMLElement,
  refresh: () => void,
): HTMLButtonElement {
  return recordButton((r) => {
    void (async () => {
      try {
        await addAudioToMoment({ momentId, tripId }, r.blob, r.seconds, r.mime);
        status.textContent = '소리를 저장했어요 · 이 기기와 백업 파일에 보관됩니다';
        refresh();
      } catch (e) {
        status.textContent = e instanceof Error ? e.message : '녹음을 저장하지 못했어요';
      }
    })();
  });
}

/**
 * 순간 id로 묶는다. 사진·비용·소리가 **같은 모양의 코드 세 벌**을 갖고 있어서 하나로 뽑았다
 * (`check-fn-size` 래칫이 밀어 준 추출 — 게이트가 설계를 밀어 준 또 한 번).
 */
function groupByMoment<T extends { momentId: string }>(rows: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const r of rows) {
    const arr = map.get(r.momentId);
    if (arr) arr.push(r);
    else map.set(r.momentId, [r]);
  }
  return map;
}

/** datetime-local 입력값(로컬시각) → ISO(UTC). 빈/무효는 undefined(변경 안 함). */
function fromLocalInputValue(v: string): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function dayHeaderLabel(g: DayGroup): string {
  const d = new Date(`${g.date}T00:00:00`);
  const md = Number.isNaN(d.getTime())
    ? g.date
    : `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[d.getDay()]})`;
  return g.dayNumber && g.dayNumber >= 1 ? `Day ${g.dayNumber} · ${md}` : md;
}

export function renderTripDetail(mount: HTMLElement, tripId: string, navigate: Navigate): void {
  mount.innerHTML = '';
  const wrap = el('main', 'screen screen-detail');
  mount.appendChild(wrap);

  void (async () => {
    const trip = await getTrip(tripId);
    if (!trip) {
      const nf = el('div', 'detail-notfound');
      nf.appendChild(el('p', 'empty-emoji', '🧭'));
      nf.appendChild(el('h2', undefined, '여행을 찾을 수 없어요'));
      const back = el('button', 'btn-primary', '← 홈으로') as HTMLButtonElement;
      back.type = 'button';
      back.addEventListener('click', () => navigate('home'));
      nf.appendChild(back);
      wrap.appendChild(nf);
      return;
    }

    // ===== 히어로 커버 =====
    const hero = el('header', `detail-hero cover--${coverIndex(trip.id)}`);
    hero.append(el('div', 'cover-veil'), el('div', 'cover-grain'));
    const back = el('button', 'hero-back', '←') as HTMLButtonElement;
    back.type = 'button';
    back.setAttribute('aria-label', '홈으로');
    back.addEventListener('click', () => navigate('home'));
    const editBtn = el('button', 'hero-edit', '✎ 편집') as HTMLButtonElement;
    editBtn.type = 'button';
    editBtn.setAttribute('aria-label', '여행 정보 편집');

    // 지도 버튼 — 위치가 있는 순간을 지도/장소목록으로. 위치 없으면 안내를 띄운다.
    let locatedPoints: MapPoint[] = [];
    const mapBtn = el('button', 'hero-map', '🗺 지도') as HTMLButtonElement;
    mapBtn.type = 'button';
    mapBtn.setAttribute('aria-label', '이 여행의 지도 보기');
    mapBtn.addEventListener('click', () => void openMapView(trip!.title, locatedPoints));

    const heroInfo = el('div', 'detail-hero-info');
    const period = trip.startDate
      ? `${trip.startDate}${trip.endDate ? ` ~ ${trip.endDate}` : ''}`
      : '기간 미정';
    const badge = el('span', 'detail-badge', STATUS_LABELS[trip.status]);
    heroInfo.appendChild(badge);
    heroInfo.appendChild(el('h1', 'detail-title', trip.title));
    heroInfo.appendChild(el('p', 'detail-period', period));
    const statRow = el('div', 'detail-stats');
    hero.append(back, mapBtn, editBtn, heroInfo, statRow);
    wrap.appendChild(hero);

    // ===== 본문 =====
    const body = el('section', 'detail-body');
    wrap.appendChild(body);

    // 넓은 화면에서 [기록 폼 | 타임라인] 2단으로 나누기 위한 좌측 묶음.
    // 좁은 화면에서는 그냥 세로로 흐른다(CSS가 분기) — DOM 순서는 기록 → 타임라인 그대로라
    // 화면읽기·키보드 탐색 순서도 자연스럽다.
    const compose = el('div', 'detail-compose');
    body.appendChild(compose);

    // 편집 패널(날짜·상태·삭제) — 토글.
    const editPanel = buildEditPanel(
      trip,
      async (patch) => {
        await updateTripLocalFirst(trip.id, patch);
        void trySync();
        renderTripDetail(mount, tripId, navigate); // 최신 데이터로 재렌더
      },
      async () => {
        // 여행 삭제(cascade tombstone) → 홈으로. 실행취소 토스트는 body 부착이라 화면 전환에도 유지.
        const children = await softDeleteTripLocalFirst(trip!.id);
        void trySync();
        navigate('home');
        showUndoToast('여행을 삭제했어요', async () => {
          await restoreTripLocalFirst(trip!.id, children);
          void trySync();
          navigate('home'); // 홈 목록에서 카드가 되살아나는 걸 바로 보여줌(실행취소를 누른 자리)
        });
      },
    );
    editPanel.hidden = true;
    editBtn.addEventListener('click', () => {
      editPanel.hidden = !editPanel.hidden;
    });
    compose.appendChild(editPanel);

    // 순간 기록 폼
    const form = el('form', 'moment-form');
    const input = el('input', 'moment-input') as HTMLInputElement;
    input.type = 'text';
    input.placeholder = '이 순간을 한 줄로… (예: 협재 노을이 멋졌다)';
    input.maxLength = 140;
    input.required = true;
    input.setAttribute('aria-label', '순간 한 줄 기록');

    const emotion = buildEmotionRow('');

    const placeField = buildPlaceField({ name: '', lat: null, lng: null });

    // 사진 선택(원본은 기기에 보관·압축본은 파생, §0). label 안에 input을 넣어 접근성 확보.
    /** 이 여행에서 가장 늦은 순간의 발생 시각. `refresh()`가 채운다. */
    let latestMomentAt: string | null = null;
    const photoInput = el('input', 'moment-photo-input') as HTMLInputElement;
    photoInput.type = 'file';
    photoInput.accept = 'image/*';
    photoInput.multiple = true;
    photoInput.setAttribute('aria-label', '사진 추가');
    const photoLabel = el('label', 'moment-photo-label');
    const photoCount = el('span', 'moment-photo-count', '');
    photoLabel.append(document.createTextNode('📷 사진 추가 '), photoCount, photoInput);
    // 선택한 사진 미리보기 + **해제**.
    //
    // 결함(2026-07-26 사용자 지적): 예전엔 "· 2장 선택됨" 글자만 있고 **무엇을 골랐는지도,
    // 어떻게 취소하는지도** 없었다. 저장된 사진에는 ✕가 있는데 저장 전 선택분에만 없어서,
    // 같은 화면 안에서 어휘가 갈렸다(§7 사용자 대면 대칭 위반). 잘못 고르면 폼을 떠나는 수밖에.
    //
    // FileList는 읽기 전용이라 DataTransfer로 다시 만들어 넣는다(표준 경로).
    const photoPreview = el('div', 'pick-preview');
    photoPreview.hidden = true;
    let previewUrls: string[] = [];
    const clearAllPhotos = el('button', 'pick-clear-all', '전체 해제') as HTMLButtonElement;
    clearAllPhotos.type = 'button';

    const setFiles = (files: File[]): void => {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(f);
      photoInput.files = dt.files;
      renderPicks();
    };

    function renderPicks(): void {
      for (const u of previewUrls) URL.revokeObjectURL(u);
      previewUrls = [];
      photoPreview.replaceChildren();
      const files = photoInput.files ? Array.from(photoInput.files) : [];
      photoCount.textContent = files.length > 0 ? `· ${files.length}장 선택됨` : '';
      photoPreview.hidden = files.length === 0;
      if (!files.length) return;

      for (const [i, f] of files.entries()) {
        const cell = el('div', 'pick-cell');
        const url = URL.createObjectURL(f);
        previewUrls.push(url);
        const img = el('img', 'pick-thumb') as HTMLImageElement;
        img.src = url;
        img.alt = f.name;
        img.loading = 'lazy';
        const x = el('button', 'pick-x', '✕') as HTMLButtonElement;
        x.type = 'button';
        x.setAttribute('aria-label', `${f.name} 선택 해제`);
        x.addEventListener('click', () => setFiles(files.filter((_, j) => j !== i)));
        cell.append(img, x);
        photoPreview.appendChild(cell);
      }
      photoPreview.appendChild(clearAllPhotos);
      // 사진이 바뀌면 시각 추측도 따라간다 — 사진이 가장 강한 근거다.
      void whenField.suggestFromFiles(files);
    }

    clearAllPhotos.addEventListener('click', () => setFiles([]));
    photoInput.addEventListener('change', renderPicks);


    // 비용(선택) — 금액 + 통화. "10초 기록"을 방해하지 않도록 한 줄, 비우면 저장 안 함.
    const moneyRow = el('div', 'moment-money');
    const amountIn = el('input', 'moment-amount') as HTMLInputElement;
    amountIn.type = 'text';
    amountIn.inputMode = 'decimal';
    amountIn.placeholder = '💰 비용 (선택)';
    amountIn.maxLength = 15;
    amountIn.setAttribute('aria-label', '비용 금액(선택)');
    const currencyIn = currencySelect(DEFAULT_CURRENCY);
    moneyRow.append(amountIn, currencyIn);

    const save = el('button', 'btn-primary', '순간 저장') as HTMLButtonElement;
    save.type = 'submit';

    // 발생 시각 — **소급 입력이 주 흐름**이라(사용자 2026-07-27) 접어 두지 않고 항상 보인다.
    const whenField = buildWhenField(trip, () => latestMomentAt);
    void whenField.suggestFromFiles([]); // 사진 전에도 근거를 보여준다(직전 순간 / 여행 시작일)

    form.append(input, emotion.el, whenField.el, placeField.el, moneyRow, photoLabel, photoPreview, save);
    compose.appendChild(form);

    const note = el('p', 'sync-note', '');
    note.setAttribute('role', 'status');
    compose.appendChild(note);

    const timeline = el('div', 'timeline-wrap');
    body.appendChild(timeline);

    // 썸네일 objectURL 관리(재렌더 시 이전 URL 회수).
    let objectUrls: string[] = [];
    function resetUrls(): void {
      for (const u of objectUrls) URL.revokeObjectURL(u);
      objectUrls = [];
    }

    // ── 환율 환산(보조 표시) ──
    // 렌더는 동기라 캐시에 있는 표로만 그리고, 없는 날짜는 비동기로 받아온 뒤 한 번 다시 그린다.
    // 원금액(사용자 기록)은 절대 바꾸지 않는다 — 환산은 옆에 붙는 파생 표시값이다(H-04·원칙 #2).
    const fxCache = new Map<string, FxRateTable | null>();

    /** 사용일(순간의 발생 시각) 기준 표를 캐시에서만 찾는다. */
    function fxTableFor(occurredAt: string): FxRateTable | null {
      const key = fxKey(fxDateFor(occurredAt, todayDate()), fxBase());
      return fxCache.get(key) ?? null;
    }

    /** 화면에 필요한 날짜의 표를 받아 캐시에 채운다. 새로 채워졌으면 true(→ 한 번 재렌더). */
    async function hydrateFx(moments: LocalMoment[], expenses: LocalExpense[]): Promise<boolean> {
      const base = fxBase();
      const today = todayDate();
      const dates = new Set<string>();
      const byId = new Map(moments.map((m) => [m.id, m]));
      for (const ex of expenses) {
        if (ex.originalCurrency.toUpperCase() === base) continue; // 환산 불필요
        const m = byId.get(ex.momentId);
        if (m) dates.add(fxDateFor(m.occurredAt, today));
      }
      let added = false;
      for (const d of dates) {
        const key = fxKey(d, base);
        if (fxCache.has(key)) continue;
        const t = await ensureTable(d, base);
        fxCache.set(key, t); // null도 기록 — 실패한 날짜를 매 렌더마다 다시 때리지 않는다
        if (t) added = true;
      }
      return added;
    }


    async function refresh(): Promise<void> {
      const [moments, media, expenses] = await Promise.all([
        listMoments(trip!.id),
        listMediaByTrip(trip!.id),
        listExpensesByTrip(trip!.id),
      ]);
      latestMomentAt = latestOccurredAt(moments); // 순수 함수 — 비교는 순간으로(M-0034)
      const audioAll = await listAudioByTrip(trip!.id);
      const audioByMoment = groupByMoment(audioAll);
      const byMoment = groupByMoment(media);
      const expByMoment = groupByMoment(expenses);
      // 위치가 있는 순간(사진 EXIF GPS) → 지도 포인트.
      locatedPoints = [];
      for (const m of moments) {
        const mediaList = byMoment.get(m.id) ?? [];
        // 사용자가 고른 장소 좌표 우선, 없으면 사진 EXIF GPS.
        const coord =
          m.placeLat != null && m.placeLng != null ? { lat: m.placeLat, lng: m.placeLng } : momentCoord(mediaList);
        if (coord) {
          const point: MapPoint = {
            momentId: m.id,
            title: m.title,
            occurredAt: m.occurredAt,
            lat: coord.lat,
            lng: coord.lng,
            placeName: m.placeName,
          };
          if (mediaList[0]) point.previewBlob = mediaList[0].displayBlob; // 표시본(선명)
          locatedPoints.push(point);
        }
      }
      renderTimeline(moments, byMoment, expByMoment, audioByMoment);
      const groups = groupMomentsByDay(moments, trip!.startDate || undefined);
      statRow.innerHTML = '';
      statRow.append(
        stat(String(moments.length), '순간'),
        stat(String(groups.length), '일'),
        stat(String(media.length), '사진'),
      );
      const totals = formatTotals(sumByCurrency(expenses));
      if (totals.length) statRow.append(stat(totals.join(' · '), '비용'));

      // 환산 합계(보조): 각 비용을 **자기 사용일** 환율로 환산해 더한다(한 날 환율로 뭉뚱그리지 않음).
      // 환산 못 한 통화가 있으면 숨기지 않고 라벨에 남긴다(정직).
      const base = fxBase();
      const mixed = totals.length > 1 || !Object.keys(sumByCurrency(expenses)).includes(base);
      if (expenses.length && mixed) {
        const byId = new Map(moments.map((m) => [m.id, m]));
        let sum = 0;
        let converted = 0;
        const missing = new Set<string>();
        for (const ex of expenses) {
          const cur = ex.originalCurrency.toUpperCase();
          if (cur === base) {
            sum += ex.originalAmount;
            converted++;
            continue;
          }
          const mo = byId.get(ex.momentId);
          const t = mo ? fxTableFor(mo.occurredAt) : null;
          const v = t ? convertAmount(ex.originalAmount, cur, base, t) : null;
          if (v === null) missing.add(cur);
          else {
            sum += v;
            converted++;
          }
        }
        if (converted > 0) {
          const label = missing.size ? `환산 합계 (${[...missing].join('·')} 제외)` : '환산 합계';
          statRow.append(stat(`≈ ${formatMoney(sum, base)}`, label));
        }
      }

      // 캐시에 없던 날짜의 환율을 받아오고, 새로 채워졌으면 한 번만 다시 그린다(무한루프 없음).
      void hydrateFx(moments, expenses).then((added) => {
        if (added) void refresh();
      });
    }

    function renderTimeline(
      moments: LocalMoment[],
      byMoment: Map<string, LocalMedia[]>,
      expByMoment: Map<string, LocalExpense[]>,
      audioByMoment: Map<string, LocalAudio[]>,
    ): void {
      resetUrls();
      timeline.innerHTML = '';
      if (moments.length === 0) {
        const empty = el('div', 'empty-state');
        empty.appendChild(el('p', 'empty-emoji', '📝'));
        empty.appendChild(el('h2', undefined, '첫 순간을 남겨보세요'));
        empty.appendChild(el('p', 'muted', '사진·장소는 나중에 채워도 돼요. 한 줄이면 충분합니다.'));
        timeline.appendChild(empty);
        return;
      }
      for (const g of groupMomentsByDay(moments, trip!.startDate || undefined)) {
        timeline.appendChild(el('h3', 'day-head', dayHeaderLabel(g)));
        const items = el('div', 'timeline');
        for (const m of g.items) {
          items.appendChild(buildMomentCard(m, byMoment.get(m.id) ?? [], expByMoment.get(m.id) ?? [], audioByMoment.get(m.id) ?? []));
        }
        timeline.appendChild(items);
      }
    }

    function buildMomentCard(m: LocalMoment, mediaList: LocalMedia[], expenseList: LocalExpense[], audioList: LocalAudio[]): HTMLElement {
      const item = el('div', 'tl-item');
      item.appendChild(el('span', 'tl-node'));
      const t = localTime(m.occurredAt);
      if (t) item.appendChild(el('div', 'tl-time', t));
      const card = el('article', 'moment-card');
      const head = el('div', 'moment-head');
      head.appendChild(el('p', 'moment-say', m.title));
      const headRight = el('div', 'moment-head-right');
      if (m.emotion) headRight.appendChild(el('span', 'moment-emo', m.emotion));
      const editBtn = el('button', 'icon-btn', '✎') as HTMLButtonElement;
      editBtn.type = 'button';
      editBtn.setAttribute('aria-label', '이 순간 편집');
      const delBtn = el('button', 'icon-btn', '🗑') as HTMLButtonElement;
      delBtn.type = 'button';
      delBtn.setAttribute('aria-label', '이 순간 삭제');
      headRight.append(editBtn, delBtn);
      head.appendChild(headRight);
      card.appendChild(head);

      // 편집 모드에서 기존 순간에 사진 추가(생성 흐름과 같은 배치 편집 경로 재사용).
      const addPhotoWrap = el('div', 'moment-addphoto');
      addPhotoWrap.hidden = true;
      const addPhotoInput = el('input', 'moment-photo-input') as HTMLInputElement;
      addPhotoInput.type = 'file';
      addPhotoInput.accept = 'image/*';
      addPhotoInput.multiple = true;
      addPhotoInput.setAttribute('aria-label', '사진 추가');
      const addPhotoLabel = el('label', 'moment-photo-label moment-addphoto-btn');
      addPhotoLabel.append(document.createTextNode('📷 사진 추가 '), addPhotoInput);
      const addProgress = el('span', 'moment-addphoto-note muted small');
      addProgress.setAttribute('role', 'status');
      // 🎙 소리 남기기 — 사진 추가와 **같은 줄**에 둔다(둘 다 "이 순간에 뭔가 더하기"다).
      addPhotoWrap.append(addPhotoLabel, buildRecordButton(m.id, trip!.id, addProgress, refresh), addProgress);
      addPhotoInput.addEventListener('change', () => {
        const files = addPhotoInput.files ? Array.from(addPhotoInput.files) : [];
        if (!files.length) return;
        void (async () => {
          try {
            await processPhotosIntoMoment(files, m.id, trip!.id, (msg) => {
              addProgress.textContent = msg;
            });
            addPhotoInput.value = '';
            addProgress.textContent = '✅ 추가됨';
            await refresh();
          } catch (err) {
            addProgress.textContent = `추가 실패: ${err instanceof Error ? err.message : String(err)}`;
          }
        })();
      });

      // 인라인 편집 폼(토글). 저장 시 순간 수정 + 비용 조정(생성/수정/삭제) → 재렌더.
      const existingExpense = expenseList[0];
      const editForm = buildMomentEditForm(
        m,
        trip,
        existingExpense,
        async (patch, expenseIntent) => {
          await updateMomentLocalFirst(m.id, patch);
          if (expenseIntent.amount !== null) {
            if (existingExpense) {
              await updateExpenseLocalFirst(existingExpense.id, {
                originalAmount: expenseIntent.amount,
                originalCurrency: expenseIntent.currency,
              });
            } else {
              await createExpenseLocalFirst({
                momentId: m.id,
                tripId: trip!.id,
                originalAmount: expenseIntent.amount,
                originalCurrency: expenseIntent.currency,
              });
            }
          } else if (existingExpense) {
            const removedId = existingExpense.id;
            await softDeleteExpenseLocalFirst(removedId);
            // 다른 도메인과 같은 복구 보장(§5) — 비용만 되돌릴 수 없던 자리를 메운다.
            showUndoToast('비용을 삭제했어요', async () => {
              await restoreExpenseLocalFirst(removedId);
              await refresh();
              void trySync();
            });
          }
          await refresh();
          void trySync();
        },
        () => {
          editForm.hidden = true;
          addPhotoWrap.hidden = true;
        },
      );
      editForm.hidden = true;
      editBtn.addEventListener('click', () => {
        const show = editForm.hidden; // 열기로 전환
        editForm.hidden = !show;
        addPhotoWrap.hidden = !show;
      });

      // 삭제 → tombstone + 실행취소 토스트(5초). 사진도 함께 tombstone되고 undo가 함께 복원.
      delBtn.addEventListener('click', () => {
        if (delBtn.disabled) return; // 빠른 이중 탭 재진입 방지
        delBtn.disabled = true;
        void (async () => {
          try {
            const children = await softDeleteMomentLocalFirst(m.id);
            await refresh();
            void trySync();
            showUndoToast('순간을 삭제했어요', async () => {
              await restoreMomentLocalFirst(m.id, children); // 묶음 통째로(손으로 고르면 빠뜨린다 — M-0007)
              await refresh();
              void trySync();
            });
          } catch {
            delBtn.disabled = false; // 실패 시 재시도 허용
          }
        })();
      });

      if (m.note) card.appendChild(el('p', 'moment-note', m.note));
      if (m.placeName || expenseList.length || audioList.length) {
        const chips = el('div', 'chips');
        if (m.placeName) chips.appendChild(placeChip(m));
        appendAudioChips(chips, audioList, refresh);
        // 환율 상세(탭하면 펼쳐짐) — 툴팁(title)은 모바일에서 안 보이므로 실제 패널로 보여준다.
        const fxDetail = el('div', 'fx-detail');
        fxDetail.hidden = true;

        for (const ex of expenseList) {
          const chip = el('span', 'chip money', `💰 ${formatMoney(ex.originalAmount, ex.originalCurrency)}`);
          // 환산(보조): 사용일 기준환율로 기준통화 환산값을 덧붙인다. 원금액이 주(主), 환산이 부(副).
          const base = fxBase();
          if (ex.originalCurrency.toUpperCase() !== base) {
            const t = fxTableFor(m.occurredAt);
            const conv = t ? convertAmount(ex.originalAmount, ex.originalCurrency, base, t) : null;
            if (t && conv !== null) {
              const approx = el('button', 'chip-approx', `≈ ${formatMoney(conv, base)}`) as HTMLButtonElement;
              approx.type = 'button';
              approx.setAttribute('aria-expanded', 'false');
              approx.setAttribute('aria-label', `환산 ${formatMoney(conv, base)} — 적용 환율 자세히 보기`);
              approx.addEventListener('click', (e) => {
                e.stopPropagation();
                const mine = fxDetail.dataset['for'] === ex.id;
                if (mine && !fxDetail.hidden) {
                  fxDetail.hidden = true; // 같은 배지 다시 탭 → 접기
                  approx.setAttribute('aria-expanded', 'false');
                  return;
                }
                fxDetail.dataset['for'] = ex.id;
                fxDetail.innerHTML = '';
                fxDetail.append(...fxDetailRows(ex, m.occurredAt, base, t, conv));
                fxDetail.hidden = false;
                for (const b of chips.querySelectorAll('.chip-approx')) {
                  b.setAttribute('aria-expanded', String(b === approx));
                }
              });
              chip.appendChild(approx);
            }
          }
          chips.appendChild(chip);
        }
        card.appendChild(chips);
        card.appendChild(fxDetail);
      }
      if (mediaList.length) {
        const grid = el('div', 'photo-thumbs');
        for (const [mdIdx, md] of mediaList.entries()) {
          const url = URL.createObjectURL(md.thumbBlob);
          objectUrls.push(url);
          const cell = el('div', 'photo-thumb-wrap');
          const img = el('img', 'photo-thumb') as HTMLImageElement;
          img.src = url;
          img.alt = '여행 사진';
          img.loading = 'lazy';
          img.addEventListener('click', () => openPhotoViewer(mediaList, mdIdx, refresh));
          const pdel = el('button', 'photo-del', '✕') as HTMLButtonElement;
          pdel.type = 'button';
          pdel.setAttribute('aria-label', '이 사진 삭제');
          // 사진 삭제 → tombstone(원본 보존) + 실행취소. 미디어는 로컬 전용이라 sync 불필요.
          pdel.addEventListener('click', (e) => {
            e.stopPropagation();
            if (pdel.disabled) return;
            pdel.disabled = true;
            void (async () => {
              try {
                await softDeleteMediaLocalFirst(md.id);
                await refresh();
                showUndoToast('사진을 삭제했어요', async () => {
                  await restoreMediaLocalFirst(md.id);
                  await refresh();
                });
              } catch {
                pdel.disabled = false;
              }
            })();
          });
          cell.append(img, pdel);
          grid.appendChild(cell);
        }
        card.appendChild(grid);
      }
      card.append(addPhotoWrap, editForm);
      item.appendChild(card);
      return item;
    }

    // 뷰어: 순간의 사진 묶음을 넘겨보며(◀▶·방향키·스와이프) 회전·재편집한다.
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      save.disabled = true;
      const files = photoInput.files ? Array.from(photoInput.files) : [];
      void (async () => {
        try {
          const moment = await createMomentLocalFirst({
            tripId: trip!.id,
            title: input.value,
            emotion: emotion.value(),
            note: '',
            ...placeInputOf(placeField),
            // 비었으면 넘기지 않는다 — 서비스가 `now`로 채운다(계약을 두 곳에 쓰지 않는다).
            ...(whenField.value() ? { occurredAt: whenField.value()! } : {}),
          });
          // 비용(선택): 금액이 유효하면 순간에 딸린 비용으로 저장.
          const amountVal = parseAmount(amountIn.value);
          if (amountVal !== null) {
            try {
              await createExpenseLocalFirst({
                momentId: moment.id,
                tripId: trip!.id,
                originalAmount: amountVal,
                originalCurrency: currencyIn.value,
              });
            } catch {
              /* 비용 저장 실패는 순간 저장을 무르지 않는다 */
            }
          }
          await processPhotosIntoMoment(files, moment.id, trip!.id, (msg) => {
            // 진행 중은 갈 곳이 없다 — 지금 벌어지는 일을 보고할 뿐이고, 곧 결과로 바뀐다.
            setNote(note, msg, 'info', null); // 사진 처리 진행 — 잠깐 보이는 정보
          });
          input.value = '';
          placeField.reset();
          emotion.reset();
          amountIn.value = '';
          currencyIn.value = DEFAULT_CURRENCY;
          // 미리보기 URL 회수 + 개수 문구까지 한 번에(초기화 경로를 두 개 만들지 않는다).
          setFiles([]);
          setNote(note, '✅ 저장됨', 'ok', null); // 정상 — 조용하게(침묵이 정상이므로 갈 곳도 안 만든다)
          await refresh();
          await trySync(); // 로그인 시 서버로 전송(순간). 사진은 후속(3b).
          await refresh();
        } catch (err) {
          // 저장 실패야말로 갈 곳이 필요하다 — 무엇이 막혔는지는 「동기화 상태」가 말한다.
          setNote(note, `저장 실패: ${err instanceof Error ? err.message : String(err)}`, 'error', {
            go: () => void openDiagnosticsHub('sync'),
            label: '동기화 상태 열기',
          });
        } finally {
          save.disabled = false;
        }
      })();
    });

    await refresh();
    await trySync(); // 다른 기기의 순간을 받아옴(pull)
    await refresh();
  })();
}

/** 여행 날짜·상태·제목 편집 패널 + 삭제. onSave(patch)/onDelete() 호출 후 상위에서 처리. */
function buildEditPanel(
  trip: LocalTrip,
  onSave: (patch: { title: string; startDate: string; endDate: string; status: LocalTrip['status'] }) => Promise<void>,
  onDelete: () => Promise<void>,
): HTMLElement {
  const panel = el('form', 'edit-panel');

  const titleIn = el('input', 'edit-input') as HTMLInputElement;
  titleIn.type = 'text';
  titleIn.value = trip.title;
  titleIn.maxLength = 100;
  titleIn.required = true;
  titleIn.setAttribute('aria-label', '여행 제목');

  const dates = el('div', 'edit-dates');
  const startIn = el('input', 'edit-input') as HTMLInputElement;
  startIn.type = 'date';
  startIn.value = trip.startDate;
  startIn.setAttribute('aria-label', '시작일');
  const endIn = el('input', 'edit-input') as HTMLInputElement;
  endIn.type = 'date';
  endIn.value = trip.endDate;
  endIn.setAttribute('aria-label', '종료일');
  dates.append(startIn, el('span', 'edit-sep', '~'), endIn);

  const status = el('select', 'edit-input') as HTMLSelectElement;
  status.setAttribute('aria-label', '여행 상태');
  for (const s of STATUS_ORDER) {
    const opt = el('option', undefined, STATUS_LABELS[s]) as HTMLOptionElement;
    opt.value = s;
    if (s === trip.status) opt.selected = true;
    status.appendChild(opt);
  }

  const row = el('div', 'edit-actions');
  const save = el('button', 'btn-primary', '저장') as HTMLButtonElement;
  save.type = 'submit';
  const cancel = el('button', 'btn-ghost', '취소') as HTMLButtonElement;
  cancel.type = 'button';
  cancel.addEventListener('click', () => {
    panel.hidden = true;
  });
  row.append(save, cancel);

  // 위험 구역: 여행 삭제(순간·사진 포함). 실수 방지로 2단계(삭제 → 정말 삭제) + 실행취소 토스트.
  const danger = el('div', 'edit-danger');
  const delBtn = el('button', 'btn-danger', '🗑 여행 삭제') as HTMLButtonElement;
  delBtn.type = 'button';
  const confirmRow = el('div', 'edit-confirm');
  confirmRow.hidden = true;
  confirmRow.appendChild(el('span', 'edit-confirm-msg', '순간·사진까지 함께 삭제돼요. 계속할까요?'));
  const confirmBtn = el('button', 'btn-danger', '정말 삭제') as HTMLButtonElement;
  confirmBtn.type = 'button';
  const keepBtn = el('button', 'btn-ghost', '유지') as HTMLButtonElement;
  keepBtn.type = 'button';
  keepBtn.addEventListener('click', () => {
    confirmRow.hidden = true;
    delBtn.hidden = false;
  });
  delBtn.addEventListener('click', () => {
    delBtn.hidden = true;
    confirmRow.hidden = false;
  });
  confirmBtn.addEventListener('click', () => {
    confirmBtn.disabled = true;
    void onDelete().catch(() => {
      confirmBtn.disabled = false;
    });
  });
  confirmRow.append(confirmBtn, keepBtn);
  danger.append(delBtn, confirmRow);

  panel.append(
    el('label', 'edit-label', '제목'),
    titleIn,
    el('label', 'edit-label', '기간'),
    dates,
    el('label', 'edit-label', '상태'),
    status,
    row,
    danger,
  );

  panel.addEventListener('submit', (e) => {
    e.preventDefault();
    save.disabled = true;
    void onSave({
      title: titleIn.value,
      startDate: startIn.value,
      endDate: endIn.value,
      status: status.value as LocalTrip['status'],
    }).catch(() => {
      save.disabled = false;
    });
  });

  return panel;
}

/** 순간 인라인 편집 폼(한 줄·감정·장소·메모·비용·발생시각). onSave(patch, 비용의도) 호출. */
/**
 * 파일들을 배치 편집(← 이전/다음·나머지 모두 원본) 후 한 순간에 일괄 저장한다.
 * 생성 흐름과 "기존 순간에 사진 추가" 흐름이 공유한다(단일 경로 — SSOT).
 * 사진은 한 장씩 열고 굽고 저장하므로 배치가 커도 메모리는 장당 한 장만 쓴다(명시적 장수 제한 없음).
 */
async function processPhotosIntoMoment(
  files: File[],
  momentId: string,
  tripId: string,
  onProgress: (msg: string) => void,
): Promise<void> {
  if (!files.length) return;
  const states: (EditorResult['state'] | undefined)[] = new Array(files.length);
  const blobs: (Blob | null)[] = new Array(files.length).fill(null);
  let i = 0;
  while (i < files.length) {
    onProgress(`사진 편집… (${i + 1}/${files.length})`);
    const prev = states[i];
    const r = await openPhotoEditor(files[i]!, `${i + 1}/${files.length} · ${files[i]!.name}`, {
      canGoBack: i > 0,
      batchRemaining: files.length - i,
      ...(prev ? { initialState: prev } : {}),
    });
    states[i] = r.state;
    if (r.action === 'back') {
      i -= 1;
      continue;
    }
    if (r.action === 'skipAll') break; // 이 사진 포함 나머지 전부 원본
    blobs[i] = r.blob; // apply→편집본(무편집 null), skip→null(원본)
    i += 1;
  }
  for (let k = 0; k < files.length; k += 1) {
    onProgress(`사진 저장… (${k + 1}/${files.length})`);
    try {
      await addPhotoToMoment(
        files[k]!,
        { momentId, tripId },
        blobs[k] ?? undefined,
        blobs[k] ? states[k] : undefined, // 편집한 경우만 편집상태 저장(재편집 이어서용)
      );
    } catch {
      /* 개별 사진 실패는 건너뜀(순간 자체는 유지) */
    }
  }
}

function buildMomentEditForm(
  m: LocalMoment,
  /** 여행 기간 — 기간 밖 경고에 쓴다(생성 폼과 같은 필드·같은 문장, §7). */
  trip: { startDate: string | null; endDate: string | null; timeZone?: string } | null,
  existingExpense: LocalExpense | undefined,
  onSave: (
    // 서비스의 계약 타입을 그대로 쓴다 — 필드가 늘 때 화면·서비스 두 곳을 고치지 않는다(SSOT).
    patch: UpdateMomentPatch,
    expenseIntent: { amount: number | null; currency: string },
  ) => Promise<void>,
  onCancel: () => void,
): HTMLElement {
  const panel = el('form', 'edit-panel moment-edit');

  const titleIn = el('input', 'edit-input') as HTMLInputElement;
  titleIn.type = 'text';
  titleIn.value = m.title;
  titleIn.maxLength = 140;
  titleIn.required = true;
  titleIn.setAttribute('aria-label', '순간 한 줄 기록');

  const emotion = buildEmotionRow(m.emotion); // 생성 폼과 같은 위젯(§7)

  const placeField = buildPlaceField({ name: m.placeName, lat: m.placeLat ?? null, lng: m.placeLng ?? null });

  const noteIn = el('textarea', 'edit-input edit-note') as HTMLTextAreaElement;
  noteIn.value = m.note;
  noteIn.maxLength = 500;
  noteIn.rows = 2;
  noteIn.placeholder = '메모 (선택)';
  noteIn.setAttribute('aria-label', '메모(선택)');

  // 비용(선택): 금액 비우면 기존 비용 삭제, 채우면 생성/수정.
  const moneyRow = el('div', 'moment-money');
  const amountIn = el('input', 'moment-amount') as HTMLInputElement;
  amountIn.type = 'text';
  amountIn.inputMode = 'decimal';
  amountIn.placeholder = '💰 비용 (선택)';
  amountIn.maxLength = 15;
  amountIn.value = existingExpense ? String(existingExpense.originalAmount) : '';
  amountIn.setAttribute('aria-label', '비용 금액(선택)');
  const currencyIn = currencySelect(existingExpense ? existingExpense.originalCurrency : DEFAULT_CURRENCY);
  moneyRow.append(amountIn, currencyIn);

  // 이미 정해진 값이므로 `set()`(추측이 아니라 근거 줄은 비운다).
  const timeField = buildWhenField(trip);
  timeField.set(m.occurredAt);

  const row = el('div', 'edit-actions');
  const save = el('button', 'btn-primary', '저장') as HTMLButtonElement;
  save.type = 'submit';
  const cancel = el('button', 'btn-ghost', '취소') as HTMLButtonElement;
  cancel.type = 'button';
  cancel.addEventListener('click', onCancel);
  row.append(save, cancel);

  panel.append(
    el('label', 'edit-label', '한 줄 기록'),
    titleIn,
    emotion.el,
    el('label', 'edit-label', '장소'),
    placeField.el,
    el('label', 'edit-label', '메모'),
    noteIn,
    el('label', 'edit-label', '비용'),
    moneyRow,
    el('label', 'edit-label', '발생 시각'),
    timeField.el,
    row,
  );

  panel.addEventListener('submit', (e) => {
    e.preventDefault();
    save.disabled = true;
    // 인라인 타입 대신 **서비스의 계약 타입**을 쓴다 — 필드가 늘 때 두 곳을 고치지 않는다(SSOT).
    const patch: UpdateMomentPatch = {
      title: titleIn.value,
      emotion: emotion.value(),
      ...placeInputOf(placeField),
      note: noteIn.value,
    };
    const occ = timeField.value();
    if (occ !== undefined) patch.occurredAt = occ;
    const expenseIntent = { amount: parseAmount(amountIn.value), currency: currencyIn.value };
    void onSave(patch, expenseIntent).catch(() => {
      save.disabled = false;
    });
  });

  return panel;
}

/**
 * 환율 상세 행 — 사용자가 **직접 검산할 수 있게** 적용일·단위환율·계산식·출처를 모두 보인다.
 * 숫자를 그냥 믿으라고 하지 않는다(정직한 완료의 UI 판).
 */
function fxDetailRows(
  ex: LocalExpense,
  occurredAt: string,
  base: string,
  t: FxRateTable,
  conv: number,
): HTMLElement[] {
  const cur = ex.originalCurrency.toUpperCase();
  const asked = fxDateFor(occurredAt, todayDate()); // 요청한 날(= 비용 사용일)
  const rows: HTMLElement[] = [];

  const line = (label: string, value: string): HTMLElement => {
    const r = el('div', 'fx-row');
    r.append(el('span', 'fx-row-k', label), el('span', 'fx-row-v', value));
    return r;
  };

  // 적용 환율일 — 요청일과 다르면(주말·공휴일) 이유를 밝힌다.
  rows.push(line('적용 환율일', t.date === asked ? t.date : `${t.date} (사용일 ${asked}은 고시 없음 → 직전 고시일)`));

  // 단위 환율 양방향 — 어느 쪽으로 보든 이해되게.
  const rFwd = unitRate(cur, base, t);
  const rBack = unitRate(base, cur, t);
  if (rFwd !== null) rows.push(line('환율', `1 ${cur} = ${formatRate(rFwd)} ${base}`));
  if (rBack !== null) rows.push(line('', `1 ${base} = ${formatRate(rBack)} ${cur}`));

  // 계산식 — 원금액 × 단위환율 = 환산값. 사용자가 계산기로 확인 가능.
  if (rFwd !== null) {
    rows.push(
      line(
        '계산',
        `${formatMoney(ex.originalAmount, cur)} × ${formatRate(rFwd)} = ${formatMoney(conv, base)}`,
      ),
    );
  }

  rows.push(line('출처', `${t.source} · 공개 기준환율`));

  const note = el(
    'p',
    'fx-note',
    '실시간 시장가·은행 매매기준율이 아닙니다. 카드 결제나 현찰 환전 시 수수료 때문에 실제 금액은 다를 수 있어요. 원래 적은 금액은 그대로 보존됩니다.',
  );
  rows.push(note);
  return rows;
}

function stat(value: string, label: string): HTMLElement {
  const s = el('div', 'detail-stat');
  s.appendChild(el('b', undefined, value));
  s.appendChild(el('span', undefined, label));
  return s;
}

