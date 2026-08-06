// tests/unit/roundTripVerdict.test.ts — 「왕복 시험」의 판정과 **화면 문장**을 잠근다.
//
// 이 도구가 특히 위험한 이유: **쓰기 시험**이라 결과를 잘못 말하면 사용자가 서버 상태를
// 오해한다. 「안 재봤음」을 초록으로 칠하거나, 「어디서 끊겼는지」를 틀리게 가리키면
// 사용자는 엉뚱한 곳을 뒤진다(M-0021의 형태 — 판정 문장이 엉뚱한 곳을 지목).

import { describe, it, expect } from 'vitest';
import {
  roundTripView,
  firstFailure,
  ROUND_TRIP_STEPS,
  STEP_LABEL,
  STEP_PROVES,
  ROUND_TRIP_TITLE_PREFIX,
  type RoundTripRun,
  type RoundTripStep,
  type StepResult,
} from '../../src/domain/roundTripVerdict';

const pass = (step: RoundTripStep, note: string | null = null): StepResult => ({ step, state: 'pass', ms: 12, error: null, note });
const fail = (step: RoundTripStep, error: string): StepResult => ({ step, state: 'fail', ms: 9, error, note: null });
const skip = (step: RoundTripStep): StepResult => ({ step, state: 'skipped', ms: null, error: null, note: null });

/** 전부 통과한 한 판. */
const allPass = (over: Partial<RoundTripRun> = {}): RoundTripRun => ({
  at: '2026-08-05T15:00:00.000Z',
  steps: ROUND_TRIP_STEPS.map((s) => pass(s)),
  leftover: null,
  ...over,
});

/** `at` 단계에서 끊긴 한 판 — 그 뒤는 전부 skipped. */
const failedAt = (step: RoundTripStep, error = '서버가 거절했어요'): RoundTripRun => {
  const i = ROUND_TRIP_STEPS.indexOf(step);
  return {
    at: '2026-08-05T15:00:00.000Z',
    steps: [...ROUND_TRIP_STEPS.slice(0, i).map((s) => pass(s)), fail(step, error), ...ROUND_TRIP_STEPS.slice(i + 1).map(skip)],
    leftover: null,
  };
};

describe('아직 안 해본 상태', () => {
  it('🔴 「안 재봤음」을 정상으로 칠하지 않는다 — 미검사를 통과로 적는 건 거짓말이다(§8)', () => {
    const v = roundTripView(null);
    expect(v.level).toBe('unknown');
    expect(v.actual).toBe('해본 적 없음');
  });

  it('무엇을 하는 시험인지, 그리고 **기존 기록을 안 건드린다**는 것을 말한다', () => {
    const v = roundTripView(null);
    // 쓰기 시험이라 사용자가 겁먹을 수 있다 — 안전 경계를 먼저 말한다.
    expect(v.meaning).toContain('기존 기록은 건드리지 않아요');
  });
});

describe('전부 통과', () => {
  it('정상이면 ok이고 몇 단계를 통과했는지 말한다', () => {
    const v = roundTripView(allPass());
    expect(v.level).toBe('ok');
    expect(v.actual).toBe(`${ROUND_TRIP_STEPS.length}/${ROUND_TRIP_STEPS.length} 단계 통과`);
    expect(v.meaning).toBeUndefined(); // 정상은 침묵한다(§5 1항)
  });

  it('판정 문장이 **무엇이 확인됐는지**를 말한다(「정상입니다」로 뭉개지 않는다)', () => {
    const v = roundTripView(allPass());
    expect(v.headline).toContain('저장');
    expect(v.headline).toContain('서버');
    expect(v.headline).toContain('영구삭제');
  });
});

describe('어디서 끊겼나 — 이 도구의 핵심 답', () => {
  it('🔴 첫 실패 단계를 정확히 가리킨다', () => {
    const run = failedAt('serverRead', '올렸는데 서버에서 그 행을 찾지 못했습니다');
    expect(firstFailure(run)?.step).toBe('serverRead');
    const v = roundTripView(run);
    expect(v.level).toBe('problem');
    expect(v.headline).toContain(STEP_LABEL.serverRead);
  });

  it('🔴 실패 사유를 조용히 삼키지 않는다(§13 4항 ③)', () => {
    const v = roundTripView(failedAt('push', '네트워크 끊김'));
    expect(v.meaning).toContain('네트워크 끊김');
  });

  it('그 단계가 **무엇을 증명하려던 것인지**도 말한다 — 사용자가 결과를 해석할 수 있게', () => {
    const v = roundTripView(failedAt('purgeRead'));
    expect(v.meaning).toContain(STEP_PROVES.purgeRead);
  });

  it('건너뛴 단계를 통과로 세지 않는다 — 「안 쟀다」와 「통과」는 다른 말이다', () => {
    const v = roundTripView(failedAt('push'));
    // create만 통과했다(push 실패, 나머지 skipped).
    expect(v.actual).toBe(`1/${ROUND_TRIP_STEPS.length} 단계 통과`);
  });

  it('단계마다 라벨과 증명 문장이 **빠짐없이** 있다(§7 — 새 단계가 조용히 이름 없이 생기지 않게)', () => {
    for (const s of ROUND_TRIP_STEPS) {
      expect(STEP_LABEL[s]?.length).toBeGreaterThan(0);
      expect(STEP_PROVES[s]?.length).toBeGreaterThan(0);
    }
  });
});

describe('뒷정리 실패 — 자료 안전 문제는 아니지만 남긴 것은 말한다', () => {
  it('왕복은 됐는데 잔재가 있으면 ok가 아니라 todo다', () => {
    const v = roundTripView(allPass({ leftover: 'abc-123' }));
    expect(v.level).toBe('todo');
    expect(v.headline).toContain('남았');
  });

  it('🔴 어떻게 치우는지 **알려준다** — 막다른 문장으로 끝내지 않는다(§7-D)', () => {
    const v = roundTripView(allPass({ leftover: 'abc-123' }));
    expect(v.meaning).toContain(ROUND_TRIP_TITLE_PREFIX);
    expect(v.meaning).toContain('휴지통');
  });

  it('잔재가 실패보다 급하지 않다 — 실패가 있으면 실패를 먼저 가리킨다', () => {
    const run = { ...failedAt('purge'), leftover: 'abc-123' };
    expect(roundTripView(run).level).toBe('problem');
  });
});

describe('화면 문장 규율', () => {
  it('🔴 마크다운을 쓰지 않는다 — textContent로 그리므로 `**`가 그대로 찍힌다(§5 7항)', () => {
    for (const run of [null, allPass(), allPass({ leftover: 'x' }), failedAt('serverRead')]) {
      const v = roundTripView(run);
      expect(v.headline).not.toContain('**');
      expect(v.actual).not.toContain('**');
      expect(v.expected).not.toContain('**');
      expect(v.meaning ?? '').not.toContain('**');
    }
  });

  it('모든 갈래에 기대값이 있다 — 없으면 지표가 아니라 맥락이다(§4)', () => {
    for (const run of [null, allPass(), allPass({ leftover: 'x' }), failedAt('delete')]) {
      const v = roundTripView(run);
      expect(v.expected.length).toBeGreaterThan(0);
      expect(v.actual.length).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T-013 — 서버 트리거가 `updated_at`을 덮어써 LWW 판정을 흔들지 않는가
//
// 실측(운영 DB 2026-08-06): `journey.set_updated_at()`은 `new.updated_at := now()`로
// **무조건 덮어쓴다.** 다만 트리거는 이름 순으로 돌아 `a_sync_write_guard`가 **먼저** 보므로
// LWW·OCC 판정 자체는 **이 기기가 보낸 값**으로 내려진다. 그리고 push가 read-back으로
// 서버 값을 받아 적어(`updatedAt: serverTrip.updatedAt`) 양쪽이 같아진다.
//
// 🔴 그 「같아짐」은 **코드가 아니라 실제 서버에서** 확인돼야 한다 — 그래서 단계가 생겼다.
// 여기 유닛이 지키는 것은 그 단계가 **등록부에서 조용히 사라지지 않는 것**이다.
// ─────────────────────────────────────────────────────────────────────────────
describe('T-013 — 수정 시각 단계', () => {
  it('고치기와 시각 확인이 단계 목록에 있다 — 만들기만 재면 UPDATE 트리거를 못 본다', () => {
    expect(ROUND_TRIP_STEPS).toContain('update');
    expect(ROUND_TRIP_STEPS).toContain('stampRead');
  });

  // 🔴 순서가 계약이다: 고친 **다음에** 시각을 봐야 하고, 지우기 **전에** 봐야 한다
  //    (지운 뒤엔 tombstone 쓰기가 시각을 또 바꾼다).
  it('고치기 → 시각 확인 → 삭제 순서다', () => {
    const i = (s: RoundTripStep): number => ROUND_TRIP_STEPS.indexOf(s);
    expect(i('serverRead')).toBeLessThan(i('update'));
    expect(i('update')).toBeLessThan(i('stampRead'));
    expect(i('stampRead')).toBeLessThan(i('delete'));
  });

  it('시각이 어긋나면 그 단계를 지목한다 — 사용자가 엉뚱한 곳을 뒤지지 않게', () => {
    const v = roundTripView(failedAt('stampRead', '이 기기와 서버가 서로 다른 수정 시각을 들고 있어요'));
    expect(v.level).toBe('problem');
    expect(v.headline).toContain(STEP_LABEL.stampRead);
    expect(v.meaning).toContain('서로 다른 수정 시각');
  });

  // 🔴 §12: 통과했어도 **본 것**은 화면에 갈 수 있어야 한다. 서버가 시각을 바꾸는 것 자체는
  //    결함이 아니지만, 그 사실을 앱만 알고 사용자는 모르면 다음에 또 사람이 DB를 뒤진다.
  it('통과한 단계도 관측을 실을 자리가 있다(note)', () => {
    const run = allPass();
    const stamped = {
      ...run,
      steps: run.steps.map((s) => (s.step === 'stampRead' ? pass('stampRead', '서버가 자기 시각으로 바꿨습니다') : s)),
    };
    expect(roundTripView(stamped).level).toBe('ok'); // 관측이 있다고 판정이 내려가지 않는다
    expect(stamped.steps.find((s) => s.step === 'stampRead')?.note).toContain('서버가 자기 시각으로');
  });
});
