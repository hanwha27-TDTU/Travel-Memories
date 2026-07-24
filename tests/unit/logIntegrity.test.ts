// 버전/연구노트 append-only 무결성(기계화) — 손으로 세지 않고 배열 자체를 검사한다.
// changelog: 최신이 위·0.01 단위 연속·날짜 비증가. researchLog: seq 1..N 연속·날짜 비감소.
import { describe, it, expect } from 'vitest';
import { CHANGELOG } from '../../src/app/changelog';
import { RESEARCH_LOG } from '../../src/app/researchLog';

describe('changelog 무결성', () => {
  it('버전은 최신이 위이고 0.01 단위로 연속', () => {
    const nums = CHANGELOG.map((e) => Math.round(parseFloat(e.version) * 100));
    for (let i = 1; i < nums.length; i += 1) {
      expect(nums[i - 1]! - nums[i]!).toBe(1); // 바로 위가 정확히 +0.01
    }
  });
  it('날짜는 위(최신)로 갈수록 비증가(내림차순 허용)', () => {
    for (let i = 1; i < CHANGELOG.length; i += 1) {
      expect(CHANGELOG[i - 1]!.date >= CHANGELOG[i]!.date).toBe(true);
    }
  });
  it('모든 항목에 notes가 하나 이상', () => {
    for (const e of CHANGELOG) expect(e.notes.length).toBeGreaterThan(0);
  });
});

describe('researchLog 무결성', () => {
  it('seq는 1..N 연속(append-only·재배열 금지)', () => {
    RESEARCH_LOG.forEach((e, i) => expect(e.seq).toBe(i + 1));
  });
  it('날짜는 아래(과거)에서 위(최근)로 비감소', () => {
    for (let i = 1; i < RESEARCH_LOG.length; i += 1) {
      expect(RESEARCH_LOG[i]!.date >= RESEARCH_LOG[i - 1]!.date).toBe(true);
    }
  });
  it('각 항목에 human·ai·decision이 채워짐', () => {
    for (const e of RESEARCH_LOG) {
      expect(e.human.length).toBeGreaterThan(0);
      expect(e.ai.length).toBeGreaterThan(0);
      expect(e.decision.length).toBeGreaterThan(0);
    }
  });
});
