// domain/roundTripVerdict.ts — 「왕복 시험」의 단계 정의와 **판정·문장**(순수 함수).
//
// 이 도구가 묻는 질문(§7-E — 질문을 쓰고 판정을 그 질문에 맞춘다):
//
//   **「지금 이 기기에서 저장한 것이 서버까지 갔다가, 지운 흔적까지 남기고 사라지는가?」**
//
// 왜 **쓰기** 시험인가(사용자 결정 2026-08-05): 읽기 전용 관측은 *지금 상태*만 말한다.
// 「저장이 실제로 도착하는가」는 **한 번 보내 봐야** 안다. 이 저장소의 결함 셋(M-0100·M-0101·
// M-0015)이 전부 *"코드는 맞는데 실제로는 안 갔다"* 형태였고, 그때마다 사용자의 실기기가
// 유일한 검출기였다 — 이 도구는 그 검출을 **앱이 스스로** 하게 만든다.
//
// 🔴 **자기가 만든 것만 건드린다.** 각 단계는 이 시험이 방금 만든 id 하나만 대상으로 하며,
//    사용자의 실제 기록은 읽지도 쓰지도 않는다(§0 — 원본 자료를 임의로 삭제/덮어쓰지 않는다).

/** 왕복의 단계 — 순서가 계약이다. 앞이 실패하면 뒤는 돌지 않는다. */
export const ROUND_TRIP_STEPS = [
  'create', // 이 기기에 저장(내구성 로컬 커밋 — 비타협 원칙 #1이 보장하는 지점)
  'push', // 서버로 올림
  'serverRead', // 🔴 서버에서 **되읽어** 확인 — 성공 응답이 아니라 행이 실제로 있는가(§2-B)
  'delete', // 휴지통으로(tombstone)
  'tombstoneRead', // 그 삭제가 서버에도 반영됐는가 — 다른 기기가 이걸 보고 지운다
  'purge', // 영구삭제
  'purgeRead', // 서버 행이 사라지고 **원장에 id가 남았는가**(좀비 차단의 근거)
  'cleanup', // 이 기기에도 안 남았는가 — 시험이 자기 뒷정리를 했는가(§3-C)
] as const;

export type RoundTripStep = (typeof ROUND_TRIP_STEPS)[number];

/** 사람이 읽는 단계 이름 — 화면이 손으로 다시 적지 않게 여기 한 곳(§7). */
export const STEP_LABEL: Record<RoundTripStep, string> = {
  create: '이 기기에 저장',
  push: '서버로 올림',
  serverRead: '서버에서 되읽기',
  delete: '휴지통으로 삭제',
  tombstoneRead: '삭제가 서버에 반영',
  purge: '영구삭제',
  purgeRead: '서버 행 사라짐 + 원장에 남음',
  cleanup: '이 기기 뒷정리',
};

/**
 * 각 단계가 **무엇을 증명하는가.** 이걸 못 쓰면 그 단계는 시험이 아니라 절차다 —
 * 사용자가 「왜 이 줄이 여기 있는지」를 알 수 있어야 결과를 해석할 수 있다.
 *
 * 🔴 **여기에 마크다운을 쓰지 마라.** 이 문자열은 `textContent`로 그려지므로 `**`가 화면에
 * 그대로 찍힌다(§5 7항). 실제로 첫 판에 `**실제 행**`이라고 썼다가 유닛이 잡았다 —
 * 강조가 필요하면 문자열이 아니라 `level`로 표현한다.
 */
export const STEP_PROVES: Record<RoundTripStep, string> = {
  create: '네트워크가 없어도 기록이 남는다(오프라인 우선)',
  push: '보낼 것이 큐에 앉아만 있지 않는다',
  serverRead: '성공 응답이 아니라 실제 행이 서버에 있다',
  delete: '삭제가 즉시 되돌릴 수 있는 형태(휴지통)로 남는다',
  tombstoneRead: '다른 기기도 이 삭제를 보게 된다',
  purge: '영구삭제가 2단계를 거쳐 실제로 실행된다',
  purgeRead: '지운 것이 다른 기기에서 되살아나지 않는다(좀비 차단)',
  cleanup: '시험이 자기 흔적을 남기지 않는다',
};

export type StepState = 'pass' | 'fail' | 'skipped';

export interface StepResult {
  step: RoundTripStep;
  state: StepState;
  /** 얼마나 걸렸나(ms). 건너뛴 단계는 null. 어디서 느린지가 보인다. */
  ms: number | null;
  /** 실패했으면 그 사유. 성공이면 null. 조용히 삼키지 않는다. */
  error: string | null;
}

export interface RoundTripRun {
  /** 시험 시각(ISO). 언제 잰 결과인지 없으면 낡은 초록을 믿게 된다. */
  at: string;
  steps: StepResult[];
  /**
   * 🔴 정리에 실패해 **서버나 이 기기에 남은** 시험용 여행 id. 비어 있어야 정상.
   * 남았으면 사용자가 지울 수 있게 화면이 그 사실과 id를 **말한다** — 조용히 남기면
   * 그게 곧 M-0019형 오염(옛 방식 잔재)이 된다.
   */
  leftover: string | null;
}

export type RoundTripLevel = 'ok' | 'todo' | 'problem' | 'unknown';

export interface RoundTripView {
  level: RoundTripLevel;
  headline: string;
  /** 최상위 지표 한 줄의 값·기대값. */
  actual: string;
  expected: string;
  meaning?: string;
}

/** 첫 실패 단계 — 없으면 null. 「어디서 끊겼나」가 이 도구의 답이다. */
export function firstFailure(run: RoundTripRun): StepResult | null {
  return run.steps.find((s) => s.state === 'fail') ?? null;
}

/**
 * 아직 한 번도 안 돌린 상태는 **정상이 아니라 「확인 불가」**다(§8 — 미검사를 통과로 적는 것은
 * 거짓말이다). 「문제 없음」과 「안 재봤음」을 같은 초록으로 칠하면 그 초록은 아무 뜻도 없다.
 */
export function roundTripView(run: RoundTripRun | null): RoundTripView {
  if (!run) {
    return {
      level: 'unknown',
      headline: '아직 왕복 시험을 해보지 않았어요',
      actual: '해본 적 없음',
      expected: '최근에 통과',
      meaning:
        '이 기기에서 저장한 것이 서버까지 갔다가 지운 흔적까지 남기는지를 실제로 한 번 보내 봅니다. ' +
        '시험용 여행 하나를 만들었다가 스스로 지우며, 기존 기록은 건드리지 않아요.',
    };
  }
  const fail = firstFailure(run);
  const passed = run.steps.filter((s) => s.state === 'pass').length;
  const total = run.steps.length;

  if (fail) {
    return {
      level: 'problem',
      headline: `「${STEP_LABEL[fail.step]}」에서 끊겼어요`,
      actual: `${passed}/${total} 단계 통과`,
      expected: `${total}/${total} 단계 통과`,
      // 사유를 그대로 보여준다 — 조용히 삼키면 사용자는 원인을 영영 못 찾는다(§13 4항 ③).
      meaning: `${STEP_PROVES[fail.step]} — 이걸 확인하지 못했습니다. 사유: ${fail.error ?? '알 수 없음'}`,
    };
  }
  if (run.leftover) {
    // 왕복 자체는 됐는데 뒷정리가 안 됐다 — 자료 안전 문제는 아니지만 **남긴 것은 말한다**.
    return {
      level: 'todo',
      headline: '왕복은 됐는데 시험용 기록이 남았어요',
      actual: `${passed}/${total} 단계 통과 · 남은 항목 1건`,
      expected: `${total}/${total} 단계 통과 · 남은 항목 없음`,
      meaning: `제목이 「${ROUND_TRIP_TITLE_PREFIX}」로 시작하는 여행이 남아 있어요. [데이터 관리 › 휴지통]에서 지울 수 있습니다.`,
    };
  }
  return {
    level: 'ok',
    headline: '저장 → 서버 → 삭제 → 영구삭제가 전부 확인됐어요',
    actual: `${passed}/${total} 단계 통과`,
    expected: `${total}/${total} 단계 통과`,
  };
}

/**
 * 시험용 여행 제목의 접두사.
 *
 * 🔴 **숨기지 않고 알아보게 만든다.** 홈 목록에서 감추면 정리가 실패했을 때 사용자가
 * 그 사실을 영영 모른다 — 조용한 잔재가 나중에 「이 여행 뭐지?」가 되는 것보다,
 * 제목이 스스로 정체를 밝히는 편이 정직하다(§8 — 모르는 걸 아는 척하지 않는다의 역방향).
 * 정상 흐름에서는 몇 초 안에 사라지므로 사용자 눈에 남지 않는다.
 */
export const ROUND_TRIP_TITLE_PREFIX = '[진단] 왕복 시험';
