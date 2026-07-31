// ui/toast.ts — 공용 실행취소 토스트(§5 복구가능성). 화면 전환에도 살아남도록
// document.body에 부착한다(삭제 후 홈으로 이동해도 되살리기 버튼이 유지됨).
// 한 번에 하나만 띄운다. 5초 후 자동 사라짐.

import { el } from './dom';

let activeTimer: ReturnType<typeof setTimeout> | null = null;

/** 삭제 등 되돌릴 수 있는 작업 뒤에 호출. onUndo는 한 번만 실행된다. */
export function showUndoToast(message: string, onUndo: () => void | Promise<void>): void {
  document.querySelector('.undo-toast')?.remove();
  if (activeTimer) {
    clearTimeout(activeTimer);
    activeTimer = null;
  }

  const toast = el('div', 'undo-toast');
  toast.setAttribute('role', 'status');
  toast.appendChild(el('span', 'undo-msg', message));

  const btn = el('button', 'undo-btn', '실행취소') as HTMLButtonElement;
  btn.type = 'button';
  let used = false;
  const close = (): void => {
    if (activeTimer) {
      clearTimeout(activeTimer);
      activeTimer = null;
    }
    toast.remove();
  };
  btn.addEventListener('click', () => {
    if (used) return;
    used = true;
    close();
    void onUndo();
  });

  toast.appendChild(btn);
  document.body.appendChild(toast);
  activeTimer = setTimeout(close, 5000);
}

/**
 * 되돌릴 것이 없는 **알림 토스트**. 실행취소 버튼 없이 문장만 5초.
 *
 * 왜 필요했나(2026-07-31): 「사진에 위치 정보가 없어요」처럼 **앱이 아무것도 안 했다는
 * 사실**을 말해야 하는 자리가 생겼다. 아무것도 안 했으니 되돌릴 것도 없는데, 그렇다고
 * 침묵하면 사용자는 **고장인지 없는 건지 구분할 수 없다**(§12 — 앱이 아는 것을 말한다).
 *
 * 진행 줄로는 안 된다: 사진 추가는 곧바로 재렌더하므로 그 줄이 그 자리에서 사라진다.
 * 토스트는 `document.body`에 붙어 살아남는다 — `showUndoToast`와 **같은 자리, 같은 규칙**
 * (한 번에 하나만·5초). 그래서 구현을 나누지 않고 여기 함께 둔다(§7 2층).
 */
export function showNoticeToast(message: string): void {
  document.querySelector('.undo-toast')?.remove();
  if (activeTimer) {
    clearTimeout(activeTimer);
    activeTimer = null;
  }
  const toast = el('div', 'undo-toast');
  toast.setAttribute('role', 'status');
  toast.appendChild(el('span', 'undo-msg', message));
  document.body.appendChild(toast);
  activeTimer = setTimeout(() => toast.remove(), 5000);
}
