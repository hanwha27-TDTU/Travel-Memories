// ui/screens/aboutApp.ts — '개발자 정보' 모달. 앱 버전·개발자·업데이트 이력·문서 규범 체계.
//
// 정직성(§4·CLAUDE.md): 버전·이력은 app/changelog.ts(SSOT)에서만 읽는다. 여기서 숫자를
// 손으로 쓰지 않는다. 모든 자유 텍스트는 textContent로만 넣는다(innerHTML 금지 — CSP 게이트).

import { el } from '../dom';
import { CHANGELOG, DEVELOPER, APP_VERSION, LAST_MODIFIED, FIRST_DEV_DATE } from '../../app/changelog';
import { openResearchNote } from './researchNote';
import { openDesignOverview } from './designOverview';
import { openMechChecks } from './mechChecks';
import { REGISTRY } from '../../app/registry.gen';
import {
  GATE_CONTROL_DISCLAIMER,
  gateControlHeadline,
  summarizeGateControl,
} from '../../domain/gateControlView';

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

/**
 * 게이트 대조군 현황 절 — top-level로 뽑았다(함수 크기 래칫 · §7 구조적 강제).
 *
 * 🔴 **판정 렌더러를 쓰지 않는다.** ✓/! 글리프가 붙으면 「지금 정상」으로 읽히는데,
 *    앱은 게이트가 실제로 돌았는지 볼 수 없다(§8 · diagGroups의 ERRORS-GATE-HEALTH가
 *    *"앱이 이걸 판정하는 척하면 그 초록이 거짓이 된다"*고 이미 등록해 뒀다).
 *    이건 **계약을 비추는 표**이지 상태 진단이 아니므로, 첫 줄이 그 사실부터 말한다.
 */
function buildGateControlSection(bodyEl: HTMLElement): void {
  bodyEl.appendChild(el('h3', 'about-section-h', '🛡️ 검사 장치의 확인 절차'));
  const axes = summarizeGateControl([...REGISTRY.gateControl]);
  bodyEl.appendChild(el('p', 'about-gc-head', gateControlHeadline(axes)));
  bodyEl.appendChild(el('p', 'guide-note', GATE_CONTROL_DISCLAIMER));
  const list = el('div', 'about-tiers');
  for (const a of axes) {
    const row = el('div', 'about-tier');
    const head = el('div', 'about-tier-head');
    head.append(el('b', 'about-tier-rank', `${a.have} / ${a.total}`), el('span', 'about-tier-ic', a.label));
    row.append(head, el('span', 'about-tier-role muted small', a.meaning));
    // 침묵이 정상(§8) — 다 갖춘 축은 이름을 나열하지 않는다. 남아 있는 것이 곧 할 일이다.
    if (a.missing.length) {
      const chips = el('div', 'about-tier-docs');
      for (const n of a.missing) chips.appendChild(el('span', 'about-doc-chip', n));
      // 🔴 **자른 사실을 반드시 말한다**(§5 3항). 조용히 자르면 여섯 개가 전부인 줄 안다.
      if (a.missingMore > 0) chips.appendChild(el('span', 'about-doc-chip muted', `외 ${a.missingMore}개`));
      row.appendChild(chips);
    }
    list.appendChild(row);
  }
  bodyEl.appendChild(list);
}

/** 문서 규범 체계 절 — top-level(함수 크기 래칫 · §7 구조적 강제). */
function buildNormTiersSection(bodyEl: HTMLElement): void {
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
}

/** '개발자 정보' 모달을 연다. 현재 화면은 유지하고 위에 오버레이로 뜬다. */
export function openAboutApp(): void {
  const prevFocus = document.activeElement as HTMLElement | null;

  const overlay = el('div', 'overlay-base guide-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '개발자 정보');

  const modal = el('div', 'modal-base guide-modal');

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
    el('span', 'about-dev', `${DEVELOPER.name} · ${DEVELOPER.affiliation}`),
    el('span', 'about-role muted small', DEVELOPER.role),
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

  // ── 연구노트(특허 증거용) ──
  const rn = el('div', 'about-rn');
  rn.append(
    el('b', 'about-rn-title', '📓 연구노트 (특허 증거용)'),
    el(
      'p',
      'about-rn-desc',
      'AI가 도왔지만 방향·판단·최종결정은 사람이 했습니다. 그 흔적을 사람/AI/최종결정으로 나눠 SHA-256 해시체인으로 남깁니다(원본 불변·append-only). 법적 보증이 아니라 향후 특허 검토용 구조화 증거 로그입니다.',
    ),
  );
  const rnBtn = el('button', 'btn-ghost about-rn-open', '📓 연구노트 열기') as HTMLButtonElement;
  rnBtn.type = 'button';
  rnBtn.addEventListener('click', () => openResearchNote());
  rn.appendChild(rnBtn);
  bodyEl.appendChild(rn);

  // ── 설계 개요도(배선맵) ──
  const bp = el('div', 'about-rn');
  bp.append(
    el('b', 'about-rn-title', '🗺️ 설계 개요도 (데이터가 화면까지 닿는 큰 그림)'),
    el(
      'p',
      'about-rn-desc',
      '데이터가 태어나 → 다듬어지고 → 보관·동기화되어 → 화면까지 닿는 전체 배선을, 손이 아니라 앱이 실제 목록·구조에서 자동으로 그립니다. 끊긴 배선이 있으면 그대로 드러나 오류를 줄여줍니다.',
    ),
  );
  const bpBtn = el('button', 'btn-ghost about-rn-open', '🗺️ 설계 개요도 열기') as HTMLButtonElement;
  bpBtn.type = 'button';
  bpBtn.addEventListener('click', () => openDesignOverview());
  const mcBtn = el('button', 'btn-ghost about-rn-open', '🛡️ 기계화 검증 흐름도 열기') as HTMLButtonElement;
  mcBtn.type = 'button';
  mcBtn.addEventListener('click', () => openMechChecks());
  bp.append(bpBtn, mcBtn);
  bodyEl.appendChild(bp);

  buildGateControlSection(bodyEl);

  buildNormTiersSection(bodyEl);

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
