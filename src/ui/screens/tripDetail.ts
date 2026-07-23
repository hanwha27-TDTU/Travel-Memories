// ui/screens/tripDetail.ts — 여행 상세 + 타임라인 + 순간 기록(로컬우선).
// 자유 텍스트는 textContent만 사용. 서버 동기화(순간)는 후속 — 지금은 이 기기에 내구성 저장.

import { el } from '../dom';
import { getTrip, updateTripLocalFirst } from '../../services/trips';
import { createMomentLocalFirst, listMoments } from '../../services/moments';
import { addPhotoToMoment, listMediaByTrip } from '../../services/media';
import { groupMomentsByDay, type DayGroup } from '../../domain/moment/timeline';
import { supabase } from '../../services/supabase/client';
import { currentUser } from '../../services/auth';
import { runSync } from '../../services/sync';
import type { Route } from '../../app/router';
import type { LocalMoment, LocalTrip, LocalMedia } from '../../offline/db';

type Navigate = (route: Route, param?: string) => void;

const STATUS_LABELS: Record<LocalTrip['status'], string> = {
  planned: '계획 중',
  active: '진행 중',
  completed: '완료',
  archived: '보관',
};
const STATUS_ORDER: LocalTrip['status'][] = ['planned', 'active', 'completed', 'archived'];

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
    const editBtn = el('button', 'hero-edit', '✎ 편집') as HTMLButtonElement;
    editBtn.type = 'button';
    editBtn.setAttribute('aria-label', '여행 정보 편집');

    const heroInfo = el('div', 'detail-hero-info');
    const period = trip.startDate
      ? `${trip.startDate}${trip.endDate ? ` ~ ${trip.endDate}` : ''}`
      : '기간 미정';
    const badge = el('span', 'detail-badge', STATUS_LABELS[trip.status]);
    heroInfo.appendChild(badge);
    heroInfo.appendChild(el('h1', 'detail-title', trip.title));
    heroInfo.appendChild(el('p', 'detail-period', period));
    const statRow = el('div', 'detail-stats');
    hero.append(back, editBtn, heroInfo, statRow);
    wrap.appendChild(hero);

    // ===== 본문 =====
    const body = el('section', 'detail-body');
    wrap.appendChild(body);

    // 편집 패널(날짜·상태) — 토글.
    const editPanel = buildEditPanel(trip, async (patch) => {
      await updateTripLocalFirst(trip.id, patch);
      void trySync();
      renderTripDetail(mount, tripId, navigate); // 최신 데이터로 재렌더
    });
    editPanel.hidden = true;
    editBtn.addEventListener('click', () => {
      editPanel.hidden = !editPanel.hidden;
    });
    body.appendChild(editPanel);

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

    // 사진 선택(원본은 기기에 보관·압축본은 파생, §0). label 안에 input을 넣어 접근성 확보.
    const photoInput = el('input', 'moment-photo-input') as HTMLInputElement;
    photoInput.type = 'file';
    photoInput.accept = 'image/*';
    photoInput.multiple = true;
    photoInput.setAttribute('aria-label', '사진 추가');
    const photoLabel = el('label', 'moment-photo-label');
    const photoCount = el('span', 'moment-photo-count', '');
    photoLabel.append(document.createTextNode('📷 사진 추가 '), photoCount, photoInput);
    photoInput.addEventListener('change', () => {
      const n = photoInput.files?.length ?? 0;
      photoCount.textContent = n > 0 ? `· ${n}장 선택됨` : '';
    });

    const save = el('button', 'btn-primary', '순간 저장') as HTMLButtonElement;
    save.type = 'submit';

    form.append(input, emoRow, place, photoLabel, save);
    body.appendChild(form);

    const note = el('p', 'sync-note', '');
    note.setAttribute('role', 'status');
    body.appendChild(note);

    const timeline = el('div', 'timeline-wrap');
    body.appendChild(timeline);

    // 썸네일 objectURL 관리(재렌더 시 이전 URL 회수).
    let objectUrls: string[] = [];
    function resetUrls(): void {
      for (const u of objectUrls) URL.revokeObjectURL(u);
      objectUrls = [];
    }

    async function refresh(): Promise<void> {
      const [moments, media] = await Promise.all([listMoments(trip!.id), listMediaByTrip(trip!.id)]);
      const byMoment = new Map<string, LocalMedia[]>();
      for (const md of media) {
        const arr = byMoment.get(md.momentId);
        if (arr) arr.push(md);
        else byMoment.set(md.momentId, [md]);
      }
      renderTimeline(moments, byMoment);
      const groups = groupMomentsByDay(moments, trip!.startDate || undefined);
      statRow.innerHTML = '';
      statRow.append(
        stat(String(moments.length), '순간'),
        stat(String(groups.length), '일'),
        stat(String(media.length), '사진'),
      );
    }

    function renderTimeline(moments: LocalMoment[], byMoment: Map<string, LocalMedia[]>): void {
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
        for (const m of g.items) items.appendChild(buildMomentCard(m, byMoment.get(m.id) ?? []));
        timeline.appendChild(items);
      }
    }

    function buildMomentCard(m: LocalMoment, mediaList: LocalMedia[]): HTMLElement {
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
      if (mediaList.length) {
        const grid = el('div', 'photo-thumbs');
        for (const md of mediaList) {
          const url = URL.createObjectURL(md.thumbBlob);
          objectUrls.push(url);
          const img = el('img', 'photo-thumb') as HTMLImageElement;
          img.src = url;
          img.alt = '여행 사진';
          img.loading = 'lazy';
          img.addEventListener('click', () => openViewer(md));
          grid.appendChild(img);
        }
        card.appendChild(grid);
      }
      item.appendChild(card);
      return item;
    }

    function openViewer(md: LocalMedia): void {
      const url = URL.createObjectURL(md.displayBlob);
      const overlay = el('div', 'photo-viewer');
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-label', '사진 보기');
      const img = el('img') as HTMLImageElement;
      img.src = url;
      img.alt = '여행 사진';
      overlay.appendChild(img);
      const close = () => {
        overlay.remove();
        URL.revokeObjectURL(url);
      };
      overlay.addEventListener('click', close);
      document.body.appendChild(overlay);
    }

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      save.disabled = true;
      const files = photoInput.files ? Array.from(photoInput.files) : [];
      void (async () => {
        try {
          const moment = await createMomentLocalFirst({
            tripId: trip!.id,
            title: input.value,
            emotion: picked,
            placeName: place.value,
          });
          if (files.length) {
            let done = 0;
            note.textContent = `사진 처리 중… (0/${files.length})`;
            for (const f of files) {
              try {
                await addPhotoToMoment(f, { momentId: moment.id, tripId: trip!.id });
              } catch {
                /* 개별 사진 실패는 건너뜀(순간 자체는 저장됨) */
              }
              done += 1;
              note.textContent = `사진 처리 중… (${done}/${files.length})`;
            }
          }
          input.value = '';
          place.value = '';
          picked = '';
          photoInput.value = '';
          photoCount.textContent = '';
          for (const btn of emoButtons.values()) btn.setAttribute('aria-pressed', 'false');
          note.textContent = '✅ 저장됨';
          await refresh();
          await trySync(); // 로그인 시 서버로 전송(순간). 사진은 후속(3b).
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

/** 여행 날짜·상태·제목 편집 패널. onSave(patch) 호출 후 상위에서 재렌더. */
function buildEditPanel(
  trip: LocalTrip,
  onSave: (patch: { title: string; startDate: string; endDate: string; status: LocalTrip['status'] }) => Promise<void>,
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

  panel.append(
    el('label', 'edit-label', '제목'),
    titleIn,
    el('label', 'edit-label', '기간'),
    dates,
    el('label', 'edit-label', '상태'),
    status,
    row,
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

function stat(value: string, label: string): HTMLElement {
  const s = el('div', 'detail-stat');
  s.appendChild(el('b', undefined, value));
  s.appendChild(el('span', undefined, label));
  return s;
}

