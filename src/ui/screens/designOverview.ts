// ui/screens/designOverview.ts — '설계 개요도' 모달(배선맵). 데이터가 화면까지 닿는 큰 그림.
//
// 정직성(§4·LESSONS §3·§7): 손으로 그리지 않는다. app/blueprint.ts(SSOT)와 Dexie 실카운트에서
// 자동으로 그리고, check-blueprint 게이트가 선언↔현실을 대조한다. 모든 텍스트는 textContent(CSP).

import { el } from '../dom';
import { SOURCES, SHAPING, STORAGE, SCREENS, selfCheck, liveCounts } from '../../app/blueprint';

/** '설계 개요도' 모달을 연다. 현재 화면 유지하고 위에 오버레이. */
export function openDesignOverview(): void {
  const prevFocus = document.activeElement as HTMLElement | null;

  const overlay = el('div', 'overlay-base guide-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '설계 개요도');
  const modal = el('div', 'modal-base guide-modal');

  const header = el('div', 'guide-header');
  const titleWrap = el('div', 'guide-title-wrap');
  titleWrap.append(
    el('h2', 'guide-title', '🗺️ 설계 개요도 — 데이터가 화면까지 닿는 큰 그림'),
    el('p', 'guide-sub', '손으로 그린 게 아니라, 앱이 실제 목록에서 그때그때 읽어 자동으로 그립니다.'),
  );
  const closeBtn = el('button', 'guide-close', '✕') as HTMLButtonElement;
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', '닫기');
  header.append(titleWrap, closeBtn);

  const body = el('div', 'guide-body');
  modal.append(header, body);
  overlay.appendChild(modal);

  body.appendChild(
    el(
      'p',
      'guide-note',
      '이 앱이 어떻게 도는지 전기 흐름으로 봅니다 — 데이터가 ① 태어나고 → ② 모양을 다듬고 → ③ 안전하게 보관·동기화되어 → ④ 여러분이 보는 모든 화면에 나타납니다(발전소 → 배선 → 콘센트에 비유). 데이터가 있기만 하면 0점, 실제로 화면까지 닿아야 100점.',
    ),
  );

  // ── 자가 점검 카드 ──
  const chk = selfCheck();
  const scoreCard = el('div', 'bp-score');
  const scoreTop = el('div', 'bp-score-top');
  scoreTop.append(
    el('span', 'bp-score-badge', String(chk.score)),
    (() => {
      const w = el('div', 'bp-score-text');
      w.append(
        el('b', undefined, `자동 자가 점검 ${chk.got}/${chk.total} (${chk.score}점)`),
        el('span', 'muted small', '앱이 실제 구조를 직접 세어 매긴 점수 — 끊긴 배선이 있으면 감점'),
      );
      return w;
    })(),
  );
  scoreCard.appendChild(scoreTop);
  const bar = el('div', 'bp-bar');
  const fill = el('div', 'bp-bar-fill');
  fill.style.width = `${chk.score}%`;
  bar.appendChild(fill);
  scoreCard.appendChild(bar);
  const groupRow = el('div', 'bp-score-groups');
  for (const g of chk.groups) {
    const gEl = el('span', 'bp-score-group');
    gEl.append(el('span', 'bp-sg-k', g.label), el('b', 'bp-sg-v', `${g.got}/${g.total}`));
    groupRow.appendChild(gEl);
  }
  scoreCard.appendChild(groupRow);
  if (chk.gaps.length > 0) {
    const gapBox = el('div', 'bp-gaps');
    gapBox.appendChild(el('b', 'bp-gaps-title', `끊긴 배선 ${chk.gaps.length}건`));
    const ul = el('ul');
    for (const g of chk.gaps) ul.appendChild(el('li', undefined, g));
    gapBox.appendChild(ul);
    scoreCard.appendChild(gapBox);
  } else {
    scoreCard.appendChild(el('p', 'bp-ok', '✅ 실장된 데이터가 모두 왕복·동기화·화면까지 배선됨(끊긴 배선 없음).'));
  }
  if (chk.roadmap.length > 0) {
    scoreCard.appendChild(
      el('p', 'guide-note', `🧭 로드맵(아직 저장 안 되는 계획 도메인): ${chk.roadmap.join(' · ')} — 감점 아님, 예정.`),
    );
  }
  body.appendChild(scoreCard);

  const stageHead = (n: string, title: string, sub: string): HTMLElement => {
    const h = el('div', 'bp-stage-head');
    h.append(el('span', 'bp-stage-n', n), (() => {
      const w = el('div');
      w.append(el('b', 'bp-stage-title', title), el('span', 'muted small', sub));
      return w;
    })());
    return h;
  };
  const arrow = (label: string): HTMLElement => {
    const a = el('div', 'bp-arrow');
    a.append(el('span', 'bp-arrow-ic', '▾'), el('span', 'bp-arrow-l muted small', label));
    return a;
  };

  // ── ① 데이터가 태어나는 곳 ──
  const s1 = el('div', 'bp-stage');
  s1.appendChild(stageHead('1', '① 데이터가 태어나는 곳', '앱이 다루는 데이터를 저장 형태별로 묶었어요. 숫자는 지금 담긴 개수.'));
  const srcGrid = el('div', 'bp-src-grid');
  const countRefs = new Map<string, HTMLElement>();
  const makeSrc = (label: string, cls: string, items: typeof SOURCES): HTMLElement => {
    const cardEl = el('div', `bp-src-card ${cls}`);
    cardEl.appendChild(el('b', 'bp-src-title', label));
    for (const s of items) {
      const row = el('div', 'bp-src-row');
      const name = el('span', 'bp-src-name');
      name.append(el('b', undefined, s.label), el('span', 'muted small', ` ${s.table}`));
      const val = el('b', 'bp-src-val', s.implemented ? '…' : '예정');
      if (s.implemented) countRefs.set(s.key, val);
      row.append(name, val);
      cardEl.appendChild(row);
    }
    return cardEl;
  };
  srcGrid.append(
    makeSrc('● 반듯한 표', 'bp-form-table', SOURCES.filter((s) => s.implemented && s.form === 'table')),
    makeSrc('● 복합 묶음(사진)', 'bp-form-bundle', SOURCES.filter((s) => s.implemented && s.form === 'bundle')),
    makeSrc('○ 계획(로드맵)', 'bp-form-plan', SOURCES.filter((s) => !s.implemented)),
  );
  s1.appendChild(srcGrid);
  body.append(s1, arrow('데이터 모양 다듬기'));

  // ── ② 데이터 다듬기 ──
  const s2 = el('div', 'bp-stage');
  s2.appendChild(stageHead('2', '② 데이터 다듬기', '저장·동기화 전에 데이터 모양을 통일하는 공통 처리.'));
  const stepGrid = el('div', 'bp-step-grid');
  for (const st of SHAPING) {
    const c = el('div', 'bp-step');
    c.append(el('span', 'bp-step-code', st.code), el('b', undefined, st.label), el('span', 'muted small', st.sub));
    stepGrid.appendChild(c);
  }
  s2.appendChild(stepGrid);
  body.append(s2, arrow('내 기기 → 클라우드'));

  // ── ③ 안전하게 보관·동기화 ──
  const s3 = el('div', 'bp-stage');
  s3.appendChild(stageHead('3', '③ 안전하게 보관·동기화', '내 기기에 먼저 저장하고 클라우드와 맞춥니다 — 하나도 안 잃도록.'));
  const stoGrid = el('div', 'bp-step-grid');
  for (const st of STORAGE) {
    const c = el('div', 'bp-step');
    c.append(el('span', 'bp-step-code', st.code), el('b', undefined, st.label), el('span', 'muted small', st.sub));
    stoGrid.appendChild(c);
  }
  s3.appendChild(stoGrid);
  s3.appendChild(
    el('p', 'bp-shield', '🛡 데이터를 절대 잃지 않는 약속 — 로컬 커밋+read-back, 빈-클라우드 가드, tombstone·좀비 차단. "저장됐다"는 말만 믿지 않고 실제로 되읽어 확인.'),
  );
  body.append(s3, arrow('화면으로 연결'));

  // ── ④ 보이는 모든 화면 ──
  const s4 = el('div', 'bp-stage');
  s4.appendChild(stageHead('4', '④ 보이는 모든 화면', '실제로 쓰는 화면들 — 각 화면이 어떤 데이터에 닿는지 자동 표시.'));
  const scrGrid = el('div', 'bp-scr-grid');
  for (const sc of SCREENS) {
    const c = el('div', 'bp-scr-card');
    const top = el('div', 'bp-scr-top');
    const badge = sc.feeds.length > 0 ? el('span', 'bp-scr-badge bp-conn', '연결됨') : el('span', 'bp-scr-badge bp-info', '정보');
    top.append(el('b', 'bp-scr-name', sc.label), badge);
    c.appendChild(top);
    const feeds = sc.feeds
      .map((k) => SOURCES.find((s) => s.key === k)?.label ?? k)
      .join(' · ');
    c.appendChild(el('span', 'muted small', feeds ? `데이터: ${feeds}` : '메타 화면(데이터 소비 없음)'));
    scrGrid.appendChild(c);
  }
  s4.appendChild(scrGrid);
  body.appendChild(s4);

  // ── 범례 ──
  const legend = el('div', 'bp-legend');
  legend.appendChild(el('b', undefined, '범례'));
  const legRow = el('div', 'bp-legend-row');
  legRow.append(
    el('span', 'bp-leg bp-form-table', '● 반듯한 표'),
    el('span', 'bp-leg bp-form-bundle', '● 복합 묶음'),
    el('span', 'bp-leg bp-form-plan', '○ 계획(예정)'),
    el('span', 'bp-leg bp-conn', '연결됨=화면이 데이터에 닿음'),
  );
  legend.appendChild(legRow);
  legend.appendChild(
    el('p', 'guide-note', '이 그림은 손으로 그린 게 아니라, 앱이 실제 목록·구조를 그때그때 읽어 자동으로 그립니다 — 빠지거나 끊긴 배선이 있으면 숨지 않고 그대로 드러납니다(CI 게이트 check-blueprint가 선언↔현실을 대조).'),
  );
  body.appendChild(legend);

  // ── 실카운트 채우기(Dexie 실제 목록) ──
  void (async () => {
    try {
      const counts = await liveCounts();
      for (const [key, ref] of countRefs) ref.textContent = String(counts[key] ?? 0);
    } catch {
      for (const [, ref] of countRefs) ref.textContent = '?';
    }
  })();

  // ── 닫기 배선 ──
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
