// ui/screens/home.ts — 홈 화면 (여행 생성·목록 + 로그인·동기화).
// 오프라인 우선: 저장은 항상 로컬 먼저, 로그인 시 백그라운드로 서버 동기화.
// 자유 텍스트(이메일 등)는 textContent만 사용(innerHTML 금지).

import { isConfigured, supabase } from '../../services/supabase/client';
import { createTripLocalFirst, listTrips, pendingSyncCount } from '../../services/trips';
import {
  currentUser,
  signInWithGoogle,
  signOut,
  onAuthChange,
  isAllowedUser,
  type SessionUser,
} from '../../services/auth';
import { runSync } from '../../services/sync';
import type { LocalTrip } from '../../offline/db';

let unsubscribeAuth: (() => void) | null = null;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function tripCard(t: LocalTrip): HTMLElement {
  const card = el('article', 'trip-card');
  card.appendChild(el('h3', 'trip-title', t.title));
  const period = t.startDate ? `${t.startDate}${t.endDate ? ` ~ ${t.endDate}` : ''}` : '기간 미정';
  card.appendChild(el('p', 'trip-meta', `${period} · ${t.status === 'planned' ? '계획 중' : t.status}`));
  return card;
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

export function renderHome(mount: HTMLElement): void {
  if (unsubscribeAuth) {
    unsubscribeAuth();
    unsubscribeAuth = null;
  }
  mount.innerHTML = '';

  let user: SessionUser | null = null;

  const wrap = el('main', 'screen screen-home');
  const header = el('header', 'app-header');
  header.appendChild(el('h1', 'app-title', '🧳 Bugeon Journey'));
  const authArea = el('div', 'auth-area');
  header.appendChild(authArea);
  wrap.appendChild(header);

  const section = el('section', 'trip-section');
  const list = el('div', 'trip-list');
  const status = el('p', 'sync-note muted');
  status.setAttribute('role', 'status');

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
    const [trips, pending] = await Promise.all([listTrips(), pendingSyncCount()]);
    list.innerHTML = '';
    if (trips.length === 0) {
      const empty = el('div', 'empty-state');
      empty.appendChild(el('p', 'empty-emoji', '✈️'));
      empty.appendChild(el('h2', undefined, '첫 여행을 기록해보세요'));
      empty.appendChild(el('p', 'muted', '제목 하나면 충분해요. 이 기기에 안전하게 저장됩니다.'));
      list.appendChild(empty);
    } else {
      for (const t of trips) list.appendChild(tripCard(t));
    }
    if (!isConfigured()) {
      status.textContent = `📴 로컬 저장 모드 · 대기 ${pending}건`;
    } else if (user) {
      status.textContent = pending > 0 ? `☁️ 동기화 대기 ${pending}건` : '☁️ 동기화됨';
    } else {
      status.textContent = `🔒 로그인하면 기기 간 동기화 · 로컬 대기 ${pending}건`;
    }
  }

  section.append(form, list, status);
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
