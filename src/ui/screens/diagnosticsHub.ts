// ui/screens/diagnosticsHub.ts — '진단 도구' 허브.
//
// 왜 별도 창인가(사용자 제안 2026-07-26): 진단은 [가이드]의 "앱을 설명한다"와도, [데이터 관리]의
// "내 데이터를 어떻게 한다"와도 성격이 다르다. **"지금 무슨 일이 벌어지고 있나"를 보는 축**이라
// 자기 자리를 가져야 한다. 두 허브 모두에서 이 창으로 들어온다.
//
// 무엇을 담을지 **연역으로 골랐다** — "개발자가 볼 수 없는 것" 중 *기억을 잃거나 사용자를 막는 것*.
// 목록과 그 근거는 `panels/diagnostics.ts`의 `CORE_TOOLS`에 있다(허브가 손으로 다시 적지 않는다).
//
// 2026-07-26 재설계 — **허브가 판정을 한다.**
// 이전 허브는 여섯 카드를 전부 같은 정적 라벨로 그렸다. 진단 도구를 여는 사람은 이미 "뭔가
// 이상하다"고 느낀 상태인데, 화면은 *어디를 볼지*조차 알려주지 않고 여섯 갈래 탐색을 시켰다.
// 지금은 열자마자 다섯 도구를 실제로 돌려 **총괄 한 줄 + 카드별 배지**를 그린다. 정상이면
// 다섯 개를 열 필요가 없다.
//
// 규율:
//  - 계산 전에는 '확인 중…'이다. **정상을 먼저 칠하지 않는다** — 미검사를 통과로 적는 건 거짓말이다.
//  - 정상 카드는 배지를 달지 않는다(침묵이 정상 신호). 이상일 때만 배지가 나타난다.
//  - 전부 **읽기 전용 관측**이 기본. 상태를 바꾸는 것은 각 도구의 액션뿐이고, 어느 것도
//    사용자의 기억을 지우지 않는다.

import { el, applyText } from '../dom';
import { DIAG_TOOLS, renderDiagTool, rollup, type DiagTool } from '../panels/diagnostics';
import { DIAG_GROUPS, GROUP_META, BLIND_SPOTS } from '../../domain/diagGroups';
import { LEVELS, type Level } from '../panels/verdict';

/** 허브 카드 하나 — 구조는 [가이드]·[데이터 관리]와 **같은 계약**(ic / mid / 우측 슬롯)을 지킨다. */
function card(t: DiagTool, onOpen: (t: DiagTool) => void): { btn: HTMLButtonElement; slot: HTMLElement } {
  const btn = el('button', 'guide-card guide-card-diag') as HTMLButtonElement;
  btn.type = 'button';
  btn.setAttribute('data-tool', t.label);
  const ic = el('span', 'guide-card-ic', t.icon);
  ic.setAttribute('aria-hidden', 'true');
  const mid = el('span', 'guide-card-mid');
  mid.append(el('b', 'guide-card-label', t.label), el('small', 'guide-card-hint', t.hint));
  const slot = el('span', 'guide-card-slot');
  slot.append(el('span', 'vd-dot vd-dot-pending'), el('span', 'guide-card-chev', '›'));
  btn.append(ic, mid, slot);
  btn.addEventListener('click', () => onOpen(t));
  return { btn, slot };
}

/**
 * 🔴 **도구를 경로축 단계로 묶어 그린다**(v1.79).
 *
 * 사용자가 진단을 여는 이유는 늘 *"어디서 끊겼나?"*이므로, 목록이 **기억이 지나는 순서**로
 * 서면 위에서부터 좁힐 수 있다. v1.76에서 이 분류(`DIAG_GROUPS`)를 만들어 놓고 **도구에는
 * 안 걸어서** 목록이 평평한 채로 남아 있었다 — 분류는 사각지대 등록부에만 붙었고, 인계
 * 문서는 「재분류했다」고 적혀 있었다. M-0015(*"만들어 놓고 화면에서 부르지 않음"*)의 재발이다.
 *
 * 🔴 **비어 있는 단계도 그린다.** 도구가 없는 단계를 그냥 빼면 그 구멍이 화면에서 사라지고,
 * 사용자도 다음 개발자도 **그 단계가 검사된 줄 안다**(§8 — 모르는 것을 정상으로 반올림하지
 * 않는다). 지금 「🖼 파일 실물」이 정확히 그 상태다(전수 확인 도구 미제작). 자리를 남기고
 * **왜 비었는지**를 말한다 — 그 이유는 손으로 적지 않고 **사각지대 등록부에서 가져온다**
 * (두 곳에 적으면 갈라진다 · §7). 등록부에 이유가 없으면 게이트가 RED로 잡는다.
 *
 * @returns 도구 id → 배지 슬롯. 롤업이 끝나면 부르는 쪽이 여기에 판정을 꽂는다.
 */
function renderByPath(body: HTMLElement, onOpen: (t: DiagTool) => void): Map<string, HTMLElement> {
  const slots = new Map<string, HTMLElement>();
  for (const g of DIAG_GROUPS) {
    const meta = GROUP_META[g];
    const tools = DIAG_TOOLS.filter((t) => t.group === g);
    const head = el('div', 'diag-group-head');
    head.setAttribute('data-diag-group', g);
    head.append(
      el('h3', 'diag-group-title', `${meta.icon} ${meta.label}`),
      el('p', 'diag-group-asks muted small', meta.asks),
    );
    body.appendChild(head);
    if (!tools.length) {
      const why = BLIND_SPOTS.filter((b) => b.group === g && b.coveredBy === null);
      const note = el('p', 'guide-note diag-group-empty');
      note.textContent = why.length
        ? `아직 이 단계를 보는 도구가 없어요 — ${why.map((b) => b.what).join(' · ')}`
        : '아직 이 단계를 보는 도구가 없어요.';
      body.appendChild(note);
      continue;
    }
    const grid = el('div', 'guide-card-grid');
    for (const t of tools) {
      const { btn, slot } = card(t, onOpen);
      slots.set(t.id, slot);
      grid.appendChild(btn);
    }
    body.appendChild(grid);
  }
  return slots;
}

function dot(level: Level): HTMLElement {
  const d = el('span', `vd-dot vd-dot-${level}`, LEVELS[level].glyph);
  d.setAttribute('aria-label', LEVELS[level].name);
  return d;
}

/**
 * 진단 허브를 연다. `toolId`를 주면 **그 도구로 바로 들어간다**(허브 홈을 거치지 않는다).
 *
 * 왜(사용자 제안 2026-07-26): 첫 화면의 「동기화 대기 13건」 칩이 *말만 하고 갈 곳을 주지
 * 않았다.* 사용자는 [데이터 관리] → [진단 도구] → [동기화 상태]를 스스로 찾아 들어가야 했다.
 * 진단 §7-B와 같은 자리다 — **판정만 하고 행동을 못 주면 관측으로 되돌아간 것이다.**
 *
 * 모르는 id를 주면 허브 홈을 연다 — 조용히 실패하지 않고, 잘못된 화면도 보여주지 않는다.
 */
export function openDiagnosticsHub(toolId?: string): void {
  const prevFocus = document.activeElement as HTMLElement | null;

  const overlay = el('div', 'overlay-base guide-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '진단 도구');

  const modal = el('div', 'modal-base guide-modal');
  const header = el('div', 'guide-header');
  const titleWrap = el('div', 'guide-title-wrap');
  titleWrap.append(
    el('h2', 'guide-title', '앱 상태 확인'),
    el('p', 'guide-sub', '지금 이 기기에서 무슨 일이 벌어지고 있는지 봅니다. 대부분 읽기 전용이에요.'),
  );
  const closeBtn = el('button', 'guide-close', '✕') as HTMLButtonElement;
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', '진단 도구 닫기');
  header.append(titleWrap, closeBtn);

  const body = el('div', 'guide-body');

  const showHome = (): void => {
    body.replaceChildren();

    // 총괄 판정 — 열자마자 보이는 한 줄. 계산 전에는 '확인 중…'.
    const banner = el('div', 'vd-rollup vd-rollup-pending');
    const bTop = el('div', 'vd-rollup-top');
    const bDot = el('span', 'vd-dot vd-dot-pending');
    const bLine = el('p', 'vd-rollup-line', '확인 중…');
    bTop.append(bDot, bLine);
    banner.append(bTop);
    banner.setAttribute('data-rollup', '');
    body.appendChild(banner);

    const slots = renderByPath(body, showDetail);
    body.appendChild(
      el(
        'p',
        'guide-note',
        '이 도구들은 개발자가 볼 수 없는 것 — 이 기기의 저장소·환경·오류 — 을 보이게 만듭니다. 문제가 생기면 [진단 요약 복사]로 한 번에 전달해 주세요. 기록 내용(여행 제목·메모·사진)은 담기지 않습니다.',
      ),
    );
    closeBtn.focus();

    void rollup()
      .then((r) => {
        banner.className = `vd-rollup vd-rollup-${r.level}`;
        bDot.replaceWith(dot(r.level));
        const bad = r.per.filter((p) => p.level === 'problem');
        const todo = r.per.filter((p) => p.level === 'todo');
        applyText(
          bLine,
          r.level === 'problem'
            ? `지금 확인할 것 ${bad.length}가지 — ${bad.map((p) => p.label).join(' · ')}`
            : r.level === 'todo'
              ? `해두면 좋은 일 ${todo.length}가지 — ${todo.map((p) => p.label).join(' · ')}`
              : r.level === 'unknown'
                ? '확인하지 못한 항목이 있어요'
                : '이상 없음 · 방금 확인했어요',
        );

        for (const p of r.per) {
          const slot = slots.get(p.id);
          if (!slot) continue;
          // 정상은 배지 없이 셰브론만 — 침묵이 정상 신호다.
          slot.replaceChildren(...(p.level === 'ok' ? [] : [dot(p.level)]), el('span', 'guide-card-chev', '›'));
        }
        // 요약 도구는 롤업 대상이 아니므로 총괄 판정을 그대로 물려받는다.
        const s = slots.get('summary');
        if (s) s.replaceChildren(...(r.level === 'ok' ? [] : [dot(r.level)]), el('span', 'guide-card-chev', '›'));
      })
      .catch(() => {
        banner.className = 'vd-rollup vd-rollup-unknown';
        bLine.textContent = '상태를 확인하지 못했어요. 카드를 열어 개별로 확인해 주세요.';
      });
  };

  const showDetail = (t: DiagTool): void => {
    body.replaceChildren();
    const bar = el('div', 'guide-detail-bar');
    const back = el('button', 'guide-back', '‹ 앱 상태 확인') as HTMLButtonElement;
    back.type = 'button';
    back.addEventListener('click', showHome);
    bar.append(back, el('span', 'guide-detail-title', t.label));
    body.append(bar, renderDiagTool(t));
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

  // 지목된 도구로 바로 들어간다. 없는 id면 허브 홈 — 모르는 곳으로 데려가지 않는다.
  const target = toolId ? DIAG_TOOLS.find((t) => t.id === toolId) : undefined;
  if (target) showDetail(target);
  else showHome();
}
