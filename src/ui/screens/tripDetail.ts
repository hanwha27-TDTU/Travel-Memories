// ui/screens/tripDetail.ts — 여행 상세 + 타임라인 + 순간 기록(로컬우선).
// 자유 텍스트는 textContent만 사용. 서버 동기화(순간)는 후속 — 지금은 이 기기에 내구성 저장.

import { el } from '../dom';
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
} from '../../services/media';
import {
  createExpenseLocalFirst,
  updateExpenseLocalFirst,
  softDeleteExpenseLocalFirst,
  listExpensesByTrip,
} from '../../services/expenses';
import { CURRENCIES, DEFAULT_CURRENCY, formatMoney, sumByCurrency, formatTotals } from '../../domain/expense/format';
import { openPhotoEditor, type EditorResult } from '../photoEditor';
import { groupMomentsByDay, type DayGroup } from '../../domain/moment/timeline';
import { supabase } from '../../services/supabase/client';
import { currentUser } from '../../services/auth';
import { runSync } from '../../services/sync';
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
    const opt = el('option', undefined, `${c.symbol} ${c.code}`) as HTMLOptionElement;
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
        const { momentIds, mediaIds } = await softDeleteTripLocalFirst(trip!.id);
        void trySync();
        navigate('home');
        showUndoToast('여행을 삭제했어요', async () => {
          await restoreTripLocalFirst(trip!.id, momentIds, mediaIds);
          void trySync();
          navigate('home'); // 홈 목록에서 카드가 되살아나는 걸 바로 보여줌(실행취소를 누른 자리)
        });
      },
    );
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

    form.append(input, emoRow, place, moneyRow, photoLabel, save);
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
            await softDeleteExpenseLocalFirst(existingExpense.id);
          }
          await refresh();
          void trySync();
        },
        () => {
          editForm.hidden = true;
        },
      );
      editForm.hidden = true;
      editBtn.addEventListener('click', () => {
        editForm.hidden = !editForm.hidden;
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
        for (const ex of expenseList) {
          chips.appendChild(el('span', 'chip money', `💰 ${formatMoney(ex.originalAmount, ex.originalCurrency)}`));
        }
        card.appendChild(chips);
      }
      if (mediaList.length) {
        const grid = el('div', 'photo-thumbs');
        for (const md of mediaList) {
          const url = URL.createObjectURL(md.thumbBlob);
          objectUrls.push(url);
          const cell = el('div', 'photo-thumb-wrap');
          const img = el('img', 'photo-thumb') as HTMLImageElement;
          img.src = url;
          img.alt = '여행 사진';
          img.loading = 'lazy';
          img.addEventListener('click', () => openViewer(md));
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
      card.appendChild(editForm);
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
      const close = () => {
        overlay.remove();
        URL.revokeObjectURL(url);
      };
      const closeBtn = el('button', 'photo-viewer-close', '✕') as HTMLButtonElement;
      closeBtn.type = 'button';
      closeBtn.setAttribute('aria-label', '닫기');
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        close();
      });
      overlay.append(img, closeBtn);
      overlay.addEventListener('click', close); // 배경 탭으로도 닫기
      document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') {
          close();
          document.removeEventListener('keydown', esc);
        }
      });
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
          if (files.length) {
            // 배치 편집: 사진 간 ← 이전/다음 이동 + 각 사진 편집상태 기억. 결정 후 일괄 저장.
            const states: (EditorResult['state'] | undefined)[] = new Array(files.length);
            const blobs: (Blob | null)[] = new Array(files.length).fill(null);
            let i = 0;
            while (i < files.length) {
              note.textContent = `사진 편집… (${i + 1}/${files.length})`;
              const prev = states[i];
              const r = await openPhotoEditor(files[i]!, `${i + 1}/${files.length} · ${files[i]!.name}`, {
                canGoBack: i > 0,
                ...(prev ? { initialState: prev } : {}),
              });
              states[i] = r.state;
              if (r.action === 'back') {
                i -= 1;
                continue;
              }
              blobs[i] = r.blob; // apply→편집본(무편집 null), skip→null(원본)
              i += 1;
            }
            for (let k = 0; k < files.length; k += 1) {
              note.textContent = `사진 저장… (${k + 1}/${files.length})`;
              try {
                await addPhotoToMoment(files[k]!, { momentId: moment.id, tripId: trip!.id }, blobs[k] ?? undefined);
              } catch {
                /* 개별 사진 실패는 건너뜀(순간 자체는 저장됨) */
              }
            }
          }
          input.value = '';
          place.value = '';
          picked = '';
          amountIn.value = '';
          currencyIn.value = DEFAULT_CURRENCY;
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
function buildMomentEditForm(
  m: LocalMoment,
  existingExpense: LocalExpense | undefined,
  onSave: (
    patch: {
      title: string;
      emotion: string;
      placeName: string;
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

  const placeIn = el('input', 'edit-input') as HTMLInputElement;
  placeIn.type = 'text';
  placeIn.value = m.placeName;
  placeIn.maxLength = 80;
  placeIn.placeholder = '📍 장소 (선택)';
  placeIn.setAttribute('aria-label', '장소(선택)');

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
    placeIn,
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
    const patch: { title: string; emotion: string; placeName: string; note: string; occurredAt?: string } = {
      title: titleIn.value,
      emotion: picked,
      placeName: placeIn.value,
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

function stat(value: string, label: string): HTMLElement {
  const s = el('div', 'detail-stat');
  s.appendChild(el('b', undefined, value));
  s.appendChild(el('span', undefined, label));
  return s;
}

