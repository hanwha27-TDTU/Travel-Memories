// ui/screens/tripDetail.ts — 여행 상세 + 타임라인 + 순간 기록(로컬우선).
// 자유 텍스트는 textContent만 사용. 서버 동기화(순간)는 후속 — 지금은 이 기기에 내구성 저장.

import { el } from '../dom';
import { getTrip } from '../../services/trips';
import { createMomentLocalFirst, listMoments } from '../../services/moments';
import { groupMomentsByDay, type DayGroup } from '../../domain/moment/timeline';
import { supabase } from '../../services/supabase/client';
import { currentUser } from '../../services/auth';
import { runSync } from '../../services/sync';
import type { Route } from '../../app/router';
import type { LocalMoment } from '../../offline/db';

type Navigate = (route: Route, param?: string) => void;

/** 로그인·설정된 경우 백그라운드 동기화(순간 push/pull 포함). 실패는 다음 트리거에서 재시도. */
async function trySync(): Promise<void> {
  const c = supabase();
  if (!c) return;
  const u = await currentUser();
  if (!u) return;
  try {
    await runSync(c, u.id);
  } catch {
    /* 다음 트리거에서 재시도 */
  }
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
    const heroInfo = el('div', 'detail-hero-info');
    const period = trip.startDate
      ? `${trip.startDate}${trip.endDate ? ` ~ ${trip.endDate}` : ''}`
      : '기간 미정';
    heroInfo.appendChild(el('h1', 'detail-title', trip.title));
    heroInfo.appendChild(el('p', 'detail-period', period));
    const statRow = el('div', 'detail-stats');
    hero.append(back, heroInfo, statRow);
    wrap.appendChild(hero);

    // ===== 본문 =====
    const body = el('section', 'detail-body');
    wrap.appendChild(body);

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

    const place = el('input', 'moment-place') as HTMLInputElement;
    place.type = 'text';
    place.placeholder = '📍 장소 (선택)';
    place.maxLength = 80;
    place.setAttribute('aria-label', '장소(선택)');

    const save = el('button', 'btn-primary', '순간 저장') as HTMLButtonElement;
    save.type = 'submit';

    form.append(input, emoRow, place, save);
    body.appendChild(form);

    const note = el('p', 'sync-note', '');
    note.setAttribute('role', 'status');
    body.appendChild(note);

    const timeline = el('div', 'timeline-wrap');
    body.appendChild(timeline);

    async function refresh(): Promise<void> {
      const moments = await listMoments(trip!.id);
      renderTimeline(moments);
      const startArg = trip!.startDate || undefined;
      const groups = groupMomentsByDay(moments, startArg);
      statRow.innerHTML = '';
      statRow.append(
        stat(String(moments.length), '순간'),
        stat(String(groups.length), '일'),
      );
    }

    function renderTimeline(moments: LocalMoment[]): void {
      timeline.innerHTML = '';
      if (moments.length === 0) {
        const empty = el('div', 'empty-state');
        empty.appendChild(el('p', 'empty-emoji', '📝'));
        empty.appendChild(el('h2', undefined, '첫 순간을 남겨보세요'));
        empty.appendChild(el('p', 'muted', '사진·장소는 나중에 채워도 돼요. 한 줄이면 충분합니다.'));
        timeline.appendChild(empty);
        return;
      }
      const startArg = trip!.startDate || undefined;
      for (const g of groupMomentsByDay(moments, startArg)) {
        timeline.appendChild(el('h3', 'day-head', dayHeaderLabel(g)));
        const items = el('div', 'timeline');
        for (const m of g.items) items.appendChild(momentCard(m));
        timeline.appendChild(items);
      }
    }

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      save.disabled = true;
      void (async () => {
        try {
          await createMomentLocalFirst({
            tripId: trip!.id,
            title: input.value,
            emotion: picked,
            placeName: place.value,
          });
          input.value = '';
          place.value = '';
          picked = '';
          for (const btn of emoButtons.values()) btn.setAttribute('aria-pressed', 'false');
          note.textContent = '✅ 저장됨';
          await refresh();
          await trySync(); // 로그인 시 서버로 전송
          await refresh();
        } catch (err) {
          note.textContent = `저장 실패: ${err instanceof Error ? err.message : String(err)}`;
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

function stat(value: string, label: string): HTMLElement {
  const s = el('div', 'detail-stat');
  s.appendChild(el('b', undefined, value));
  s.appendChild(el('span', undefined, label));
  return s;
}

function momentCard(m: LocalMoment): HTMLElement {
  const item = el('div', 'tl-item');
  item.appendChild(el('span', 'tl-node'));
  const t = timeLabel(m.occurredAt);
  if (t) item.appendChild(el('div', 'tl-time', t));
  const card = el('article', 'moment-card');
  const head = el('div', 'moment-head');
  head.appendChild(el('p', 'moment-say', m.title));
  if (m.emotion) head.appendChild(el('span', 'moment-emo', m.emotion));
  card.appendChild(head);
  if (m.placeName) {
    const chips = el('div', 'chips');
    chips.appendChild(el('span', 'chip gps', `📍 ${m.placeName}`));
    card.appendChild(chips);
  }
  item.appendChild(card);
  return item;
}
