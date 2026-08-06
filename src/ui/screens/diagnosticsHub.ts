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
import { DIAG_TOOLS, CORE_TOOLS, renderDiagTool, rollup, rollupBanner, copyDiagSummary, type DiagTool } from '../panels/diagnostics';
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

/** 허브 머리말 — 제목·설명·닫기. 조립만 하고 배선은 부르는 쪽이 한다. */
function hubHeader(): { header: HTMLElement; closeBtn: HTMLButtonElement } {
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
  return { header, closeBtn };
}

/** 도구 하나를 상세로 그린다 — 뒤로 가기는 **허브 홈**이지 화면 닫기가 아니다. */
function renderDetail(body: HTMLElement, t: DiagTool, onBack: () => void): void {
  body.replaceChildren();
  const bar = el('div', 'guide-detail-bar');
  const back = el('button', 'guide-back', '‹ 앱 상태 확인') as HTMLButtonElement;
  back.type = 'button';
  back.addEventListener('click', onBack);
  bar.append(back, el('span', 'guide-detail-title', t.label));
  body.append(bar, renderDiagTool(t));
  body.scrollTop = 0;
  back.focus();
}

/**
 * 총괄 판정 바로 아래의 [🔄 일괄 점검] · [📋 결과 복사] (사용자 제안 2026-08-06:
 * *"상단에 일괄 점검 버튼 누르고 점검결과를 바로 옆에 버튼을 만들어서 복사할 수 있도록"*).
 *
 * 왜 위인가: 예전엔 복사가 **맨 아래 「진단 요약 복사」 도구 안**에 있었다. 문제가 보이는
 * 순간(맨 위)과 전달 수단(맨 아래) 사이에 화면 하나가 있었고, 그 거리를 사람이 스크롤로
 * 메우고 있었다(§12 — 앱이 사람에게 시키던 일). 복사는 **판정 바로 옆**이 자리다.
 *
 * 두 버튼 모두 **결과 문장을 화면에 낸다**(§13 4항) — 계산해놓고 안 알리면 M-0022의 행동판이다.
 */
function rollupActions(recheckAll: () => Promise<string>): HTMLElement[] {
  const bar = el('div', 'vd-actions vd-rollup-actions');
  const recheck = el('button', 'vd-btn vd-btn-primary', '🔄 일괄 점검') as HTMLButtonElement;
  recheck.type = 'button';
  recheck.setAttribute('data-recheck-all', '');
  const copy = el('button', 'vd-btn', '📋 결과 복사') as HTMLButtonElement;
  copy.type = 'button';
  copy.setAttribute('data-copy-all', '');
  const note = el('p', 'vd-msg');
  note.hidden = true;
  bar.append(recheck, copy);

  const say = (msg: string): void => {
    applyText(note, msg);
    note.hidden = false;
  };
  // 누른 뒤 버튼이 잠긴 채 남지 않는다(§13 4항 ④) — `finally`가 그 계약이다.
  const wire = (btn: HTMLButtonElement, busy: string, run: () => Promise<string>, failed: string): void => {
    btn.addEventListener('click', () => {
      btn.disabled = true;
      say(busy);
      void run()
        .then(say)
        .catch(() => say(failed))
        .finally(() => {
          btn.disabled = false;
        });
    });
  };
  wire(recheck, '다시 재는 중…', recheckAll, '다시 재지 못했어요. 카드를 열어 개별로 확인해 주세요.');
  wire(copy, '요약을 만드는 중…', copyDiagSummary, '요약을 만들지 못했어요. [진단 요약 복사] 도구를 열어 주세요.');
  return [bar, note];
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
export interface DiagHubOptions {
  /**
   * 닫을 때 돌아갈 곳. 자기를 닫고 허브를 연 화면이 **자기를 다시 여는 함수**를 준다.
   * 안 주면 그냥 닫힌다 — 첫 화면 칩처럼 아래에 화면이 남아 있는 경우가 그렇다.
   */
  onClose?: () => void;
}

export function openDiagnosticsHub(toolId?: string, opts?: DiagHubOptions): void {
  const prevFocus = document.activeElement as HTMLElement | null;

  const overlay = el('div', 'overlay-base guide-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '진단 도구');

  const modal = el('div', 'modal-base guide-modal');
  const { header, closeBtn } = hubHeader();

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

    // 자리는 판정 바로 아래로 고정하고, 내용은 `runRollup`이 선 뒤에 채운다(자리 ≠ 시점).
    const actionSlot = el('div', 'vd-rollup-slot');
    body.appendChild(actionSlot);

    const slots = renderByPath(body, showDetail);
    body.appendChild(
      el(
        'p',
        'guide-note',
        '이 도구들은 개발자가 볼 수 없는 것 — 이 기기의 저장소·환경·오류 — 을 보이게 만듭니다. 문제가 생기면 [진단 요약 복사]로 한 번에 전달해 주세요. 기록 내용(여행 제목·메모·사진)은 담기지 않습니다.',
      ),
    );
    closeBtn.focus();

    // 🔴 배너를 그리는 일이 **한 곳**에만 있어야 [일괄 점검]과 첫 진입이 갈라지지 않는다(§7 2층).
    const runRollup = (): Promise<string> =>
      rollup()
      .then((r) => {
        // 🔴 배너는 `bannerLevel`을 쓴다 — **구조적 확인 불가는 비정상으로 분류하지 않는다**
        // (사용자 지적 2026-08-06). 카드에는 여전히 `?`가 붙으므로 판정을 숨기는 것이 아니라
        // 분류만 바꾸는 것이고, 그 경계는 아래 문장이 **개수로 말한다**(§8 시야의 경계).
        banner.className = `vd-rollup vd-rollup-${r.bannerLevel}`;
        bDot.replaceWith(dot(r.bannerLevel));
        const bad = r.per.filter((p) => p.level === 'problem');
        const todo = r.per.filter((p) => p.level === 'todo');
        // 문장은 순수 함수가 만든다 — 갈래를 유닛으로 전수 검사할 수 있어야 한다(§10 ③).
        applyText(
          bLine,
          rollupBanner({
            bannerLevel: r.bannerLevel,
            badLabels: bad.map((p) => p.label),
            todoLabels: todo.map((p) => p.label),
            structuralCount: r.structuralCount,
          }),
        );

        for (const p of r.per) {
          const slot = slots.get(p.id);
          if (!slot) continue;
          // 정상은 배지 없이 셰브론만 — 침묵이 정상 신호다.
          slot.replaceChildren(...(p.level === 'ok' ? [] : [dot(p.level)]), el('span', 'guide-card-chev', '›'));
        }
        // 요약 도구는 롤업 대상이 아니므로 총괄 판정을 그대로 물려받는다.
        const s = slots.get('summary');
        if (s) s.replaceChildren(...(r.bannerLevel === 'ok' ? [] : [dot(r.bannerLevel)]), el('span', 'guide-card-chev', '›'));
        // 판정 자체는 **맨 위 배너**가 말한다 — 여기서 그 문장을 되풀이하면 대시가 겹쳐 읽기 나쁘다.
        return `${CORE_TOOLS.length}가지를 다시 쟀어요 — 결과는 맨 위 판정에 반영했습니다.`;
      })
      .catch(() => {
        banner.className = 'vd-rollup vd-rollup-unknown';
        bLine.textContent = '상태를 확인하지 못했어요. 카드를 열어 개별로 확인해 주세요.';
        return '상태를 확인하지 못했어요. 카드를 열어 개별로 확인해 주세요.';
      });

    actionSlot.append(...rollupActions(runRollup));
    void runRollup();
  };

  const showDetail = (t: DiagTool): void => renderDetail(body, t, showHome);

  const close = (): void => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (prevFocus && document.contains(prevFocus)) prevFocus.focus();
    // 🔴 **온 곳으로 돌려보낸다**(사용자 지적 2026-08-06: *"닫기를 누르면 바로 전 단계 화면으로
    // 가야 하는데 메인화면으로 돌아가게 되어 불편함"*). 이 허브는 [데이터 관리]가 **자기를 닫고**
    // 열기 때문에, 닫으면 그 아래에 아무것도 없어 첫 화면이 나왔다. 온 곳을 아는 것은 부른 쪽뿐이라
    // 돌아갈 길을 **인자로 받는다** — 허브가 호출자를 추측하지 않는다.
    opts?.onClose?.();
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
