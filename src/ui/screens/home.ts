// ui/screens/home.ts — 홈 화면 (여행 생성·목록 + 로그인·동기화).
// 오프라인 우선: 저장은 항상 로컬 먼저, 로그인 시 백그라운드로 서버 동기화.
// 자유 텍스트(이메일 등)는 textContent만 사용(innerHTML 금지).

import { isConfigured } from '../../services/supabase/client';
import {
  createTripLocalFirst,
  listTrips,
  listArchivedTrips,
  updateTripLocalFirst,
  softDeleteTripLocalFirst,
  restoreTripLocalFirst,
  pendingSyncCount,
} from '../../services/trips';
import { showUndoToast } from '../toast';
import {
  currentUser,
  signInWithGoogle,
  signOut,
  onAuthChange,
  isAllowedUser,
  type SessionUser,
} from '../../services/auth';
import { requestSync } from '../../services/autoSync';
import { el, setNote, type NoteAction } from '../dom';
// 보조 화면은 반드시 lazyScreens를 거친다(정적 import 금지 — check-lazy-screens).
import { openDiagnosticsHub, openDataManager, openAboutApp } from '../lazyScreens';
// 버전은 생성물에서 읽는다. changelog.ts를 직접 import하면 CHANGELOG 전문(80KB)이
// 첫 로드 번들에 딸려 온다(registry.gen.ts는 check-registry-gen이 동기화를 강제).
import { REGISTRY } from '../../app/registry.gen';
import {
  SEASONS,
  SEASON_LABEL,
  currentSeason,
  effectiveTheme,
  setSeason,
  toggleTheme,
  type Season,
} from '../theme';
import type { Route } from '../../app/router';
import type { LocalTrip } from '../../offline/db';
import { formatTripPeriod } from '../../domain/time';
import {
  buildTimeTree,
  matchesPeriod,
  monthLabel,
  periodLabel,
  sortTripsNewestFirst,
  type PeriodSel,
  type TimeTree,
} from '../../domain/trip/timeTree';

type Navigate = (route: Route, param?: string) => void;

let unsubscribeAuth: (() => void) | null = null;

const STATUS_LABEL: Record<LocalTrip['status'], string> = {
  planned: '계획 중',
  active: '진행 중',
  completed: '완료',
  archived: '보관',
};

// 활성 여행 카드 — div(role=button)로 만들어 내부에 '삭제' 버튼을 중첩 허용(button 중첩 불가 회피).
function tripCard(
  t: LocalTrip,
  index: number,
  navigate: Navigate,
  onDelete: (t: LocalTrip) => void,
): HTMLElement {
  const card = el('div', `trip-card cover--${index % 3}`);
  card.setAttribute('role', 'button');
  card.tabIndex = 0;
  card.setAttribute('aria-label', `${t.title} 여행 열기`);
  const go = (): void => navigate('trip-detail', t.id);
  card.addEventListener('click', go);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      go();
    }
  });
  card.append(el('div', 'cover-veil'), el('div', 'cover-grain'));
  // 삭제(🗑) — 카드 열기와 겹치지 않게 stopPropagation. 실제 삭제는 확인 + 실행취소 + 휴지통(복구 가능).
  const del = el('button', 'trip-delete', '🗑') as HTMLButtonElement;
  del.type = 'button';
  del.title = '여행 삭제';
  del.setAttribute('aria-label', `${t.title} 여행 삭제`);
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    onDelete(t);
  });
  card.appendChild(del);
  const info = el('div', 'cover-info');
  info.appendChild(el('span', 'trip-badge', STATUS_LABEL[t.status]));
  info.appendChild(el('h3', 'trip-title', t.title));
  info.appendChild(el('p', 'trip-meta', formatTripPeriod(t.startDate, t.endDate)));
  card.appendChild(info);
  return card;
}

/** 보관함 카드 — 카드는 div(role=button)로 만들어 내부에 '복원' 버튼을 중첩 허용. */
function archivedCard(
  t: LocalTrip,
  index: number,
  navigate: Navigate,
  onRestore: (id: string) => void,
): HTMLElement {
  const card = el('div', `trip-card cover--${index % 3}`);
  card.setAttribute('role', 'button');
  card.tabIndex = 0;
  card.setAttribute('aria-label', `${t.title} 여행 열기`);
  const go = (): void => navigate('trip-detail', t.id);
  card.addEventListener('click', go);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      go();
    }
  });
  card.append(el('div', 'cover-veil'), el('div', 'cover-grain'));
  const restore = el('button', 'trip-restore', '↩ 복원') as HTMLButtonElement;
  restore.type = 'button';
  restore.setAttribute('aria-label', `${t.title} 여행 복원`);
  restore.addEventListener('click', (e) => {
    e.stopPropagation();
    onRestore(t.id);
  });
  card.appendChild(restore);
  const info = el('div', 'cover-info');
  info.appendChild(el('span', 'trip-badge', STATUS_LABEL[t.status]));
  info.appendChild(el('h3', 'trip-title', t.title));
  info.appendChild(el('p', 'trip-meta', formatTripPeriod(t.startDate, t.endDate)));
  card.appendChild(info);
  return card;
}

/** 계절 세그먼트 + 라이트/다크 토글 컨트롤. */
function buildControls(): HTMLElement {
  const controls = el('div', 'header-actions');

  const seg = el('div', 'seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', '계절 테마');
  const active = currentSeason();
  const buttons = new Map<Season, HTMLButtonElement>();
  for (const s of SEASONS) {
    const b = el('button', undefined, SEASON_LABEL[s]) as HTMLButtonElement;
    b.type = 'button';
    b.setAttribute('aria-pressed', String(s === active));
    b.addEventListener('click', () => {
      setSeason(s);
      for (const [key, btn] of buttons) btn.setAttribute('aria-pressed', String(key === s));
    });
    buttons.set(s, b);
    seg.appendChild(b);
  }

  const themeBtn = el('button', 'theme-btn') as HTMLButtonElement;
  themeBtn.type = 'button';
  const paintTheme = (mode: 'light' | 'dark') => {
    themeBtn.textContent = mode === 'dark' ? '☀️ 라이트' : '🌙 다크';
    themeBtn.setAttribute('aria-label', mode === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환');
  };
  paintTheme(effectiveTheme());
  themeBtn.addEventListener('click', () => paintTheme(toggleTheme()));

  controls.append(seg, themeBtn);
  return controls;
}

/**
 * 헤더 조립 — 제목 줄(+계정) / 컨트롤 줄.
 *
 * 왜 함수로 뺐나: `renderHome`이 길이 래칫에 걸렸다(`check-fn-size`). 래칫은 한 방향이라
 * "늘린 만큼 다른 데로 덜어내라"고 말한다 — 그 요구가 이 추출을 만들었고, 결과적으로
 * 헤더 구조가 한눈에 읽힌다. 게이트가 설계를 밀어준 사례다.
 *
 * `authArea`를 **인자로 받는** 이유: 내용은 로그인 상태에 따라 계속 다시 그려지므로
 * 그 껍데기의 소유권은 호출부(`renderAuth`)에 있어야 한다.
 */
function buildHeader(authArea: HTMLElement, syncStatus: HTMLElement, onData: () => void): HTMLElement {
  const header = el('header', 'app-header');

  // 제목 + 버전 배지(누르면 개발자 정보). 버전은 changelog SSOT의 생성물에서 읽는다.
  const titleRow = el('div', 'app-title-row');
  titleRow.appendChild(el('h1', 'app-title', '🧳 Bugeon Journey'));
  const verBadge = el('button', 'app-version', `v${REGISTRY.appVersion}`) as HTMLButtonElement;
  verBadge.type = 'button';
  verBadge.setAttribute('aria-label', `버전 ${REGISTRY.appVersion} · 개발자 정보 열기`);
  verBadge.addEventListener('click', () => void openAboutApp());
  titleRow.appendChild(verBadge);

  // 계정 영역은 **제목과 같은 줄 오른쪽**에 둔다(사용자 요청 2026-07-26).
  // 왜: 예전에는 계절·테마 컨트롤과 같은 행에 넣었는데, 그 행이 좁은 화면에서 줄바꿈되면서
  // 계정 줄이 화면 위쪽을 한 줄 더 먹었다. 계정 정보는 **자주 쓰지 않는 것**이라 세로 공간을
  // 그만큼 쓸 이유가 없다 — 제목 옆 빈 자리가 그 자리다.
  // 좁아지면 자연스럽게 줄바꿈되어 오른쪽 정렬로 내려간다(숨기지 않는다).
  const headTools = el('div', 'app-head-tools');
  // 계정 줄은 제목과 같은 높이를 지키고, 상태는 바로 아래 우측에 둔다. 둘을 가로로 놓으면
  // 900px에서도 합산 폭 때문에 계정 전체가 다음 줄로 밀렸다(기존 헤더 라이브 계약 RED).
  headTools.append(authArea, syncStatus);
  const headTop = el('div', 'app-head-top');
  headTop.append(titleRow, headTools);
  header.appendChild(headTop);

  const controls = buildControls();
  const dataBtn = el('button', 'btn-ghost data-open', '📦 데이터 관리') as HTMLButtonElement;
  dataBtn.type = 'button';
  dataBtn.setAttribute('aria-label', '데이터 관리 열기 — 백업·복원·휴지통·가이드');
  dataBtn.addEventListener('click', onData);
  controls.appendChild(dataBtn);
  header.appendChild(controls);
  return header;
}

/** 로그인 상태면 서버 동기화 시도(실패는 다음 트리거에서 재시도). */
/** 동기화 요청 — 규칙은 `services/autoSync.ts` 한 곳에 있다(§7). */
async function trySync(_user: SessionUser | null): Promise<void> {
  await requestSync('홈 저장/변경');
}

/** 기간 트리 버튼 한 줄 — 라벨 + 개수. 눌림 상태는 aria-pressed(색만으로 인코딩하지 않는다). */
function treeBtn(cls: string, label: string, count: number, pressed: boolean, onClick: () => void): HTMLButtonElement {
  const b = el('button', cls) as HTMLButtonElement;
  b.type = 'button';
  b.setAttribute('aria-pressed', String(pressed));
  b.appendChild(el('span', undefined, label));
  b.appendChild(el('span', 'tree-count', String(count)));
  b.addEventListener('click', onClick);
  return b;
}

/** 기간 트리 렌더 — 여행 데이터에서 파생(SSOT), 여행 있는 연·월만 그린다(빈 달은 침묵). */
function renderPeriodTree(nav: HTMLElement, tree: TimeTree, sel: PeriodSel, onSelect: (next: PeriodSel) => void): void {
  nav.innerHTML = '';
  const isAll = !sel.year && !sel.undated;
  nav.appendChild(treeBtn('tree-all', '전체', tree.total, isAll, () => onSelect({})));
  for (const y of tree.years) {
    const yearOn = sel.year === y.year;
    nav.appendChild(
      // 같은 연도를 다시 누르면 해제(선택할 수 있으면 해제할 수 있다 — ui 계약 #9).
      treeBtn('tree-year', `${y.year}년`, y.count, yearOn && !sel.month, () => onSelect(yearOn && !sel.month ? {} : { year: y.year })),
    );
    for (const m of y.months) {
      const monthOn = yearOn && sel.month === m.month;
      nav.appendChild(
        treeBtn('tree-month', monthLabel(m.month), m.count, monthOn, () =>
          onSelect(monthOn ? { year: y.year } : { year: y.year, month: m.month }),
        ),
      );
    }
  }
  if (tree.undated > 0) {
    nav.appendChild(treeBtn('tree-undated', '기간 미정', tree.undated, Boolean(sel.undated), () => onSelect(sel.undated ? {} : { undated: true })));
  }
}

/** 목록이 아예 빌 때의 빈 상태(뷰별 문구). */
function emptyListState(view: 'active' | 'archived'): HTMLElement {
  const empty = el('div', 'empty-state');
  if (view === 'archived') {
    empty.appendChild(el('p', 'empty-emoji', '📦'));
    empty.appendChild(el('h2', undefined, '보관함이 비어 있어요'));
    empty.appendChild(el('p', 'muted', '여행 편집에서 상태를 “보관”으로 바꾸면 여기로 들어와요.'));
  } else {
    empty.appendChild(el('p', 'empty-emoji', '✈️'));
    empty.appendChild(el('h2', undefined, '첫 여행을 기록해보세요'));
    empty.appendChild(el('p', 'muted', '제목 하나면 충분해요. 이 기기에 안전하게 저장됩니다.'));
  }
  return empty;
}

/** 기간 필터가 다 걸러낸 상태 — 막다른 문장으로 끝내지 않는다(§13): 되돌아갈 버튼을 준다. */
function filteredEmptyState(onReset: () => void): HTMLElement {
  const empty = el('div', 'empty-state');
  empty.appendChild(el('p', 'empty-emoji', '🗓️'));
  empty.appendChild(el('h2', undefined, '이 기간에는 여행이 없어요'));
  const back = el('button', 'btn-ghost', '전체 보기') as HTMLButtonElement;
  back.type = 'button';
  back.addEventListener('click', onReset);
  empty.appendChild(back);
  return empty;
}

/** 새 여행 폼 — 제출 흐름(비활성화·초기화)은 여기, 저장·동기화는 onCreate가 맡는다. */
function buildTripForm(onCreate: (title: string) => Promise<void>): HTMLFormElement {
  const form = el('form', 'trip-form') as HTMLFormElement;
  const input = el('input') as HTMLInputElement;
  input.type = 'text';
  input.placeholder = '여행 제목 (예: 제주도 여름 여행)';
  input.maxLength = 100;
  input.required = true;
  input.setAttribute('aria-label', '여행 제목');
  const submit = el('button', 'btn-primary', '+ 새 여행') as HTMLButtonElement;
  submit.type = 'submit';
  form.append(input, submit);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit.disabled = true;
    void (async () => {
      try {
        await onCreate(input.value);
        input.value = '';
      } catch {
        // 실패 문구는 onCreate가 상태 줄에 이미 표시했다 — 입력값은 지우지 않는다(다시 치게 하지 않기).
      } finally {
        submit.disabled = false;
      }
    })();
  });
  return form;
}

/** 기간 필터 UI 묶음 — 선택 상태를 갖고, refresh가 apply()로 목록을 거른다. */
interface PeriodUi {
  fold: HTMLDetailsElement;
  filterNow: HTMLElement;
  /** 현재 선택으로 items를 거르고 트리·요약·현재선택 줄을 다시 그린다. */
  apply(items: LocalTrip[], onChange: () => void): LocalTrip[];
  /** 선택 해제(전체로). [전체 보기]·✕가 부른다. */
  clear(): void;
}

function buildPeriodUi(): PeriodUi {
  let sel: PeriodSel = {};
  const fold = el('details', 'tree-fold') as HTMLDetailsElement;
  const summary = el('summary', 'tree-fold-sum');
  const nav = el('nav', 'home-tree');
  nav.setAttribute('aria-label', '기간별 보기');
  fold.append(summary, nav);
  const filterNow = el('div', 'filter-now');
  filterNow.hidden = true;
  // 넓은 화면(≥1100px)에서는 트리가 옆 칸에 늘 펼쳐진다 — summary는 CSS가 숨긴다.
  // 좁은 화면은 접힌 필터로 내려간다(주 사용처인 폰 세로를 해치지 않는다).
  const wideMq = window.matchMedia('(min-width: 1100px)');
  fold.open = wideMq.matches;
  wideMq.addEventListener('change', (e) => {
    if (e.matches) fold.open = true;
  });
  return {
    fold,
    filterNow,
    apply(items, onChange) {
      const tree = buildTimeTree(items);
      renderPeriodTree(nav, tree, sel, (next) => {
        sel = next;
        onChange();
      });
      summary.textContent = `🗓️ 기간: ${periodLabel(sel)}`;
      // 전체·기간 필터 모두 같은 탐색 규칙을 쓴다: 시작일 최신순, 기간 미정은 맨 뒤.
      const shown = sortTripsNewestFirst(items.filter((t) => matchesPeriod(t, sel)));
      const isAll = !sel.year && !sel.undated;
      filterNow.hidden = isAll; // 전체(정상)는 침묵 — 필터가 걸렸을 때만 말한다.
      if (!isAll) {
        filterNow.innerHTML = '';
        filterNow.appendChild(el('span', undefined, `🗓️ ${periodLabel(sel)} · ${shown.length}개`));
        const x = el('button', 'filter-clear', '✕') as HTMLButtonElement;
        x.type = 'button';
        x.setAttribute('aria-label', '기간 필터 해제');
        x.addEventListener('click', () => {
          sel = {};
          onChange();
        });
        filterNow.appendChild(x);
      }
      return shown;
    },
    clear() {
      sel = {};
    },
  };
}

export function renderHome(mount: HTMLElement, navigate: Navigate): void {
  if (unsubscribeAuth) {
    unsubscribeAuth();
    unsubscribeAuth = null;
  }
  mount.innerHTML = '';

  let user: SessionUser | null = null;

  const wrap = el('main', 'screen screen-home');
  const authArea = el('div', 'auth-area');
  const status = el('p', 'sync-note muted');
  status.setAttribute('role', 'status');
  // onChanged: 복원·휴지통 조작 후 홈 목록·통계를 즉시 갱신(refresh는 아래에서 선언·호이스팅).
  wrap.appendChild(buildHeader(authArea, status, () => void openDataManager({ onChanged: () => void refresh() })));

  const section = el('section', 'trip-section');
  const list = el('div', 'trip-list');
  // 기간 트리(연도▸월): 넓은 화면에선 왼쪽 고정 칸, 좁은 화면에선 접힌 필터.
  const periodUi = buildPeriodUi();

  // 목록 뷰: 활성(홈) ↔ 보관함. 보관 상태 여행은 홈에서 숨고 보관함에서 본다.
  let view: 'active' | 'archived' = 'active';
  const viewBar = el('div', 'view-bar');
  const archiveToggle = el('button', 'btn-ghost archive-toggle') as HTMLButtonElement;
  archiveToggle.type = 'button';
  archiveToggle.addEventListener('click', () => {
    view = view === 'active' ? 'archived' : 'active';
    void refresh();
  });
  viewBar.appendChild(archiveToggle);

  /** 여행 삭제(cascade tombstone) — 확인 → 소프트삭제 → 실행취소 토스트. 휴지통에서도 복구 가능. */
  function deleteTrip(t: LocalTrip): void {
    const ok = window.confirm(
      `"${t.title}" 여행을 삭제할까요?\n순간·사진·비용·소리도 함께 삭제되지만, 실행취소나 [데이터 관리 › 휴지통]에서 되살릴 수 있어요.`,
    );
    if (!ok) return;
    void (async () => {
      try {
        const children = await softDeleteTripLocalFirst(t.id);
        void trySync(user);
        await refresh();
        showUndoToast('여행을 삭제했어요', async () => {
          await restoreTripLocalFirst(t.id, children);
          void trySync(user);
          await refresh();
        });
      } catch (err) {
        status.textContent = `삭제 실패: ${err instanceof Error ? err.message : String(err)}`;
      }
    })();
  }

  /** 보관 여행을 완료 상태로 복원(홈으로 되돌림). */
  function restoreTrip(id: string): void {
    void (async () => {
      try {
        await updateTripLocalFirst(id, { status: 'completed' });
        await refresh();
        await trySync(user);
        await refresh();
      } catch (err) {
        status.textContent = `복원 실패: ${err instanceof Error ? err.message : String(err)}`;
      }
    })();
  }

  const form = buildTripForm(async (title) => {
    try {
      await createTripLocalFirst({ title });
      await refresh();
      await trySync(user); // 저장 후 백그라운드 전송
      await refresh();
    } catch (err) {
      status.textContent = `저장 실패: ${err instanceof Error ? err.message : String(err)}`;
      throw err; // 폼이 입력값을 지우지 않게(실패한 제목을 다시 치게 하지 않는다)
    }
  });

  function renderAuth(): void {
    authArea.innerHTML = '';
    if (!isConfigured()) {
      authArea.appendChild(el('span', 'muted small', '📴 로컬 모드'));
      return;
    }
    if (user) {
      const who = el('span', 'muted small auth-who');
      who.textContent = user.email ?? '로그인됨';
      // 좁은 화면에서는 CSS가 말줄임으로 자른다 — 잘린 값을 확인할 길을 남긴다.
      if (user.email) who.title = user.email;
      const syncBtn = el('button', 'btn-ghost', '↻ 동기화') as HTMLButtonElement;
      syncBtn.type = 'button';
      syncBtn.addEventListener('click', () => {
        syncBtn.disabled = true;
        void (async () => {
          await trySync(user);
          await refresh();
          syncBtn.disabled = false;
        })();
      });
      const out = el('button', 'btn-ghost', '로그아웃') as HTMLButtonElement;
      out.type = 'button';
      out.addEventListener('click', () => {
        void signOut();
      });
      authArea.append(who, syncBtn, out);
    } else {
      const inBtn = el('button', 'btn-primary', 'Google 로그인') as HTMLButtonElement;
      inBtn.type = 'button';
      inBtn.addEventListener('click', () => {
        inBtn.disabled = true;
        void signInWithGoogle().catch((err) => {
          status.textContent = `로그인 실패: ${err instanceof Error ? err.message : String(err)}`;
          inBtn.disabled = false;
        });
      });
      authArea.appendChild(inBtn);
    }
  }

  /**
   * 초대제 잠금 게이트(ADR-0021): 허용 목록에 없는 사용자는 자동 로그아웃 안내.
   * DB RLS가 실제 방어이며 이건 UX용. 통과하면 그대로, 아니면 null 반환.
   */
  async function gateAccess(u: SessionUser | null): Promise<SessionUser | null> {
    if (!u) return null;
    const ok = await isAllowedUser();
    if (ok) return u;
    status.textContent = '🔒 이 앱은 초대된 사용자만 사용할 수 있어요. 접근이 필요하면 관리자에게 문의하세요.';
    await signOut();
    return null;
  }

  async function refresh(): Promise<void> {
    const [trips, archived, pending] = await Promise.all([
      listTrips(),
      listArchivedTrips(),
      pendingSyncCount(),
    ]);

    // 보관함 토글: 활성 뷰에선 보관이 있을 때만 노출, 보관 뷰에선 되돌아가기.
    if (view === 'archived') {
      archiveToggle.textContent = '← 여행 목록으로';
      archiveToggle.hidden = false;
    } else {
      archiveToggle.textContent = `📦 보관함 ${archived.length}`;
      archiveToggle.hidden = archived.length === 0;
    }
    form.hidden = view === 'archived'; // 보관함에선 새 여행 폼 숨김

    const items = view === 'archived' ? archived : trips;
    // 기간 필터: 트리는 현재 뷰(홈/보관함)의 여행에서 파생되고, 목록도 같은 선택으로 걸러진다(§7 대칭).
    const shown = periodUi.apply(items, () => void refresh());
    list.innerHTML = '';
    if (items.length === 0) {
      list.appendChild(emptyListState(view));
    } else if (shown.length === 0) {
      list.appendChild(
        filteredEmptyState(() => {
          periodUi.clear();
          void refresh();
        }),
      );
    } else if (view === 'archived') {
      shown.forEach((t, i) => list.appendChild(archivedCard(t, i, navigate, restoreTrip)));
    } else {
      shown.forEach((t, i) => list.appendChild(tripCard(t, i, navigate, deleteTrip)));
    }
    // 정상(동기화됨)은 조용하게, 알아둘 것·문제는 눈에 띄게(setNote 위계).
    //
    // 목적지(§7 — 갈 곳이 있는 상태에 전부 걸었는가):
    //  · 대기 N건      → 「동기화 상태」. 거기에 [지금 동기화]가 있다. 사용자가 요청한 자리.
    //  · 로컬 저장 모드 → 「환경·기능」. 왜 서버로 안 가는지는 환경이 답한다.
    //  · 로그인 안내    → **목적지 없음.** 조치 버튼([로그인])이 이 화면 헤더에 이미 있다 —
    //                    진단으로 보내면 오히려 멀어진다.
    //  · 동기화됨(ok)  → **목적지 없음.** 정상은 침묵이어야 한다(진단 §5.1). 여기에 알약과
    //                    셰브론을 붙이면 아무 할 일 없는 상태가 화면에서 제일 시끄러워진다.
    const toSync: NoteAction = { go: () => void openDiagnosticsHub('sync'), label: '동기화 상태 열기' };
    if (!isConfigured()) {
      setNote(status, `📴 로컬 저장 모드 · 대기 ${pending}건`, 'info', {
        go: () => void openDiagnosticsHub('environment'),
        label: '환경·기능 열기',
      });
    } else if (user) {
      if (pending > 0) setNote(status, `☁️ 동기화 대기 ${pending}건`, 'info', toSync);
      else setNote(status, '☁️ 동기화됨', 'ok', null);
    } else {
      setNote(status, `🔒 로그인하면 기기 간 동기화 · 로컬 대기 ${pending}건`, 'info', null);
    }
  }

  // 2단 몸통: 왼쪽 기간 트리 | 오른쪽 목록. DOM 순서 = 논리 순서(입력 → 필터 → 목록)라
  // 화면읽기·키보드 탐색이 흔들리지 않고, 시각 배치는 CSS(≥1100px grid)만 바꾼다.
  const body = el('div', 'home-body');
  const main = el('div', 'home-main');
  main.append(viewBar, periodUi.filterNow, list);
  body.append(periodUi.fold, main);
  section.append(form, body);
  wrap.appendChild(section);
  mount.appendChild(wrap);

  // 인증 상태 구독: 로그인되면 동기화 후 갱신.
  unsubscribeAuth = onAuthChange((u) => {
    void (async () => {
      user = await gateAccess(u);
      renderAuth();
      await trySync(user);
      await refresh();
    })();
  });

  // 온라인 복귀 시 동기화 시도.
  window.addEventListener('online', () => void trySync(user).then(refresh));

  // 초기값: 현재 세션 확인(구독이 늦게 올 수 있으므로 즉시 1회).
  void (async () => {
    user = await gateAccess(await currentUser());
    renderAuth();
    await refresh();
    await trySync(user);
    await refresh();
  })();
}
