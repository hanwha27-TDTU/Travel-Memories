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
    // 대신 관계를 잰다: 실장 도메인은 하나 이상이고, 서버로 안 가는 것은 **이유가 있어야** 한다.
    const built = SOURCES.filter((s) => s.implemented);
    expect(built.length).toBeGreaterThan(0);
    for (const s of built) {
      // 서버 배선이 없는데 이유도 없으면 그건 결함이다(§7 — 이유 없는 제외 금지).
      if (!s.hasSync) expect(s.localOnlyReason, `${s.label}에 localOnlyReason이 없다`).toBeTruthy();
    }
    // 그룹 분모는 **서버로 가는 도메인 수**다(로컬 전용은 rowmap·sync 분모에서 빠진다).
    const synced = built.filter((s) => !s.localOnlyReason).length;
    for (const g of c.groups) {
      expect(g.total === synced || g.total === built.length).toBe(true);
    }
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
