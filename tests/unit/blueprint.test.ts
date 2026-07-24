// blueprint 자가점검(순수) — 실장 도메인이 왕복·동기화·화면까지 배선됐는지 점수화.
import { describe, it, expect } from 'vitest';
import { selfCheck, SOURCES, SCREENS } from '../../src/app/blueprint';

describe('blueprint selfCheck', () => {
  it('현재 구조: 실장 도메인이 모두 배선됨(끊긴 배선 0·점수 100)', () => {
    const c = selfCheck();
    expect(c.gaps).toEqual([]);
    expect(c.score).toBe(100);
    expect(c.got).toBe(c.total);
    // 3개 점검 그룹, 각 그룹 total = 실장 도메인 수(4)
    const built = SOURCES.filter((s) => s.implemented).length;
    expect(built).toBe(4);
    for (const g of c.groups) expect(g.total).toBe(built);
  });

  it('로드맵(계획 도메인)은 감점이 아니라 정직한 예정으로 표시', () => {
    const c = selfCheck();
    const planned = SOURCES.filter((s) => !s.implemented).map((s) => s.label);
    expect(c.roadmap).toEqual(planned);
    expect(planned.length).toBeGreaterThan(0);
  });

  it('모든 실장 발전원은 최소 한 화면에 닿는다(끊긴 배선 없음)', () => {
    for (const s of SOURCES.filter((x) => x.implemented)) {
      expect(SCREENS.some((sc) => sc.feeds.includes(s.key))).toBe(true);
    }
  });

  it('feeds가 참조하는 소스 키는 모두 SOURCES에 존재(유령 배선 금지)', () => {
    const keys = new Set(SOURCES.map((s) => s.key));
    for (const sc of SCREENS) for (const f of sc.feeds) expect(keys.has(f)).toBe(true);
  });
});
