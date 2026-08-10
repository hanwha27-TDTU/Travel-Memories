// ui/panels/verdict.ts — **판정(verdict) 공용 계약과 단 하나의 렌더러**.
//
// 왜 이 파일이 존재하는가(사용자 지적 2026-07-26):
//   "우리가 이런 도구를 만드는 건 **정상은 어떤 상태이고 문제가 발생한 게 뭔지 차이를 아는 것**
//    아닐까요?"
// 그 전까지 진단 화면들은 *관측*을 했다 — 사실을 전부 같은 무게로 나열했다. 정상 11줄이 화면
// 대부분을 먹고, 진짜 이상은 그 더미 속에 파묻혔다. 관측은 **개발자용으로는 옳고 사용자용으로는
// 틀렸다**. 사용자는 사실이 아니라 판정을 원한다.
//
// 그래서 세 가지를 뒤집는다:
//   ① **침묵이 정상이다.** 기대값과 일치하는 지표는 화면에서 사라지고 한 줄로만 집계된다.
//      남아 있는 것이 곧 문제 — 이 규칙이 생기면 "뭐가 문제인지 모르겠다"가 사라진다.
//   ② **지표마다 기대값을 병기한다.** `지금 3건 / 정상 0건`. 기준이 없으면 사용자는 숫자를 보고
//      불안해질 수는 있어도 행동할 수는 없다.
//   ③ **판정을 위로, 근거는 요청 시.** 요약(한 문장) → 이상 지표 → 정상 한 줄 → 접힌 출처.
//
// **왜 렌더러가 하나뿐인가 — 이게 이 파일의 진짜 목적이다.**
// CLAUDE.md 「수평전개와 대칭성」: 선언만으로는 안 지켜진다. 실제로 겪었다 — LESSONS §3에 이미
// "도메인 대칭성"이 적혀 있었는데도 cascade는 사진·비용만 조용히 빠졌다(M-0006). 규율을 문서에
// 적는 것과 구조가 그것을 강제하는 것은 다르다. 도구마다 자기 렌더 코드를 가지면 여섯 벌이
// 각자 흘러가고, 그 드리프트는 사용자가 실기기에서 먼저 본다. 그래서 도구는 `Verdict`(데이터)만
// 만들고 **그리는 일은 여기 한 곳**에서 한다. 새 도구는 렌더러를 안 쓰는 선택지가 없다.
// (게이트: scripts/check-verdict-symmetry.mjs 가 이 계약의 이탈을 정적으로 막는다.)

import { el, applyText } from '../dom';

/**
 * 판정 4단.
 *
 * 3단(정상/주의/문제)이 아니라 4단인 이유는 **정직함** 때문이다(비타협 원칙 #4). 진단에는
 * 현재 증거로는 알 수 없는 상태가 실제로 있다. op 없는 tombstone은 로컬만으로 구분할 수 없어
 * 서버 행·영구삭제 원장까지 대조하고, 거기에도 없거나 조회가 불완전할 때만 unknown이다
 * (M-0008·M-0095). 모르는 것을 '문제'나 '정상'으로 단정하지 않는다.
 * 모르는 것을 정상이나 문제 어느 쪽으로 밀어 넣어도 거짓말이 된다 — 그래서 자기 칸을 준다.
 */
export type Level = 'ok' | 'todo' | 'problem' | 'unknown';

export interface LevelMeta {
  /** 색맹·흑백 인쇄에서도 구분되도록 색과 **함께** 쓰는 글리프(색만으로 인코딩하지 않는다). */
  glyph: string;
  name: string;
  /** 위험 순위 — 낮을수록 급하다. 롤업(worst)이 이걸로 정렬한다. */
  rank: number;
}

export const LEVELS: Record<Level, LevelMeta> = {
  problem: { glyph: '!', name: '문제', rank: 0 },
  // 다시 확인하면 풀릴 수 있는 `unknown/transient`는 선택적 할 일보다 먼저 보여야 한다.
  // 구조적 unknown은 롤업의 `bannerLevelOf()`가 별도로 제외한다.
  unknown: { glyph: '?', name: '확인 불가', rank: 1 },
  todo: { glyph: '●', name: '할 일', rank: 2 },
  ok: { glyph: '✓', name: '정상', rank: 3 },
};

/** 여러 판정의 롤업 — 가장 급한 것이 이긴다. 빈 배열은 '정상'이 아니라 '확인 불가'다. */
export function worst(levels: Level[]): Level {
  if (!levels.length) return 'unknown';
  return levels.reduce((a, b) => (LEVELS[b].rank < LEVELS[a].rank ? b : a));
}

/**
 * 🔴 `확인 불가`가 **왜** 확인 불가인가 — 두 가지는 사용자에게 뜻이 정반대다
 * (사용자 지적 2026-08-06: *"구조적으로 확인불가이면 확인불가로 판정은 하되 **비정상으로
 * 분류하면 안 될 거 같아요**"*).
 *
 *  · `structural` — **이 기기·이 배포에서는 원리적으로 잴 수 없다.** 다시 눌러도 안 된다.
 *    예: APK 셸에서 브라우저 persist가 무엇을 뜻하는지 · 클라우드를 안 쓰는 배포의 서버 계약.
 *    이건 **잘못된 상태가 아니다.** 총괄 판정을 끌어내리면 멀쩡한 앱이 아파 보인다(§7-E).
 *  · `transient` — **지금 못 쟀을 뿐, 재보면 알 수 있다.** 서버가 답을 안 했거나 로그인 전이거나.
 *    이건 총괄에 그대로 반영한다 — 사용자가 다시 눌러 해소할 수 있는 상태다.
 *
 * 🔴 **기본값을 두지 않는다.** 기본값이 있으면 새 지표가 안 적어도 컴파일되고, 그게 이 규율이
 * 조용히 빠지는 길이다(M-0060). 아래 유니온이 **누락을 컴파일 오류로** 만든다(§7 2층).
 */
export type UnknownKind = 'structural' | 'transient';

/** 지표의 공통 부분 — 등급과 무관하게 언제나 필요한 것. */
interface MetricBase {
  /** 대상만 말한다. 상태를 라벨에 넣지 않는다(옛 결함: "지움 + 보낼목록 없음  없음" 이중부정). */
  label: string;
  /** 지금 값(사람이 읽는 문자열). */
  actual: string;
  /** 정상이라면 이 값이어야 한다. */
  expected: string;
  /** level !== 'ok' 일 때 화면에 함께 뜨는 한 줄 — 무슨 뜻이고 무엇을 하면 되는지. */
  meaning?: string;
}

/**
 * 지표 하나 — **기대값이 필수다**.
 *
 * 선택 필드로 두면 빠뜨린 지표가 조용히 섞여 들어와 "값만 있고 기준은 없는" 옛 화면으로 되돌아간다.
 * 기대값을 못 쓰는 지표라면 그건 지표가 아니라 **맥락**이다 → `context`로 보낸다.
 *
 * 그리고 `unknown`이면 **왜 모르는지의 종류**(`unknownKind`)도 필수다 — 위 주석 참조.
 */
export type Metric =
  | (MetricBase & { level: 'ok' | 'todo' | 'problem' })
  | (MetricBase & { level: 'unknown'; unknownKind: UnknownKind });

/**
 * 이 도구의 `확인 불가`가 **전부 구조적인가** — 그렇다면 총괄 판정을 끌어내리지 않는다.
 *
 * 하나라도 `transient`가 섞여 있으면 false다: 재시도로 풀릴 수 있는 것이 하나라도 있으면
 * 사용자에게 알려야 한다(모르는 것을 정상으로 반올림하지 않는다 · §8).
 */
/**
 * 지표 리터럴에서 등급 부분만 만든다 — `...levelOr(조건, 종류, 아니면)`으로 펼쳐 쓴다.
 *
 * 왜: 유니온 때문에 손으로 쓰면 세 줄짜리 삼항이 지표마다 반복된다. 한 곳에 두면 짧아질 뿐
 * 아니라, **`kind`를 안 넘기면 컴파일되지 않는다**는 계약이 그대로 유지된다(기본값 금지).
 */
export function levelOr(
  isUnknown: boolean,
  kind: UnknownKind,
  otherwise: 'ok' | 'todo' | 'problem',
): { level: 'unknown'; unknownKind: UnknownKind } | { level: 'ok' | 'todo' | 'problem' } {
  return isUnknown ? { level: 'unknown', unknownKind: kind } : { level: otherwise };
}

export function unknownIsStructural(metrics: Metric[]): boolean {
  const unknowns = metrics.filter((m) => m.level === 'unknown');
  return unknowns.length > 0 && unknowns.every((m) => m.unknownKind === 'structural');
}

interface ActionBase {
  label: string;
  /** 판정을 바꾸는 행동은 화면당 **하나**만 primary. 나머지는 접힌 곳으로. */
  primary?: boolean;
  /** data-* 훅(라이브 검증·E2E가 셀렉터로 잡는다). */
  hook?: string;
}

interface TextAction extends ActionBase {
  /** 실행 후 사용자에게 보일 한 줄. 끝나면 렌더러가 자동으로 다시 판정한다. */
  run: (input: string) => Promise<string>;
  /**
   * 값을 받아야 하는 행동 — 렌더러가 버튼 **앞에** 입력칸 하나를 붙이고 그 값을 `run()`에 넘긴다.
   *
   * 왜 여기(렌더러)인가: 도구가 자기 입력 UI를 그리기 시작하면 도구마다 다른 모양이 생기고,
   * 그게 이 저장소에서 세 번 반복된 결함군이다(§7). 입력을 쓰는 도구가 하나뿐일 때 만들어 둬야
   * **다음 도구가 자동으로 따라온다.**
   */
  input?: {
    type?: 'text';
    /** 입력칸의 접근성 라벨(화면읽기). 화면에는 placeholder로 보인다. */
    label: string;
    placeholder?: string;
    /** 열 때 채워 둘 값 — 매번 다시 계산한다(재판정 후 최신값을 물고 와야 하므로 함수다). */
    initial?: () => string;
    maxLength?: number;
  };
}

interface FileAction extends ActionBase {
  run: (input: File) => Promise<string>;
  input: {
    type: 'file';
    /** 파일 선택기의 접근성 라벨. */
    label: string;
    accept?: string;
  };
}

/** 입력 종류가 늘어나도 모든 진단 도구가 같은 렌더러·접근성·read-back 규율을 물려받는다. */
export type Action = TextAction | FileAction;

function isFileAction(action: Action): action is FileAction {
  return action.input?.type === 'file';
}

/** 접힌 '출처' 층 — 목록·기술코드·원문 덤프는 전부 여기로 내려간다. */
export interface Evidence {
  label: string;
  build: () => HTMLElement;
}

export interface Verdict {
  level: Level;
  /** 판정 한 문장. 사실이 아니라 **결론**을 쓴다. */
  headline: string;
  /** 그 결론의 근거 한 줄(선택). */
  because?: string;
  metrics: Metric[];
  actions: Action[];
  evidence: Evidence[];
  /** 상태가 아닌 환경 사실(앱 버전·시간대 등) — 판정에 영향을 주지 않는다. 맨 아래 작게. */
  context: { label: string; value: string }[];
}

/** 판정 없이 만들 수 있는 빈 골격 — 도구가 필드를 빠뜨리지 않게. */
export function emptyVerdict(level: Level, headline: string): Verdict {
  return { level, headline, metrics: [], actions: [], evidence: [], context: [] };
}

/**
 * 지표들에서 전체 판정을 파생한다.
 *
 * 손으로 level을 적으면 지표는 빨간데 headline은 초록인 화면이 만들어진다(자기모순).
 * 파생하면 그 모순이 구조적으로 불가능해진다.
 */
export function levelFromMetrics(metrics: Metric[]): Level {
  return worst(metrics.map((m) => m.level));
}

// ────────────────────────────────────────────────────────────────────────────
// 렌더러 — **여기 한 곳에서만 그린다**
// ────────────────────────────────────────────────────────────────────────────

function badge(level: Level): HTMLElement {
  const b = el('span', `vd-badge vd-${level}`);
  b.append(el('span', 'vd-glyph', LEVELS[level].glyph), el('span', 'vd-badge-txt', LEVELS[level].name));
  return b;
}

/** 이상 지표 하나 = 카드. **기준 대조**가 카드의 본문이다. */
function metricCard(m: Metric): HTMLElement {
  const card = el('div', `vd-metric vd-metric-${m.level}`);
  const top = el('div', 'vd-metric-top');
  top.append(badge(m.level), el('span', 'vd-metric-label', m.label));
  const cmp = el('div', 'vd-compare');
  const now = el('div', 'vd-compare-cell');
  now.append(el('span', 'vd-compare-k', '지금'), el('span', 'vd-compare-v', m.actual));
  const exp = el('div', 'vd-compare-cell');
  exp.append(el('span', 'vd-compare-k', '정상'), el('span', 'vd-compare-v', m.expected));
  cmp.append(now, exp);
  card.append(top, cmp);
  if (m.meaning) card.appendChild(el('p', 'vd-metric-why', m.meaning));
  return card;
}

/** 정상 지표들 — **나열하지 않는다**. 한 줄 + 접힌 미니표. */
function quietBlock(ok: Metric[]): HTMLElement {
  const d = el('details', 'vd-quiet');
  const s = el('summary', 'vd-quiet-sum');
  s.append(el('span', 'vd-glyph vd-glyph-ok', '✓'), el('span', 'vd-quiet-txt', `정상 ${ok.length}개`));
  d.appendChild(s);
  const mini = el('div', 'vd-mini');
  for (const m of ok) {
    const r = el('div', 'vd-mini-row');
    r.append(el('span', 'vd-mini-k', m.label), el('span', 'vd-mini-v', m.actual), el('span', 'vd-mini-e', `정상 ${m.expected}`));
    mini.appendChild(r);
  }
  d.appendChild(mini);
  return d;
}

export interface ToolView {
  title: string;
  /** 이 도구가 무엇을 보는지 한 줄. */
  lead: string;
  probe: () => Promise<Verdict>;
}

function showActionFailure(message: HTMLElement, error: Error, reread: () => void): void {
  message.textContent = `실행 실패: ${error.message}`;
  message.hidden = false;
  // 일부 변경 뒤 실패했을 수 있다. 실패 문장만 믿지 않고 현재 권위 상태를 다시 읽는다.
  reread();
}

/**
 * 액션 한 개의 입력·버튼·실패·read-back 배선. renderTool 안에 두면 입력 종류가 늘 때마다
 * 판정 렌더 전체가 커지고, 도구별로 파일 UI를 따로 만들게 된다. 모든 입력은 이 문을 지난다.
 */
function appendAction(
  actionBar: HTMLElement,
  message: HTMLElement,
  action: Action,
  reread: () => void,
): void {
  let field: HTMLInputElement | null = null;
  if (action.input) {
    field = el('input', 'vd-input') as HTMLInputElement;
    field.type = isFileAction(action) ? 'file' : 'text';
    field.setAttribute('aria-label', action.input.label);
    if (isFileAction(action)) {
      if (action.input.accept) field.accept = action.input.accept;
    } else {
      field.placeholder = action.input.placeholder ?? action.input.label;
      if (action.input.maxLength) field.maxLength = action.input.maxLength;
      field.value = action.input.initial?.() ?? '';
    }
    if (action.hook) field.setAttribute(`${action.hook}-input`, '');
    actionBar.appendChild(field);
  }

  const button = el('button', action.primary ? 'vd-btn vd-btn-primary' : 'vd-btn') as HTMLButtonElement;
  button.type = 'button';
  button.textContent = action.label;
  if (action.hook) button.setAttribute(action.hook, '');
  if (!isFileAction(action)) {
    field?.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') button.click();
    });
  }
  button.addEventListener('click', () => {
    if (isFileAction(action) && !field?.files?.[0]) {
      applyText(message, '실행 실패: 확인할 파일을 먼저 골라 주세요.');
      message.hidden = false;
      return;
    }
    button.disabled = true;
    const task = isFileAction(action)
      ? action.run(field!.files![0]!)
      : action.run(field?.value ?? '');
    void task
      .then((text) => {
        applyText(message, text);
        message.hidden = false;
        reread();
      })
      .catch((error: Error) => {
        showActionFailure(message, error, reread);
      })
      .finally(() => {
        button.disabled = false;
      });
  });
  actionBar.appendChild(button);
}

/**
 * 도구 하나를 그린다 — **모든 진단 도구가 이 함수를 통과한다**.
 *
 * 계약상 중요한 것 두 가지:
 *  - 계산 전에는 절대 '정상'을 그리지 않는다. 빈 화면에 초록을 먼저 칠하면 그건 거짓말이다.
 *  - 액션 실행 후에는 **다시 판정한다**. 고쳤다고 말만 하고 화면이 옛 값을 들고 있으면
 *    사용자는 고쳐졌는지 알 수 없다("read-back으로 확인" — 데이터 안전 불변식과 같은 규율).
 */
export function renderTool(v: ToolView): HTMLElement {
  const wrap = el('div', 'vd-tool');
  wrap.setAttribute('data-verdict-tool', v.title);

  const card = el('div', 'vd-card vd-card-pending');
  const head = el('div', 'vd-card-head');
  const line = el('p', 'vd-headline', '확인 중…');
  head.append(badge('unknown'), line);
  const because = el('p', 'vd-because');
  because.hidden = true;
  card.append(head, because);

  const actionBar = el('div', 'vd-actions');
  const msg = el('p', 'vd-msg');
  msg.hidden = true;
  const body = el('div', 'vd-body');
  const ctx = el('p', 'vd-context');
  ctx.hidden = true;

  wrap.append(el('p', 'vd-lead', v.lead), card, actionBar, msg, body, ctx);

  let running = false;
  const run = (): void => {
    if (running) return;
    running = true;
    card.className = 'vd-card vd-card-pending';
    head.replaceChildren(badge('unknown'), line);
    line.textContent = '확인 중…';
    void v
      .probe()
      .then((r) => {
        card.className = `vd-card vd-card-${r.level}`;
        applyText(line, r.headline);
        head.replaceChildren(badge(r.level), line);
        applyText(because, r.because ?? '');
        because.hidden = !r.because;

        // 본문: 이상만 카드, 정상은 한 줄
        body.replaceChildren();
        const bad = r.metrics.filter((m) => m.level !== 'ok');
        const ok = r.metrics.filter((m) => m.level === 'ok');
        for (const m of bad) body.appendChild(metricCard(m));
        if (ok.length) body.appendChild(quietBlock(ok));
        for (const e of r.evidence) {
          const d = el('details', 'vd-evidence');
          d.appendChild(el('summary', 'vd-evidence-sum', e.label));
          let built = false;
          d.addEventListener('toggle', () => {
            if (d.open && !built) {
              built = true;
              d.appendChild(e.build());
            }
          });
          body.appendChild(d);
        }

        // 액션: primary 하나 + 나머지, 그리고 항상 [다시 확인]
        actionBar.replaceChildren();
        for (const action of r.actions) appendAction(actionBar, msg, action, run);
        const again = el('button', 'vd-btn', '다시 확인') as HTMLButtonElement;
        again.type = 'button';
        again.setAttribute('data-verdict-recheck', '');
        again.addEventListener('click', run);
        actionBar.appendChild(again);

        ctx.textContent = r.context.map((c) => `${c.label} ${c.value}`).join(' · ');
        ctx.hidden = r.context.length === 0;
      })
      .catch((e: Error) => {
        // 관측 실패는 관측된 문제와 다르다. 다시 열면 풀릴 수 있는 일시적 확인 불가다.
        card.className = 'vd-card vd-card-unknown';
        applyText(line, '확인하지 못했어요');
        head.replaceChildren(badge('unknown'), line);
        applyText(because, e.message);
        because.hidden = false;
      })
      .finally(() => {
        running = false;
      });
  };
  run();
  return wrap;
}
