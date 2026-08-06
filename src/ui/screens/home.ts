// ui/screens/home.ts — 홈 화면 (여행 생성·목록 + 로그인·동기화).
// 오프라인 우선: 저장은 항상 로컬 먼저, 로그인 시 백그라운드로 서버 동기화.
// 자유 텍스트(이메일 등)는 textContent만 사용(innerHTML 금지).

import { isConfigured } from '../../services/supabase/client';
import { canViewLocalRecords } from '../../domain/authGate';
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
import { requestSync, syncStatus as syncEngineStatus, onSyncStatus } from '../../services/autoSync';
import { syncBadge, badgeActionLabel } from '../../domain/syncBadgeVerdict';
import { lastParity, refreshParity, installParityWatch } from '../../services/syncParity';
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
// 상태 라벨·순서·구획 판정의 SSOT. 예전엔 이 파일과 tripDetail이 **각자 손으로** 같은 표를
// 갖고 있었다(§2 — 손편집 중복 자체가 결함).
import {
  STATUS_LABEL,
  homeSections,
  statusChips,
  summaryPool,
  type HomeSection,
  type TripStatus,
} from '../../domain/trip/homeSections';

type Navigate = (route: Route, param?: string) => void;

let unsubscribeAuth: (() => void) | null = null;
/** 동기화 상태·대조 구독 — 홈을 다시 그릴 때 겹치지 않게 모듈에 들고 있다가 해지한다. */
let unsubscribeSync: (() => void) | null = null;
let unsubscribeParity: (() => void) | null = null;

/**
 * 카드 껍데기 — 활성·보관함 **두 카드가 이 한 곳**을 쓴다(§7 구조적 강제).
 *
 * 🔴 예전엔 두 함수가 각자 `cover--${index % 3}`·베일·노이즈를 손으로 붙였다. 그래서
 * 「목록 카드에서 커버를 걷어낸다」는 결정이 **두 곳을 다 고쳐야만** 지켜졌다 — 한쪽만
 * 고치면 보관함만 조용히 옛 모양으로 남는다. 껍데기를 하나로 모아 그 선택지를 없앤다.
 *
 * `index`를 더는 받지 않는다: 순번으로 색을 돌리던 유일한 쓸모가 사라졌고(사용자 결정
 * 2026-08-05 — 뜻 없는 색은 소음), 남겨 두면 다음 사람이 다시 색을 걸 자리가 된다.
 */
function tripCardShell(t: LocalTrip, navigate: Navigate): HTMLElement {
  const card = el('div', 'trip-card');
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
  return card;
}

/**
 * 제목·날짜 — 두 카드가 **같은 자리에 같은 어휘**로 말한다(§7 사용자 대면 대칭).
 *
 * 🔴 **상태 배지가 여기 있었는데 뺐다**(사용자 결정 2026-08-06). 실측하니 여행 9장 중
 * 7장에 똑같은 「완료」가 붙어 있었다 — **거의 모두에 붙는 표시는 정보가 아니라 소음**이다
 * (§8). 뜻 없는 색을 걷어낸 2026-08-05 결정과 같은 부류다.
 *
 * 그럼 상태는 이제 누가 말하나: **목록이 상태별로 갈렸으므로 구획 제목과 눌린 칩이 말한다.**
 * 요약 화면의 구획도, 칩을 눌러 들어간 목록도 **한 상태만** 담기므로 카드마다 되풀이할
 * 이유가 없다 — 말은 한 번만 한다. 다시 섞인 목록을 만들 일이 생기면 그때는 배지가
 * 되살아나야 한다(그 목록은 스스로 상태를 말하지 못한다).
 */
function tripCardInfo(t: LocalTrip): HTMLElement {
  const info = el('div', 'cover-info');
  info.appendChild(el('h3', 'trip-title', t.title));
  info.appendChild(el('p', 'trip-meta', formatTripPeriod(t.startDate, t.endDate)));
  return info;
}

// 활성 여행 카드 — div(role=button)로 만들어 내부에 '삭제' 버튼을 중첩 허용(button 중첩 불가 회피).
function tripCard(t: LocalTrip, navigate: Navigate, onDelete: (t: LocalTrip) => void): HTMLElement {
  const card = tripCardShell(t, navigate);
  // 삭제(🗑) — 카드 열기와 겹치지 않게 stopPropagation. 실제 삭제는 확인 + 실행취소 + 휴지통(복구 가능).
  const del = el('button', 'trip-delete', '🗑') as HTMLButtonElement;
  del.type = 'button';
  del.title = '여행 삭제';
  del.setAttribute('aria-label', `${t.title} 여행 삭제`);
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    onDelete(t);
  });
  card.append(del, tripCardInfo(t));
  return card;
}

/** 보관함 카드 — 카드는 div(role=button)로 만들어 내부에 '복원' 버튼을 중첩 허용. */
function archivedCard(t: LocalTrip, navigate: Navigate, onRestore: (id: string) => void): HTMLElement {
  const card = tripCardShell(t, navigate);
  const restore = el('button', 'trip-restore', '↩ 복원') as HTMLButtonElement;
  restore.type = 'button';
  restore.setAttribute('aria-label', `${t.title} 여행 복원`);
  restore.addEventListener('click', (e) => {
    e.stopPropagation();
    onRestore(t.id);
  });
  card.append(restore, tripCardInfo(t));
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

/**
 * 동기화 요청 — 규칙은 `services/autoSync.ts` **한 곳**에 있다(§7).
 *
 * 로그인 여부·온라인 여부를 여기서 다시 묻지 않으므로 인자를 받지 않는다. 예전엔 쓰지도
 * 않는 `_user`를 받아 호출부마다 넘기고 있었다 — 안 쓰는 인자는 "이게 판단에 쓰인다"는
 * **거짓 신호**라 다음 사람이 그 전제 위에 코드를 쌓는다.
 */
async function trySync(): Promise<void> {
  await requestSync('홈 저장/변경');
}

/**
 * 카드의 삭제·복원 — `renderHome`에서 분리(길이 래칫 `check-fn-size`, §11).
 *
 * 두 행동이 한 곳에 있는 이유: 둘 다 **되돌릴 수 있어야 하고**(비타협 원칙 #5) 끝나면
 * **다시 읽어야 한다**(§8 — 고쳤다고 말하지 말고 재판정). 그 규율을 형제가 각자 구현하면
 * 한쪽만 조용히 빠진다 — 실제로 비용에만 `restore*`가 없던 적이 있다(§7).
 */
function tripActions(deps: { refresh: () => Promise<void>; fail: (msg: string) => void }): {
  deleteTrip: (t: LocalTrip) => void;
  restoreTrip: (id: string) => void;
} {
  const say = (err: unknown, what: string): void =>
    deps.fail(`${what} 실패: ${err instanceof Error ? err.message : String(err)}`);
  return {
    // 여행 삭제(cascade tombstone) — 확인 → 소프트삭제 → 실행취소 토스트. 휴지통에서도 복구 가능.
    deleteTrip(t) {
      const ok = window.confirm(
        `"${t.title}" 여행을 삭제할까요?\n순간·사진·비용·소리도 함께 삭제되지만, 실행취소나 [데이터 관리 › 휴지통]에서 되살릴 수 있어요.`,
      );
      if (!ok) return;
      void (async () => {
        try {
          const children = await softDeleteTripLocalFirst(t.id);
          void trySync();
          await deps.refresh();
          showUndoToast('여행을 삭제했어요', async () => {
            await restoreTripLocalFirst(t.id, children);
            void trySync();
            await deps.refresh();
          });
        } catch (err) {
          say(err, '삭제');
        }
      })();
    },
    // 보관 여행을 완료 상태로 복원(요약 화면으로 되돌림).
    restoreTrip(id) {
      void (async () => {
        try {
          await updateTripLocalFirst(id, { status: 'completed' });
          await deps.refresh();
          await trySync();
          await deps.refresh();
        } catch (err) {
          say(err, '복원');
        }
      })();
    },
  };
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

/**
 * 목록이 아예 빌 때의 빈 상태.
 *
 * `sel`이 null이면 요약 화면(= 여행이 하나도 없음), 아니면 그 상태만 비어 있다는 뜻이다.
 * 🔴 **막다른 문장으로 끝내지 않는다**(§13): 상태 칩을 눌러 들어왔다면 되돌아갈 길을 준다.
 */
function emptyListState(sel: TripStatus | null, onClear: () => void): HTMLElement {
  const empty = el('div', 'empty-state');
  if (sel === 'archived') {
    empty.appendChild(el('p', 'empty-emoji', '📦'));
    empty.appendChild(el('h2', undefined, '보관 중인 여행이 없어요'));
    empty.appendChild(el('p', 'muted', '여행 편집에서 상태를 “보관”으로 바꾸면 여기로 들어와요.'));
  } else if (sel) {
    empty.appendChild(el('p', 'empty-emoji', '🧭'));
    empty.appendChild(el('h2', undefined, `${STATUS_LABEL[sel]} 여행이 없어요`));
    empty.appendChild(el('p', 'muted', '여행 편집에서 상태를 바꾸면 여기로 들어와요.'));
  } else {
    empty.appendChild(el('p', 'empty-emoji', '✈️'));
    empty.appendChild(el('h2', undefined, '첫 여행을 기록해보세요'));
    empty.appendChild(el('p', 'muted', '제목 하나면 충분해요. 이 기기에 안전하게 저장됩니다.'));
    return empty; // 요약 화면엔 되돌아갈 곳이 없다 — 없는 버튼을 만들지 않는다
  }
  const back = el('button', 'btn-ghost', '← 전체 보기') as HTMLButtonElement;
  back.type = 'button';
  back.addEventListener('click', onClear);
  empty.appendChild(back);
  return empty;
}

/**
 * 로그아웃(또는 아직 로그인 전) 상태에서 다른 계정의 이 기기 로컬 기록을 가리는 화면.
 *
 * 🔴 클라우드 모드(isConfigured())에서는 로그인 여부가 "이 계정의 여행을 볼 자격"의 경계다
 * (사용자 요청 2026-08-05: "로그아웃하면 사진 데이터가 보이지 않아야 하는데"). **가리는 것과
 * 지우는 것은 다르다** — 비타협 원칙 #1은 그대로 지킨다. Dexie 데이터는 그대로 남고, 로그인하면
 * 다시 보인다. `isConfigured()===false`(진짜 로컬 전용 빌드)에서는 이 화면을 아예 안 쓴다 —
 * 그 빌드엔 "다른 계정"이라는 개념 자체가 없다.
 */
export function signedOutLockState(): HTMLElement {
  const empty = el('div', 'empty-state');
  empty.appendChild(el('p', 'empty-emoji', '🔒'));
  empty.appendChild(el('h2', undefined, '로그인하면 볼 수 있어요'));
  empty.appendChild(el('p', 'muted', '이 기기에 저장된 여행은 로그아웃 중엔 가려져요. 지워지지 않았어요 — 로그인하면 다시 보여요.'));
  return empty;
}

/**
 * 로그아웃 잠금을 화면에 적용한다 — refresh()에서 분리(함수 크기 래칫, §7 구조적 강제).
 * 잠갔으면 true를 돌려 refresh()가 나머지(목록 렌더)를 건너뛰게 한다.
 *
 * 무엇을 가리나: 목록·새 여행 폼·기간 트리·**상태 칩 줄**. **Dexie는 손대지 않는다** — 다음
 * refresh(로그인 뒤)가 같은 데이터를 그대로 보여준다(가리는 것과 지우는 것은 다른 일 —
 * 비타협 원칙 #1).
 *
 * 🔴 상태 칩도 반드시 가린다: 칩에는 **개수**가 적혀 있어서, 목록만 가리고 칩을 두면
 * *"완료 7"*이 로그아웃 화면에 남아 이전 계정의 기록 규모를 그대로 알려준다(M-0102의
 * 같은 형태 — 문구는 「로그인하세요」인데 화면은 이미 말하고 있다).
 *
 * 🔴 **잠글지 말지의 판정은 여기 있지 않다.** `domain/authGate.ts`의 `canViewLocalRecords`
 * 한 곳이 정하고, 딥링크 가드(main.ts)도 **같은 함수**를 쓴다. 손으로 두 번 쓰면 한쪽만
 * 고쳐져 다른 쪽이 우회로가 된다 — M-0102가 정확히 그 형태였다(목록은 잠갔는데 딥링크는 열림).
 */
export function applySignedOutLock(
  locked: boolean,
  ui: {
    viewBar: HTMLElement;
    fold: HTMLDetailsElement;
    form: HTMLFormElement;
    filterNow: HTMLElement;
    list: HTMLElement;
    clearPeriod: () => void;
  },
): boolean {
  ui.viewBar.hidden = locked;
  ui.fold.hidden = locked;
  ui.form.hidden = locked;
  if (!locked) return false;
  ui.clearPeriod();
  ui.filterNow.hidden = true;
  ui.list.innerHTML = '';
  ui.list.appendChild(signedOutLockState());
  return true;
}

/**
 * 초대제 잠금 게이트(ADR-0021): 허용 목록에 없는 사용자는 자동 로그아웃 안내.
 * DB RLS가 실제 방어이며 이건 UX용. 통과하면 그대로, 아니면 null 반환.
 * top-level로 뽑음(함수 크기 래칫, §7 구조적 강제) — `status` 줄만 클로저 대신 인자로 받는다.
 */
async function gateAccess(u: SessionUser | null, status: HTMLElement): Promise<SessionUser | null> {
  if (!u) return null;
  const ok = await isAllowedUser();
  if (ok) return u;
  status.textContent = '🔒 이 앱은 초대된 사용자만 사용할 수 있어요. 접근이 필요하면 관리자에게 문의하세요.';
  await signOut();
  return null;
}

/**
 * 상태 칩 줄 — 「계획 중·진행 중·완료·보관 중」(사용자 요청 2026-08-06).
 *
 * 예전 [📦 보관함] 토글이 하던 일을 이 줄이 그대로 받았다. **보관만 전용 버튼을 갖고 나머지
 * 셋은 못 갖던 비대칭**이 이걸로 사라진다(§7 — 형제에게는 대칭을 기본값으로 준다).
 *
 * 눌림은 `aria-pressed`로 말한다(색만으로 인코딩하지 않는다). 같은 칩을 다시 누르면 해제 —
 * **선택할 수 있으면 해제할 수 있다**(ui 계약 #9).
 */
function renderStatusChips(
  bar: HTMLElement,
  chips: ReadonlyArray<{ status: TripStatus; label: string; count: number }>,
  sel: TripStatus | null,
  onSelect: (next: TripStatus | null) => void,
): void {
  bar.innerHTML = '';
  // 칩이 하나뿐이면 고를 것이 없다 — 고를 수 없는 선택지는 소음이다(§8).
  bar.hidden = chips.length < 2;
  for (const c of chips) {
    const on = sel === c.status;
    const b = el('button', `status-chip status-chip--${c.status}`) as HTMLButtonElement;
    b.type = 'button';
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', `${c.label} ${c.count}개${on ? ' — 다시 누르면 전체' : ''}`);
    b.appendChild(el('span', undefined, c.label));
    b.appendChild(el('span', 'chip-count', String(c.count)));
    b.addEventListener('click', () => onSelect(on ? null : c.status));
    bar.appendChild(b);
  }
}

/**
 * 요약 구획 하나 — 제목(+총 개수) · 카드 격자 · [모두 보기].
 *
 * 카드 격자를 `.trip-list`로 감싸는 이유: 넓은 화면의 2·3열 규칙이 **그 클래스 한 곳**에
 * 있다(§7 구조적 강제). 구획마다 자기 격자를 쓰면 다음 구획이 조용히 갈라진다.
 */
function renderSection(
  sec: HomeSection<LocalTrip>,
  card: (t: LocalTrip) => HTMLElement,
  onMore: (status: TripStatus) => void,
): HTMLElement {
  const box = el('section', 'home-section');
  const head = el('div', 'home-section-head');
  head.appendChild(el('h2', 'home-section-title', sec.title));
  head.appendChild(el('span', 'home-section-count', String(sec.total)));
  box.appendChild(head);
  const grid = el('div', 'trip-list');
  for (const t of sec.trips) grid.appendChild(card(t));
  box.appendChild(grid);
  // 접힌 게 없으면 버튼을 아예 그리지 않는다(§8 — 정상은 침묵).
  if (sec.moreLabel) {
    const more = el('button', 'btn-ghost section-more', sec.moreLabel) as HTMLButtonElement;
    more.type = 'button';
    more.addEventListener('click', () => onMore(sec.status));
    box.appendChild(more);
  }
  return box;
}

/**
 * 목록 자리를 그린다 — 빈 상태 / 요약 구획 / 평평한 목록 **셋 중 하나**.
 *
 * `refresh()`에서 뽑았다: 길이 래칫(`check-fn-size`)이 막았고, 래칫은 한 방향이라
 * "늘린 만큼 덜어내라"고 말한다. 그 요구가 이 추출을 만들었고 결과적으로 **세 갈래가
 * 한눈에 읽힌다** — 게이트가 설계를 밀어준 사례다(§11).
 */
function renderListArea(
  list: HTMLElement,
  ctx: {
    /** 상태 필터까지만 적용한 대상(기간 필터 이전) — 「여행 자체가 없음」을 가른다. */
    items: LocalTrip[];
    /** 기간 필터까지 적용해 실제로 그릴 것 — 「기간이 다 걸러냄」을 가른다. */
    shown: LocalTrip[];
    statusSel: TripStatus | null;
    card: (t: LocalTrip) => HTMLElement;
    backToAll: () => void;
    onMore: (s: TripStatus) => void;
  },
): void {
  list.innerHTML = '';
  if (ctx.items.length === 0) {
    list.appendChild(emptyListState(ctx.statusSel, ctx.backToAll));
    return;
  }
  if (ctx.shown.length === 0) {
    list.appendChild(filteredEmptyState(ctx.backToAll));
    return;
  }
  if (ctx.statusSel === null) {
    // 요약: 상태별 구획. 완료만 최근 3개로 접히고 나머지는 [모두 보기] 뒤로 간다.
    for (const sec of homeSections(ctx.shown)) list.appendChild(renderSection(sec, ctx.card, ctx.onMore));
    return;
  }
  // 한 상태만 담긴 평평한 목록 — 상태는 눌린 칩이 말한다(카드에 배지를 되풀이하지 않는다).
  const grid = el('div', 'trip-list');
  for (const t of ctx.shown) grid.appendChild(ctx.card(t));
  list.appendChild(grid);
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
  /**
   * 거르기만 한다(트리·문장은 그대로).
   *
   * 왜 따로 있나: **상태 칩의 개수도 기간 필터를 따라야 한다.** 칩이 「완료 7」이라 말하고
   * 눌렀더니 2개가 나오면 그게 바로 사용자가 말한 산만함의 다른 얼굴이다. 다만 트리는
   * 여전히 *현재 대상 목록*에서 파생돼야 하므로(§7 — 오늘의 계약) 그리기와 거르기를 나눈다.
   */
  match(items: LocalTrip[]): LocalTrip[];
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
    match(items) {
      return items.filter((t) => matchesPeriod(t, sel));
    },
    clear() {
      sel = {};
    },
  };
}

// 정상(동기화됨)은 조용하게, 알아둘 것·문제는 눈에 띄게(setNote 위계).
//
// 목적지(§7 — 갈 곳이 있는 상태에 전부 걸었는가):
//  · 실패           → 「동기화 상태」. 진짜 에러 메시지가 거기 있다.
//  · 대기 N건       → 「동기화 상태」. 거기에 [지금 동기화]가 있다. 사용자가 요청한 자리.
//  · 로컬 저장 모드 → 「환경·기능」. 왜 서버로 안 가는지는 환경이 답한다.
//  · 로그인 안내    → **목적지 없음.** 조치 버튼([로그인])이 이 화면 헤더에 이미 있다 —
//                    진단으로 보내면 오히려 멀어진다.
//  · 동기화됨(ok)   → **목적지 없음.** 정상은 침묵이어야 한다(진단 §5.1). 여기에 알약과
//                    셰브론을 붙이면 아무 할 일 없는 상태가 화면에서 제일 시끄러워진다.
//
// 🔴 M-0101(2026-08-05) — 예전엔 여기가 `pending > 0`만 봤다. 그러면 **보낼 게 없어서
// 조용한 것**과 **최근 동기화가 실제로 실패했지만 보낼 것도 없어서 조용한 것**이 같은
// "☁️ 동기화됨"으로 보였다 — 로그인은 됐는데 pull이 계속 실패하는 계정이 정상처럼
// 표시됐다. 실패는 pending 여부와 무관하게 먼저 본다.
function renderSyncNote(status: HTMLElement, pending: number, user: SessionUser | null): void {
  // 🔴 판정과 문장은 `domain/syncBadgeVerdict.ts`가 한다 — 이 한 줄이 사용자가 앱을 열 때
  //    **가장 먼저 읽는 문장**이라, 여기가 거짓말하면 나머지 진단은 열어 보지도 않는다.
  //    순수 함수라 유닛이 갈래를 전부 돌린다(§10 ③).
  const engine = syncEngineStatus();
  const v = syncBadge({
    cloudConfigured: isConfigured(),
    signedIn: Boolean(user),
    pending,
    phase: engine.phase,
    lastError: engine.lastError,
    // **`null`은 「같다」가 아니라 「모른다」**다 — 만료된 대조는 lastParity가 null을 준다.
    parity: lastParity(),
  });
  const label = badgeActionLabel(v);
  const action: NoteAction | null =
    v.go === null && !v.syncOnTap
      ? null
      : {
          label,
          go: () => {
            // [동기화] 버튼을 없애고 그 일을 배지가 받았다(사용자 제안 2026-08-05).
            // 「지금 확인」이 필요한 상태에서는 누르면 실제로 돌린다.
            if (v.syncOnTap) void requestSync('배지');
            if (v.go === 'sync') void openDiagnosticsHub('sync');
            else if (v.go === 'store') void openDiagnosticsHub('store');
            else if (v.go === 'env') void openDiagnosticsHub('environment');
          },
        };
  setNote(status, v.text, v.level, action);
}


/**
 * 배지가 스스로 최신을 유지하게 배선한다 — renderHome에서 분리(함수 크기 래칫, §7).
 *
 * 🔴 동기화가 끝나면 **배지를 다시 그린다.** 안 그러면 「동기화 중…」이나 「확인 전」이
 * 화면에 박힌 채 남는다 — 판정을 고쳐도 그리지 않으면 사용자에게는 안 고친 것이다(M-0022).
 * 대조 갱신 자체는 `installParityWatch`가 **같은 신호**로 건다(§7 — 주기를 두 곳에 두지 않는다).
 *
 * 🔴 이 배선이 [↻ 동기화] 버튼을 대신한다(사용자 제안 2026-08-05: *"동기화 버튼을 없애도
 * 앱 접속 시마다 자동으로 동기화하도록"*). 자동 동기화는 이미 돌고 있었고(온라인 복귀·화면
 * 복귀·주기 — `installAutoSync`), 「지금 확인」이 필요할 때는 **배지를 누르면** 된다.
 * 버튼을 그냥 지우면 그 수단이 사라지므로 **일을 옮긴 것**이지 없앤 것이 아니다.
 */
function wireBadgeWatch(repaint: () => void): void {
  unsubscribeSync = onSyncStatus(repaint);
  unsubscribeParity = installParityWatch();
}

export function renderHome(mount: HTMLElement, navigate: Navigate): void {
  if (unsubscribeAuth) {
    unsubscribeAuth();
    unsubscribeAuth = null;
  }
  unsubscribeSync?.();
  unsubscribeSync = null;
  unsubscribeParity?.();
  unsubscribeParity = null;
  mount.innerHTML = '';

  let user: SessionUser | null = null;
  /** 마지막으로 잰 대기 수 — 동기화 구독이 배지를 다시 그릴 때 쓴다. */
  let lastPending = 0;

  const wrap = el('main', 'screen screen-home');
  const authArea = el('div', 'auth-area');
  const status = el('p', 'sync-note muted');
  status.setAttribute('role', 'status');
  // onChanged: 복원·휴지통 조작 후 홈 목록·통계를 즉시 갱신(refresh는 아래에서 선언·호이스팅).
  wrap.appendChild(buildHeader(authArea, status, () => void openDataManager({ onChanged: () => void refresh(), goToTrip: (id: string) => navigate('trip-detail', id) })));

  const section = el('section', 'trip-section');
  // 🔴 목록의 **껍데기**다(격자가 아니다). 격자 규칙은 `.trip-list` 한 곳에 있고, 요약 화면은
  // 구획마다 그 격자를 하나씩 갖는다. 예전엔 이 요소가 곧 `.trip-list`라 빈 상태 문구까지
  // 2열 격자의 한 칸으로 들어갔다.
  const list = el('div', 'home-list');
  // 기간 트리(연도▸월): 넓은 화면에선 왼쪽 고정 칸, 좁은 화면에선 접힌 필터.
  const periodUi = buildPeriodUi();

  /**
   * 목록 뷰 = 상태 선택. `null`이면 **요약 화면**(구획으로 묶고 완료는 최근 3개만).
   *
   * 예전엔 `'active' | 'archived'` 두 갈래였고 보관만 전용 토글을 갖고 있었다. 넷을 같은
   * 자리에서 같은 어휘로 고르게 바꾼다(§7 사용자 대면 대칭).
   */
  let statusSel: TripStatus | null = null;
  const chipBar = el('div', 'status-chips');
  chipBar.setAttribute('role', 'group');
  chipBar.setAttribute('aria-label', '상태별 보기');

  const { deleteTrip, restoreTrip } = tripActions({
    refresh: () => refresh(),
    fail: (msg) => {
      status.textContent = msg;
    },
  });

  const form = buildTripForm(async (title) => {
    try {
      await createTripLocalFirst({ title });
      await refresh();
      await trySync(); // 저장 후 백그라운드 전송
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
      const out = el('button', 'btn-ghost', '로그아웃') as HTMLButtonElement;
      out.type = 'button';
      out.addEventListener('click', () => {
        void signOut();
      });
      authArea.append(who, out);
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

  async function refresh(): Promise<void> {
    const [trips, archived, pending] = await Promise.all([
      listTrips(),
      listArchivedTrips(),
      pendingSyncCount(),
    ]);
    lastPending = pending;

    const lockUi = { viewBar: chipBar, fold: periodUi.fold, form, filterNow: periodUi.filterNow, list, clearPeriod: periodUi.clear };
    const locked = applySignedOutLock(!canViewLocalRecords(isConfigured(), Boolean(user)), lockUi);
    if (locked) {
      renderSyncNote(status, pending, user);
      return;
    }

    // 🔴 보관은 별도 질의로 들어오지만(services 계약) 화면에서는 **넷이 한 목록**이다.
    // 여기서 합치지 않으면 「보관 중」 칩만 개수를 못 세고 형제와 갈라진다(§7).
    const all = [...trips, ...archived];
    // 새 여행 폼은 보관 목록에서만 숨긴다(locked 분기는 위에서 이미 처리).
    form.hidden = statusSel === 'archived';

    // 대상 목록: 칩이 안 눌렸으면 요약(보관 제외), 눌렸으면 그 상태만.
    const items = statusSel === null ? summaryPool(all) : all.filter((t) => t.status === statusSel);
    // 기간 트리는 **현재 대상 목록**에서 파생되고 목록도 같은 선택으로 걸러진다(§7 대칭).
    const shown = periodUi.apply(items, () => void refresh());
    // 칩 개수는 기간 필터를 통과한 **전체**에서 센다 — 칩이 「완료 7」이라 말하고 눌렀더니
    // 2개가 나오는 모순을 만들지 않는다.
    renderStatusChips(chipBar, statusChips(periodUi.match(all)), statusSel, (next) => {
      statusSel = next;
      void refresh();
    });

    const backToAll = (): void => {
      statusSel = null;
      periodUi.clear();
      void refresh();
    };
    const card = (t: LocalTrip): HTMLElement =>
      // 보관 목록의 주행동은 [복원], 나머지는 [삭제]. 카드 껍데기는 한 곳을 쓴다(§7 구조적 강제).
      statusSel === 'archived' ? archivedCard(t, navigate, restoreTrip) : tripCard(t, navigate, deleteTrip);

    renderListArea(list, {
      items,
      shown,
      statusSel,
      card,
      backToAll,
      onMore: (s) => {
        statusSel = s;
        void refresh();
      },
    });
    renderSyncNote(status, pending, user);
  }

  // 2단 몸통: 왼쪽 기간 트리 | 오른쪽 목록. DOM 순서 = 논리 순서(입력 → 필터 → 목록)라
  // 화면읽기·키보드 탐색이 흔들리지 않고, 시각 배치는 CSS(≥1100px grid)만 바꾼다.
  const body = el('div', 'home-body');
  const main = el('div', 'home-main');
  main.append(chipBar, periodUi.filterNow, list);
  body.append(periodUi.fold, main);
  section.append(form, body);
  wrap.appendChild(section);
  mount.appendChild(wrap);

  wireBadgeWatch(() => renderSyncNote(status, lastPending, user));

  // 인증 상태 구독: 로그인되면 동기화 후 갱신.
  unsubscribeAuth = onAuthChange((u) => {
    void (async () => {
      user = await gateAccess(u, status);
      renderAuth();
      await trySync();
      await refresh();
    })();
  });

  // 온라인 복귀 시 동기화 시도.
  window.addEventListener('online', () => void trySync().then(refresh));

  // 초기값: 현재 세션 확인(구독이 늦게 올 수 있으므로 즉시 1회).
  void (async () => {
    user = await gateAccess(await currentUser(), status);
    renderAuth();
    await refresh();
    await trySync();
    if (user) await refreshParity(); // 안 뜨면 배지가 「확인 전」에 머문다(M-0101을 못 말한다)
    await refresh();
  })();
}
