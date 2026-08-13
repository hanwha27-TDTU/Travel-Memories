import { describe, expect, it } from 'vitest';
import {
  GATE_CONTROL_DISCLAIMER,
  gateControlHeadline,
  summarizeGateControl,
  type GateControlRow,
} from '../../src/domain/gateControlView';

const row = (name: string, control: boolean, runnable: boolean, cleanExit: boolean): GateControlRow => ({
  name,
  control,
  runnable,
  cleanExit,
});

describe('게이트 대조군 현황 문장', () => {
  it('축마다 「가진 수 / 전체」와 못 갖춘 이름을 낸다', () => {
    const axes = summarizeGateControl([row('a', true, true, true), row('b', true, false, false)]);

    expect(axes).toHaveLength(3);
    expect(axes[0]).toMatchObject({ have: 2, total: 2, missing: [] });
    expect(axes[1]).toMatchObject({ have: 1, total: 2, missing: ['b'] });
    expect(axes[2]).toMatchObject({ have: 1, total: 2, missing: ['b'] });
  });

  it('축마다 뜻을 함께 낸다 — 숫자만 있으면 지표가 아니라 맥락이다(§8)', () => {
    for (const a of summarizeGateControl([row('a', true, true, true)])) {
      expect(a.meaning.length).toBeGreaterThan(10);
    }
  });

  it('🔴 요약은 **가장 약한 축**을 말한다 — 평균은 약점을 가린다', () => {
    const axes = summarizeGateControl([
      row('a', true, false, true),
      row('b', true, false, true),
      row('c', true, false, true),
    ]);

    // 대조군 3/3 · 실행 가능 0/3 · 판정 3/3 → 약한 자리는 「밖에서 돌려 볼 수 있다」
    expect(gateControlHeadline(axes)).toContain('밖에서 돌려 볼 수 있다');
    expect(gateControlHeadline(axes)).toContain('0개');
  });

  it('전부 갖췄으면 그렇게 말한다', () => {
    const axes = summarizeGateControl([row('a', true, true, true)]);

    expect(gateControlHeadline(axes)).toContain('모두 갖췄');
  });

  it('대상이 없으면 「읽지 못했다」 — 0개를 정상으로 반올림하지 않는다(§8)', () => {
    expect(gateControlHeadline(summarizeGateControl([]))).toContain('읽지 못했');
  });

  // 🔴 §17 표면↔표면 모순 차단(2026-08-13). 가이드·기계화 흐름도는 **하네스 항목 수**
  //    (`REGISTRY.gateCount` — `typecheck`·`unit-tests` 포함)를 「게이트 N가지」로 말한다.
  //    이 문장의 모집단은 **검사 스크립트**라 그보다 작다. 둘 다 참이지만 **같은 낱말**을 쓰면
  //    두 화면을 본 사용자에게는 어긋난 것으로 읽힌다 — M-0157이 정확히 그 형태였다.
  //    그래서 이 문장은 자기 모집단의 이름을 **반드시** 달고 다닌다.
  it('🔴 숫자가 자기 모집단의 이름을 달고 다닌다 — 「게이트 N개」로 말하지 않는다(§17)', () => {
    const cases = [
      gateControlHeadline(summarizeGateControl([row('a', true, false, true)])), // 약한 축이 있는 갈래
      gateControlHeadline(summarizeGateControl([row('a', true, true, true)])), // 전부 갖춘 갈래
      gateControlHeadline(summarizeGateControl([])), // 못 읽은 갈래
    ];
    for (const line of cases) {
      expect(line).toContain('검사 스크립트');
      // 한정 없는 「게이트 N개」는 가이드 화면의 숫자와 충돌한다.
      expect(line).not.toMatch(/게이트\s*\d+개/);
    }
  });

  it('🔴 못 갖춘 이름을 전부 늘어놓지 않는다 — 화면이 작업 목록이 되면 안 된다', () => {
    const many = Array.from({ length: 20 }, (_, i) => row(`g${i}`, true, false, true));
    const axes = summarizeGateControl(many);
    const runnableAxis = axes[1]!;

    expect(runnableAxis.missing.length).toBeLessThanOrEqual(6);
    // 🔴 자른 사실을 잃지 않는다 — 조용히 자르면 여섯 개가 전부인 줄 안다(§5 3항).
    expect(runnableAxis.missingMore).toBe(20 - runnableAxis.missing.length);
  });

  it('적으면 자르지 않고 「외 N개」도 없다', () => {
    const axes = summarizeGateControl([row('a', true, false, true)]);

    expect(axes[1]!.missing).toEqual(['a']);
    expect(axes[1]!.missingMore).toBe(0);
  });

  it('🔴 이 표가 「검사 통과」가 아님을 화면 문장이 먼저 말한다', () => {
    expect(GATE_CONTROL_DISCLAIMER).toContain('앱이 알 수 없');
    expect(GATE_CONTROL_DISCLAIMER).toContain('계약');
    // 「통과」·「정상」이라는 말을 쓰지 않는다 — 그렇게 읽히는 순간 거짓이 된다.
    expect(GATE_CONTROL_DISCLAIMER).not.toMatch(/통과|정상|안전/);
  });
});
