// ui/screens/tripDetail.ts — 여행 상세 + 타임라인 + 순간 기록(로컬우선).
// 자유 텍스트는 textContent만 사용. 서버 동기화(순간)는 후속 — 지금은 이 기기에 내구성 저장.

import { el, setNote } from '../dom';
import { showUndoToast } from '../toast';
import {
  getTrip,
  updateTripLocalFirst,
  softDeleteTripLocalFirst,
  restoreTripLocalFirst,
} from '../../services/trips';
import {
  createMomentLocalFirst,
  listMoments,
  updateMomentLocalFirst,
  softDeleteMomentLocalFirst,
  restoreMomentLocalFirst,
} from '../../services/moments';
import {
  addPhotoToMoment,
  listMediaByTrip,
  softDeleteMediaLocalFirst,
  restoreMediaLocalFirst,
  reeditMediaLocalFirst,
  rotateMediaLocalFirst,
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
import { openMapView, openMapPicker, type MapPoint } from './mapView';
import { openDiagnosticsHub } from './diagnosticsHub';
import { searchPlaces } from '../../services/geocode';

/** 장소 입력 + 🔍 검색(Nominatim) + 결과 선택. 결과 텍스트는 textContent로만(외부 데이터·XSS 방지). */
interface PlaceField {
  el: HTMLElement;
  getName: () => string;
  getCoords: () => { lat: number; lng: number } | null;
  reset: () => void;
}
function buildPlaceField(initial: { name: string; lat: number | null; lng: number | null }): PlaceField {
  const wrap = el('div', 'place-field');
  const row = el('div', 'place-row');
  const input = el('input', 'edit-input place-input') as HTMLInputElement;
  input.type = 'text';
  input.value = initial.name;
  input.maxLength = 80;
  input.placeholder = '📍 장소 (선택)';
  input.setAttribute('aria-label', '장소(선택)');
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
  // 선택 확인 배지 — 좌표가 지정되면 "위치 지정됨"을 보여 무반응처럼 보이지 않게 한다.
  const picked = el('div', 'place-picked');
  picked.setAttribute('role', 'status');
  wrap.append(row, results, picked);

  let lat: number | null = initial.lat;
  let lng: number | null = initial.lng;
  // 좌표를 지도에서 직접 찍었는지 여부. 지도로 찍은 좌표는 이름을 나중에 적어도 유지한다
  // (사용자가 이름과 위치를 따로 입력하는 흐름). 검색 결과 좌표는 이름과 묶여 있으므로 손편집 시 무효화한다.
  let mapPicked = false;
  // 해제 버튼 — **선택했으면 해제할 수 있어야 한다**(결함군, 2026-07-26 사용자 지적).
  // 지도로 찍은 좌표는 이름을 지워도 유지되는데(의도된 동작), 그러면 되돌릴 길이 없었다.
  const clearPlace = el('button', 'chip-clear', '✕') as HTMLButtonElement;
  clearPlace.type = 'button';
  clearPlace.setAttribute('aria-label', '지정한 위치 해제');
  clearPlace.title = '위치 해제';
  const pickedText = el('span', 'place-picked-text');
  picked.append(pickedText, clearPlace);
  const setPicked = (detail: string | null): void => {
    if (detail === null) {
      picked.hidden = true;
      pickedText.textContent = '';
    } else {
      picked.hidden = false;
      pickedText.textContent = detail ? `📍 위치 지정됨 · ${detail}` : '📍 위치 지정됨';
    }
  };
  clearPlace.addEventListener('click', () => {
    lat = null;
    lng = null;
    mapPicked = false;
    setPicked(null);
  });
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
    setPicked(null);
  });

  const doSearch = (): void => {
    const q = input.value.trim();
    if (!q) return;
    searchBtn.disabled = true;
    results.hidden = false;
    results.textContent = '검색 중…';
    void (async () => {
      try {
        const places = await searchPlaces(q);
        results.innerHTML = '';
        if (places.length === 0) {
          results.appendChild(el('div', 'place-none', '결과가 없어요. 다른 검색어로 시도해 보세요.'));
        } else {
          for (const p of places) {
            const b = el('button', 'place-result') as HTMLButtonElement;
            b.type = 'button';
            b.append(el('b', 'place-result-name', p.name), el('span', 'place-result-full', p.displayName));
            b.addEventListener('click', () => {
              input.value = p.name;
              lat = p.lat;
              lng = p.lng;
              mapPicked = false; // 검색 좌표는 이름과 묶임
              results.hidden = true;
              setPicked(p.displayName); // 선택 확인 피드백
            });
            results.appendChild(b);
          }
        }
      } catch (err) {
        results.textContent = `검색 실패: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        searchBtn.disabled = false;
      }
    })();
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
  mapBtn.addEventListener('click', () => {
    mapBtn.disabled = true;
    void openMapPicker(lat !== null && lng !== null ? { lat, lng } : null)
      .then((coords) => {
        if (coords) {
          lat = coords.lat;
          lng = coords.lng;
          mapPicked = true; // 지도 좌표는 이름과 독립 — 이후 이름을 적어도 유지
          results.hidden = true;
          const name = input.value.trim();
          setPicked(name ? name : '지도에서 지정'); // 이름을 안 적었으면 안내만
        }
      })
      .finally(() => {
        mapBtn.disabled = false;
      });
  });

  return {
    el: wrap,
    getName: () => input.value,
    getCoords: () => (lat !== null && lng !== null ? { lat, lng } : null),
    reset: () => {
      input.value = '';
      lat = null;
      lng = null;
      mapPicked = false;
      results.hidden = true;
      results.innerHTML = '';
      setPicked(null);
    },
  };
}
import { openPhotoEditor, type EditorResult } from '../photoEditor';
import { groupMomentsByDay, type DayGroup } from '../../domain/moment/timeline';
import { requestSync } from '../../services/autoSync';
import type { Route } from '../../app/router';
import type { LocalMoment, LocalTrip, LocalMedia, LocalExpense } from '../../offline/db';

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

function timeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** ISO(UTC) → datetime-local 입력값('YYYY-MM-DDTHH:mm', 로컬시각). */
function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
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
    mapBtn.addEventListener('click', () => openMapView(trip!.title, locatedPoints));

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

    let picked = '';
    const emoRow = el('div', 'emo-row');
    emoRow.setAttribute('role', 'group');
    emoRow.setAttribute('aria-label', '감정 선택(선택)');
    const emoButtons = new Map<string, HTMLButtonElement>();
    for (const e of EMOTIONS) {
      const b = el('button', 'emo', e) as HTMLButtonElement;
      b.type = 'button';
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => {
        picked = picked === e ? '' : e;
        for (const [key, btn] of emoButtons) btn.setAttribute('aria-pressed', String(key === picked));
      });
      emoButtons.set(e, b);
      emoRow.appendChild(b);
    }

    const placeField = buildPlaceField({ name: '', lat: null, lng: null });

    // 사진 선택(원본은 기기에 보관·압축본은 파생, §0). label 안에 input을 넣어 접근성 확보.
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

    form.append(input, emoRow, placeField.el, moneyRow, photoLabel, photoPreview, save);
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
      const byMoment = new Map<string, LocalMedia[]>();
      for (const md of media) {
        const arr = byMoment.get(md.momentId);
        if (arr) arr.push(md);
        else byMoment.set(md.momentId, [md]);
      }
      const expByMoment = new Map<string, LocalExpense[]>();
      for (const ex of expenses) {
        const arr = expByMoment.get(ex.momentId);
        if (arr) arr.push(ex);
        else expByMoment.set(ex.momentId, [ex]);
      }
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
      renderTimeline(moments, byMoment, expByMoment);
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
          items.appendChild(buildMomentCard(m, byMoment.get(m.id) ?? [], expByMoment.get(m.id) ?? []));
        }
        timeline.appendChild(items);
      }
    }

    function buildMomentCard(m: LocalMoment, mediaList: LocalMedia[], expenseList: LocalExpense[]): HTMLElement {
      const item = el('div', 'tl-item');
      item.appendChild(el('span', 'tl-node'));
      const t = timeLabel(m.occurredAt);
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
      addPhotoWrap.append(addPhotoLabel, addProgress);
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
            const { deletedMediaIds } = await softDeleteMomentLocalFirst(m.id);
            await refresh();
            void trySync();
            showUndoToast('순간을 삭제했어요', async () => {
              await restoreMomentLocalFirst(m.id, deletedMediaIds);
              await refresh();
              void trySync();
            });
          } catch {
            delBtn.disabled = false; // 실패 시 재시도 허용
          }
        })();
      });

      if (m.note) card.appendChild(el('p', 'moment-note', m.note));
      if (m.placeName || expenseList.length) {
        const chips = el('div', 'chips');
        if (m.placeName) chips.appendChild(el('span', 'chip gps', `📍 ${m.placeName}`));
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
          img.addEventListener('click', () => openViewer(mediaList, mdIdx));
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
    function openViewer(list: LocalMedia[], startIndex: number): void {
      let idx = Math.max(0, Math.min(startIndex, list.length - 1));
      let current = list[idx]!;
      let currentUrl = URL.createObjectURL(current.displayBlob);
      const overlay = el('div', 'photo-viewer');
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-label', '사진 보기');
      const img = el('img') as HTMLImageElement;
      img.src = currentUrl;
      img.alt = '여행 사진';
      img.draggable = false; // 스와이프가 브라우저 이미지 드래그로 새지 않게
      // 사진 자체를 탭했을 땐 닫지 않는다(확대해 보려다 실수로 닫히는 것 방지 — 배경 탭·✕·Esc로만 닫기).
      img.addEventListener('click', (e) => e.stopPropagation());
      const counter = el('span', 'photo-viewer-count', `${idx + 1} / ${list.length}`);
      counter.hidden = list.length <= 1;

      const close = () => {
        overlay.remove();
        URL.revokeObjectURL(currentUrl);
        document.removeEventListener('keydown', keys); // 어떤 경로로 닫혀도 리스너 잔류 없음
      };
      // ── 확대/이동(기기 최적화): 더블탭·핀치·휠로 확대, 끌어서 이동. scale=1이면 스와이프로 넘기기. ──
      const MAX_ZOOM = 5;
      let scale = 1;
      let tx = 0;
      let ty = 0;
      function applyTransform(animate = false): void {
        img.style.transition = animate ? 'transform .16s ease' : 'none';
        img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
        img.classList.toggle('is-zoomed', scale > 1.01);
      }
      function clampPan(): void {
        // 확대된 이미지가 화면 밖으로 완전히 빠지지 않도록(약간의 여유 포함) 이동 범위를 제한.
        const mx = Math.max(0, (img.clientWidth * scale - window.innerWidth) / 2 + 24);
        const my = Math.max(0, (img.clientHeight * scale - window.innerHeight) / 2 + 24);
        tx = Math.max(-mx, Math.min(mx, tx));
        ty = Math.max(-my, Math.min(my, ty));
      }
      // 화면점(px,py)을 고정한 채 목표 배율로 확대/축소(휠·핀치·더블탭 공통).
      function zoomAround(px: number, py: number, target: number, animate = false): void {
        const vcx = window.innerWidth / 2;
        const vcy = window.innerHeight / 2;
        const lx = (px - vcx - tx) / scale;
        const ly = (py - vcy - ty) / scale;
        scale = Math.max(1, Math.min(MAX_ZOOM, target));
        tx = px - vcx - scale * lx;
        ty = py - vcy - scale * ly;
        if (scale <= 1.001) {
          scale = 1;
          tx = 0;
          ty = 0;
        }
        clampPan();
        applyTransform(animate);
      }
      function resetZoom(): void {
        scale = 1;
        tx = 0;
        ty = 0;
        applyTransform();
      }

      function show(next: number): void {
        idx = (next + list.length) % list.length; // 끝에서 처음으로 순환
        current = list[idx]!;
        const newUrl = URL.createObjectURL(current.displayBlob);
        img.src = newUrl;
        URL.revokeObjectURL(currentUrl);
        currentUrl = newUrl;
        counter.textContent = `${idx + 1} / ${list.length}`;
        resetZoom(); // 다음 사진은 항상 꽉 맞춤에서 시작
      }
      function keys(e: KeyboardEvent): void {
        if (e.key === 'Escape') close();
        else if (e.key === 'ArrowLeft' && list.length > 1) show(idx - 1);
        else if (e.key === 'ArrowRight' && list.length > 1) show(idx + 1);
        else if ((e.key === '0' || e.key === 'Escape') && scale > 1) resetZoom();
      }

      // 포인터: 1개 = 스와이프(확대 전) 또는 팬(확대 중), 2개 = 핀치 줌.
      const pts = new Map<number, { x: number; y: number }>();
      let pinchStart: { dist: number; scale: number } | null = null;
      let dragStart: { x: number; y: number; tx: number; ty: number; moved: boolean } | null = null;
      let lastTap = 0;
      let lastTapX = 0;
      let lastTapY = 0;
      const dist2 = (): number => {
        const [a, b] = [...pts.values()];
        return Math.hypot(a!.x - b!.x, a!.y - b!.y);
      };
      const mid2 = (): { x: number; y: number } => {
        const [a, b] = [...pts.values()];
        return { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
      };
      img.addEventListener('pointerdown', (e) => {
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        try {
          img.setPointerCapture(e.pointerId);
        } catch {
          /* 합성/종료 포인터 캡처 불가 시에도 추적은 계속 */
        }
        if (pts.size === 2) {
          pinchStart = { dist: dist2(), scale };
          dragStart = null;
        } else {
          dragStart = { x: e.clientX, y: e.clientY, tx, ty, moved: false };
        }
      });
      img.addEventListener('pointermove', (e) => {
        if (!pts.has(e.pointerId)) return;
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinchStart && pts.size === 2) {
          const m = mid2();
          zoomAround(m.x, m.y, (pinchStart.scale * dist2()) / pinchStart.dist);
          return;
        }
        if (dragStart && scale > 1) {
          // 확대 중 → 팬(이동)
          tx = dragStart.tx + (e.clientX - dragStart.x);
          ty = dragStart.ty + (e.clientY - dragStart.y);
          dragStart.moved = true;
          clampPan();
          applyTransform();
        }
      });
      function endPointer(e: PointerEvent): void {
        pts.delete(e.pointerId);
        if (pinchStart && pts.size < 2) pinchStart = null;
        if (pts.size > 0) return;
        // 마지막 포인터가 떨어짐: 더블탭 / 스와이프 판정(확대 전에만).
        const ds = dragStart;
        dragStart = null;
        if (!ds) return;
        const dx = e.clientX - ds.x;
        const dy = e.clientY - ds.y;
        const isTap = Math.abs(dx) < 12 && Math.abs(dy) < 12 && !ds.moved;
        if (isTap) {
          const now = e.timeStamp;
          if (now - lastTap < 320 && Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < 40) {
            // 더블탭: 확대 토글(탭 지점 기준)
            lastTap = 0;
            zoomAround(e.clientX, e.clientY, scale > 1 ? 1 : 2.5, true);
          } else {
            lastTap = now;
            lastTapX = e.clientX;
            lastTapY = e.clientY;
          }
          return;
        }
        // 확대 전 좌우 스와이프로 넘기기(세로 이동이 크면 무시).
        if (scale <= 1 && list.length > 1 && Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          show(dx < 0 ? idx + 1 : idx - 1);
        }
      }
      img.addEventListener('pointerup', endPointer);
      img.addEventListener('pointercancel', endPointer);
      // 데스크톱: 휠(또는 트랙패드 핀치=ctrl+wheel)로 커서 기준 확대.
      img.addEventListener(
        'wheel',
        (e) => {
          e.preventDefault();
          const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
          zoomAround(e.clientX, e.clientY, scale * Math.exp(-dy * 0.0018));
        },
        { passive: false },
      );

      // 회전 — 눕혀 보이는 사진을 90°(시계방향) 돌려 세운다. 원본 불변(§0), 표시본만 갱신·영구 저장.
      const rotateBtn = el('button', 'photo-viewer-rotate', '↻ 회전') as HTMLButtonElement;
      rotateBtn.type = 'button';
      rotateBtn.setAttribute('aria-label', '사진 90도 회전');
      rotateBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (rotateBtn.disabled) return;
        rotateBtn.disabled = true;
        void (async () => {
          try {
            const updated = await rotateMediaLocalFirst(current.id);
            list[idx] = updated; // 넘겨보기 목록에도 회전 반영
            current = updated;
            const newUrl = URL.createObjectURL(updated.displayBlob);
            img.src = newUrl;
            URL.revokeObjectURL(currentUrl);
            currentUrl = newUrl;
            await refresh(); // 뒤 목록 썸네일도 세워진 방향으로 갱신
          } catch {
            /* 회전 실패는 뷰어 유지 */
          } finally {
            rotateBtn.disabled = false;
          }
        })();
      });
      const closeBtn = el('button', 'photo-viewer-close', '✕') as HTMLButtonElement;
      closeBtn.type = 'button';
      closeBtn.setAttribute('aria-label', '닫기');
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        close();
      });

      // 재편집 — 저장된 사진을 편집기로 다시 연다. 원본에서 파생(비파괴), 이전 편집을 이어서 조정.
      const editPhotoBtn = el('button', 'photo-viewer-edit', '✎ 편집') as HTMLButtonElement;
      editPhotoBtn.type = 'button';
      editPhotoBtn.setAttribute('aria-label', '이 사진 편집');
      editPhotoBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        editPhotoBtn.disabled = true;
        void (async () => {
          try {
            const r = await openPhotoEditor(
              current.originalBlob,
              timeLabel(current.takenAt) || '사진 편집',
              current.editState ? { initialState: current.editState } : {},
            );
            if (r.action === 'apply') {
              await reeditMediaLocalFirst(current.id, r.blob ?? current.originalBlob, r.state);
              await refresh();
              close();
              return;
            }
          } catch {
            /* 편집 취소·실패는 뷰어 유지 */
          }
          editPhotoBtn.disabled = false;
        })();
      });

      overlay.append(img, counter, editPhotoBtn, rotateBtn, closeBtn);
      if (list.length > 1) {
        const prevBtn = el('button', 'photo-viewer-nav photo-viewer-prev', '‹') as HTMLButtonElement;
        prevBtn.type = 'button';
        prevBtn.setAttribute('aria-label', '이전 사진');
        prevBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          show(idx - 1);
        });
        const nextBtn = el('button', 'photo-viewer-nav photo-viewer-next', '›') as HTMLButtonElement;
        nextBtn.type = 'button';
        nextBtn.setAttribute('aria-label', '다음 사진');
        nextBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          show(idx + 1);
        });
        overlay.append(prevBtn, nextBtn);
      }
      overlay.addEventListener('click', close); // 배경 탭으로도 닫기
      document.addEventListener('keydown', keys);
      document.body.appendChild(overlay);
    }

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      save.disabled = true;
      const files = photoInput.files ? Array.from(photoInput.files) : [];
      void (async () => {
        try {
          const placeCoords = placeField.getCoords();
          const moment = await createMomentLocalFirst({
            tripId: trip!.id,
            title: input.value,
            emotion: picked,
            placeName: placeField.getName(),
            placeLat: placeCoords?.lat ?? null,
            placeLng: placeCoords?.lng ?? null,
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
          picked = '';
          amountIn.value = '';
          currencyIn.value = DEFAULT_CURRENCY;
          // 미리보기 URL 회수 + 개수 문구까지 한 번에(초기화 경로를 두 개 만들지 않는다).
          setFiles([]);
          for (const btn of emoButtons.values()) btn.setAttribute('aria-pressed', 'false');
          setNote(note, '✅ 저장됨', 'ok', null); // 정상 — 조용하게(침묵이 정상이므로 갈 곳도 안 만든다)
          await refresh();
          await trySync(); // 로그인 시 서버로 전송(순간). 사진은 후속(3b).
          await refresh();
        } catch (err) {
          // 저장 실패야말로 갈 곳이 필요하다 — 무엇이 막혔는지는 「동기화 상태」가 말한다.
          setNote(note, `저장 실패: ${err instanceof Error ? err.message : String(err)}`, 'error', {
            go: () => openDiagnosticsHub('sync'),
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
  existingExpense: LocalExpense | undefined,
  onSave: (
    patch: {
      title: string;
      emotion: string;
      placeName: string;
      placeLat: number | null;
      placeLng: number | null;
      note: string;
      occurredAt?: string;
    },
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

  let picked = m.emotion;
  const emoRow = el('div', 'emo-row');
  emoRow.setAttribute('role', 'group');
  emoRow.setAttribute('aria-label', '감정 선택(선택)');
  const emoButtons = new Map<string, HTMLButtonElement>();
  for (const e of EMOTIONS) {
    const b = el('button', 'emo', e) as HTMLButtonElement;
    b.type = 'button';
    b.setAttribute('aria-pressed', String(e === picked));
    b.addEventListener('click', () => {
      picked = picked === e ? '' : e;
      for (const [key, btn] of emoButtons) btn.setAttribute('aria-pressed', String(key === picked));
    });
    emoButtons.set(e, b);
    emoRow.appendChild(b);
  }

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

  const timeIn = el('input', 'edit-input') as HTMLInputElement;
  timeIn.type = 'datetime-local';
  timeIn.value = toLocalInputValue(m.occurredAt);
  timeIn.setAttribute('aria-label', '발생 시각');

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
    emoRow,
    el('label', 'edit-label', '장소'),
    placeField.el,
    el('label', 'edit-label', '메모'),
    noteIn,
    el('label', 'edit-label', '비용'),
    moneyRow,
    el('label', 'edit-label', '발생 시각'),
    timeIn,
    row,
  );

  panel.addEventListener('submit', (e) => {
    e.preventDefault();
    save.disabled = true;
    const placeCoords = placeField.getCoords();
    const patch: {
      title: string;
      emotion: string;
      placeName: string;
      placeLat: number | null;
      placeLng: number | null;
      note: string;
      occurredAt?: string;
    } = {
      title: titleIn.value,
      emotion: picked,
      placeName: placeField.getName(),
      placeLat: placeCoords?.lat ?? null,
      placeLng: placeCoords?.lng ?? null,
      note: noteIn.value,
    };
    const occ = fromLocalInputValue(timeIn.value);
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

