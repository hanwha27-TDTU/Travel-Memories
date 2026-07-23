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
