// ui/dragReorder.ts — **꾹 눌러 끌어 순서 바꾸기** (사용자 지시 2026-08-06:
// *"손가락으로 꾹 눌러서 순서를 변경할 수 있도록 해주고"*).
//
// ── 왜 여기 한 곳인가 (§7 2층) ───────────────────────────────────────────────
// 순서를 바꾸고 싶은 목록은 앞으로 늘어난다(사진 · 순간 · 장소…). 화면마다 제 손으로
// 포인터 배선을 짜면 **길게 누르는 시간·흔들림 허용치·스크롤 잠금이 화면마다 달라지고**,
// 그 드리프트는 사용자가 실기기에서 먼저 느낀다. 그래서 배선은 여기 하나, 화면은 목록과
// 「옮겼다」 콜백만 준다.
//
// ── 왜 HTML5 드래그가 아닌가 ────────────────────────────────────────────────
// `dragstart`/`drop`은 **터치에서 안 돈다.** 이 앱은 여행 중 한 손으로 쓰는 앱이므로
// 포인터 이벤트가 유일한 답이다.
//
// ── 판정은 여기 없다 ────────────────────────────────────────────────────────
// 「지금 놓으면 몇 번째인가」(`dropIndex`)와 「옮긴 뒤 배열」(`moveItem`)은 **순수 함수**로
// `domain/media/order.ts`에 있다. 좌표 계산이 이벤트 핸들러 안에 있으면 갈래를 검사할 수
// 없고, 그게 이 저장소의 최빈 결함군이다(§10 ③).

import { dropIndex, type Rect } from '../domain/media/order';

/** 꾹 누르기로 인정할 시간(ms). 짧으면 스크롤이 드래그로 오인되고, 길면 「반응이 없다」가 된다. */
const HOLD_MS = 420;
/** 누르는 동안 이만큼 넘게 움직이면 **스크롤 의도**로 보고 길게 누르기를 취소한다(px). */
const SLOP_PX = 10;

export interface DragReorderOptions {
  /** 끌 수 있는 칸들의 부모. 이 안에서만 자리를 잰다. */
  container: HTMLElement;
  /** 칸 하나를 고르는 셀렉터(직계 자식). */
  itemSelector: string;
  /** 순서가 확정되면 호출 — 화면에 그린 순서 그대로의 index 배열을 준다. */
  onReorder: (from: number, to: number) => void;
  /** 드래그가 시작됐을 때(진동·안내 문구 등). 화면이 정하도록 열어 둔다. */
  onStart?: () => void;
}

/** 지금 컨테이너 안의 칸들과 그 사각형(뷰포트 기준) — 매 이동마다 다시 잰다(줄바꿈이 바뀐다). */
function measure(container: HTMLElement, sel: string): { els: HTMLElement[]; rects: Rect[] } {
  const els = Array.from(container.querySelectorAll<HTMLElement>(sel));
  return { els, rects: els.map((e) => e.getBoundingClientRect()) };
}

/**
 * 🔴 **플랫폼이 이 제스처를 가져가는 길을 전부 막는다** — 한 곳에 모아 둔다.
 *
 * 이 저장소는 여기서 **두 번** 넘어졌다(M-0115 · M-0116), 그리고 **막는 이벤트가 서로 달랐다**:
 *
 *  · `dragstart` — `<img>` 위에서 누르고 움직이면 크롬이 **네이티브 이미지 드래그**를 시작하며
 *    포인터를 가로채 `pointercancel`을 낸다. (마우스에서 났다)
 *  · 🔴 `touchmove`(**비수동**) — 크롬에서 **터치 스크롤을 막는 것은 이것뿐**이다.
 *    `pointermove`의 `preventDefault()`로는 **안 막힌다.** 그래서 마우스로는 되고
 *    **손가락으로는 안 되는** 상태가 배포됐다(사용자 실기기가 잡았다).
 *  · `contextmenu` — 안드로이드는 길게 누르면 메뉴를 띄운다.
 *
 * **하나 막았다고 다 막은 것이 아니다.** 새 제스처를 만들면 이 표를 먼저 훑는다.
 */
function blockPlatformClaims(container: HTMLElement, isDragging: () => boolean): () => void {
  const stopAlways = (e: Event): void => e.preventDefault();
  const stopWhileDragging = (e: Event): void => {
    if (isDragging()) e.preventDefault();
  };
  container.addEventListener('dragstart', stopAlways);
  window.addEventListener('touchmove', stopWhileDragging, { passive: false });
  window.addEventListener('contextmenu', stopWhileDragging);
  return () => {
    container.removeEventListener('dragstart', stopAlways);
    window.removeEventListener('touchmove', stopWhileDragging);
    window.removeEventListener('contextmenu', stopWhileDragging);
  };
}

/**
 * 컨테이너에 「꾹 눌러 끌기」를 붙인다. 붙인 것을 떼는 함수를 돌려준다(다시 그릴 때 호출).
 *
 * 흐름: `pointerdown` → 420ms 버팀 → 드래그 시작 → `pointermove`로 미리보기 → `pointerup` 확정.
 * 그 사이에 손가락이 10px 넘게 움직이면 **스크롤로 보고 취소**한다 — 목록을 넘기려던 사람을
 * 붙잡지 않는 것이 이 값의 목적이다.
 */
export function attachDragReorder(opts: DragReorderOptions): () => void {
  const { container, itemSelector, onReorder, onStart } = opts;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let startX = 0;
  let startY = 0;
  let fromIndex = -1;
  let dragging = false;
  let activeEl: HTMLElement | null = null;
  let lastTo = -1;

  const clearHold = (): void => {
    if (holdTimer !== null) clearTimeout(holdTimer);
    holdTimer = null;
  };

  /**
   * 드래그 중 **놓일 자리 표시** — 그 칸에 테두리를 준다.
   *
   * 🔴 처음엔 `style.order`로 칸을 실제로 밀어 미리보기를 했다가 **좌표가 어긋났다**:
   * `order`는 *화면 순서*를 바꾸는데 `measure()`가 주는 배열은 *DOM 순서*라, 한 번 밀고 나면
   * 「몇 번째 칸 위인가」와 「몇 번째로 옮기는가」가 서로 다른 것을 가리켰다. 같은 이름이 두
   * 가지를 뜻하는 그 형태다(M-0060) — 라이브 검사가 잡았다.
   *
   * 그래서 **끌 때는 아무것도 밀지 않는다.** 자리만 표시하고, 실제 배열은 손을 뗄 때
   * 한 번 바뀐다(취소해도 자료가 안 움직인다는 이점이 덤으로 따라온다).
   */
  const preview = (to: number): void => {
    if (to === lastTo) return;
    lastTo = to;
    const { els } = measure(container, itemSelector);
    els.forEach((e, i) => e.classList.toggle('drag-over', i === to && i !== fromIndex));
  };

  const clearPreview = (): void => {
    for (const e of measure(container, itemSelector).els) e.classList.remove('drag-over');
  };

  const stop = (): void => {
    clearHold();
    if (activeEl) {
      activeEl.classList.remove('drag-lift');
      activeEl = null;
    }
    container.classList.remove('drag-active');
    dragging = false;
    fromIndex = -1;
    lastTo = -1;
  };

  const onDown = (e: PointerEvent): void => {
    // 삭제(✕)처럼 자기 일이 있는 버튼 위에서는 시작하지 않는다 — 누르려던 것을 뺏지 않는다.
    if ((e.target as HTMLElement).closest('button')) return;
    const item = (e.target as HTMLElement).closest<HTMLElement>(itemSelector);
    if (!item || !container.contains(item)) return;
    const { els } = measure(container, itemSelector);
    fromIndex = els.indexOf(item);
    if (fromIndex < 0) return;
    startX = e.clientX;
    startY = e.clientY;
    activeEl = item;
    holdTimer = setTimeout(() => {
      dragging = true;
      lastTo = fromIndex;
      item.classList.add('drag-lift');
      container.classList.add('drag-active');
      onStart?.();
    }, HOLD_MS);
  };

  const onMove = (e: PointerEvent): void => {
    if (!dragging) {
      // 아직 버티는 중 — 많이 움직였으면 **스크롤 의도**다.
      if (holdTimer !== null && Math.hypot(e.clientX - startX, e.clientY - startY) > SLOP_PX) clearHold();
      return;
    }
    const { rects } = measure(container, itemSelector);
    preview(dropIndex(rects, e.clientX, e.clientY, fromIndex));
  };


  const onUp = (): void => {
    if (dragging && lastTo >= 0 && lastTo !== fromIndex) {
      const from = fromIndex;
      const to = lastTo;
      clearPreview(); // 화면은 호출자가 다시 그린다 — 표시가 남지 않게 먼저 지운다
      stop();
      onReorder(from, to);
      return;
    }
    clearPreview();
    stop();
  };

  const offClaims = blockPlatformClaims(container, () => dragging);
  container.addEventListener('pointerdown', onDown);
  // 손가락이 컨테이너 밖으로 나가도 따라가야 하므로 창에 건다.
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);

  return () => {
    clearHold();
    offClaims();
    container.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  };
}
