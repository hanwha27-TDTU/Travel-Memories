// ui/dom.ts — 공용 DOM 생성 헬퍼. 자유 텍스트는 textContent만 사용(innerHTML 금지).

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * 상태 줄(.sync-note)의 시각 위계 — **평소엔 조용히, 문제일 땐 눈에 띄게**.
 *  ok    = 정상(동기화됨·저장됨). 배경 없이 작고 옅게 — 화면을 거의 안 쓴다.
 *  info  = 알아둘 것(대기 N건·로컬 모드·로그인 안내). 옅은 색 알약.
 *  error = 실패. 눈에 띄는 색 — 놓치면 안 되는 것만 여기 온다.
 * 두 화면(home·tripDetail)이 같은 규칙을 쓰도록 여기 한 곳에 둔다(§7 — 규칙을 두 번 쓰지 않는다).
 */
export type NoteState = 'ok' | 'info' | 'error';

export function setNote(node: HTMLElement, text: string, state: NoteState): void {
  node.textContent = text;
  node.classList.toggle('is-ok', state === 'ok');
  node.classList.toggle('is-info', state === 'info');
  node.classList.toggle('is-error', state === 'error');
  node.hidden = text === '';
}
