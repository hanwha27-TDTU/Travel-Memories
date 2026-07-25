// tests/unit/verdict.test.ts — **판정 계약**이 실제로 지켜지는가(정적 게이트가 못 보는 층).
//
// check-verdict-symmetry.mjs 는 "필드가 있다"까지만 본다. 여기서는 실제로 실행해서
// **정상과 이상이 구분되는가**를 본다 — 그게 이 도구들의 존재 이유다(사용자 지적 2026-07-26).
//
// 각 검사는 쌍으로 간다: 잡아야 할 경우 / 잡으면 안 되는 경우. 거짓 경보는 결함만큼 해롭다(M-0008).

import { describe, it, expect } from 'vitest';
import { worst, levelFromMetrics, LEVELS, emptyVerdict, type Metric, type Level } from '../../src/ui/panels/verdict';

const m = (level: Level, label = 'x'): Metric => ({ label, actual: 'a', expected: 'b', level });

describe('판정 롤업 — 가장 급한 것이 이긴다', () => {
  it('문제 > 할 일 > 확인 불가 > 정상 순으로 이긴다', () => {
    expect(worst(['ok', 'todo'])).toBe('todo');
    expect(worst(['todo', 'problem'])).toBe('problem');
    expect(worst(['ok', 'unknown'])).toBe('unknown');
    expect(worst(['unknown', 'todo'])).toBe('todo');
    expect(worst(['ok', 'ok', 'ok'])).toBe('ok');
  });

  it('빈 목록은 정상이 아니라 **확인 불가**다 — 미검사를 통과로 적지 않는다(원칙 #4)', () => {
    expect(worst([])).toBe('unknown');
  });

  it('순서가 달라도 결과가 같다(교환법칙)', () => {
    expect(worst(['problem', 'ok', 'unknown'])).toBe(worst(['unknown', 'ok', 'problem']));
  });
});

describe('전체 판정은 지표에서 파생된다 — 자기모순이 구조적으로 불가능하다', () => {
  it('지표 중 하나라도 문제면 전체가 문제다', () => {
    expect(levelFromMetrics([m('ok'), m('ok'), m('problem')])).toBe('problem');
  });

  it('전부 정상이어야 전체가 정상이다', () => {
    expect(levelFromMetrics([m('ok'), m('ok')])).toBe('ok');
  });

  it('할 일 하나가 정상 여럿에 묻히지 않는다', () => {
    expect(levelFromMetrics([m('ok'), m('ok'), m('ok'), m('todo')])).toBe('todo');
  });

  it('확인 불가는 정상으로 반올림되지 않는다', () => {
    expect(levelFromMetrics([m('ok'), m('unknown')])).toBe('unknown');
  });
});

describe('판정 4단의 시각 어휘', () => {
  it('네 판정 모두 글리프와 이름을 갖는다 — 색만으로 인코딩하지 않는다', () => {
    for (const k of ['ok', 'todo', 'problem', 'unknown'] as Level[]) {
      expect(LEVELS[k].glyph.length).toBeGreaterThan(0);
      expect(LEVELS[k].name.length).toBeGreaterThan(0);
    }
  });

  it('글리프가 서로 겹치지 않는다(흑백·색각에서도 구분)', () => {
    const gs = Object.values(LEVELS).map((l) => l.glyph);
    expect(new Set(gs).size).toBe(gs.length);
  });

  it('위험 순위가 서로 겹치지 않는다 — 롤업이 애매해지지 않게', () => {
    const rs = Object.values(LEVELS).map((l) => l.rank);
    expect(new Set(rs).size).toBe(rs.length);
  });
});

describe('빈 골격', () => {
  it('emptyVerdict는 모든 배열 필드를 채운 채로 준다(undefined 접근 방지)', () => {
    const v = emptyVerdict('unknown', '아직');
    expect(v.metrics).toEqual([]);
    expect(v.actions).toEqual([]);
    expect(v.evidence).toEqual([]);
    expect(v.context).toEqual([]);
  });
});
