// blueprint 자가점검(순수) — 실장 도메인이 왕복·동기화·화면까지 배선됐는지 점수화.
import { describe, it, expect } from 'vitest';
import { selfCheck, SOURCES, SCREENS } from '../../src/app/blueprint';

describe('blueprint selfCheck', () => {
  it('현재 구조: 실장 도메인이 모두 배선됨(끊긴 배선 0·점수 100)', () => {
    const c = selfCheck();
    expect(c.gaps).toEqual([]);
    expect(c.score).toBe(100);
    expect(c.got).toBe(c.total);
    // 실장 도메인 수는 **손으로 적지 않는다** — 도메인이 늘 때마다 이 숫자가 낡는다(M-0001).
    // 대신 관계를 잰다: 실장 도메인은 하나 이상이고, **전부 서버로 간다.**
    const built = SOURCES.filter((s) => s.implemented);
    expect(built.length).toBeGreaterThan(0);
    // 🔴 뒤집힌 케이스(2026-07-27): 예전엔 *"서버 배선이 없으면 `localOnlyReason`이 있어야
    //    한다"*였다. 그 예외 구멍 자체가 사라졌으므로 이제 **예외 없이** 배선을 요구한다.
    //    전제가 바뀌면 케이스를 먼저 뒤집는다(§11 ②).
    for (const s of built) {
      expect(s.hasRowmap, `${s.label}에 rowmap이 없다`).toBe(true);
      expect(s.hasSync, `${s.label}에 동기화 배선이 없다`).toBe(true);
    }
    for (const g of c.groups) expect(g.total).toBe(built.length);
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
