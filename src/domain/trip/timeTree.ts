// domain/trip/timeTree.ts — 홈 기간 트리(연도▸월)의 순수 로직.
//
// 왜 순수 함수인가(§10 ③): 트리 구성·필터 판정·현재 선택 문장은 전부 사용자에게 나가는
// 판정이다. DOM 클로저에 넣으면 갈래를 검사할 수 없다 — 유닛이 level만이 아니라 문장도 잰다.
//
// 왜 여행 데이터에서 파생하는가(SSOT): 트리를 손으로 관리하면 반드시 낡는다. 여행이 있는
// 연·월만 나타나고(빈 달은 침묵 — §8), 새 여행이 생기면 트리가 자동으로 따라온다.

export interface PeriodSel {
  /** 'YYYY'. 없으면 전체. */
  year?: string;
  /** 'MM' (year와 함께만 의미). */
  month?: string;
  /** 기간 미정(시작일 없음) 여행만. year와 배타. */
  undated?: boolean;
}

export interface TimeTreeMonth {
  month: string; // 'MM'
  count: number;
}
export interface TimeTreeYear {
  year: string; // 'YYYY'
  count: number;
  months: TimeTreeMonth[]; // 최신 월 먼저
}
export interface TimeTree {
  years: TimeTreeYear[]; // 최신 연도 먼저
  undated: number;
  total: number;
}

/**
 * 시작일에서 연·월을 뽑는다. 모양이 'YYYY-MM…'이 아니면 null — 쓰레기 값을 가짜 연도로
 * 반올림하지 않는다(자료계층이 막지 못한 값은 화면계층이 한 번 더 막는다 · app.css 등록부 1.35).
 */
export function tripYearMonth(startDate: string | null | undefined): { year: string; month: string } | null {
  if (!startDate) return null;
  const m = /^(\d{4})-(\d{2})/.exec(startDate);
  if (!m) return null;
  return { year: m[1]!, month: m[2]! };
}

/** 여행 목록 → 연도▸월 트리(최신 먼저, 개수 포함). 시작일 없는 여행은 undated로 집계. */
export function buildTimeTree(trips: ReadonlyArray<{ startDate?: string | null }>): TimeTree {
  const years = new Map<string, Map<string, number>>();
  let undated = 0;
  for (const t of trips) {
    const ym = tripYearMonth(t.startDate);
    if (!ym) {
      undated += 1;
      continue;
    }
    const months = years.get(ym.year) ?? new Map<string, number>();
    months.set(ym.month, (months.get(ym.month) ?? 0) + 1);
    years.set(ym.year, months);
  }
  const yearList: TimeTreeYear[] = [...years.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([year, months]) => {
      const monthList: TimeTreeMonth[] = [...months.entries()]
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([month, count]) => ({ month, count }));
      return { year, count: monthList.reduce((n, m) => n + m.count, 0), months: monthList };
    });
  return { years: yearList, undated, total: trips.length };
}

/** 선택된 기간에 이 여행이 들어가는가. 선택이 비면(전체) 항상 true. */
export function matchesPeriod(t: { startDate?: string | null }, sel: PeriodSel): boolean {
  if (sel.undated) return tripYearMonth(t.startDate) === null;
  if (!sel.year) return true;
  const ym = tripYearMonth(t.startDate);
  if (!ym || ym.year !== sel.year) return false;
  return !sel.month || ym.month === sel.month;
}

/**
 * 여행 목록을 시작일 최신순으로 복사해 돌려준다.
 * 날짜가 없거나 형식이 잘못된 항목은 뒤로 보내고, 같은 날짜끼리는 입력 순서를 보존한다.
 */
export function sortTripsNewestFirst<T extends { startDate?: string | null }>(trips: ReadonlyArray<T>): T[] {
  return trips
    .map((trip, index) => ({ trip, index, dated: tripYearMonth(trip.startDate) !== null }))
    .sort((a, b) => {
      if (a.dated !== b.dated) return a.dated ? -1 : 1;
      if (!a.dated || !b.dated) return a.index - b.index;
      const byDate = (b.trip.startDate ?? '').localeCompare(a.trip.startDate ?? '');
      return byDate || a.index - b.index;
    })
    .map(({ trip }) => trip);
}

/** 현재 선택을 사용자 문장으로. '전체'는 화면이 침묵하는 근거로 쓴다(그릴지 말지는 화면 몫). */
export function periodLabel(sel: PeriodSel): string {
  if (sel.undated) return '기간 미정';
  if (!sel.year) return '전체';
  if (!sel.month) return `${sel.year}년`;
  return `${sel.year}년 ${monthLabel(sel.month)}`;
}

/** '07' → '7월'. */
export function monthLabel(month: string): string {
  return `${String(Number(month))}월`;
}
