// ui/toast.ts — 공용 실행취소 토스트(§5 복구가능성). 화면 전환에도 살아남도록
// document.body에 부착한다(삭제 후 홈으로 이동해도 되살리기 버튼이 유지됨).
// 한 번에 하나만 띄운다. 머무는 시간은 문장 길이를 따라간다(`readMs` — 짧은 말은 5초).

import { el } from './dom';

let activeTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 🔴 **읽을 시간을 준다** — 머무는 시간이 문장 길이를 따라간다(2026-07-31 · M-0055).
 *
 * 5초는 「여행을 지웠어요」(8자) 시절의 값이었다. v1.31이 **70자가 넘는 안내 문장**을 같은
 * 그릇에 담으면서, 사용자는 다 읽기도 전에 사라지는 문장을 보게 됐다 — 그 문장의 뒷부분이
 * 하필 *"그래서 어떻게 하면 되는지"*였다(§12: 말하고 끝내지 않는다).
 *
 * 두 토스트가 **같은 규칙**을 쓴다(§7 2층). 손으로 5초·9초를 따로 정하면 한쪽이 낡는다.
 * 짧은 말은 지금까지와 똑같이 5초다(하한).
 */
function readMs(message: string): number {
  return Math.min(12000, Math.max(5000, 2500 + message.length * 90));
}

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
  activeTimer = setTimeout(close, readMs(message));
}

/**
 * 되돌릴 것이 없는 **알림 토스트**. 실행취소 버튼 없이 문장만 띄운다(머무는 시간은 `readMs`).
 *
 * 왜 필요했나(2026-07-31): 「사진에 위치 정보가 없어요」처럼 **앱이 아무것도 안 했다는
 * 사실**을 말해야 하는 자리가 생겼다. 아무것도 안 했으니 되돌릴 것도 없는데, 그렇다고
 * 침묵하면 사용자는 **고장인지 없는 건지 구분할 수 없다**(§12 — 앱이 아는 것을 말한다).
 *
 * 진행 줄로는 안 된다: 사진 추가는 곧바로 재렌더하므로 그 줄이 그 자리에서 사라진다.
 * 토스트는 `document.body`에 붙어 살아남는다 — `showUndoToast`와 **같은 자리, 같은 규칙**
 * (한 번에 하나만 · 길이에 따른 체류시간 `readMs`). 그래서 구현을 나누지 않고 여기 함께 둔다(§7 2층).
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
  activeTimer = setTimeout(() => toast.remove(), readMs(message));
}
