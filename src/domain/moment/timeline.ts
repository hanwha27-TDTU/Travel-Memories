// domain/moment/timeline.ts — 타임라인 구성 순수함수(도메인 로직 SSOT).
// UI가 아니라 여기서 날짜 그룹핑·정렬·Day 번호를 결정한다(tests/unit에서 직접 검증).

import type { LocalMoment } from '../../offline/db';
import { localDate } from '../time';

export interface DayGroup {
  /** YYYY-MM-DD */
  date: string;
  /** 여행 시작일 기준 Day 번호(시작일 있을 때만; 없으면 null). */
  dayNumber: number | null;
  /** 발생 시각 오름차순 정렬된 순간들. */
  items: LocalMoment[];
}

const MS_PER_DAY = 86_400_000;

/**
 * 순간이 속한 "그 날" = **사용자의 로컬 달력 날짜**(domain/time.ts 계약).
 * ISO 문자열을 자르면 UTC 날짜가 나와, 한국 새벽 기록이 전날 그룹에 묶인다(결함군 M-utc-slice).
 */
function dayKey(m: LocalMoment): string {
  return localDate(m.occurredAt || m.createdAt);
}

/**
 * 활성 순간을 날짜별로 묶고, 날짜 오름차순·같은 날은 발생시각 오름차순으로 정렬한다.
 * tombstone(deletedAt≠null)은 제외한다. tripStartDate가 있으면 Day 번호를 붙인다.
 */
export function groupMomentsByDay(moments: LocalMoment[], tripStartDate?: string): DayGroup[] {
  const byDate = new Map<string, LocalMoment[]>();
  for (const m of moments) {
    if (m.deletedAt !== null) continue;
    const k = dayKey(m);
    const arr = byDate.get(k);
    if (arr) arr.push(m);
    else byDate.set(k, [m]);
  }

  const start = tripStartDate ? Date.parse(`${tripStartDate}T00:00:00Z`) : NaN;

  return [...byDate.keys()]
    .sort()
    .map((date) => {
      const items = byDate
        .get(date)!
        .slice()
        .sort((a, b) => (a.occurredAt || a.createdAt).localeCompare(b.occurredAt || b.createdAt));
      let dayNumber: number | null = null;
      if (!Number.isNaN(start)) {
        const d = Date.parse(`${date}T00:00:00Z`);
        if (!Number.isNaN(d)) dayNumber = Math.floor((d - start) / MS_PER_DAY) + 1;
      }
      return { date, dayNumber, items };
    });
}
