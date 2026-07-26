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

/**
 * 상태 줄을 **누를 수 있게** 만드는 목적지.
 *
 * 왜(사용자 제안 2026-07-26): 첫 화면의 「동기화 대기 13건」이 *말만 하고 갈 곳을 주지 않았다.*
 * 사용자는 [데이터 관리] → [진단 도구] → [동기화 상태]를 스스로 찾아 들어가야 했다.
 * 진단 §7-B와 같은 자리다 — **판정만 하고 행동을 못 주면 관측으로 되돌아간 것이다.**
 */
export interface NoteAction {
  /** 눌렀을 때 갈 곳. */
  go: () => void;
  /** 화면읽기 라벨 — 화면에는 '›'만 보이므로 여기서 무엇을 하는 버튼인지 말한다. */
  label: string;
}

/**
 * 상태 줄을 갱신한다.
 *
 * `go`는 **선택이 아니라 필수**다(`null`을 명시해야 한다). 왜: 갈 곳이 있는데 안 준 상태가
 * 이 저장소의 최빈 결함군이고(§7), 선택적 매개변수는 **누락을 조용히 삼킨다** — M-0007이
 * 정확히 그 형태였다. `null`을 적게 만들면 "여긴 갈 곳이 없다"가 **결정**이 되고, 옆에 이유를
 * 적게 된다.
 */
export function setNote(node: HTMLElement, text: string, state: NoteState, go: NoteAction | null): void {
  applyText(node, text);
  node.classList.toggle('is-ok', state === 'ok');
  node.classList.toggle('is-info', state === 'info');
  node.classList.toggle('is-error', state === 'error');
  node.hidden = text === '';

  // 재렌더마다 이전 배선이 남지 않게 **속성 대입**으로 갈아 끼운다(addEventListener는 쌓인다).
  node.onclick = null;
  node.classList.toggle('is-actionable', go !== null);
  if (!go) return;

  // **역할을 바꾸지 않는다.** 이 줄은 `role="status"` 라이브 영역이라 글이 바뀌면 화면읽기가
  // 읽어 준다 — 여기에 `role="button"`을 덮으면 그 알림이 사라진다(실제로 한 번 그렇게 짰다가
  // 라이브 검사에서 잡혔다). 대신 **진짜 `<button>`을 안에 넣는다**: 키보드·화면읽기는 그
  // 버튼이 책임지고, 손가락·마우스는 알약 전체를 눌러도 되게 클릭을 위로 받는다(버튼의 활성화는
  // 어차피 이 노드로 버블링되므로 핸들러는 **한 곳**이면 된다 — 두 번 실행되지 않는다).
  const btn = el('button', 'sync-note-go', '›');
  btn.type = 'button';
  btn.setAttribute('aria-label', go.label);
  node.appendChild(btn);
  node.onclick = () => go.go();
}
