// ui/screens/home.ts — 홈 화면 (여행 생성·목록 + 로그인·동기화).
// 오프라인 우선: 저장은 항상 로컬 먼저, 로그인 시 백그라운드로 서버 동기화.
// 자유 텍스트(이메일 등)는 textContent만 사용(innerHTML 금지).

import { isConfigured, supabase } from '../../services/supabase/client';
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
import { runSync } from '../../services/sync';
import { el, setNote } from '../dom';
import { openDataManager } from './dataManager';
import { openAboutApp } from './aboutApp';
import { APP_VERSION } from '../../app/changelog';
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
  const period = t.startDate ? `${t.startDate}${t.endDate ? ` ~ ${t.endDate}` : ''}` : '기간 미정';
  info.appendChild(el('p', 'trip-meta', period));
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
  const period = t.startDate ? `${t.startDate}${t.endDate ? ` ~ ${t.endDate}` : ''}` : '기간 미정';
  info.appendChild(el('p', 'trip-meta', period));
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

/** 로그인 상태면 서버 동기화 시도(실패는 다음 트리거에서 재시도). */
async function trySync(user: SessionUser | null): Promise<void> {
  const c = supabase();
  if (!user || !c) return;
  try {
    await runSync(c, user.id);
  } catch {
    /* 재시도는 다음 로그인/온라인/저장 트리거에서 */
  }
}

export function renderHome(mount: HTMLElement, navigate: Navigate): void {
  if (unsubscribeAuth) {
    unsubscribeAuth();
    unsubscribeAuth = null;
  }
  mount.innerHTML = '';

  let user: SessionUser | null = null;

  const wrap = el('main', 'screen screen-home');
  const header = el('header', 'app-header');
  // 제목 + 버전 배지(누르면 개발자 정보). 버전은 changelog SSOT에서 읽는다.
  const titleRow = el('div', 'app-title-row');
  titleRow.appendChild(el('h1', 'app-title', '🧳 Bugeon Journey'));
  const verBadge = el('button', 'app-version', `v${APP_VERSION}`) as HTMLButtonElement;
  verBadge.type = 'button';
  verBadge.setAttribute('aria-label', `버전 ${APP_VERSION} · 개발자 정보 열기`);
  verBadge.addEventListener('click', () => openAboutApp());
  titleRow.appendChild(verBadge);
  header.appendChild(titleRow);
  const controls = buildControls();
  const dataBtn = el('button', 'btn-ghost data-open', '📦 데이터 관리') as HTMLButtonElement;
  dataBtn.type = 'button';
  dataBtn.setAttribute('aria-label', '데이터 관리 열기 — 백업·복원·휴지통·가이드');
  // onChanged: 복원·휴지통 조작 후 홈 목록·통계를 즉시 갱신(refresh는 아래에서 선언·호이스팅).
  dataBtn.addEventListener('click', () => openDataManager({ onChanged: () => void refresh() }));
  controls.appendChild(dataBtn);
  const authArea = el('div', 'auth-area');
  controls.appendChild(authArea); // 계절·테마 컨트롤과 같은 액션 행에 배치
  header.appendChild(controls);
  wrap.appendChild(header);

  const section = el('section', 'trip-section');
  const list = el('div', 'trip-list');
  const status = el('p', 'sync-note muted');
  status.setAttribute('role', 'status');

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
      `"${t.title}" 여행을 삭제할까요?\n순간·사진·비용도 함께 삭제되지만, 실행취소나 [데이터 관리 › 휴지통]에서 되살릴 수 있어요.`,
    );
    if (!ok) return;
    void (async () => {
      try {
        const { momentIds, mediaIds } = await softDeleteTripLocalFirst(t.id);
        void trySync(user);
        await refresh();
        showUndoToast('여행을 삭제했어요', async () => {
          await restoreTripLocalFirst(t.id, momentIds, mediaIds);
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

  const form = el('form', 'trip-form');
  const input = el('input') as HTMLInputElement;
  input.type = 'text';
  input.placeholder = '여행 제목 (예: 제주도 여름 여행)';
  input.maxLength = 100;
  input.required = true;
  input.setAttribute('aria-label', '여행 제목');
  const submit = el('button', 'btn-primary', '+ 새 여행') as HTMLButtonElement;
  submit.type = 'submit';
  form.appendChild(input);
  form.appendChild(submit);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit.disabled = true;
    void (async () => {
      try {
        await createTripLocalFirst({ title: input.value });
        input.value = '';
        await refresh();
        await trySync(user); // 저장 후 백그라운드 전송
        await refresh();
      } catch (err) {
        status.textContent = `저장 실패: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        submit.disabled = false;
      }
    })();
  });

  function renderAuth(): void {
    authArea.innerHTML = '';
    if (!isConfigured()) {
      authArea.appendChild(el('span', 'muted small', '📴 로컬 모드'));
      return;
    }
    if (user) {
      const who = el('span', 'muted small');
      who.textContent = user.email ?? '로그인됨';
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
    list.innerHTML = '';
    if (items.length === 0) {
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
      list.appendChild(empty);
    } else if (view === 'archived') {
      items.forEach((t, i) => list.appendChild(archivedCard(t, i, navigate, restoreTrip)));
    } else {
      items.forEach((t, i) => list.appendChild(tripCard(t, i, navigate, deleteTrip)));
    }
    // 정상(동기화됨)은 조용하게, 알아둘 것·문제는 눈에 띄게(setNote 위계).
    if (!isConfigured()) {
      setNote(status, `📴 로컬 저장 모드 · 대기 ${pending}건`, 'info');
    } else if (user) {
      if (pending > 0) setNote(status, `☁️ 동기화 대기 ${pending}건`, 'info');
      else setNote(status, '☁️ 동기화됨', 'ok');
    } else {
      setNote(status, `🔒 로그인하면 기기 간 동기화 · 로컬 대기 ${pending}건`, 'info');
    }
  }

  section.append(form, viewBar, list, status);
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
