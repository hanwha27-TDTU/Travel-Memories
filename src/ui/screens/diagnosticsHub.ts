// ui/screens/diagnosticsHub.ts — '진단 도구' 허브.
//
// 왜 별도 창인가(사용자 제안 2026-07-26): 진단은 [가이드]의 "앱을 설명한다"와도, [데이터 관리]의
// "내 데이터를 어떻게 한다"와도 성격이 다르다. **"지금 무슨 일이 벌어지고 있나"를 보는 축**이라
// 자기 자리를 가져야 한다. 두 허브 모두에서 이 창으로 들어온다.
//
// 무엇을 담을지 **연역으로 골랐다** — "개발자가 볼 수 없는 것" 중 *기억을 잃거나 사용자를 막는 것*:
//   ① 저장소 안전   : 브라우저 축출 = 앱 밖 원인의 유일한 기억 손실(원칙 #1의 예외). 최우선.
//   ② 동기화 진단   : 서버와 얼마나 어긋나 있나(오늘 좀비 사건의 해결 열쇠였다).
//   ③ ID 무결성     : 기록이 서로 앞뒤가 맞나 — 고아·부모 없는 자식은 조용히 사라진 기억이 된다.
//   ④ 환경·기능     : 지원 안 되는 기능이 있으면 앱이 조용히 대체경로로 빠진다.
//   ⑤ 오류 기록     : 사용자가 콘솔을 열 줄 몰라도 오류가 남는다.
//   ⑥ 요약 복사     : 위 전부를 텍스트 한 덩어리로 — **캡처 왕복을 한 번으로 줄인다.**
//
// 규율: 전부 **읽기 전용 관측**이 기본. 상태를 바꾸는 것은 [저장소 보호 요청]·[정리 실행]·
// [실패 재시도] 셋뿐이고, 셋 다 사용자의 기억을 지우지 않는다.

import { el } from '../dom';
import {
  syncDiagnosticsPanel,
  integrityPanel,
  storagePanel,
  environmentPanel,
  errorPanel,
  summaryPanel,
} from '../panels/diagnostics';
import { errorCount } from '../../app/errorLog';

interface Tool {
  icon: string;
  label: string;
  hint: string;
  render: () => HTMLElement;
}

const TOOLS: Tool[] = [
  { icon: '💾', label: '저장소 안전', hint: '브라우저가 데이터를 지울 위험', render: storagePanel },
  { icon: '🔍', label: '동기화 진단', hint: '서버와 얼마나 어긋나 있나', render: syncDiagnosticsPanel },
  { icon: '🔎', label: 'ID 무결성 점검', hint: '기록이 서로 앞뒤가 맞나', render: integrityPanel },
  { icon: '🧩', label: '환경·기능 지원', hint: '이 기기가 갖춘 기능', render: environmentPanel },
  { icon: '⚠️', label: '오류 기록', hint: '이 세션에서 생긴 오류', render: errorPanel },
  { icon: '📋', label: '진단 요약 복사', hint: '한 번에 복사해 전달', render: summaryPanel },
];

export function openDiagnosticsHub(): void {
  const prevFocus = document.activeElement as HTMLElement | null;

  const overlay = el('div', 'guide-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '진단 도구');

  const modal = el('div', 'guide-modal');
  const header = el('div', 'guide-header');
  const titleWrap = el('div', 'guide-title-wrap');
  titleWrap.append(
    el('h2', 'guide-title', '🩺 진단 도구'),
    el('p', 'guide-sub', '지금 이 기기에서 무슨 일이 벌어지고 있는지 봅니다. 대부분 읽기 전용이에요.'),
  );
  const closeBtn = el('button', 'guide-close', '✕') as HTMLButtonElement;
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', '진단 도구 닫기');
  header.append(titleWrap, closeBtn);

  const body = el('div', 'guide-body');

  const showHome = (): void => {
    body.innerHTML = '';
    const grid = el('div', 'guide-card-grid');
    for (const t of TOOLS) {
      const btn = el('button', 'guide-card') as HTMLButtonElement;
      btn.type = 'button';
      btn.setAttribute('data-tool', t.label);
      const n = t.label === '오류 기록' ? errorCount() : 0;
      btn.append(
        el('span', 'guide-card-icon', t.icon),
        el('span', 'guide-card-label', n > 0 ? `${t.label} (${n})` : t.label),
        el('span', 'guide-card-hint', t.hint),
      );
      btn.addEventListener('click', () => showDetail(t));
      grid.appendChild(btn);
    }
    body.appendChild(grid);
    body.appendChild(
      el(
        'p',
        'guide-note',
        '이 도구들은 개발자가 볼 수 없는 것 — 이 기기의 저장소·환경·오류 — 을 보이게 만듭니다. 문제가 생기면 [진단 요약 복사]로 한 번에 전달해 주세요. 기록 내용(여행 제목·메모·사진)은 담기지 않습니다.',
      ),
    );
    closeBtn.focus();
  };

  const showDetail = (t: Tool): void => {
    body.innerHTML = '';
    const bar = el('div', 'guide-detail-bar');
    const back = el('button', 'guide-back', '‹ 진단 도구') as HTMLButtonElement;
    back.type = 'button';
    back.addEventListener('click', showHome);
    bar.append(back, el('span', 'guide-detail-title', `${t.icon} ${t.label}`));
    body.append(bar, t.render());
    body.scrollTop = 0;
    back.focus();
  };

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

  modal.append(header, body);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  showHome();
}
