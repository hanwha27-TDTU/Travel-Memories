// ui/screens/tripDetail.ts — 여행 상세 + 타임라인 + 순간 기록(로컬우선).
// 자유 텍스트는 textContent만 사용. 서버 동기화(순간)는 후속 — 지금은 이 기기에 내구성 저장.

import { el, setNote } from '../dom';
import { externalMapRow } from '../externalMapRow';
import { audioChip, recordButton } from '../audioNote';
import { listAudioByTrip, addAudioToMoment, softDeleteAudio, restoreAudio } from '../../services/audio';
import type { LocalAudio } from '../../offline/db';
import { showUndoToast, showNoticeToast } from '../toast';
import {
  getTrip,
  updateTripLocalFirst,
  softDeleteTripLocalFirst,
  restoreTripLocalFirst,
} from '../../services/trips';
import { guessOccurredAt, outsideTripWarning, latestOccurredAt, type WhenGuess } from '../../domain/moment/whenDefault';
import { readPhotoMeta, type PhotoMeta } from '../../services/media';
import { photoHintOf, photoPlaceLabel, photoPlaceNotice, type PhotoMetaLike } from '../../domain/place/photoHint';
import { hereFailMessage, hereLabel, hereVerdict } from '../../domain/place/here';
import { readHere } from '../../services/here';
import { wireAltPick, ORIGINAL_ACCEPT, GALLERY_ACCEPT } from '../pickOriginal';
import { wireNativeIntake } from '../../services/nativePhotos';
import { hasAgreed, rememberAgreed, PHOTO_GEO_CONSENT_KEY, PHOTO_GEO_CONSENT_TEXT } from '../../services/consent';
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
import { coordInputLabel, parseCoordinateInput, swapCoord, isRealCoord, type ParsedCoord } from '../../domain/place/coordInput';
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
  /**
   * 🔴 **고른 사진이 위치를 알고 있으면 그것으로 채운다**(사용자 제안 2026-07-30).
   *
   * 시각 칸(`WhenField.suggestFrom`)과 **같은 어휘·같은 규율**이다(§7 사용자 대면 대칭):
   *  · **사용자가 손댄 값을 덮지 않는다.** 이름을 적었거나 좌표를 이미 골랐으면 아무 일도 없다.
   *  · **근거를 말한다.** 「📷 사진 위치에서 · 위도, 경도」 — 추측을 사실처럼 두지 않는다.
   *  · 좌표가 없는 사진(스크린샷·GPS 끈 카메라)이면 **아무 말도 하지 않는다**(§8).
   *
   * 좌표 채우기는 **네트워크가 0**이다. 이름 조회만 동의를 거친다(`consent.ts` 참조).
   */
  suggestFrom: (metas: readonly PhotoMetaLike[]) => void;
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
          el('p', 'muted small', '[🗺 지도]로 직접 찍거나, 아래 지도에서 찾은 좌표(또는 링크)를 여기에 붙여넣어 보세요.'),
        );
        // 🔴 **앱이 이미 검색어를 쥐고 있다**(사용자 제안 2026-07-30). 예전엔 「네이버·카카오·
        // 구글에서 찾아 붙여넣으세요」라고 **말만** 하고, 사용자가 다른 앱을 열어 **같은 말을
        // 다시 치게** 했다 — §12가 묻는 그 형태다. 이제 그 검색어로 바로 열어 준다.
        //
        // 좌표는 넘기지 않는다(`lat/lng: null`) — 여기는 *좌표를 아직 모르는* 자리이고,
        // 그래서 링크는 **이름으로 찾는다**(`precision: 'name'`). 부품이 그 사실을 caveat로
        // 함께 말한다(동명이 있으면 다른 곳이 열릴 수 있다).
        const row = externalMapRow(
          { name: q, lat: null, lng: null },
          {
            lead: '다른 지도에서 찾기',
            className: 'place-none-ext',
          },
        );
        if (row) none.appendChild(row);
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

/**
 * 「기존 순간에 사진 추가」 줄 — 입력칸 + 📷 라벨 + 📁 원본에서 + 진행 줄.
 *
 * 생성 폼의 사진 줄과 **같은 것을 두 벌 손으로 만들고 있었다.** 래칫이 밀어줘서 뽑았지만,
 * 떼고 보니 이게 맞다 — 「사진을 어떤 선택기로 고르는가」는 이 앱에서 **위치 정보의 생사가
 * 갈리는 지점**이라(M-0054), 화면 300줄 안에 묻혀 있으면 다음 사람이 못 본다.
 */
/**
 * 사진 입력칸 공장 — **두 폼(생성·추가)이 같은 문을 지난다**(§7 2층).
 *
 * 여기 담긴 두 규율은 각각 나흘짜리였다: `ORIGINAL_ACCEPT`(M-0064 — 갤러리 선택기가 위치를
 * 지운다) · `wireNativeIntake`(ADR-0036 — 셸 안에서는 ACCESS_MEDIA_LOCATION 문으로).
 * 손으로 두 벌 만들면 한쪽이 낡는다 — 실제로 그랬다.
 */
function photoFileInput(): HTMLInputElement {
  const input = el('input', 'moment-photo-input') as HTMLInputElement;
  input.type = 'file';
  input.accept = ORIGINAL_ACCEPT; // 기본이 원본 보존 경로다(2026-08-01 — 위치를 잃지 않게)
  wireNativeIntake(input); // 셸(ADR-0036) 안에서는 위치가 살아 있는 네이티브 문 — 크롬에선 무행동
  input.multiple = true;
  input.setAttribute('aria-label', '사진 추가');
  return input;
}

function buildAddPhotoRow(): { wrap: HTMLElement; input: HTMLInputElement; progress: HTMLElement } {
  const wrap = el('div', 'moment-addphoto');
  wrap.hidden = true;
  const input = photoFileInput();
  const label = el('label', 'moment-photo-label moment-addphoto-btn');
  label.append(document.createTextNode('📷 사진 추가 '), input);
  const progress = el('span', 'moment-addphoto-note muted small');
  progress.setAttribute('role', 'status');
  // §7 — 두 경로가 **같은 부품**을 쓴다. 손으로 두 벌 만들면 한쪽이 낡는다.
  wrap.append(label, galleryPickButton(input));
  return { wrap, input, progress };
}

/**
 * 📁 **원본에서** 버튼 — 사진 선택기를 우회해 파일 선택기로 고른다(v1.34).
 *
 * 생성 폼과 「사진 추가」 **두 곳이 같은 부품을 쓴다**(§7 2층). 라벨·설명·배선을 손으로
 * 두 벌 만들면 한쪽만 고쳐지는 날이 오고, 이 저장소는 그 사고를 이미 세 번 겪었다.
 */
function galleryPickButton(input: HTMLInputElement): HTMLButtonElement {
  const btn = el('button', 'btn-ghost pick-original', '🖼️ 갤러리에서') as HTMLButtonElement;
  btn.type = 'button';
  btn.setAttribute('aria-label', '갤러리에서 고르기 — 고르기는 편하지만 위치 정보가 빠질 수 있어요');
  btn.title = '고르기는 편하지만 위치 정보가 빠질 수 있어요';
  wireAltPick(input, btn, GALLERY_ACCEPT);
  return btn;
}

/**
 * 📍 **내 위치** 버튼 — 한 번 눌러 지금 자리를 장소로 넣는다(v1.33).
 *
 * 사용자 요구(2026-07-31): *"장소가 바로 입력되게 하고 싶은거야. 어떤 방식이든 결과가 중요함."*
 * 사진 EXIF는 안드로이드가 지워서 넘기므로(M-0054) **그 길로는 결과가 안 나온다.**
 * 기기의 현재 위치는 막히지 않는다.
 *
 * 🔴 지키는 것 넷:
 *  · **덮지 않는다** — 이미 좌표가 있으면 사용자에게 먼저 묻는다(앱이 사용자를 이기지 않는다).
 *  · **정확도를 말한다** — 실내 wifi 측위는 2km로 오기도 한다. 이미 있는 정밀도 체계를 지나므로
 *    「⚠ 동네 범위」 같은 한정 문장이 **자동으로** 붙는다(§7 사용자 대면 대칭).
 *  · **실패를 삼키지 않는다** — 권한 거부·실내·시간초과는 할 일이 각각 달라 문장이 다르다(§8).
 *  · **잠긴 채 남지 않는다** — `finally`로 반드시 되돌린다(§13 4항 ④).
 */
function wireHereButton(o: {
  btn: HTMLButtonElement;
  note: HTMLElement;
  ctx: CoordApplyContext;
  hasCoord: () => boolean;
}): void {
  o.btn.addEventListener('click', () => {
    if (o.hasCoord() && !window.confirm('이미 지정된 위치가 있어요. 지금 내 위치로 바꿀까요?')) return;
    const label = o.btn.textContent;
    o.btn.disabled = true;
    o.btn.textContent = '📍 찾는 중…';
    void readHere()
      .then((r) => {
        if (!r.coord) {
          // 실패해도 **말한다**. 조용히 아무 일도 안 일어나면 사용자는 고장으로 읽는다(M-0053).
          o.note.textContent = hereFailMessage(r.fail ?? 'unavailable');
          o.note.hidden = false;
          return;
        }
        o.ctx.commit(r.coord.lat, r.coord.lng);
        o.ctx.setPicked(hereLabel(r.coord, r.accuracyM), hereVerdict(r.accuracyM));
        o.note.textContent = '';
        o.note.hidden = true;
        // 이름은 좌표가 기기 밖으로 나가는 일이라 **이미 동의가 있을 때만**(원칙 #3).
        // 거절하셨어도 좌표는 남는다 — 이름만 직접 적으시면 된다.
        if (!o.ctx.input.value.trim() && hasAgreed(PHOTO_GEO_CONSENT_KEY)) {
          void fillNameFromReverse(o.ctx, r.coord.lat, r.coord.lng);
        }
      })
      .finally(() => {
        o.btn.disabled = false;
        o.btn.textContent = label;
      });
  });
}

/**
 * 이름을 **손으로 고쳤을 때** 좌표를 어떻게 할 것인가 — 이 필드에서 가장 미묘한 규칙이라
 * 이름을 붙여 밖으로 뺐다(래칫이 밀어줬지만, 떼고 보니 이게 맞다).
 *
 * · **검색으로 얻은 좌표**는 이름과 한 몸이다. 이름을 바꾸면 그 좌표는 **다른 장소**일 수
 *   있으므로 무효화한다 — 안 그러면 「경복궁」을 지우고 「덕수궁」이라 적었는데 핀은 경복궁에
 *   남는다. 그건 조용한 거짓말이다.
 * · **지도·내 위치로 찍은 좌표**는 이름과 독립이다(사용자가 자리를 먼저 정하고 이름을 나중에
 *   적는 흐름). 유지하고 배지의 이름만 갱신한다.
 */
function wireNameEdit(o: {
  input: HTMLInputElement;
  results: HTMLElement;
  coordIsIndependent: () => boolean;
  setPicked: (detail: string | null) => void;
  clearCoord: () => void;
}): void {
  o.input.addEventListener('input', () => {
    o.results.hidden = true;
    if (o.coordIsIndependent()) {
      o.setPicked(o.input.value.trim() || '지도에서 지정');
      return;
    }
    o.clearCoord();
    o.setPicked(null);
  });
}

/** 장소 필드의 뼈대(입력칸 + 검색·지도·내 위치 버튼 + 결과 상자). 상태가 없는 순수 DOM 조립이다. */
interface PlaceFieldShell {
  wrap: HTMLElement;
  row: HTMLElement;
  input: HTMLInputElement;
  searchBtn: HTMLButtonElement;
  mapBtn: HTMLButtonElement;
  hereBtn: HTMLButtonElement;
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
  // 🔴 **지금 내 위치**(v1.33 · 사용자 2026-07-31: *"장소가 바로 입력되게 하고 싶은거야"*).
  // 사진 EXIF의 GPS는 안드로이드가 지워서 넘긴다(M-0054, 실기기 확정) — 파서로는 못 뚫는다.
  // 기기는 자기 위치를 알고 있고 그건 안드로이드가 막는 대상이 아니다. **한 번 눌러 끝**이
  // 되는 길을 항상 열어 둔다. 부품이 하나라 생성 폼·편집 폼이 **동시에** 받는다(§7 2층).
  const hereBtn = el('button', 'btn-ghost place-here', '📍 내 위치') as HTMLButtonElement;
  hereBtn.type = 'button';
  hereBtn.setAttribute('aria-label', '지금 내 위치로 장소 지정');
  row.append(input, searchBtn, mapBtn, hereBtn);
  const results = el('div', 'place-results');
  results.hidden = true;
  return { wrap, row, input, searchBtn, mapBtn, hereBtn, results };
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

/**
 * **고른 사진 미리보기 + 해제**, 그리고 **메타를 한 번만 읽어 나눠 주는 자리**.
 *
 * 결함(2026-07-26 사용자 지적): 예전엔 "· 2장 선택됨" 글자만 있고 **무엇을 골랐는지도,
 * 어떻게 취소하는지도** 없었다. 저장된 사진에는 ✕가 있는데 저장 전 선택분에만 없어서,
 * 같은 화면 안에서 어휘가 갈렸다(§7 사용자 대면 대칭 위반).
 *
 * 🔴 **메타는 여기서 한 번만 읽는다**(2026-07-30). 앞 256KB만 읽어도 9장이면 2.3MB이고,
 * 시각 칸과 장소 칸이 각자 읽으면 그게 두 배가 된다(저메모리 기기 규율). 읽기를 여기로
 * 모으고 **결과를 나눠 준다** — 그래서 콜백이 파일이 아니라 `metas`를 받는다.
 *
 * FileList는 읽기 전용이라 DataTransfer로 다시 만들어 넣는다(표준 경로).
 */
/**
 * **앱이 받은 바이트의 사실**을 접힌 상자로. 좌표를 못 얻었을 때만 나온다(정상은 침묵 — §8).
 *
 * 🔴 왜 이게 필요했나(2026-08-01 · M-0066): 나흘 동안 *"왜 위치가 안 들어오나"*를 **추측으로**
 * 좁혔고 네 번 틀렸다. 그 사이 사용자는 스크린샷을 찍어 날랐다 — §12가 금지하는 상태다.
 * 앱은 그 바이트를 손에 쥐고 있으면서 **아무 말도 하지 않았다.**
 *
 * 여기서 **판정하지 않는다.** 관측만 적는다 — 왜 그런지는 이미 네 번 틀렸다(§8).
 */
async function renderProbe(box: HTMLElement, files: File[]): Promise<void> {
  box.replaceChildren();
  box.hidden = files.length === 0;
  if (!files.length) return;
  const sum = el('summary', '', '🔬 앱이 받은 사진 정보 보기');
  box.appendChild(sum);
  const { probeJpeg, EXIF_HEAD_BYTES } = await import('../../media/exif');
  const { photoProbeLine, photoProbeNext, photoProbePath } = await import('../../domain/place/photoProbe');
  const { pickedVia } = await import('../../services/nativePhotos');
  const { shellState } = await import('../../services/capacitorShell');
  for (const f of files.slice(0, 3)) {
    // 저장 경로(media.ts)와 **같은 창**을 읽는다 — 여기만 크면 "🔬는 위치 있다는데 저장은 안 됨"이
    // 된다(H-2). 상수는 exif.ts가 SSOT. 손으로 512KB를 다시 쓰지 않는다.
    const buf = await f.slice(0, EXIF_HEAD_BYTES).arrayBuffer();
    // 해시는 **파일 전체**로 낸다 — 앞부분만 재면 폰의 원본과 대조할 수 없다.
    const digest = await crypto.subtle.digest('SHA-256', await f.arrayBuffer());
    const sha16 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
    const probe = probeJpeg(buf);
    box.appendChild(el('div', 'probe-line', photoProbeLine({ name: f.name, bytes: f.size, sha16, probe })));
    // 🔴 경로 줄(M-0069) — 셸/브라우저·원본 승격 여부·사유까지. 스크린샷 한 장이 경로를 말한다.
    box.appendChild(el('div', 'probe-line', photoProbePath({ shell: shellState(), picked: pickedVia(f.name) })));
    box.appendChild(el('div', 'probe-next muted', photoProbeNext(probe)));
  }
}

function buildPickPreview(
  photoInput: HTMLInputElement,
  onMetas: (metas: PhotoMeta[]) => void,
  fallbackZone: () => string,
): { el: HTMLElement; count: HTMLElement; setFiles: (files: File[]) => void } {
  const wrap = el('div', 'pick-preview');
  wrap.hidden = true;
  const probeBox = el('details', 'pick-probe');
  const count = el('span', 'moment-photo-count', '');
  const clearAll = el('button', 'pick-clear-all', '전체 해제') as HTMLButtonElement;
  clearAll.type = 'button';
  let previewUrls: string[] = [];

  const setFiles = (files: File[]): void => {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    photoInput.files = dt.files;
    render();
  };

  function render(): void {
    for (const u of previewUrls) URL.revokeObjectURL(u);
    previewUrls = [];
    wrap.replaceChildren();
    const files = photoInput.files ? Array.from(photoInput.files) : [];
    count.textContent = files.length > 0 ? `· ${files.length}장 선택됨` : '';
    wrap.hidden = files.length === 0;
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
      wrap.appendChild(cell);
    }
    wrap.appendChild(clearAll);
    wrap.appendChild(probeBox);
    void (async () => {
      const metas = await Promise.all(files.map((f) => readPhotoMeta(f, fallbackZone())));
      onMetas(metas);
      // 🔴 **앱이 무엇을 받았는지 앱이 말한다**(M-0066). 좌표를 얻지 못했을 때만 — 정상은
      // 침묵한다(§8). 이게 없어서 사용자가 나흘 동안 스크린샷을 날랐고 나는 추측했다(§12).
      const noCoord = metas.every((m) => m.gpsLat === null || m.gpsLng === null);
      await renderProbe(probeBox, noCoord ? files : []);
    })();
  }

  clearAll.addEventListener('click', () => setFiles([]));
  photoInput.addEventListener('change', render);
  return { el: wrap, count, setFiles };
}

/**
 * 「기존 순간에 사진 추가」 배선.
 *
 * 🔴 **굽기 전에 메타를 먼저 읽는다**(§0 — 사진 압축 전에 촬영시각·GPS를 읽어 별도 저장).
 * 그 값으로 편집 폼의 장소 칸을 채운다 — 인테이크도 다시 읽지만(그쪽은 파일 이름·GPS 저장용)
 * 여기서 재사용하면 순서 가정이 생겨 더 얽힌다. 앞 256KB 읽기라 값이 싸다.
 */
function wireAddPhoto(
  input: HTMLInputElement,
  progress: HTMLElement,
  o: {
    momentId: string;
    tripId: string;
    fallbackZone: string;
    /** 이 순간이 **이미 장소를 갖고 있는가.** 참이면 사진이 장소를 건드리지 않는다. */
    hasPlace: boolean;
    refresh: () => Promise<void>;
  },
): void {
  input.addEventListener('change', () => {
    const files = input.files ? Array.from(input.files) : [];
    if (!files.length) return;
    void (async () => {
      try {
        const metas = await Promise.all(files.map((f) => readPhotoMeta(f, o.fallbackZone)));
        await processPhotosIntoMoment(files, o.momentId, o.tripId, (msg) => {
          progress.textContent = msg;
        });
        input.value = '';
        progress.textContent = '✅ 추가됨';
        await placeFromPhotos(o.momentId, o.hasPlace, metas, o.refresh);
        await o.refresh();
      } catch (err) {
        progress.textContent = `추가 실패: ${err instanceof Error ? err.message : String(err)}`;
      }
    })();
  });
}

/**
 * 🔴 **사진 위치를 순간에 실제로 써 넣는다** (사용자 지적 2026-07-31 · 스크린샷).
 *
 * 왜 폼 칸을 채우는 것으로는 안 되나: 「기존 순간에 사진 추가」는 **곧바로 저장하고 화면을
 * 다시 그린다**(사진이 보여야 하므로). 그러면 폼은 저장된 데이터로 새로 만들어지고 내가 채운
 * 칸은 그 즉시 사라진다 — 실제로 그렇게 짰다가 라이브 검사가 잡았다. 생성 폼과 이 자리는
 * **흐름이 다르다**: 생성 폼은 사용자가 [저장]을 누를 때까지 값이 폼에 머문다.
 *
 * 🔴 **비어 있을 때만 쓴다.** 사용자가 적어 둔 장소를 사진이 덮으면 그건 앱이 사용자를
 * 이기는 것이다.
 *
 * 🔴 그리고 **말하고, 되돌릴 길을 준다**(토스트 + 실행취소). 앱이 사용자 데이터를 스스로
 * 바꿨으므로 §5(복구 가능성)가 그대로 걸린다. 진행 줄로는 안 된다 — 사진 추가는 곧바로
 * 재렌더하므로 그 줄이 **그 자리에서 사라진다**(실제로 그렇게 짰다가 라이브 검사가 잡았다).
 * 토스트는 `document.body`에 붙어 화면이 다시 그려져도 남는다.
 */
async function placeFromPhotos(
  momentId: string,
  hasPlace: boolean,
  metas: readonly PhotoMetaLike[],
  refresh: () => Promise<void>,
): Promise<void> {
  if (hasPlace) return;
  const hint = photoHintOf(metas);
  if (!hint.coord) {
    // 🔴 **침묵하지 않는다**(사용자 지적 2026-07-31). 예전엔 조용히 지나갔고, 그래서
    // *"안되네요"*가 나왔다 — 사진에 위치가 없는 것인지 기능이 고장난 것인지 **구분할 방법이
    // 없었다.** 앱은 그 답을 알고 있었다(§12: 앱이 아는 것을 사람에게 묻거나 감추지 않는다).
    //
    // 문장은 `photoPlaceNotice` 한 곳에서 만든다 — **생성 폼과 여기가 같은 말을 해야** 한다.
    // v1.30에 여기에만 문자열을 인라인으로 적었고, 그래서 생성 폼은 계속 침묵했다(§7).
    const msg = photoPlaceNotice(hint);
    if (msg) showNoticeToast(msg);
    return;
  }
  const { lat, lng } = hint.coord;
  // 이름 조회는 좌표가 기기 밖으로 나가는 일이라 **동의가 있을 때만.** 없으면 좌표만 넣는다
  // (여기서 새로 묻지 않는다 — 사진을 넣는 중에 대화상자를 띄우면 흐름이 끊긴다).
  const hit = hasAgreed(PHOTO_GEO_CONSENT_KEY) ? await reverseGeocode(lat, lng) : null;
  const name = hit?.name ?? '';
  await updateMomentLocalFirst(momentId, { placeName: name, placeLat: lat, placeLng: lng });
  showUndoToast(name ? `📍 사진 위치로 장소를 넣었어요 · ${name}` : '📍 사진 위치(좌표)를 넣었어요', async () => {
    await updateMomentLocalFirst(momentId, { placeName: '', placeLat: null, placeLng: null });
    await refresh();
  });
}

/**
 * 🕒 **사진이 찍힌 나라로 여행 시간대를 제안한다** (사용자 제안 2026-07-30:
 * *"초기값은 사진찍은 장소로 셋팅..어때?"*).
 *
 * 🔴 **자동으로 정해 버리지 않는다.** 좌표→시간대는 경계 데이터셋이 필요해 하지 않고(수 MB),
 * 우리가 아는 것은 **나라까지**다. 나라의 시간대가 하나면 사실상 답이지만, 여럿이면
 * (미국 29개·우즈베키스탄 2개) 고르는 것은 사용자다 — 조용히 하나를 집으면 그건 §8이
 * 금지하는 반올림이고, **엉뚱한 시간대는 Day 묶음까지 흔든다.**
 *
 * 침묵하는 경우 셋: ①이미 시간대가 정해져 있다(사용자가 고른 것을 앱이 이기지 않는다)
 * ②사진에 좌표가 없다 ③나라의 시간대가 하나가 아니거나 모른다.
 *
 * 그리고 **동의 없이는 좌표를 내보내지 않는다** — 장소 칸에서 이미 확인받았을 때만 조회한다
 * (여기서 또 묻지 않는다. 같은 사진, 같은 좌표, 같은 결정이다).
 */
function buildZoneSuggest(
  clock: TripClock,
  apply: (zone: string) => Promise<void>,
): { el: HTMLElement; suggest: (metas: readonly PhotoMetaLike[]) => void } {
  // 🔴 클래스는 `zone-suggest`다 — **`zone-notice`가 아니다.** 처음엔 모양이 같다고 같은
  // 이름을 줬는데, 그 순간 「미지정 고지가 떴는가」를 세던 라이브 검사가 **숨어 있는 이 상자를
  // 먼저 집었다.** 같은 모양이라고 같은 이름을 주면 *다른 것*이 하나의 이름 뒤에 숨는다.
  // 모양은 CSS가 공유하고(`.zone-notice, .zone-suggest`), 이름은 뜻을 따라간다.
  const box = el('div', 'zone-suggest');
  box.hidden = true;
  box.setAttribute('role', 'status');
  const msg = el('span', 'zone-notice-msg');
  const btn = el('button', 'btn-ghost zone-notice-fix', '이 시간대로 하기') as HTMLButtonElement;
  btn.type = 'button';
  btn.setAttribute('data-zone-suggest', '1'); // 라이브 검사가 **눌러 보는** 손잡이(§13 4항)
  box.append(msg, btn);

  const suggest = (metas: readonly PhotoMetaLike[]): void => {
    if (clock.zone) return;
    const hint = photoHintOf(metas);
    if (!hint.coord || !hasAgreed(PHOTO_GEO_CONSENT_KEY)) return;
    const { lat, lng } = hint.coord;
    void (async () => {
      const hit = await reverseGeocode(lat, lng);
      const cc = hit?.address.countryCode ?? '';
      const zones = cc ? zonesForCountry(cc.toUpperCase()) : [];
      if (zones.length !== 1) return; // 여럿이거나 모르면 **침묵한다** — 목록에서 고르면 된다
      const zone = zones[0]!;
      const where = hit?.address.country ?? cc.toUpperCase();
      msg.textContent = `📷 사진이 ${where}에서 찍혔어요 — 이 여행 시간대를 「${zoneLabel(new Date().toISOString(), zone)}」로 할까요?`;
      box.hidden = false;
      btn.onclick = () => {
        btn.disabled = true;
        void apply(zone).catch(() => {
          btn.disabled = false; // 실패해도 잠긴 채 남지 않는다(§13 4항 ④)
          msg.textContent = '시간대를 저장하지 못했어요 — 여행 편집에서 직접 골라 주세요';
        });
      };
    })();
  };
  return { el: box, suggest };
}

/**
 * 장소 검색 실행 — **좌표를 먼저 보고**, 아니면 지오코더에 묻는다.
 *
 * 최상위로 뽑은 이유는 래칫이지만 결과가 낫다: 「무엇을 검색으로 볼 것인가」는 이 화면의
 * 규칙이 아니라 **장소 도메인의 규칙**이고, 클로저 밖에 있어야 다음 사람이 찾는다.
 */
function makeDoSearch(o: {
  input: HTMLInputElement;
  results: HTMLElement;
  searchBtn: HTMLButtonElement;
  useCoord: (c: ParsedCoord) => void;
  near: () => { lat: number; lng: number } | null;
  apply: Parameters<typeof runPlaceSearch>[1]['apply'];
  linkPlace: (id: string | null) => void;
}): () => void {
  return () => {
    const q = o.input.value.trim();
    if (!q) return;
    // 🔴 **좌표 먼저 본다.** 네이버·카카오·구글에서 찾은 좌표를 그대로 붙여넣는 흐름
    //    (사용자 제안 2026-07-30) — 앱이 못 찾는 곳을 사람이 뚫는 탈출구다.
    //    지오코더에 「37.587, 127.0016」을 물어봐야 좋은 답이 나올 리 없다.
    const coord = parseCoordinateInput(q);
    if (coord) {
      o.results.hidden = false;
      o.results.innerHTML = '';
      renderCoordInput(o.results, coord, o.useCoord);
      return;
    }
    o.searchBtn.disabled = true;
    o.results.hidden = false;
    o.results.textContent = '검색 중…';
    void runPlaceSearch(q, {
      results: o.results,
      // 이미 좌표가 있으면 그 근처를 우선한다 — 「대학로」가 전국에 여럿일 때 지금 보고 있는
      // 도시가 먼저 나오는 것이 맞다. 경계 밖을 **버리지는 않는다**(해외 검색을 막지 않게).
      near: o.near(),
      apply: o.apply,
      linkPlace: o.linkPlace,
    }).finally(() => {
      o.searchBtn.disabled = false;
    });
  };
}

/**
 * 📷 **사진 위치로 장소 칸을 채우는 규칙** (사용자 제안 2026-07-30).
 *
 * 최상위로 뽑은 이유는 래칫(`check-fn-size`)이지만, 떼고 보니 이게 맞다 — 여기 담긴 것은
 * *"장소를 고르는 일"*이 아니라 **개인정보 경계**다(좌표가 언제 기기 밖으로 나가는가).
 * 그 판단이 300줄짜리 클로저 안에 묻혀 있으면 다음 사람이 못 본다(§11 *게이트가 설계를 밀어준다*).
 *
 * @param taken 사용자가 이미 손댔는가. 참이면 **아무 일도 하지 않는다** — 앱이 사용자를 이기지 않는다.
 */
function photoPlaceSuggester(o: {
  note: HTMLElement;
  ctx: CoordApplyContext;
  setPicked: (detail: string | null) => void;
  taken: () => boolean;
}): (metas: readonly PhotoMetaLike[]) => void {
  return (metas) => {
    const hint = photoHintOf(metas);
    // 🔴 **없다는 사실을 먼저 처리한다.** 순서를 반대로 뒀다가 라이브 게이트에 잡혔다:
    // 위치 있는 사진 → 위치 없는 사진으로 바꾸면 `taken()`이 참(좌표가 이미 있으므로)이라
    // 조기 반환했고, **먼저 고른 사진의 좌표를 말하는 문장이 화면에 그대로 남았다.**
    // 지금 고른 사진에는 그 위치가 없는데 화면은 있다고 말한 것 — M-0021(판정 문장이 엉뚱한
    // 곳을 가리킴)과 같은 형태다. 좌표 자체는 남긴다(사용자가 지운 적 없다) — 그 사실은
    // 배지가 계속 말한다. 사라지는 것은 **「이번에 고른 사진이 알려줬다」는 주장**뿐이다.
    if (!hint.coord) {
      // 🔴 **여기가 침묵하고 있었다**(사용자 2026-07-31: *"아직도 해결이 안되네"*).
      // v1.30이 「사진 추가」 경로만 말하게 했고 **사용자가 실제로 쓴 화면은 이쪽**이었다.
      // §8의 「침묵이 정상」을 잘못 적용한 자리다 — 그 조항은 *기대와 일치하는 것*을 감추라는
      // 뜻이지, **사용자가 기대한 일이 안 일어난 것**을 감추라는 뜻이 아니다. 사진을 골랐는데
      // 장소가 안 채워진 것은 정상이 아니라 **설명이 필요한 사건**이다.
      // 좌표 자체는 남긴다(사용자가 지운 적 없다) — 사라지는 것은 「이번 사진이 알려줬다」는 주장뿐.
      //
      // 🔴 단, **이미 장소가 있으면 침묵한다** — 그때는 앱이 못 한 일이 없으므로 설명할 것도
      // 없다(§8). 이건 취향이 아니라 형제 맞춤이다: 「사진 추가」 경로도 `hasPlace`면 아무
      // 말 없이 지나간다. 한쪽만 말하면 같은 상황에서 화면이 둘로 갈린다(§7 사용자 대면 대칭).
      // 그래도 **문장은 지운다** — 앞서 고른 사진이 남긴 말이 그대로 있으면 지금 사진에 대한
      // 주장으로 읽힌다(M-0052 ①이 그 형태였다).
      o.note.textContent = o.taken() ? '' : photoPlaceNotice(hint);
      o.note.hidden = !o.note.textContent;
      return;
    }
    if (o.taken()) return;
    // 좌표 채우기는 **네트워크가 0**이다. 이 값은 기기 밖으로 나가지 않으므로 물을 것이 없다.
    o.ctx.commit(hint.coord.lat, hint.coord.lng);
    o.setPicked('사진 위치');
    o.note.textContent = photoPlaceLabel(hint);
    o.note.hidden = false;

    // 🔴 이름 조회는 **좌표가 기기 밖으로 나가는 일**이라 처음 한 번 확인받는다(원칙 #3).
    // 이름 검색과 다르게 묻는 이유: 이름은 사용자가 치고 [검색]을 누른 것이라 의도가 분명한데,
    // 사진 GPS는 **사진을 골랐을 뿐인데** 나간다. 거절해도 좌표는 남는다 — 기능을 통째로 막지 않는다.
    if (!hasAgreed(PHOTO_GEO_CONSENT_KEY)) {
      if (!window.confirm(PHOTO_GEO_CONSENT_TEXT)) {
        o.note.textContent = `${photoPlaceLabel(hint)} — 이름은 직접 적어 주세요`;
        return;
      }
      rememberAgreed(PHOTO_GEO_CONSENT_KEY);
    }
    void fillNameFromReverse(o.ctx, hint.coord.lat, hint.coord.lng);
  };
}

function buildPlaceField(initial: { name: string; lat: number | null; lng: number | null }): PlaceField {
  const { wrap, row, input, searchBtn, mapBtn, hereBtn, results } = buildPlaceFieldShell(initial.name);

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
  wireNameEdit({
    input,
    results,
    coordIsIndependent: () => mapPicked,
    setPicked,
    clearCoord: () => {
      lat = null;
      lng = null;
      placeId = null; // 좌표가 무효면 링크도 무효다 — 링크만 남으면 엉뚱한 곳을 가리킨다
    },
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

  const doSearch = makeDoSearch({
    input,
    results,
    searchBtn,
    useCoord,
    near: () => (lat !== null && lng !== null ? { lat, lng } : null),
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
  });
  searchBtn.addEventListener('click', doSearch);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault(); // 폼 제출 대신 검색
      doSearch();
    }
  });

  // 📷 사진이 위치를 알고 있으면 그것으로 채운다(사용자 제안 2026-07-30). 로직은 최상위에.
  const photoNote = el('p', 'place-photo-note when-note', '');
  photoNote.hidden = true;
  wrap.appendChild(photoNote);
  const suggestFrom = photoPlaceSuggester({
    note: photoNote,
    ctx: coordCtx,
    setPicked,
    taken: () => input.value.trim() !== '' || (lat !== null && lng !== null),
  });

  // 🗺 지도에서 위치 지정 — 장소 이름은 사용자가 직접 적고, 좌표만 지도로 찍는다.
  // (등록되지 않은 곳일 수 있으므로 이름은 검색 결과에 의존하지 않는다.)
  wireMapPickButton(mapBtn, results, coordCtx, () => (lat !== null && lng !== null ? { lat, lng } : null));
  // 📍 내 위치 — 같은 부품이므로 생성 폼·편집 폼이 **함께** 받는다(§7 2층).
  wireHereButton({ btn: hereBtn, note: photoNote, ctx: coordCtx, hasCoord: () => lat !== null && lng !== null });

  return {
    el: wrap,
    getName: () => input.value,
    getCoords: () => (lat !== null && lng !== null ? { lat, lng } : null),
    getPlaceId: () => placeId,
    suggestFrom,
    reset: () => {
      photoNote.hidden = true;
      photoNote.textContent = '';
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
import {
  momentWhen,
  atOffset,
  wallClockToInstant,
  clockOffsetAtWall,
  inputClockHint,
  zoneOptions,
  zonePreview,
  zoneLabel,
  zonesForCountry,
  deviceZone,
  zoneMatches,
  type TripClock,
} from '../../domain/time';
import { homeZone, setHomeZone } from '../../services/homeZone';
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
  /**
   * 고른 사진에서 추측해 채운다. 사용자가 이미 손댔으면 **아무 일도 하지 않는다**.
   *
   * 🔴 파일이 아니라 **이미 읽은 메타**를 받는다(2026-07-30). 예전엔 이 함수가 직접
   * `readPhotoMeta`를 불렀는데, 장소 칸도 같은 메타가 필요해지면서 **한 장을 두 번 읽게**
   * 됐다 — 9장을 고르면 앞 256KB × 9 × 2다(저메모리 기기 규율 위반). 읽기를 폼으로 올리고
   * 두 칸이 **같은 결과를 나눠 쓴다.**
   */
  suggestFrom(metas: readonly PhotoMeta[]): void;
  /** 값을 그대로 넣고 근거 줄은 비운다(편집 폼 — 이미 정해진 값이라 추측이 아니다). */
  set(iso: string): void;
}

function buildWhenField(
  trip: { startDate: string | null; endDate: string | null; timeZone?: string } | null,
  /**
   * 이 여행의 시계. 🔴 **입력 칸도 여행지 시각으로 적는다** — 타임라인이 19:08이라 말하는데
   * 편집 칸을 열면 21:08이면, 사용자는 저장 버튼을 누르는 순간 시각이 바뀐다고 느낀다.
   * (실제로는 안 바뀌는데도 그렇게 보인다. 그게 더 나쁘다 — 앱을 못 믿게 된다.)
   */
  clock: TripClock,
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
  // 어느 시계로 적는 중인지 **늘 말한다**(§13 3항 — 추측을 숨기지 않는다).
  const hint = el('p', 'when-clock muted small', inputClockHint(new Date().toISOString(), clock));
  wrap.append(input, hint, note, warn);

  /** 벽시계 → 절대시각. 오프셋은 **적힌 벽시계 기준**으로 재야 DST 경계가 맞는다. */
  const read = (): string | undefined => fromLocalInputValue(input.value, clockOffsetAtWall(input.value, clock));
  /** 절대시각 → 벽시계. 여행지 오프셋으로 그린다. */
  const write = (iso: string): string => toLocalInputValue(iso, momentWhen(iso, null, clock).offsetMin);

  let touched = false;
  const refreshWarn = (): void => {
    const iso = read();
    const w = iso
      ? outsideTripWarning(iso, trip?.startDate ?? null, trip?.endDate ?? null, momentWhen(iso, null, clock).offsetMin)
      : null;
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
    input.value = write(g.at);
    note.textContent = g.label;
    note.hidden = false;
    refreshWarn();
  };

  return {
    el: wrap,
    value: read,
    suggestFrom(metas) {
      // **EXIF가 없는 사진은 세지 않는다**(null 제거): 스크린샷의 파일 수정시각을 근거로 쓰면
      // 화면이 「📷 사진에서」라고 말하면서 실은 *앱에 넣은 시각*을 보여주게 된다 — 거짓 근거다.
      const photoTakenAts = metas.map((m) => m.takenAt).filter((t): t is string => t !== null);
      apply(
        guessOccurredAt({
          photoTakenAts,
          previousOccurredAt: latestMomentAt(),
          tripStartDate: trip?.startDate ?? null,
          now: new Date().toISOString(),
          offsetMin: clockOffsetAtWall(`${trip?.startDate || '2000-01-01'}T12:00`, clock),
        }),
      );
    },
    set(iso) {
      input.value = write(iso);
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
function toLocalInputValue(iso: string, offsetMin: number): string {
  const { date, time } = atOffset(iso, offsetMin);
  return date ? `${date}T${time}` : '';
}

/**
 * 장소 칩 — **탭하면 그 장소의 지도가 열린다.**
 *
 * 🔴 **좌표만 있어도 그린다**(사용자 지적 2026-07-31 — *"안되네요"*). 예전엔 `placeName`이
 * 있어야만 칩이 나왔다. 그런데 사진에서 좌표를 넣었는데 이름 조회가 안 되면(동의 없음·
 * 오프라인) 이름이 빈 채로 남고, 그러면 **좌표가 들어갔는데 화면은 아무 일도 없었던 것처럼**
 * 보인다. 사용자가 「안 된다」고 읽는 것이 당연하다 — 앱이 한 일을 말하지 않았으니까(§12).
 * 이름이 없으면 **좌표를 라벨로** 쓴다: 「이름 없는 장소」는 앱의 사정이지 사용자의 정보가
 * 아니지만, 좌표는 적어도 *어디인지*를 말하고 지도에서 열 수도 있다.
 *
 * 왜 앱 지도인가(사용자 결정 2026-07-27): 앱 지도(MapLibre+OSM)는 비공개이고 오프라인에서도
 * 뜬다. 구글은 길찾기·스트리트뷰가 필요할 때 **거기서 한 걸음 더** 가는 곳이다. 그래서 칩은
 * 늘 앱 지도를 열고, 「🌐 구글지도로 열기」는 그 안에 둔다 — 좌표가 조용히 밖으로 나가지 않는다.
 *
 * 좌표가 없어도 **누를 수 있다.** 지도는 빈 상태로 열려 "좌표가 없다"고 말하고, 이름으로
 * 검색해 갈 길을 준다. 누를 수 없게 두면 *왜* 안 눌리는지 사용자가 알 방법이 없다(§12).
 */
/**
 * 이 순간에 **쓸 만한 장소가 있는가**(순수).
 *
 * 🔴 **이미 저장된 0,0은 장소로 치지 않는다**(M-0057). 사용자 기록에 이미 들어가 있고,
 * 옛 파서가 넣은 것이라 **사용자가 지운 적이 없다.** 「장소가 있다」로 세면 ①칩이 기니만
 * 앞바다 좌표를 보여주고 ②사진에서 위치를 채우는 길이 「이미 있음」으로 막힌다.
 *
 * **지우지는 않는다** — 사용자 자료를 앱이 임의로 삭제하지 않는다(§0). 화면에서 **없는
 * 것으로 보고**, 새 위치가 들어오면 자연스럽게 덮인다.
 */
function momentHasPlace(m: { placeName: string; placeLat?: number | null; placeLng?: number | null }): boolean {
  // 🔴 「진짜 좌표인가」는 단 하나의 함수(isRealCoord)가 판정한다(H-3). 예전엔 여기서 NaN을
  // 안 막아 `NaN, NaN`이 「장소 있음」으로 통과했다 — 이제 유한·범위·0,0을 한꺼번에 거른다.
  return Boolean(m.placeName) || isRealCoord(m.placeLat, m.placeLng);
}

function placeChip(m: { id: string; placeName: string; placeLat?: number | null; placeLng?: number | null }): HTMLElement {
  const lat = m.placeLat ?? null;
  const lng = m.placeLng ?? null;
  // 이름이 없으면 **좌표를 보여준다.** 「이름 없는 장소」라고 쓰면 그건 앱의 사정이지
  // 사용자의 정보가 아니다 — 좌표는 적어도 *어디인지*를 말한다(지도에서 열 수도 있다).
  // 🔴 「진짜 좌표인가」는 단 하나의 함수(isRealCoord)가 판정한다(H-3 · NaN·범위밖·0,0 배제).
  const realCoord = isRealCoord(lat, lng);
  const label = m.placeName || (realCoord ? `${lat!.toFixed(4)}, ${lng!.toFixed(4)}` : '');
  const chip = el('button', 'chip gps chip-tap', `📍 ${label}`) as HTMLButtonElement;
  chip.type = 'button';
  chip.setAttribute('aria-label', `${label} 지도에서 보기`);
  const place = { name: label, lat, lng };
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    const pts =
      lat !== null && lng !== null
        // 장소 칩에서 여는 지도는 **한 장소를 가리키는 것**이지 순간의 시각을 말하는 자리가
        // 아니다 — `whenText: ''`가 그 사실이고, 팝업은 시각 줄을 아예 그리지 않는다.
        ? [{ momentId: m.id, lat, lng, title: label, occurredAt: '', placeName: label, whenText: '' }]
        : [];
    void openMapView(label, pts, place);
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
function fromLocalInputValue(v: string, offsetMin: number): string | undefined {
  if (!v) return undefined;
  return wallClockToInstant(v, offsetMin) ?? undefined;
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

    // 🕒 **이 여행의 시계를 여기서 한 번 만든다.** 아래 모든 시각 표시가 이것을 지난다 —
    // 화면 안에서 자가 갈리지 않게(M-utc-slice의 근본형은 「같은 값을 두 자로 쟀다」였다).
    // 여행 시간대를 고치면 화면이 통째로 재렌더되므로(onSave → renderTripDetail) const로 둔다.
    const clock: TripClock = { zone: trip.timeZone ?? '', homeZone: homeZone() };

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
    const photoInput = photoFileInput();
    const photoLabel = el('label', 'moment-photo-label');
    photoLabel.append(document.createTextNode('📷 사진 추가 '));
    // 🔴 사진이 EXIF로 직접 말한 시간대 오프셋(환승·국경일 때 여행 시간대와 다르다 — M-1).
    // 저장 시 순간에 실어 준다. 예전엔 이 값이 photoHintOf에서 계산만 되고 버려졌다.
    let photoTzOffsetMin: number | null = null;
    // 선택한 사진 미리보기 + 해제. 로직은 최상위 `buildPickPreview`에 있다.
    const picks = buildPickPreview(photoInput, (metas) => {
      // 사진이 바뀌면 **시각·장소·시간대가 함께** 따라간다 — 사진이 가장 강한 근거다.
      whenField.suggestFrom(metas);
      placeField.suggestFrom(metas);
      zoneHint.suggest(metas);
      photoTzOffsetMin = photoHintOf(metas).exifOffsetMin;
    }, () => trip?.timeZone ?? '');
    photoLabel.append(picks.count, photoInput);
  // 📁 안드로이드 사진 선택기가 GPS를 지우므로(M-0054), **원본 파일로 가는 길**을 함께 둔다.
  const origBtn = galleryPickButton(photoInput);



    // 비용(선택) — 금액 + 통화. "10초 기록"을 방해하지 않도록 한 줄, 비우면 저장 안 함.
    const money = buildMoneyRow(undefined);

    const save = el('button', 'btn-primary', '순간 저장') as HTMLButtonElement;
    save.type = 'submit';

    // 🕒 사진이 찍힌 나라로 여행 시간대를 **제안**한다(사용자 제안 2026-07-30). 규칙은 최상위에.
    const zoneHint = buildZoneSuggest(clock, async (zone) => {
      await updateTripLocalFirst(trip!.id, { timeZone: zone });
      void trySync();
      renderTripDetail(mount, tripId, navigate); // 화면 전체가 새 시계로 다시 그려진다
    });
    compose.appendChild(zoneHint.el);

    // 발생 시각 — **소급 입력이 주 흐름**이라(사용자 2026-07-27) 접어 두지 않고 항상 보인다.
    const whenField = buildWhenField(trip, clock, () => latestMomentAt);
    whenField.suggestFrom([]); // 사진 전에도 근거를 보여준다(직전 순간 / 여행 시작일)

    form.append(input, emotion.el, whenField.el, placeField.el, money.el, photoLabel, origBtn, picks.el, save);
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
      const key = fxKey(fxDateFor(occurredAt, todayDate(), momentWhen(occurredAt, null, clock).offsetMin), fxBase());
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
        if (m) dates.add(fxDateFor(m.occurredAt, today, momentWhen(m.occurredAt, m.tzOffsetMin, clock).offsetMin));
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
      locatedPoints = toMapPoints(moments, byMoment, clock);
      renderTimeline(moments, byMoment, expByMoment, audioByMoment);
      const groups = groupMomentsByDay(moments, clock, trip!.startDate || undefined);
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
      // 🕒 미지정 고지 — **순간이 하나라도 있을 때만.** 빈 화면에서는 「첫 순간을 남겨보세요」가
      // 할 일이고, 그 위에 시간대 경고를 얹으면 시작하기 전에 숙제를 주는 셈이 된다.
      const notice = moments.length
        ? zoneNotice(momentWhen(moments[0]!.occurredAt, moments[0]!.tzOffsetMin, clock).caveat, () => {
            editPanel.hidden = false;
            // 🔴 `HTMLInputElement`로 좁히지 않는다 — v1.28에서 `<select>`가 되면서
            // **이 줄이 조용히 죽었다**(컴파일은 통과하고 초점만 안 갔다). 라이브 검사가 잡았다.
            const zi = editPanel.querySelector('[data-zone-input]');
            if (zi instanceof HTMLElement) zi.focus();
            editPanel.scrollIntoView({ block: 'nearest' });
          })
        : null;
      if (notice) timeline.appendChild(notice);
      if (moments.length === 0) {
        const empty = el('div', 'empty-state');
        empty.appendChild(el('p', 'empty-emoji', '📝'));
        empty.appendChild(el('h2', undefined, '첫 순간을 남겨보세요'));
        empty.appendChild(el('p', 'muted', '사진·장소는 나중에 채워도 돼요. 한 줄이면 충분합니다.'));
        timeline.appendChild(empty);
        return;
      }
      for (const g of groupMomentsByDay(moments, clock, trip!.startDate || undefined)) {
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
      // 🕒 **그 자리의 시각**이 크게, 집 시간 환산이 그 아래 작게. 같은 값을 두 번 말하지
      // 않는다 — 환산은 시각이 **다를 때만** 나온다(`home`이 빈 문자열이면 침묵. §8).
      item.append(...timeGutter(momentWhen(m.occurredAt, m.tzOffsetMin, clock)));
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
      const { wrap: addPhotoWrap, input: addPhotoInput, progress: addProgress } = buildAddPhotoRow();
      // 🎙 소리 남기기 — 사진 추가와 **같은 줄**에 둔다(둘 다 "이 순간에 뭔가 더하기"다).
      addPhotoWrap.append(buildRecordButton(m.id, trip!.id, addProgress, refresh), addProgress);
      // 사진 추가 배선은 최상위 `wireAddPhoto`가 한다(래칫이 밀어줬다 — 그리고 이 배선의
      // 규율은 「§0 굽기 전에 EXIF」라 화면 코드가 아니라 밖에 있는 편이 맞다).

      // 인라인 편집 폼(토글). 저장 시 순간 수정 + 비용 조정(생성/수정/삭제) → 재렌더.
      const existingExpense = expenseList[0];
      const editForm = buildMomentEditForm(
        m,
        trip,
        clock,
        existingExpense,
        async (patch, expenseIntent) => {
          await updateMomentLocalFirst(m.id, patch);
          if (expenseIntent.amount !== null) {
            if (existingExpense) {
              await updateExpenseLocalFirst(existingExpense.id, {
                originalAmount: expenseIntent.amount,
                originalCurrency: expenseIntent.currency,
                note: expenseIntent.note,
              });
            } else {
              await createExpenseLocalFirst({
                momentId: m.id,
                tripId: trip!.id,
                originalAmount: expenseIntent.amount,
                originalCurrency: expenseIntent.currency,
                note: expenseIntent.note,
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
      // `hasPlace`: 이름이든 좌표든 하나라도 있으면 사진이 장소를 **손대지 않는다.**
      const hasPlace = momentHasPlace(m);
      wireAddPhoto(addPhotoInput, addProgress, { momentId: m.id, tripId: trip!.id, fallbackZone: trip?.timeZone ?? '', hasPlace, refresh });
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
      if (hasPlace || expenseList.length || audioList.length) {
        const chips = el('div', 'chips');
        if (hasPlace) chips.appendChild(placeChip(m)); // 좌표만 있어도 그린다 — placeChip 주석 참조
        appendAudioChips(chips, audioList, refresh);
        // 환율 상세(탭하면 펼쳐짐) — 툴팁(title)은 모바일에서 안 보이므로 실제 패널로 보여준다.
        const fxDetail = el('div', 'fx-detail');
        fxDetail.hidden = true;

        for (const ex of expenseList) {
          // 메모가 있으면 **금액과 함께** 보인다 — 숫자만 남은 비용은 한 달 뒤 의미를 잃는다.
          // 없으면 아무것도 붙지 않는다(빈 구분자를 만들지 않는다).
          const chip = el(
            'span',
            'chip money',
            `💰 ${formatMoney(ex.originalAmount, ex.originalCurrency)}${ex.note ? ` · ${ex.note}` : ''}`,
          );
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
                fxDetail.append(
                  ...fxDetailRows(ex, m.occurredAt, momentWhen(m.occurredAt, m.tzOffsetMin, clock).offsetMin, base, t, conv),
                );
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
          img.addEventListener('click', () => openPhotoViewer(mediaList, mdIdx, refresh, clock));
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
            // 🔴 사진이 EXIF로 직접 말한 오프셋만 실어 준다(M-1 — 환승·국경). 없으면 null이라
            // 여행 시간대로 파생된다. 이 한 줄이 그동안 죽어 있던 파이프를 살린다.
            ...(photoTzOffsetMin !== null ? { tzOffsetMin: photoTzOffsetMin } : {}),
          });
          // 비용(선택): 금액이 유효하면 순간에 딸린 비용으로 저장(실패해도 순간을 무르지 않는다).
          await saveMomentExpense(moment.id, trip!.id, money);
          await processPhotosIntoMoment(files, moment.id, trip!.id, (msg) => {
            // 진행 중은 갈 곳이 없다 — 지금 벌어지는 일을 보고할 뿐이고, 곧 결과로 바뀐다.
            setNote(note, msg, 'info', null); // 사진 처리 진행 — 잠깐 보이는 정보
          });
          input.value = '';
          placeField.reset();
          emotion.reset();
          money.reset();
          // 미리보기 URL 회수 + 개수 문구까지 한 번에(초기화 경로를 두 개 만들지 않는다).
          picks.setFiles([]);
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

/**
 * **여행 시간대 칸** — 「그 자리의 시계」를 정하는 단 하나의 자리.
 *
 * 🔴 **`<datalist>`에서 `<select>`로 바꿨다**(사용자 제안 2026-07-30: *"드롭다운해서 선택하게끔"*).
 *
 * 처음엔 `<input list=…>`로 만들었다 — 타이핑으로 418개를 좁힐 수 있어서다. 그런데 그때
 * **내가 직접 「안드로이드 크롬에서 자동완성이 안 뜰 수 있다」를 실기기 확인 항목에 적었다.**
 * 즉 *가장 약한 고리를 알면서 사용자에게 검증을 떠넘긴* 셈이다(§13이 금지하는 그 형태).
 * `<select>`는 어느 폰에서든 **네이티브 선택기**가 뜨고, 오타가 원리적으로 불가능하며,
 * 「이 시간대를 알 수 없어요」 경로 자체가 사라진다.
 *
 * 418개는 **대륙별 `<optgroup>`**으로 묶는다. 분류표를 우리가 만들지 않는다 —
 * `Asia/`·`Europe/` 접두사가 **이미 그 묶음**이다.
 *
 * 🔴 **비우는 것을 막지 않는다.** 「미지정」은 결함이 아니라 사실이다 — 어디였는지 모르는
 * 옛 여행이 있고, 그때는 앱이 **모른다고 말하는 것이 맞다**(§8 「모르는 것은 확인 불가」).
 * 대신 미지정이면 타임라인이 「이 기기 시간대로 보여주고 있어요」를 붙인다.
 */
interface ZoneField {
  el: HTMLElement;
  value(): string;
  set(zone: string): void;
}

interface ZoneSelectOptions {
  initial: string;
  ariaLabel: string;
  /** 라이브 검사가 이 칸을 집는 `data-*` 이름(§13). */
  handle: string;
  /** 「미지정」 선택지를 둘 것인가. 여행은 둔다(모르는 것은 사실), 집은 두지 않는다(환산 기준이라 늘 있다). */
  allowNone: boolean;
  /**
   * 목록에 **반드시 있어야 하는** 추가 id들.
   *
   * 🔴 왜 필요한가(라이브 검사가 잡았다): `Intl.supportedValuesOf('timeZone')`은 418개를 주는데
   * **`UTC`는 그 안에 없다.** 기기 시간대가 `UTC`인 환경에서 집 시간대를 한 번 바꾸면,
   * 다시 그릴 때 옛 값의 자리가 사라져 **드롭다운으로 되돌아갈 길이 없어진다.**
   * 그래서 「내 기기 시간대」는 늘 고를 수 있게 둔다.
   */
  alsoOffer?: string[];
  /**
   * **자주 쓰는 시간대** — 목록 맨 위 「자주 씀」 묶음에 이 순서대로 올린다.
   *
   * 사용자 지적(2026-08-01): *"시간대가 너무 많아서 찾기가 힘들어요...서울 시간대와
   * 타슈켄트 시간대를 배치하면 좋을 듯 해요. 자주 쓰거든요"*. 두 자리(여행·집 시간대)가
   * 같은 값을 쓴다(§7) — 손으로 두 벌 만들면 한쪽만 낡는다.
   */
  pinned?: string[];
  /** 미리보기 문장 — 자리마다 하는 말이 다르므로 호출부가 정한다. */
  say: (zone: string) => string;
  onChange?: (zone: string) => void;
}

/** 여행·집 시간대 칸이 공유하는 「자주 씀」 목록(§7 SSOT) — 서울·타슈켄트. */
const PINNED_ZONES: readonly string[] = ['Asia/Seoul', 'Asia/Tashkent'];

/**
 * 🔴 **시간대 선택기 — 여행과 집이 같은 한 곳을 지난다**(§7 2층 · 화면 대칭).
 *
 * 두 칸을 손으로 두 벌 만들면 한쪽만 낡는다. 실제로 그럴 뻔했다: 여행 칸을 `<select>`로
 * 바꾸는 순간 집 칸이 **사라진 `<datalist>`를 계속 가리키고** 있었다 — 컴파일은 통과하고
 * 화면에서만 조용히 죽는 부류다(§10 ③).
 */
function buildZoneSelect(o: ZoneSelectOptions): ZoneField {
  const wrap = el('div', 'zone-field');

  // 🔍 검색 — 418개를 스크롤로 찾기 힘들다는 지적(2026-08-01)에 대한 응답. select 자체는
  // 네이티브로 유지하고(§13 주석 참조 — 자동완성 신뢰성 문제로 datalist를 버렸다), 검색은
  // **option을 숨기는 것**으로 구현한다 — 선택 방식은 그대로, 목록만 좁아진다.
  const search = el('input', 'edit-input zone-search') as HTMLInputElement;
  search.type = 'search';
  search.placeholder = '🔍 검색 (예: seoul, tashkent, asia)';
  search.setAttribute('aria-label', `${o.ariaLabel} 검색`);
  search.setAttribute(`${o.handle}-search`, '1');

  const sel = el('select', 'edit-input zone-input') as HTMLSelectElement;
  sel.setAttribute('aria-label', o.ariaLabel);
  sel.setAttribute(o.handle, '1');

  if (o.allowNone) {
    const none = el('option', undefined, '— 미지정 —') as HTMLOptionElement;
    none.value = '';
    sel.appendChild(none);
  }

  const now = new Date().toISOString();
  const optionFor = (z: string): HTMLOptionElement => {
    const city = z.slice(z.indexOf('/') + 1).replace(/_/g, ' ');
    const opt = el('option', undefined, `${city} · ${zoneLabel(now, z)}`) as HTMLOptionElement;
    opt.value = z;
    return opt;
  };

  const pinned = (o.pinned ?? []).filter((z, i, arr) => arr.indexOf(z) === i);
  if (pinned.length) {
    const g = el('optgroup') as HTMLOptGroupElement;
    g.label = '⭐ 자주 씀';
    for (const z of pinned) g.appendChild(optionFor(z));
    sel.appendChild(g);
  }

  // 대륙별로 묶는다. 418개를 한 줄로 늘어놓으면 폰에서 찾을 수가 없고, `Asia/`·`Europe/`가
  // 이미 그 묶음이다 — **우리가 분류표를 만들지 않는다**(id가 스스로 말한다).
  // 자주 씀에 이미 올라간 항목은 여기서 뺀다(같은 값이 목록에 두 번 나오지 않게).
  const pinnedSet = new Set(pinned);
  const byRegion = new Map<string, string[]>();
  for (const z of zoneOptions()) {
    if (pinnedSet.has(z)) continue;
    const region = z.includes('/') ? z.slice(0, z.indexOf('/')) : '기타';
    const arr = byRegion.get(region);
    if (arr) arr.push(z);
    else byRegion.set(region, [z]);
  }
  for (const [region, zs] of byRegion) {
    const g = el('optgroup') as HTMLOptGroupElement;
    g.label = region;
    for (const z of zs) g.appendChild(optionFor(z));
    sel.appendChild(g);
  }

  /** 목록에 없는 값(옛 기록·별칭)이 조용히 「미지정」으로 바뀌지 않게 자리를 만들어 준다. */
  const ensureOption = (z: string): void => {
    if (!z || [...sel.options].some((opt) => opt.value === z)) return;
    const g = el('optgroup') as HTMLOptGroupElement;
    g.label = '저장된 값';
    g.appendChild(optionFor(z));
    sel.insertBefore(g, sel.children[o.allowNone ? 1 : 0] ?? null);
  };
  for (const z of o.alsoOffer ?? []) ensureOption(z);
  ensureOption(o.initial);
  sel.value = o.initial;

  // 검색어로 option을 숨긴다(순수 판정은 domain/time.ts의 zoneMatches — 유닛이 그쪽을 돈다).
  // 그룹 전체가 안 보이면 그룹 자체도 접는다 — 빈 지역 이름만 남는 것을 막는다.
  const applyFilter = (): void => {
    const q = search.value;
    for (const opt of Array.from(sel.options)) {
      opt.hidden = !zoneMatches(q, opt.value, opt.textContent ?? '');
    }
    for (const g of Array.from(sel.querySelectorAll('optgroup'))) {
      g.hidden = Array.from(g.children).every((c) => (c as HTMLOptionElement).hidden);
    }
  };
  search.addEventListener('input', applyFilter);

  const preview = el('p', 'zone-preview muted small');
  preview.setAttribute('role', 'status');
  const sync = (): void => {
    preview.textContent = o.say(sel.value);
  };
  sel.addEventListener('change', () => {
    o.onChange?.(sel.value);
    sync();
  });
  sync();

  wrap.append(search, sel, preview);
  return {
    el: wrap,
    value: () => sel.value,
    set: (zone) => {
      ensureOption(zone);
      sel.value = zone;
      sync();
    },
  };
}

/** 여행 시간대 칸 — 「그 자리의 시계」. 비우는 것을 막지 않는다. */
function buildZoneField(initial: string): ZoneField {
  return buildZoneSelect({
    initial,
    ariaLabel: '여행 시간대',
    handle: 'data-zone-input',
    allowNone: true,
    pinned: [...PINNED_ZONES],
    say: (z) => {
      if (!z) return '미지정 — 순간 시각을 이 기기 시간대로 보여줘요';
      const now = new Date().toISOString();
      return `${zoneLabel(now, z)} · ${zonePreview(now, z)}`;
    },
  });
}

/**
 * **집 시간대 칸** — 환산 꼬리표의 기준. 여행 시간대 바로 아래에 둔다(같은 성격이라 같은 자리).
 *
 * 이 값은 여행이 아니라 **이 기기의 표시 설정**이라 저장 위치가 다르다(localStorage).
 * 그래서 고르는 즉시 저장한다 — 여행의 [저장] 버튼과 묶으면 "여행을 안 고쳤는데 왜 저장?"이 된다.
 */
function buildHomeZoneField(): ZoneField {
  return buildZoneSelect({
    initial: homeZone(),
    ariaLabel: '집 시간대',
    handle: 'data-home-zone-input',
    allowNone: false,
    pinned: [...PINNED_ZONES],
    alsoOffer: [deviceZone()], // 「내 기기 시간대」로 되돌아갈 길을 늘 남긴다
    onChange: setHomeZone,
    say: (z) => {
      const now = new Date().toISOString();
      return `${zoneLabel(now, z)} 기준으로 환산해요 (${zonePreview(now, z)})`;
    },
  });
}

/**
 * 위치가 있는 순간 → 지도 포인트. **시각 문장까지 여기서 만든다.**
 *
 * 최상위로 뽑은 이유(래칫이 밀어줬다 — 세 번째): 이 변환은 DOM을 만들지 않고 값만 바꾼다.
 * 그리고 여기가 **지도 팝업의 시각이 정해지는 유일한 자리**가 됐으므로(`mapView`는 더 이상
 * 계산하지 않는다) 그 사실이 화면 코드 깊숙이 묻히면 안 된다.
 */
function toMapPoints(
  moments: LocalMoment[],
  byMoment: Map<string, LocalMedia[]>,
  clock: TripClock,
): MapPoint[] {
  const out: MapPoint[] = [];
  for (const m of moments) {
    const mediaList = byMoment.get(m.id) ?? [];
    // 사용자가 고른 장소 좌표 우선, 없으면 사진 EXIF GPS.
    const coord = m.placeLat != null && m.placeLng != null ? { lat: m.placeLat, lng: m.placeLng } : momentCoord(mediaList);
    if (!coord) continue;
    const point: MapPoint = {
      momentId: m.id,
      title: m.title,
      occurredAt: m.occurredAt,
      lat: coord.lat,
      lng: coord.lng,
      placeName: m.placeName,
      // 시각 문장은 **시계를 아는 이곳에서** 만든다 — 지도 화면은 계산하지 않는다.
      whenText: momentWhen(m.occurredAt, m.tzOffsetMin, clock).dateTime,
    };
    if (mediaList[0]) point.previewBlob = mediaList[0].displayBlob; // 표시본(선명)
    out.push(point);
  }
  return out;
}

/**
 * **비용 줄**(금액 + 통화) — 생성 폼과 편집 폼이 같은 구현을 쓴다(§7).
 *
 * 🔴 이 추출도 래칫이 밀어줬다(2026-07-30). 두 폼에 **같은 9줄이 손으로 두 벌** 있었고,
 * 실제로 한쪽에만 `value` 채우기가 있었다 — 드리프트가 이미 시작돼 있었던 것이다.
 * 우회하지 않고 덜어내니 중복이 사라졌다(§11 「게이트가 설계를 밀어준다」).
 */
/**
 * 순간에 딸린 비용을 저장한다(금액이 유효할 때만). **실패가 순간 저장을 무르지 않는다** —
 * 비용은 부가정보이므로, 저장 실패로 사용자가 방금 적은 기록을 잃게 하지 않는다.
 * (renderTripDetail에서 뽑아낸 헬퍼 — 생성 흐름을 짧게 유지한다.)
 */
async function saveMomentExpense(
  momentId: string,
  tripId: string,
  money: { amount(): string; currency(): string; note(): string },
): Promise<void> {
  const amountVal = parseAmount(money.amount());
  if (amountVal === null) return;
  try {
    await createExpenseLocalFirst({
      momentId,
      tripId,
      originalAmount: amountVal,
      originalCurrency: money.currency(),
      note: money.note(),
    });
  } catch {
    /* 비용 저장 실패는 순간 저장을 무르지 않는다 */
  }
}

function buildMoneyRow(existing: LocalExpense | undefined): {
  el: HTMLElement;
  amount(): string;
  currency(): string;
  note(): string;
  /** 저장 후 초기화 — 감정 줄(`emotion.reset()`)과 **같은 어휘**를 쓴다(§7). */
  reset(): void;
} {
  const wrap = el('div', 'moment-money-wrap');
  const row = el('div', 'moment-money');
  const amountIn = el('input', 'moment-amount') as HTMLInputElement;
  amountIn.type = 'text';
  amountIn.inputMode = 'decimal';
  amountIn.placeholder = '💰 비용 (선택)';
  amountIn.maxLength = 15;
  amountIn.value = existing ? String(existing.originalAmount) : '';
  amountIn.setAttribute('aria-label', '비용 금액(선택)');
  const currencyIn = currencySelect(existing ? existing.originalCurrency : DEFAULT_CURRENCY);
  row.append(amountIn, currencyIn);

  // 💬 **무엇에 쓴 돈인가**(사용자 제안 2026-07-30).
  //
  // 🔴 이 칸은 **새로 만든 것이 아니다.** `LocalExpense.note`는 처음부터 있었고 서비스도
  // `createExpenseLocalFirst({note})`·`updateExpenseLocalFirst({note})`로 받고 있었으며,
  // 휴지통 라벨은 그 값을 **이미 쓰고 있었다**(「50,000 UZS · 택시」). 화면에 입력 칸만
  // 없었다 — M-0015(전파 기능을 만들어 놓고 화면에서 부르지 않음)와 **같은 형태**다.
  //
  // 왜 필요한가: 숫자만 남은 비용은 나중에 **의미를 잃는다.** 「50,000 so'm」이 택시였는지
  // 저녁이었는지 한 달 뒤에는 아무도 모른다 — 이 앱의 북극성이 *"여행이 나에게 남긴 의미를
  // 다시 찾아준다"*인데, 의미가 없는 숫자는 그 반대다.
  //
  // 왜 둘째 줄인가: 「10초 기록」을 지켜야 한다(mobile-capture-ux). 금액+통화가 한 줄로 남고
  // 메모는 그 아래 **선택**으로 흐른다 — 비우면 아무 일도 없다.
  const noteIn = el('input', 'edit-input moment-money-note') as HTMLInputElement;
  noteIn.type = 'text';
  // 폴드5 접은 폭(344px)에서 잘리지 않게 짧게. 뜻은 `aria-label`이 온전히 들고 있다.
  noteIn.placeholder = '무엇에 썼나요? (예: 택시)';
  noteIn.maxLength = 60;
  noteIn.value = existing?.note ?? '';
  noteIn.setAttribute('aria-label', '비용 메모(선택)');
  noteIn.setAttribute('data-expense-note', '1'); // 라이브 검사 손잡이(§13)

  wrap.append(row, noteIn);
  return {
    el: wrap,
    amount: () => amountIn.value,
    currency: () => currencyIn.value,
    note: () => noteIn.value,
    reset: () => {
      amountIn.value = '';
      currencyIn.value = DEFAULT_CURRENCY;
      noteIn.value = '';
    },
  };
}

/**
 * **타임라인 시간 열** — 그 자리의 시각(크게) + 집 시간 환산(작게, **다를 때만**).
 *
 * 최상위로 뽑은 이유가 둘이다. ①`when`만 주면 되므로 DOM 클로저에 있을 필요가 없다.
 * ②라이브 검사가 `.tl-time` / `.tl-time-home` 두 줄의 관계를 재는데, 그 규칙(환산은 다를
 * 때만)이 화면 코드 깊숙이 있으면 다음 사람이 무심코 `|| ''`로 늘 그리게 만든다.
 */
function timeGutter(when: { time: string; home: string }): HTMLElement[] {
  if (!when.time) return [];
  const out = [el('div', 'tl-time', when.time)];
  if (when.home) out.push(el('div', 'tl-time-home muted', when.home));
  return out;
}

/**
 * **시간대 미지정 고지** — 타임라인 맨 위에 **한 번만**. 없으면 `null`.
 *
 * 왜 순간마다가 아니라 한 번인가: 같은 문장이 100번 나오면 그건 고지가 아니라 배경이 된다.
 * 그리고 §12 — 말하기만 하고 끝내지 않는다. **그 자리에서 고칠 버튼**을 함께 준다.
 */
function zoneNotice(caveat: string, onFix: () => void): HTMLElement | null {
  if (!caveat) return null; // 시간대가 정해져 있으면 **아무것도 그리지 않는다**(§8 침묵이 정상)
  const box = el('div', 'zone-notice');
  box.setAttribute('role', 'status');
  box.appendChild(el('span', 'zone-notice-msg', `🕒 ${caveat}`));
  const fix = el('button', 'btn-ghost zone-notice-fix', '여행 시간대 정하기') as HTMLButtonElement;
  fix.type = 'button';
  fix.setAttribute('data-zone-fix', '1'); // 라이브 검사가 **눌러 보는** 손잡이(§13 4항)
  fix.addEventListener('click', onFix);
  box.appendChild(fix);
  return box;
}

/** 여행 날짜·상태·제목·시간대 편집 패널 + 삭제. onSave(patch)/onDelete() 호출 후 상위에서 처리. */
function buildEditPanel(
  trip: LocalTrip,
  onSave: (patch: {
    title: string;
    startDate: string;
    endDate: string;
    status: LocalTrip['status'];
    timeZone: string;
  }) => Promise<void>,
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

  const zone = buildZoneField(trip.timeZone ?? '');

  panel.append(
    el('label', 'edit-label', '제목'),
    titleIn,
    el('label', 'edit-label', '기간'),
    dates,
    el('label', 'edit-label', '상태'),
    status,
    // 🕒 시간대 두 칸은 **붙여서** 둔다 — 「그곳」과 「집」은 한 쌍으로만 뜻이 있다.
    el('label', 'edit-label', '여행 시간대 (그 자리의 시계)'),
    zone.el,
    el('label', 'edit-label', '집 시간대 (환산 기준)'),
    buildHomeZoneField().el,
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
      timeZone: zone.value(),
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
  /** 이 여행의 시계 — 생성 폼과 **같은 자**로 재야 한다(§7 사용자 대면 대칭). */
  clock: TripClock,
  existingExpense: LocalExpense | undefined,
  onSave: (
    // 서비스의 계약 타입을 그대로 쓴다 — 필드가 늘 때 화면·서비스 두 곳을 고치지 않는다(SSOT).
    patch: UpdateMomentPatch,
    expenseIntent: { amount: number | null; currency: string; note: string },
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
  const money = buildMoneyRow(existingExpense);

  const timeField = buildWhenField(trip, clock);
  timeField.set(m.occurredAt); // 이미 정해진 값이므로 `set()` — 추측이 아니라 근거 줄은 비운다

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
    money.el,
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
    const expenseIntent = { amount: parseAmount(money.amount()), currency: money.currency(), note: money.note() };
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
  /** 여행지 오프셋(분) — 「사용일」은 그 돈을 쓴 자리의 날짜다. */
  offsetMin: number,
  base: string,
  t: FxRateTable,
  conv: number,
): HTMLElement[] {
  const cur = ex.originalCurrency.toUpperCase();
  const asked = fxDateFor(occurredAt, todayDate(), offsetMin); // 요청한 날(= 비용 사용일)
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

