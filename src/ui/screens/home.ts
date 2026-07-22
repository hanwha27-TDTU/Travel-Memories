// ui/screens/home.ts — 홈 화면 (thin slice: 여행 생성·목록, 로컬우선)
// mobile-capture-ux 원칙: 기록 시작은 한 번의 터치, 최소 입력(제목 하나).
// empty-state-designer 원칙: 비어 있음이 다음 행동(첫 여행 만들기)으로 이끈다.

import { isConfigured } from '../../services/supabase/client';
import { createTripLocalFirst, listTrips, pendingSyncCount } from '../../services/trips';
import type { LocalTrip } from '../../offline/db';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // textContent만 사용 — innerHTML 금지
  return node;
}

function tripCard(t: LocalTrip): HTMLElement {
  const card = el('article', 'trip-card');
  card.appendChild(el('h3', 'trip-title', t.title));
  const meta = el('p', 'trip-meta');
  const period = t.startDate ? `${t.startDate}${t.endDate ? ` ~ ${t.endDate}` : ''}` : '기간 미정';
  meta.textContent = `${period} · ${t.status === 'planned' ? '계획 중' : t.status}`;
  card.appendChild(meta);
  return card;
}

export function renderHome(mount: HTMLElement): void {
  mount.innerHTML = ''; // 정적 골격 초기화(자유 텍스트 보간 없음)

  const wrap = el('main', 'screen screen-home');
  const header = el('header', 'app-header');
  header.appendChild(el('h1', 'app-title', '🧳 Journey Archive'));
  wrap.appendChild(header);

  const section = el('section', 'trip-section');
  const list = el('div', 'trip-list');
  const status = el('p', 'sync-note muted');
  status.setAttribute('role', 'status');

  // 새 여행 폼 — 한 줄 입력 + 저장 (10초 기록 원칙의 골격)
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
      } catch (err) {
        status.textContent = `저장 실패: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        submit.disabled = false;
      }
    })();
  });

  async function refresh(): Promise<void> {
    const [trips, pending] = await Promise.all([listTrips(), pendingSyncCount()]);
    list.innerHTML = '';
    if (trips.length === 0) {
      const empty = el('div', 'empty-state');
      empty.appendChild(el('p', 'empty-emoji', '✈️'));
      empty.appendChild(el('h2', undefined, '첫 여행을 기록해보세요'));
      empty.appendChild(el('p', 'muted', '제목 하나면 충분해요. 지금은 이 기기에 안전하게 저장됩니다.'));
      list.appendChild(empty);
    } else {
      for (const t of trips) list.appendChild(tripCard(t));
    }
    const syncState = isConfigured()
      ? `☁️ 동기화 설정됨 · 대기 ${pending}건`
      : `📴 로컬 저장 모드 · 동기화 대기 ${pending}건 (로그인 연결 시 전송)`;
    status.textContent = syncState;
  }

  section.appendChild(form);
  section.appendChild(list);
  section.appendChild(status);
  wrap.appendChild(section);
  mount.appendChild(wrap);

  void refresh();
}
