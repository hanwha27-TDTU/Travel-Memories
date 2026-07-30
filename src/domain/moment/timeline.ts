// domain/moment/timeline.ts — 타임라인 구성 순수함수(도메인 로직 SSOT).
// UI가 아니라 여기서 날짜 그룹핑·정렬·Day 번호를 결정한다(tests/unit에서 직접 검증).

import type { LocalMoment } from '../../offline/db';
import { momentWhen, compareInstants, type TripClock } from '../time';

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
 * 순간이 속한 "그 날" = **그 자리에서 겪은 달력 날짜**(domain/time.ts 계약).
 *
 * 두 번 고쳤다. ①ISO를 자르면 UTC 날짜가 나와 한국 새벽 기록이 전날에 묶였다(M-utc-slice).
 * ②그 다음엔 **보는 기기의** 로컬 날짜였다 — 베트남 여행을 한국에서 열면 자정 근처 순간이
 * 하루 밀린다(M-0049 후반). 이제 여행 시간대로 잰다.
 *
 * 🔴 Day 묶기가 표시보다 무겁다: 시각은 두 시간 틀려도 「저녁쯤」으로 읽히지만, 날짜가
 * 밀리면 **없던 Day가 생기고** 하루가 두 조각으로 갈린다.
 */
function dayKey(m: LocalMoment, clock: TripClock): string {
  return momentWhen(m.occurredAt || m.createdAt, m.tzOffsetMin, clock).date;
}

/**
 * 활성 순간을 날짜별로 묶고, 날짜 오름차순·같은 날은 발생시각 오름차순으로 정렬한다.
 * tombstone(deletedAt≠null)은 제외한다. tripStartDate가 있으면 Day 번호를 붙인다.
 *
 * 🔴 `clock`이 **두 번째 인자**다(옛 판은 `(moments, tripStartDate?)`였다). 순서를 바꾼 것은
 * 의도다 — 새 인자를 뒤에 옵션으로 붙이면 기존 호출부가 조용히 옛 동작을 유지하고, 그게
 * §7이 말하는 「다음 형제가 자동으로 따라오지 않는」 상태다. 이제 **컴파일이 막는다.**
 */
export function groupMomentsByDay(moments: LocalMoment[], clock: TripClock, tripStartDate?: string): DayGroup[] {
  const byDate = new Map<string, LocalMoment[]>();
  for (const m of moments) {
    if (m.deletedAt !== null) continue;
    const k = dayKey(m, clock);
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
        // ⚠️ **순간으로 비교한다 — 문자열 대소가 아니라**(M-0034·자기점검 2026-07-27).
        // 예전엔 `localeCompare`였다. 표기를 경계에서 정규화하도록 고쳤지만 **비교까지 바꾸지
        // 않으면 방어선이 하나뿐**이고, 옛 표기가 한 줄만 남아도 순서가 흔들린다.
        // `mergeDecision`은 이미 `compareInstants`를 쓰는데 여기만 문자열이었다 — §7 비대칭.
        // 못 읽는 값은 0(동률)으로 두고 아래 안정 정렬에 맡긴다: 지어낸 순서를 만들지 않는다.
        .sort((a, b) => compareInstants(a.occurredAt || a.createdAt, b.occurredAt || b.createdAt) ?? 0);
      let dayNumber: number | null = null;
      if (!Number.isNaN(start)) {
        const d = Date.parse(`${date}T00:00:00Z`);
        if (!Number.isNaN(d)) dayNumber = Math.floor((d - start) / MS_PER_DAY) + 1;
      }
      return { date, dayNumber, items };
    });
}
