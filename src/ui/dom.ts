// ui/dom.ts — 공용 DOM 생성 헬퍼. 자유 텍스트는 textContent만 사용(innerHTML 금지).

/**
 * `**강조**` 를 `<strong>` 으로 바꿔 넣는다. **innerHTML을 쓰지 않는다** — 조각을 잘라
 * textContent로만 채우므로 사용자 입력이 섞여도 마크업이 될 수 없다.
 *
 * 왜 el() 안에 있는가(실제 결함 M-0012, 2026-07-26 사용자 화면에서 발견):
 * 화면 문자열 곳곳에 `**…**` 가 쓰여 있었는데 렌더가 textContent라 **별표가 그대로 찍혔다**.
 * 하필 "영구삭제는 되돌릴 수 없어요. **이 기기의 저장공간**을 비우는 것이며…" 처럼 무거운
 * 문구들이었다.
 *
 * 처음엔 문자열에서 별표를 지우고 "쓰지 마라"는 게이트를 붙였는데, 그 게이트의 대상 파일을
 * **손으로 6개 골랐다.** 그래서 dataManager·r2Setup·changelog가 통째로 빠졌고, 심지어 그
 * 게이트를 만든 릴리스의 변경 노트에 새 `**` 를 넣었다. CLAUDE.md §7이 "형제 목록을 손으로
 * 세지 말고 등록부·디렉터리에서 뽑으라"고 적힌 그대로의 위반이다.
 *
 * 그래서 규칙을 문자열 쪽이 아니라 **렌더러 쪽**에 둔다. 여기 한 곳이 처리하면 누가 어디에
 * 무슨 문자열을 쓰든 자동으로 따라온다 — 다음 사람이 이 규칙을 몰라도 지켜진다(§7 2층).
 */
export interface TextRun {
  text: string;
  bold: boolean;
}

/**
 * 문자열을 강조 조각으로 자른다 — **순수 함수**(DOM 없음).
 *
 * 왜 분리했나: 유닛 검사 환경에 DOM이 없어서(jsdom 미설치) 렌더 함수를 직접 못 돌린다.
 * 규칙 자체를 순수 함수로 빼면 **모든 경계를 유닛이 실제로 실행**할 수 있고, 진짜 `<strong>`이
 * 그려지는지는 라이브 렌더가 본다. 두 층이 각자 볼 수 있는 것을 본다(CLAUDE.md §3).
 *
 * 규칙: 짝이 맞는 `**…**` 만 강조. 홀수로 남은 `**` 는 **먹지 않고 평문으로 되돌린다** —
 * 사용자가 쓴 글자를 조용히 삼키지 않는다.
 */
export function parseEmphasis(text: string): TextRun[] {
  if (!text.includes('**')) return text ? [{ text, bold: false }] : [];
  const parts = text.split('**');
  const runs: TextRun[] = [];
  const push = (t: string, bold: boolean): void => {
    if (!t) return;
    const last = runs[runs.length - 1];
    if (last && last.bold === bold) last.text += t;
    else runs.push({ text: t, bold });
  };
  for (let i = 0; i < parts.length; i++) {
    const chunk = parts[i] as string;
    const closed = i % 2 === 1 && i < parts.length - 1;
    if (closed) push(chunk, true);
    else push(i % 2 === 1 ? `**${chunk}` : chunk, false);
  }
  return runs;
}

export function applyText(node: HTMLElement, text: string): void {
  const runs = parseEmphasis(text);
  if (runs.length <= 1 && !runs.some((r) => r.bold)) {
    node.textContent = text;
    return;
  }
  node.replaceChildren();
  for (const r of runs) {
    if (r.bold) {
      const b = document.createElement('strong');
      b.textContent = r.text;
      node.appendChild(b);
    } else {
      node.appendChild(document.createTextNode(r.text));
    }
  }
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) applyText(node, text);
  return node;
}

/**
 * 상태 줄(.sync-note)의 시각 위계 — 평소엔 조용히, 문제일 땐 눈에 띄게.
 *  ok    = 정상(동기화됨·저장됨). 배경 없이 작고 옅게 — 화면을 거의 안 쓴다.
 *  info  = 알아둘 것(대기 N건·로컬 모드·로그인 안내). 옅은 색 알약.
 *  error = 실패. 눈에 띄는 색 — 놓치면 안 되는 것만 여기 온다.
 * 두 화면(home·tripDetail)이 같은 규칙을 쓰도록 여기 한 곳에 둔다(§7 — 규칙을 두 번 쓰지 않는다).
 */
export type NoteState = 'ok' | 'info' | 'error';

export function setNote(node: HTMLElement, text: string, state: NoteState): void {
  applyText(node, text);
  node.classList.toggle('is-ok', state === 'ok');
  node.classList.toggle('is-info', state === 'info');
  node.classList.toggle('is-error', state === 'error');
  node.hidden = text === '';
}
