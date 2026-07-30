// ui/photoViewer.ts — 전체보기 사진 뷰어(넘기기·확대/이동·회전·재편집).
//
// 왜 별도 파일인가: tripDetail의 renderTripDetail 안에 249줄짜리 클로저로 살고 있었다.
// 그 함수는 863줄이었고, 그 안에서는 **아무것도 유닛으로 검사할 수 없었다** — 포인터
// 제스처·확대 수식처럼 순수하게 검사 가능한 로직이 DOM 클로저에 갇혀 있었다(§10 ③).
// 뷰어가 바깥에서 필요로 하는 것은 `onChanged` 하나뿐이라 이음매가 깨끗했다.
//
// 규칙 정본: .claude/skills/photo-editor-dev/SKILL.md (편집기·뷰어 전용 규칙).
// 원본 불변(§0): 회전·재편집은 표시본만 갱신하고 originalBlob은 건드리지 않는다.

import { el } from './dom';
import { momentWhen, type TripClock } from '../domain/time';
import { openPhotoEditor } from './photoEditor';
import { rotateMediaLocalFirst, reeditMediaLocalFirst } from '../services/media';
import { requestSync } from '../services/autoSync';
import type { LocalMedia } from '../offline/db';

/** 화면에 있는 두 포인터 사이 거리 — 핀치 확대의 기준. */
type Pts = Map<number, { x: number; y: number }>;

/**
 * 🔴 **래칫이 밀어준 추출**(2026-07-30). `clock`을 받으며 이 함수가 한 줄 길어졌고
 * `check-fn-size`가 막았다. 주석을 줄이는 대신 **순수한 것을 밖으로 냈다** — 두 손가락
 * 계산은 DOM이 필요 없으므로 최상위에 있어야 하고, 그래야 유닛이 닿는다(게이트의 원래 목적).
 */
function pinchDist(pts: Pts): number {
  const [a, b] = [...pts.values()];
  return Math.hypot(a!.x - b!.x, a!.y - b!.y);
}

/** 두 포인터의 중점 — 확대의 중심(손가락 사이가 화면에 고정돼 보이게). */
function pinchMid(pts: Pts): { x: number; y: number } {
  const [a, b] = [...pts.values()];
  return { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
}

/**
 * 사진을 전체화면으로 연다.
 * @param onChanged 회전·재편집으로 사진이 바뀌면 호출(뒤 목록 썸네일 갱신).
 * @param clock 이 사진들이 속한 여행의 시계. 편집기 제목의 촬영시각을 **그 자리 기준**으로
 *   적는다 — 타임라인이 19:08이라 말한 사진을 열었더니 제목이 21:08이면 사용자는 다른
 *   사진을 열었다고 생각한다(같은 값을 두 자로 재는 것 = M-utc-slice의 형태).
 */
export function openPhotoViewer(
  list: LocalMedia[],
  startIndex: number,
  onChanged: () => Promise<void>,
  clock: TripClock,
): void {
  let idx = Math.max(0, Math.min(startIndex, list.length - 1));
  let current = list[idx]!;
  let currentUrl = URL.createObjectURL(current.displayBlob);
  const overlay = el('div', 'photo-viewer');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', '사진 보기');
  const img = el('img') as HTMLImageElement;
  img.src = currentUrl;
  img.alt = '여행 사진';
  img.draggable = false; // 스와이프가 브라우저 이미지 드래그로 새지 않게
  // 사진 자체를 탭했을 땐 닫지 않는다(확대해 보려다 실수로 닫히는 것 방지 — 배경 탭·✕·Esc로만 닫기).
  img.addEventListener('click', (e) => e.stopPropagation());
  const counter = el('span', 'photo-viewer-count', `${idx + 1} / ${list.length}`);
  counter.hidden = list.length <= 1;

  const close = () => {
    overlay.remove();
    URL.revokeObjectURL(currentUrl);
    document.removeEventListener('keydown', keys); // 어떤 경로로 닫혀도 리스너 잔류 없음
  };
  // ── 확대/이동(기기 최적화): 더블탭·핀치·휠로 확대, 끌어서 이동. scale=1이면 스와이프로 넘기기. ──
  const MAX_ZOOM = 5;
  let scale = 1;
  let tx = 0;
  let ty = 0;
  function applyTransform(animate = false): void {
    img.style.transition = animate ? 'transform .16s ease' : 'none';
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    img.classList.toggle('is-zoomed', scale > 1.01);
  }
  function clampPan(): void {
    // 확대된 이미지가 화면 밖으로 완전히 빠지지 않도록(약간의 여유 포함) 이동 범위를 제한.
    const mx = Math.max(0, (img.clientWidth * scale - window.innerWidth) / 2 + 24);
    const my = Math.max(0, (img.clientHeight * scale - window.innerHeight) / 2 + 24);
    tx = Math.max(-mx, Math.min(mx, tx));
    ty = Math.max(-my, Math.min(my, ty));
  }
  // 화면점(px,py)을 고정한 채 목표 배율로 확대/축소(휠·핀치·더블탭 공통).
  function zoomAround(px: number, py: number, target: number, animate = false): void {
    const vcx = window.innerWidth / 2;
    const vcy = window.innerHeight / 2;
    const lx = (px - vcx - tx) / scale;
    const ly = (py - vcy - ty) / scale;
    scale = Math.max(1, Math.min(MAX_ZOOM, target));
    tx = px - vcx - scale * lx;
    ty = py - vcy - scale * ly;
    if (scale <= 1.001) {
      scale = 1;
      tx = 0;
      ty = 0;
    }
    clampPan();
    applyTransform(animate);
  }
  function resetZoom(): void {
    scale = 1;
    tx = 0;
    ty = 0;
    applyTransform();
  }

  function show(next: number): void {
    idx = (next + list.length) % list.length; // 끝에서 처음으로 순환
    current = list[idx]!;
    const newUrl = URL.createObjectURL(current.displayBlob);
    img.src = newUrl;
    URL.revokeObjectURL(currentUrl);
    currentUrl = newUrl;
    counter.textContent = `${idx + 1} / ${list.length}`;
    resetZoom(); // 다음 사진은 항상 꽉 맞춤에서 시작
  }
  function keys(e: KeyboardEvent): void {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft' && list.length > 1) show(idx - 1);
    else if (e.key === 'ArrowRight' && list.length > 1) show(idx + 1);
    else if ((e.key === '0' || e.key === 'Escape') && scale > 1) resetZoom();
  }

  // 포인터: 1개 = 스와이프(확대 전) 또는 팬(확대 중), 2개 = 핀치 줌.
  const pts = new Map<number, { x: number; y: number }>();
  let pinchStart: { dist: number; scale: number } | null = null;
  let dragStart: { x: number; y: number; tx: number; ty: number; moved: boolean } | null = null;
  let lastTap = 0;
  let lastTapX = 0;
  let lastTapY = 0;
  img.addEventListener('pointerdown', (e) => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      img.setPointerCapture(e.pointerId);
    } catch {
      /* 합성/종료 포인터 캡처 불가 시에도 추적은 계속 */
    }
    if (pts.size === 2) {
      pinchStart = { dist: pinchDist(pts), scale };
      dragStart = null;
    } else {
      dragStart = { x: e.clientX, y: e.clientY, tx, ty, moved: false };
    }
  });
  img.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinchStart && pts.size === 2) {
      const m = pinchMid(pts);
      zoomAround(m.x, m.y, (pinchStart.scale * pinchDist(pts)) / pinchStart.dist);
      return;
    }
    if (dragStart && scale > 1) {
      // 확대 중 → 팬(이동)
      tx = dragStart.tx + (e.clientX - dragStart.x);
      ty = dragStart.ty + (e.clientY - dragStart.y);
      dragStart.moved = true;
      clampPan();
      applyTransform();
    }
  });
  function endPointer(e: PointerEvent): void {
    pts.delete(e.pointerId);
    if (pinchStart && pts.size < 2) pinchStart = null;
    if (pts.size > 0) return;
    // 마지막 포인터가 떨어짐: 더블탭 / 스와이프 판정(확대 전에만).
    const ds = dragStart;
    dragStart = null;
    if (!ds) return;
    const dx = e.clientX - ds.x;
    const dy = e.clientY - ds.y;
    const isTap = Math.abs(dx) < 12 && Math.abs(dy) < 12 && !ds.moved;
    if (isTap) {
      const now = e.timeStamp;
      if (now - lastTap < 320 && Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < 40) {
        // 더블탭: 확대 토글(탭 지점 기준)
        lastTap = 0;
        zoomAround(e.clientX, e.clientY, scale > 1 ? 1 : 2.5, true);
      } else {
        lastTap = now;
        lastTapX = e.clientX;
        lastTapY = e.clientY;
      }
      return;
    }
    // 확대 전 좌우 스와이프로 넘기기(세로 이동이 크면 무시).
    if (scale <= 1 && list.length > 1 && Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      show(dx < 0 ? idx + 1 : idx - 1);
    }
  }
  img.addEventListener('pointerup', endPointer);
  img.addEventListener('pointercancel', endPointer);
  // 데스크톱: 휠(또는 트랙패드 핀치=ctrl+wheel)로 커서 기준 확대.
  img.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAround(e.clientX, e.clientY, scale * Math.exp(-dy * 0.0018));
    },
    { passive: false },
  );

  // 회전 — 눕혀 보이는 사진을 90°(시계방향) 돌려 세운다. 원본 불변(§0), 표시본만 갱신·영구 저장.
  const rotateBtn = el('button', 'photo-viewer-rotate', '↻ 회전') as HTMLButtonElement;
  rotateBtn.type = 'button';
  rotateBtn.setAttribute('aria-label', '사진 90도 회전');
  rotateBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (rotateBtn.disabled) return;
    rotateBtn.disabled = true;
    void (async () => {
      try {
        const updated = await rotateMediaLocalFirst(current.id);
        list[idx] = updated; // 넘겨보기 목록에도 회전 반영
        current = updated;
        const newUrl = URL.createObjectURL(updated.displayBlob);
        img.src = newUrl;
        URL.revokeObjectURL(currentUrl);
        currentUrl = newUrl;
        await onChanged(); // 뒤 목록 썸네일도 세워진 방향으로 갱신
        // 회전은 표시본을 바꾼 '변경'이다 — 큐에 op만 넣고 끝내면 다음 자동 트리거까지
        // 다른 기기에 안 간다(M-0015 근본형). 추출 전에도 여기서 sync를 안 불렀고,
        // `check-verdict-symmetry`가 그 자리를 짚어 줬다.
        await requestSync('저장/변경');
      } catch {
        /* 회전 실패는 뷰어 유지 */
      } finally {
        rotateBtn.disabled = false;
      }
    })();
  });
  const closeBtn = el('button', 'photo-viewer-close', '✕') as HTMLButtonElement;
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', '닫기');
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    close();
  });

  // 재편집 — 저장된 사진을 편집기로 다시 연다. 원본에서 파생(비파괴), 이전 편집을 이어서 조정.
  const editPhotoBtn = el('button', 'photo-viewer-edit', '✎ 편집') as HTMLButtonElement;
  editPhotoBtn.type = 'button';
  editPhotoBtn.setAttribute('aria-label', '이 사진 편집');
  editPhotoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    editPhotoBtn.disabled = true;
    void (async () => {
      try {
        const r = await openPhotoEditor(
          current.originalBlob,
          momentWhen(current.takenAt, null, clock).time || '사진 편집',
          current.editState ? { initialState: current.editState } : {},
        );
        if (r.action === 'apply') {
          await reeditMediaLocalFirst(current.id, r.blob ?? current.originalBlob, r.state);
          await onChanged();
          await requestSync('저장/변경');
          close();
          return;
        }
      } catch {
        /* 편집 취소·실패는 뷰어 유지 */
      }
      editPhotoBtn.disabled = false;
    })();
  });

  overlay.append(img, counter, editPhotoBtn, rotateBtn, closeBtn);
  if (list.length > 1) {
    const prevBtn = el('button', 'photo-viewer-nav photo-viewer-prev', '‹') as HTMLButtonElement;
    prevBtn.type = 'button';
    prevBtn.setAttribute('aria-label', '이전 사진');
    prevBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      show(idx - 1);
    });
    const nextBtn = el('button', 'photo-viewer-nav photo-viewer-next', '›') as HTMLButtonElement;
    nextBtn.type = 'button';
    nextBtn.setAttribute('aria-label', '다음 사진');
    nextBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      show(idx + 1);
    });
    overlay.append(prevBtn, nextBtn);
  }
  overlay.addEventListener('click', close); // 배경 탭으로도 닫기
  document.addEventListener('keydown', keys);
  document.body.appendChild(overlay);
}
