// ui/screens/aboutApp.ts — '개발자 정보' 모달. 앱 버전·개발자·업데이트 이력·문서 규범 체계.
//
// 정직성(§4·CLAUDE.md): 버전·이력은 app/changelog.ts(SSOT)에서만 읽는다. 여기서 숫자를
// 손으로 쓰지 않는다. 모든 자유 텍스트는 textContent로만 넣는다(innerHTML 금지 — CSP 게이트).

import { el } from '../dom';
import { CHANGELOG, DEVELOPER, APP_VERSION, LAST_MODIFIED, FIRST_DEV_DATE } from '../../app/changelog';

/** 문서 규범 체계(법령 체계) — 기존 문서 지도를 규범 위계로 재구성. 새 사실을 만들지 않는다. */
interface NormTier {
  icon: string;
  rank: string;
  role: string;
  docs: string[];
}
const NORM_TIERS: NormTier[] = [
  { icon: '⚖️', rank: '헌법 (최고규범)', role: '북극성·비타협 원칙·§0 절대금지·작업 규율(5W1H)', docs: ['CLAUDE.md', 'AGENTS.md'] },
  { icon: '📜', rank: '기본법', role: '요구사항 최상위 — 무엇을 만드나', docs: ['PROJECT_SPEC.md'] },
  { icon: '📚', rank: '도메인 법령', role: '데이터·동기화·보안·개인정보·미디어·구조', docs: ['DATA_MODEL', 'SYNC_PROTOCOL', 'SECURITY', 'PRIVACY', 'MEDIA_PIPELINE', 'ARCHITECTURE'] },
  { icon: '🧭', rank: '시행지침', role: '배포 계약·검증 계획·에이전트 운영', docs: ['DEPLOYMENT', 'TEST_PLAN', 'AGENT_REGISTRY'] },
  { icon: '🗂', rank: '판례 · 기록', role: '결정 근거·교훈·인계·변경 이력', docs: ['DECISIONS', 'LESSONS', 'HANDOFF', 'CHANGELOG(이 화면의 SSOT)'] },
];

/** '개발자 정보' 모달을 연다. 현재 화면은 유지하고 위에 오버레이로 뜬다. */
export function openAboutApp(): void {
  const prevFocus = document.activeElement as HTMLElement | null;

  const overlay = el('div', 'guide-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '개발자 정보');

  const modal = el('div', 'guide-modal');

  // ── 헤더 ──
  const header = el('div', 'guide-header');
  const titleWrap = el('div', 'guide-title-wrap');
  const titleRow = el('div', 'about-title-row');
  titleRow.append(el('h2', 'guide-title', '🧑‍💻 개발자 정보'), el('span', 'about-ver-badge', `v${APP_VERSION}`));
  titleWrap.append(titleRow, el('p', 'guide-sub', '이 앱을 만든 사람과 걸어온 기록입니다.'));
  const closeBtn = el('button', 'guide-close', '✕') as HTMLButtonElement;
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', '닫기');
  header.append(titleWrap, closeBtn);

  const bodyEl = el('div', 'guide-body');
  modal.append(header, bodyEl);
  overlay.appendChild(modal);

  // ── 프로필 카드 ──
  const profile = el('div', 'about-profile');
  const avatar = el('div', 'about-avatar', '🧳');
  avatar.setAttribute('aria-hidden', 'true');
  const pinfo = el('div', 'about-profile-info');
  pinfo.append(
    el('b', 'about-app-name', DEVELOPER.appName),
    el('span', 'about-dev', `${DEVELOPER.name} · ${DEVELOPER.role}`),
    el('span', 'about-tagline muted small', DEVELOPER.tagline),
  );
  profile.append(avatar, pinfo);
  bodyEl.appendChild(profile);

  // ── 요약 카드(최초 개발 / 최종 수정 / 현재 버전) ──
  const stats = el('div', 'about-stats');
  const statCard = (label: string, value: string): HTMLElement => {
    const c = el('div', 'about-stat');
    c.append(el('span', 'about-stat-k muted small', label), el('b', 'about-stat-v', value));
    return c;
  };
  stats.append(
    statCard('최초 개발', FIRST_DEV_DATE),
    statCard('코드 최종 수정', LAST_MODIFIED),
    statCard('현재 버전', `v${APP_VERSION}`),
  );
  bodyEl.appendChild(stats);

  // ── 문서 규범 체계(법령 체계) ──
  bodyEl.appendChild(el('h3', 'about-section-h', '📐 문서 규범 체계 (거버넌스)'));
  bodyEl.appendChild(
    el('p', 'guide-note', '이 앱은 문서를 규범 위계로 관리합니다. 충돌하면 상위 규범이 이깁니다. 저장소 문서가 최종 정보원입니다.'),
  );
  const tiers = el('div', 'about-tiers');
  for (const t of NORM_TIERS) {
    const row = el('div', 'about-tier');
    const head = el('div', 'about-tier-head');
    head.append(el('span', 'about-tier-ic', t.icon), el('b', 'about-tier-rank', t.rank));
    const role = el('span', 'about-tier-role muted small', t.role);
    const docs = el('div', 'about-tier-docs');
    for (const d of t.docs) docs.appendChild(el('span', 'about-doc-chip', d));
    row.append(head, role, docs);
    tiers.appendChild(row);
  }
  bodyEl.appendChild(tiers);

  // ── 업데이트 이력 ──
  const histH = el('div', 'about-hist-head');
  histH.append(
    el('h3', 'about-section-h', '🕓 업데이트 이력'),
    el('span', 'about-hist-count muted small', `전체 ${CHANGELOG.length}건`),
  );
  bodyEl.appendChild(histH);

  const renderEntry = (i: number, latest: boolean): HTMLElement => {
    const e = CHANGELOG[i]!;
    const card = el('div', latest ? 'about-entry about-entry-latest' : 'about-entry');
    const top = el('div', 'about-entry-top');
    top.append(
      el('b', 'about-entry-title', `${latest ? '최신 · ' : ''}v${e.version} — ${e.title}`),
      el('span', 'about-entry-date muted small', e.date),
    );
    card.appendChild(top);
    const ul = el('ul', 'about-entry-notes');
    for (const n of e.notes) ul.appendChild(el('li', undefined, n));
    card.appendChild(ul);
    return card;
  };

  const histList = el('div', 'about-hist');
  histList.appendChild(renderEntry(0, true));
  bodyEl.appendChild(histList);

  if (CHANGELOG.length > 1) {
    const rest = el('div', 'about-hist-rest');
    rest.hidden = true;
    for (let i = 1; i < CHANGELOG.length; i += 1) rest.appendChild(renderEntry(i, false));
    const toggle = el('button', 'btn-ghost about-hist-toggle') as HTMLButtonElement;
    toggle.type = 'button';
    const setLabel = (): void => {
      toggle.textContent = rest.hidden ? `이전 업데이트 ${CHANGELOG.length - 1}건 펼치기 ▾` : '접기 ▴';
    };
    setLabel();
    toggle.addEventListener('click', () => {
      rest.hidden = !rest.hidden;
      setLabel();
    });
    bodyEl.append(toggle, rest);
  }

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
