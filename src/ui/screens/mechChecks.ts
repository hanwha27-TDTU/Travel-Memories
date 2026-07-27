// ui/screens/mechChecks.ts — '기계화 검증 흐름도' 모달. 잘못된 변경이 자동으로 막히는 과정을 보여준다.
//
// 정직성(§4·§7): 게이트 목록·개수는 손으로 세지 않고 registry.gen.ts(자동 집계)에서 읽는다.
// 설명·카테고리는 app/gates.ts 공유. 새 게이트를 harness에 추가하면 여기 자동 반영·개수 갱신.

import { el } from '../dom';
import { REGISTRY } from '../../app/registry.gen';
import { GATE_DESC, CATEGORY_LABEL, categoryOf, type GateCategory } from '../../app/gates';

const FLOW: [string, string][] = [
  ['① 원본(SSOT) 목록을 고침', 'harness.mjs · .claude/agents/ · db.ts · 화면 등 진실원 하나만 고칩니다.'],
  ['② 자동 생성 — 파생물 다시 만듦', 'registry.gen.ts(카운트·목록) · 설계 개요도가 원본에서 자동으로 다시 그려집니다.'],
  ['③ 자동 검사 — 게이트 전체', '아래 게이트가 원본↔파생↔현실을 대조합니다. 하나라도 어긋나면 RED.'],
  ['④ 반영 → 배포', '게이트가 다 통과해야(그리고 라이브 렌더까지) 병합·배포됩니다.'],
];

export function openMechChecks(): void {
  const prevFocus = document.activeElement as HTMLElement | null;
  const overlay = el('div', 'overlay-base guide-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '기계화 검증 흐름도');
  const modal = el('div', 'modal-base guide-modal');

  const header = el('div', 'guide-header');
  const tw = el('div', 'guide-title-wrap');
  tw.append(
    el('h2', 'guide-title', '🛡️ 기계화 검증 흐름도 — 잘못된 변경은 자동으로 막힙니다'),
    el('p', 'guide-sub', '게이트 목록·개수는 손으로 세지 않고 실제 harness에서 자동 집계합니다(registry.gen.ts).'),
  );
  const closeBtn = el('button', 'guide-close', '✕') as HTMLButtonElement;
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', '닫기');
  header.append(tw, closeBtn);
  const body = el('div', 'guide-body');
  modal.append(header, body);
  overlay.appendChild(modal);

  body.appendChild(
    el(
      'p',
      'guide-note',
      '이 앱은 코드를 바꿀 때 사람이 "조심하자"고 다짐하는 대신, 자동 검사가 전부 통과해야만 반영·배포됩니다. 하나라도 걸리면 자동으로 막혀 실수가 새어나가지 않아요.',
    ),
  );

  // ── 4단계 흐름 ──
  const flow = el('div', 'mc-flow');
  FLOW.forEach(([t, d], i) => {
    const step = el('div', 'mc-step');
    step.append(el('span', 'mc-step-n', String(i + 1)));
    const w = el('div');
    w.append(el('b', undefined, t), el('span', 'muted small', d));
    step.appendChild(w);
    flow.appendChild(step);
  });
  body.appendChild(flow);

  // ── 게이트 요약 배지 ──
  const summary = el('div', 'mc-summary');
  summary.append(
    el('span', 'mc-badge', `자동 검사 ${REGISTRY.gateCount}가지`),
    el(
      'span',
      'muted small',
      // 「전부 돌립니다」는 이제 정확하지 않다 — 라이브 층은 브라우저가 있어야 돈다.
      // 못 돌면 harness가 **통과가 아니라 「건너뜀」**으로 적는다. 그 사실을 여기서도 말한다(§8).
      'npm run harness가 한 번에 돌립니다. 라이브 층만 브라우저가 필요하고, 없으면 통과가 아니라 「건너뜀」으로 적힙니다. 목록·분류는 자동 집계.',
    ),
  );
  body.appendChild(summary);

  // ── 카테고리별 게이트(목록도 **분류도** 파생) ──
  //
  // 2026-07-27: 여기 `['static','generated','unit']`이 손으로 박혀 있었고, 라이브 렌더만
  // 아래에 카드를 **따로 손으로** 그리고 있었다(설명 문장까지 GATE_DESC와 중복). 라이브
  // 게이트를 등록부에 넣자 그 손편집이 곧바로 어긋났다 — 카드 수가 게이트 수와 안 맞았다.
  // 근본형은 §7 그대로다: **다음 형제(새 분류)가 자동으로 따라오지 않는 구조.**
  // 이제 분류 목록을 `CATEGORY_LABEL`에서 뽑으므로, `GateCategory`에 값을 하나 더하면
  // 타입이 라벨을 요구하고 화면이 그 즉시 따라온다. 손으로 추가할 자리가 없다.
  const cats = Object.keys(CATEGORY_LABEL) as GateCategory[];
  for (const cat of cats) {
    const gates = REGISTRY.gates.filter((g) => categoryOf(g) === cat);
    if (gates.length === 0) continue;
    const sec = el('div', 'mc-cat');
    const head = el('div', 'mc-cat-head');
    head.append(el('b', undefined, CATEGORY_LABEL[cat]), el('span', 'mc-cat-count', `${gates.length}개`));
    sec.appendChild(head);
    const grid = el('div', 'mc-grid');
    for (const g of gates) {
      const c = el('div', 'mc-gate');
      c.append(el('b', 'mc-gate-name', g), el('span', 'muted small', GATE_DESC[g] ?? '(설명 미등록)'));
      grid.appendChild(c);
    }
    sec.appendChild(grid);
    body.appendChild(sec);
  }

  body.appendChild(
    el(
      'p',
      'guide-note',
      '이 목록은 손으로 그린 게 아니라 scripts/harness.mjs에서 자동으로 읽습니다 — 새 게이트를 추가하면 여기 자동 반영되고, 카운트가 실제와 다르면 check-registry-gen이 빌드를 막습니다. 정직한 경계: 색·미세정렬·실기기 느낌은 사람 눈으로 확인합니다.',
    ),
  );

  const close = (): void => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (prevFocus && document.contains(prevFocus)) prevFocus.focus();
  };
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') close();
  }
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  closeBtn.focus();
}
