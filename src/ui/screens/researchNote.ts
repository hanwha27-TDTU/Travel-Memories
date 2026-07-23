// ui/screens/researchNote.ts — '연구노트(특허 증거용)' 모달. 사람/AI/최종결정 흔적 + SHA-256 해시체인.
//
// 정직성(§4): "법적 보증"이 아니라 특허 검토용 구조화 증거 로그다. 데이터는 researchLog(SSOT),
// 해시는 런타임 계산(hashchain). 무결성 배지는 실제 재계산 결과만 반영한다(성공/실패/미지원 구분).
// 모든 자유 텍스트는 textContent로만 넣는다(innerHTML 금지 — CSP 게이트).

import { el } from '../dom';
import { RESEARCH_LOG } from '../../app/researchLog';
import { buildChain, verifyChain, anchorHash, hashchainSupported, type ChainLink } from '../../app/hashchain';

const short = (hex: string): string => `${hex.slice(0, 10)}…${hex.slice(-6)}`;

/** '연구노트' 모달을 연다. 현재 화면은 유지하고 위에 오버레이로 뜬다. */
export function openResearchNote(): void {
  const prevFocus = document.activeElement as HTMLElement | null;

  const overlay = el('div', 'guide-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '연구노트');

  const modal = el('div', 'guide-modal');
  const header = el('div', 'guide-header');
  const titleWrap = el('div', 'guide-title-wrap');
  titleWrap.append(
    el('h2', 'guide-title', '📓 연구노트'),
    el('p', 'guide-sub', '특허 검토용 구조화 증거 로그 — 법적 보증이 아닙니다.'),
  );
  const closeBtn = el('button', 'guide-close', '✕') as HTMLButtonElement;
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', '닫기');
  header.append(titleWrap, closeBtn);

  const bodyEl = el('div', 'guide-body');
  modal.append(header, bodyEl);
  overlay.appendChild(modal);

  // 설명
  bodyEl.appendChild(
    el(
      'p',
      'guide-note',
      'AI가 도왔지만 방향·판단·최종결정은 사람이 했습니다. 각 결정을 사람/AI/최종결정으로 나눠 이전 항목의 SHA-256 해시에 묶어 append-only 체인으로 남깁니다. 마지막 앵커 해시를 외부에 기록해 두면 이후 위·변조를 감지할 수 있습니다.',
    ),
  );

  // 무결성 배지 + 앵커 해시 자리(비동기 계산 후 채움)
  const integrity = el('div', 'rn-integrity');
  const badge = el('span', 'rn-badge rn-badge-pending', '무결성 확인 중…');
  const anchorRow = el('div', 'rn-anchor');
  anchorRow.append(el('span', 'rn-anchor-k muted small', '앵커 해시'), el('code', 'rn-anchor-v', '…'));
  integrity.append(badge, anchorRow);
  bodyEl.appendChild(integrity);

  // 항목 목록 자리
  const list = el('div', 'rn-list');
  bodyEl.appendChild(list);

  const renderLinks = (links: ChainLink[]): void => {
    list.innerHTML = '';
    for (const link of links) {
      const card = el('div', 'rn-entry');
      const top = el('div', 'rn-entry-top');
      top.append(
        el('b', 'rn-entry-topic', `#${link.input.seq} · ${link.input.topic}`),
        el('span', 'rn-entry-date muted small', link.input.date),
      );
      card.appendChild(top);
      const rows = el('div', 'rn-rows');
      const row = (tag: string, cls: string, text: string): HTMLElement => {
        const r = el('div', `rn-row ${cls}`);
        r.append(el('span', 'rn-tag', tag), el('span', 'rn-row-text', text));
        return r;
      };
      rows.append(
        row('사람', 'rn-human', link.input.human),
        row('AI', 'rn-ai', link.input.ai),
        row('최종결정', 'rn-decision', link.input.decision),
      );
      card.appendChild(rows);
      const hashRow = el('div', 'rn-hash');
      hashRow.append(
        el('span', 'rn-hash-k muted small', 'hash'),
        el('code', 'rn-hash-v', short(link.hash)),
        el('span', 'rn-hash-k muted small', '← prev'),
        el('code', 'rn-hash-v muted', short(link.prevHash)),
      );
      card.appendChild(hashRow);
      list.appendChild(card);
    }
  };

  // 해시체인 계산·검증(보안 컨텍스트 필요)
  void (async () => {
    if (!hashchainSupported()) {
      badge.className = 'rn-badge rn-badge-warn';
      badge.textContent = '이 환경에선 해시 계산 불가(보안 컨텍스트 필요)';
      anchorRow.hidden = true;
      // 해시 없이 내용만 표시
      renderLinks(RESEARCH_LOG.map((input) => ({ input, prevHash: '', hash: '' })));
      return;
    }
    try {
      const links = await buildChain(RESEARCH_LOG);
      renderLinks(links);
      const ok = await verifyChain(links);
      if (ok) {
        badge.className = 'rn-badge rn-badge-ok';
        badge.textContent = `무결성 유효 ✓ · 전체 ${links.length}건`;
      } else {
        badge.className = 'rn-badge rn-badge-warn';
        badge.textContent = '무결성 검증 실패';
      }
      (anchorRow.querySelector('.rn-anchor-v') as HTMLElement).textContent = short(anchorHash(links));
    } catch {
      badge.className = 'rn-badge rn-badge-warn';
      badge.textContent = '해시 계산 오류';
      anchorRow.hidden = true;
      renderLinks(RESEARCH_LOG.map((input) => ({ input, prevHash: '', hash: '' })));
    }
  })();

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
