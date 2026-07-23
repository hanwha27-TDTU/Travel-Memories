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
