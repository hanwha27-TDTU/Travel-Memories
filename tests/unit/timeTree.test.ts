// 홈 기간 트리(연도▸월) — 파생·필터·문장의 순수 로직 검사.
// 문장까지 재는 이유: §10 ③ — 자료구조가 옳아도 사용자에게 가는 문장이 틀릴 수 있다.
import { describe, expect, it } from 'vitest';
import {
  buildTimeTree,
  matchesPeriod,
  monthLabel,
  periodLabel,
  tripYearMonth,
} from '../../src/domain/trip/timeTree';

const T = (startDate: string | null): { startDate: string | null } => ({ startDate });

describe('tripYearMonth', () => {
  it('YYYY-MM-DD에서 연·월을 뽑는다', () => {
    expect(tripYearMonth('2026-07-20')).toEqual({ year: '2026', month: '07' });
  });
  it('시작일이 없으면 null', () => {
    expect(tripYearMonth(null)).toBeNull();
    expect(tripYearMonth(undefined)).toBeNull();
    expect(tripYearMonth('')).toBeNull();
  });
  it('모양이 아닌 값은 가짜 연도로 반올림하지 않는다(null)', () => {
    expect(tripYearMonth('언젠가')).toBeNull();
    expect(tripYearMonth('26-07-20')).toBeNull();
  });
});

describe('buildTimeTree', () => {
  it('여행이 있는 연·월만, 최신 먼저, 개수와 함께', () => {
    const tree = buildTimeTree([
      T('2026-07-20'),
      T('2026-07-31'),
      T('2026-08-01'),
      T('2025-12-25'),
      T(null),
    ]);
    expect(tree.total).toBe(5);
    expect(tree.undated).toBe(1);
    expect(tree.years.map((y) => y.year)).toEqual(['2026', '2025']); // 최신 연도 먼저
    const y2026 = tree.years[0]!;
    expect(y2026.count).toBe(3);
    expect(y2026.months).toEqual([
      { month: '08', count: 1 }, // 최신 월 먼저
      { month: '07', count: 2 },
    ]);
    // 빈 달은 침묵 — 여행 없는 달(01~06 등)은 트리에 아예 없다.
    expect(y2026.months.some((m) => m.month === '06')).toBe(false);
  });
  it('빈 목록이면 빈 트리(총 0 · 연도 0 · 미정 0)', () => {
    expect(buildTimeTree([])).toEqual({ years: [], undated: 0, total: 0 });
  });
});

describe('matchesPeriod', () => {
  const jul = T('2026-07-20');
  const aug = T('2026-08-01');
  const none = T(null);
  it('전체(빈 선택)는 모두 통과', () => {
    expect(matchesPeriod(jul, {})).toBe(true);
    expect(matchesPeriod(none, {})).toBe(true);
  });
  it('연도 선택은 그 해만', () => {
    expect(matchesPeriod(jul, { year: '2026' })).toBe(true);
    expect(matchesPeriod(jul, { year: '2025' })).toBe(false);
    expect(matchesPeriod(none, { year: '2026' })).toBe(false); // 미정은 연도에 안 들어간다
  });
  it('월 선택은 그 달만', () => {
    expect(matchesPeriod(jul, { year: '2026', month: '07' })).toBe(true);
    expect(matchesPeriod(aug, { year: '2026', month: '07' })).toBe(false);
  });
  it('기간 미정 선택은 시작일 없는 여행만', () => {
    expect(matchesPeriod(none, { undated: true })).toBe(true);
    expect(matchesPeriod(jul, { undated: true })).toBe(false);
  });
});

describe('periodLabel — 사용자에게 나가는 문장', () => {
  it('전체 / 연도 / 연·월 / 기간 미정', () => {
    expect(periodLabel({})).toBe('전체');
    expect(periodLabel({ year: '2026' })).toBe('2026년');
    expect(periodLabel({ year: '2026', month: '07' })).toBe('2026년 7월'); // 앞자리 0 제거
    expect(periodLabel({ undated: true })).toBe('기간 미정');
  });
  it('monthLabel은 앞자리 0을 지운다', () => {
    expect(monthLabel('07')).toBe('7월');
    expect(monthLabel('12')).toBe('12월');
  });
});
