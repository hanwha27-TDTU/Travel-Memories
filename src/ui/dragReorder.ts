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

import { dropIndex, shiftOffsets, type Rect } from '../domain/media/order';

/** 꾹 누르기로 인정할 시간(ms). 짧으면 스크롤이 드래그로 오인되고, 길면 「반응이 없다」가 된다. */
const HOLD_MS = 420;
/** 누르는 동안 이만큼 넘게 움직이면 **스크롤 의도**로 보고 길게 누르기를 취소한다(px). */
const SLOP_PX = 10;
/**
 * 들린 칸을 살짝 키운다 — 「이건 지금 내 손에 들려 있다」를 한눈에.
 *
 * 🔴 CSS가 아니라 여기서 정하는 이유: 들린 칸의 `transform`은 **손가락 위치**를 담아야 하고,
 * 인라인 `transform`은 클래스의 것을 통째로 덮는다. 두 곳에서 같은 속성을 쓰면 하나가 조용히
 * 사라진다 — 그래서 **한 곳(여기)에서 합쳐서** 쓴다.
 */
const LIFT_SCALE = 1.06;

/** 움직임을 줄여 달라고 한 사용자인가 — 「비켜서기」는 남기되 **장식(확대)은 끈다**. */
function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
}

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

/**
 * 지금 컨테이너 안의 칸들과 그 사각형(뷰포트 기준).
 *
 * 🔴 **드래그가 시작될 때 한 번만 부른다.** 예전 주석은 *"매 이동마다 다시 잰다"*였는데
 * 그 전제는 칸을 밀지 않던 시절의 것이다 — 지금은 `transform`으로 밀므로 다시 재면
 * **밀린 자리**가 나와 판정이 자기 출력을 먹는다(화석 주석을 그대로 두면 다음 사람이
 * 그 말을 믿는다 — M-0006).
 */
function measure(container: HTMLElement, sel: string): DragBase {
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
 * 🔴 드래그가 시작될 때 **한 번** 잰 자리. 이 묶음이 드래그 내내 **유일한 좌표계**다.
 *
 * 다시 재면 안 되는 이유: 아래에서 칸들을 `transform`으로 미는데, `getBoundingClientRect`는
 * **밀린 뒤의** 자리를 준다. 그걸 다시 판정에 넣으면 자기 출력이 자기 입력이 되어(피드백)
 * 칸이 떨리고, 「몇 번째 칸 위인가」가 매 프레임 달라진다 — 같은 이름이 두 좌표계를 뜻하는
 * 순간 결함이 된다(M-0115의 곁가지가 정확히 그 형태였다).
 */
interface DragBase {
  els: HTMLElement[];
  rects: Rect[];
}

/**
 * 드래그 중 **다른 칸들이 비켜선다** — 사용자 요청 2026-08-06(*"이동하는 느낌이 나게"*).
 *
 * 🔴 예전엔 `style.order`로 밀었다가 **좌표계가 갈라졌다**: `order`는 *화면 순서*를 바꾸는데
 * 그때 다시 잰 배열은 *DOM 순서*라, 한 번 밀고 나면 「몇 번째 칸 위인가」와 「몇 번째로
 * 옮기는가」가 서로 다른 것을 가리켰다(M-0060형). 그래서 이번엔 **DOM을 건드리지 않고**
 * `transform`으로만 민다 — 자식의 순서도, 각 칸의 **원래 자리(`base.rects`)**도 그대로다.
 * 판정은 끝까지 그 원래 자리로만 한다.
 *
 * 실제 배열은 여전히 **손을 뗄 때 한 번** 바뀐다(취소하면 자료가 안 움직인다).
 *
 * 들린 칸(`from`)은 여기서 건드리지 않는다 — 그건 손가락이 정한다.
 */
function applyShift(base: DragBase, from: number, to: number): void {
  const offs = shiftOffsets(base.rects, from, to);
  base.els.forEach((e, i) => {
    if (i === from) return;
    const o = offs[i];
    e.style.transform = o && (o.dx !== 0 || o.dy !== 0) ? `translate(${o.dx}px, ${o.dy}px)` : '';
  });
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
  let liftScale = 1;
  let base: DragBase | null = null; // 계약은 `DragBase`의 머리말에 있다 — 다시 재지 않는다
  /** 잰 순간의 컨테이너 자리 — 끄는 중에 화면이 스크롤돼도 같은 좌표계로 되돌리기 위해. */
  let originX = 0;
  let originY = 0;

  const clearHold = (): void => {
    if (holdTimer !== null) clearTimeout(holdTimer);
    holdTimer = null;
  };

  /** 놓일 자리가 바뀌었을 때만 다시 민다 — 매 프레임 쓰면 전환이 계속 처음부터 시작한다. */
  const preview = (to: number): void => {
    if (to === lastTo || !base) return;
    lastTo = to;
    applyShift(base, fromIndex, to);
  };

  /** 밀어 둔 것을 전부 원위치 — 취소·확정 어느 쪽으로 끝나도 인라인 스타일을 남기지 않는다. */
  const clearPreview = (): void => {
    for (const e of base?.els ?? measure(container, itemSelector).els) e.style.transform = '';
  };

  const stop = (): void => {
    clearHold();
    if (activeEl) {
      activeEl.classList.remove('drag-lift');
      activeEl.style.transform = '';
      activeEl = null;
    }
    container.classList.remove('drag-active');
    dragging = false;
    fromIndex = -1;
    lastTo = -1;
    base = null;
  };

  const onDown = (e: PointerEvent): void => {
    // 삭제(✕)처럼 자기 일이 있는 버튼 위에서는 시작하지 않는다 — 누르려던 것을 뺏지 않는다.
    if ((e.target as HTMLElement).closest('button')) return;
    const item = (e.target as HTMLElement).closest<HTMLElement>(itemSelector);
    if (!item || !container.contains(item)) return;
    if (measure(container, itemSelector).els.indexOf(item) < 0) return;
    startX = e.clientX;
    startY = e.clientY;
    activeEl = item;
    holdTimer = setTimeout(() => {
      // 🔴 좌표계는 **여기서 한 번** 굳는다 — 버티는 동안 화면이 바뀌었을 수도 있으므로
      // `pointerdown` 때가 아니라 실제로 들리는 이 순간에 잰다.
      base = measure(container, itemSelector);
      fromIndex = base.els.indexOf(item);
      if (fromIndex < 0) return; // 버티는 사이에 다시 그려졌다 — 조용히 없던 일로
      const r = container.getBoundingClientRect();
      originX = r.left;
      originY = r.top;
      liftScale = prefersReducedMotion() ? 1 : LIFT_SCALE;
      dragging = true;
      lastTo = fromIndex;
      item.classList.add('drag-lift');
      container.classList.add('drag-active');
      onStart?.();
    }, HOLD_MS);
  };

  const onMove = (e: PointerEvent): void => {
    if (!dragging || !base) {
      // 아직 버티는 중 — 많이 움직였으면 **스크롤 의도**다.
      if (holdTimer !== null && Math.hypot(e.clientX - startX, e.clientY - startY) > SLOP_PX) clearHold();
      return;
    }
    // 잰 좌표계로 되돌린다 — 끄는 도중 화면이 스크롤돼도 판정이 어긋나지 않게.
    const cr = container.getBoundingClientRect();
    const p = { x: e.clientX - (cr.left - originX), y: e.clientY - (cr.top - originY) };
    // 들린 칸은 **손가락을 그대로 따라간다.** 여기에 전환(transition)을 두면 손끝에서 뒤처진다.
    if (activeEl) activeEl.style.transform = `translate(${p.x - startX}px, ${p.y - startY}px) scale(${liftScale})`;
    preview(dropIndex(base.rects, p.x, p.y, fromIndex));
  };


  const onUp = (): void => {
    if (dragging && lastTo >= 0 && lastTo !== fromIndex) {
      const from = fromIndex;
      const to = lastTo;
      clearPreview(); // 화면은 호출자가 다시 그린다 — 밀어 둔 것이 남지 않게 먼저 지운다
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
