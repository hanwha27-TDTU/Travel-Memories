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
  const overlay = el('div', 'guide-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '기계화 검증 흐름도');
  const modal = el('div', 'guide-modal');

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
    el('span', 'muted small', 'Required 게이트 — npm run harness가 전부 돌립니다. 목록은 자동 집계.'),
  );
  body.appendChild(summary);

  // ── 카테고리별 게이트(목록은 REGISTRY에서 파생) ──
  const cats: GateCategory[] = ['static', 'generated', 'unit'];
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

  // ── 라이브 렌더(별도) ──
  const live = el('div', 'mc-cat');
  const lh = el('div', 'mc-cat-head');
  lh.append(el('b', undefined, '라이브 렌더 (실제 브라우저)'), el('span', 'mc-cat-count', '선택'));
  live.appendChild(lh);
  const lgrid = el('div', 'mc-grid');
  const lg = el('div', 'mc-gate');
  lg.append(
    el('b', 'mc-gate-name', 'verify-editor-live'),
    el('span', 'muted small', '편집기·뷰어·설계 개요도를 실제 Chromium으로 열어 픽셀·상태 변화를 read-back으로 확인.'),
  );
  lgrid.appendChild(lg);
  live.appendChild(lgrid);
  body.appendChild(live);

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
