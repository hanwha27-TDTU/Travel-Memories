// domain/gateControlView.ts — 「게이트 대조군 현황」의 문장(순수 함수).
//
// 🔴 **이 화면이 절대 말하면 안 되는 것**: *"검사가 통과했다"*.
//    앱은 게이트가 **실제로 돌았는지 볼 수 없다** — CI는 앱 밖이다(`diagGroups`의
//    `ERRORS-GATE-HEALTH`가 이미 그렇게 등록돼 있다: *"앱이 이걸 판정하는 척하면
//    그 초록이 거짓이 된다"*). 여기 있는 값은 **저장소에 적힌 계약**이고, 화면의 첫 줄이
//    그 사실부터 말한다(§8 — 모르는 것을 정상으로 반올림하지 않는다).
//
// 그래서 이 파일은 **판정(Verdict)을 만들지 않는다.** 판정 렌더러를 쓰면 ✓/! 글리프가 붙어
// 「지금 정상」으로 읽힌다. 이건 **계약을 비추는 표**이지 상태 진단이 아니다.

/** 세 축 — 이름은 `check-gate-control`의 축과 같은 말을 쓴다(두 곳이 다른 말을 하면 안 된다). */
export interface GateControlRow {
  readonly name: string;
  /** 대조군(자체검사)이 있는가 — §4가 요구하는 것. */
  readonly control: boolean;
  /** 밖에서 `--selftest`로 돌려 볼 수 있는가 — 살아 있는지까지 재려면 필요. */
  readonly runnable: boolean;
  /** 자체검사 실패를 **판정**(exit 2)으로 알리는가 — 던져서 죽으면 「위반」으로 오독된다(§18-G). */
  readonly cleanExit: boolean;
}

export interface AxisSummary {
  readonly label: string;
  readonly have: number;
  readonly total: number;
  /** 이 축이 무엇을 뜻하는지 한 줄. 숫자만 있고 뜻이 없으면 그건 지표가 아니라 맥락이다(§8). */
  readonly meaning: string;
  /**
   * 이 축을 아직 못 갖춘 게이트 이름 — **화면에 보일 만큼만**. 비면 사라진다(침묵이 정상 · §8).
   *
   * 🔴 전부 나열하지 않는다. 실기기에서 열어 보니 48개가 화면을 덮었다(2026-08-12 실측).
   *    화면이 할 일은 **지금 어떤 상태인지 말하는 것**이지 작업 목록을 옮기는 게 아니다 —
   *    그 목록은 게이트 출력에 있고, 거기가 그것이 필요한 자리다.
   */
  readonly missing: readonly string[];
  /** 화면에 안 보인 나머지 개수. 0이면 표시하지 않는다 — **자른 사실은 반드시 말한다**(§5 3항). */
  readonly missingMore: number;
}

/** 🔴 표 맨 위에 반드시 나가는 문장 — 이 표가 무엇이고 무엇이 **아닌지**. */
export const GATE_CONTROL_DISCLAIMER =
  '이 표는 저장소에 적힌 계약을 그대로 비춘 것입니다. 검사가 실제로 돌았는지는 앱이 알 수 없어요 — 그건 CI와 사람이 봅니다.';

/** 화면에 이름을 보일 최대 개수. 넘으면 「외 N개」로 접는다. */
export const MISSING_SHOWN_MAX = 6;

/** 목록을 잘라 보여줄 것과 남은 수로 나눈다 — **자른 사실을 잃지 않는다**(§5 3항). */
export function capMissing(names: readonly string[]): { shown: string[]; more: number } {
  return { shown: names.slice(0, MISSING_SHOWN_MAX), more: Math.max(0, names.length - MISSING_SHOWN_MAX) };
}

export function summarizeGateControl(rows: readonly GateControlRow[]): AxisSummary[] {
  const total = rows.length;
  const axis = (
    label: string,
    pick: (r: GateControlRow) => boolean,
    meaning: string,
  ): AxisSummary => {
    const cap = capMissing(rows.filter((r) => !pick(r)).map((r) => r.name));
    return { label, have: rows.filter(pick).length, total, meaning, missing: cap.shown, missingMore: cap.more };
  };
  return [
    axis('대조군이 있다', (r) => r.control, '일부러 틀린 것을 넣었을 때 잡아내는지 스스로 확인하는 절차가 있습니다.'),
    axis(
      '밖에서 돌려 볼 수 있다',
      (r) => r.runnable,
      '그 절차를 따로 실행해 살아 있는지 확인할 수 있습니다. 없으면 있다고 읽었을 뿐입니다.',
    ),
    axis(
      '실패를 판정으로 알린다',
      (r) => r.cleanExit,
      '자체검사가 실패하면 사유를 적고 「확인 불가」로 나갑니다. 그냥 뻗으면 「검사가 위반을 찾았다」처럼 보입니다.',
    ),
  ];
}

/**
 * 한 줄 요약 — **가장 약한 축**을 말한다.
 *
 * 🔴 평균이나 합계를 쓰지 않는다. 세 축 중 하나만 낮아도 그 자리가 약점이고,
 *    평균은 그것을 가린다(§8 — 모르는 것·약한 것을 정상으로 반올림하지 않는다).
 */
export function gateControlHeadline(axes: readonly AxisSummary[]): string {
  // 🔴 **0을 「모두 갖췄다」로 반올림하지 않는다.** 0/0은 만족이 아니라 **못 읽은 것**이다.
  //    이 저장소의 최빈 실패가 정확히 이것이다(대상 0에서 나오는 초록은 「위반 없음」이
  //    아니라 「안 봤다」). 첫 판이 여기서 걸렸고, 유닛이 잡았다.
  if (!axes.length || axes[0].total === 0) return '게이트 정보를 읽지 못했어요.';
  const weakest = axes.reduce((a, b) => (b.have / b.total < a.have / a.total ? b : a));
  if (weakest.have === weakest.total) return `게이트 ${weakest.total}개가 세 가지를 모두 갖췄어요.`;
  return `게이트 ${weakest.total}개 중 「${weakest.label}」가 ${weakest.have}개예요 — 가장 약한 자리입니다.`;
}
