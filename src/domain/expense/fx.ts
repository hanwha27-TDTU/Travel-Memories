// domain/expense/fx.ts — 환율 환산의 순수 로직(네트워크·저장 없음. 테스트로 잠금).
//
// 비타협 원칙: **원금액 불변(H-04)**. 사용자가 적은 금액·통화는 절대 덮어쓰지 않는다.
// 환산값은 "기계가 파생한 표시용 보조값"이며 사용자 기록과 시각적으로 구분한다(원칙 #2).
//
// 왜 날짜별 표(FxRateTable)인가: 비용은 **사용일 환율** 기준이어야 한다. 과거 날짜의 기준환율은
// 확정값이라 한 번 받아두면 영원히 안 변한다 → 캐시가 곧 안정적 표시를 보장한다(값이 나중에 흔들리지 않음).
// 기준통화 하나로 표를 받아두면 임의의 두 통화 사이를 이 표 하나로 왕복 환산할 수 있다(§rateOf).

import { localDate } from '../time';

export { localDate }; // 날짜 파생 SSOT는 domain/time.ts (결함군 M-utc-slice)

/** 특정 날짜·기준통화의 환율 표. rates[X] = 1 base 당 X의 수량. */
export interface FxRateTable {
  /** 실제 적용된 환율 날짜 'YYYY-MM-DD'. 주말·공휴일이면 요청일보다 이를 수 있다(정직하게 표시). */
  date: string;
  /** 기준통화(대문자). rates에 base 자신은 없을 수 있으며 rateOf가 1로 처리한다. */
  base: string;
  /** 통화코드(대문자) → 비율. */
  rates: Record<string, number>;
  /** 데이터 출처 식별자(표시·감사용). */
  source: string;
  /** 이 표를 받아온 시각(ISO) — 'latest'(오늘) 표의 신선도 판정에만 쓴다. */
  fetchedAt: string;
}

/** 캐시 키 — 날짜+기준통화 하나당 표 하나. */
export function fxKey(date: string, base: string): string {
  return `${date}|${base.toUpperCase()}`;
}


/** 표 안에서 통화 하나의 비율. 기준통화 자신은 1. 없으면 null(위조하지 않는다). */
export function rateOf(table: FxRateTable, currency: string): number | null {
  const cur = currency.toUpperCase();
  if (cur === table.base.toUpperCase()) return 1;
  const r = table.rates[cur];
  return typeof r === 'number' && Number.isFinite(r) && r > 0 ? r : null;
}

/**
 * from 통화의 금액을 to 통화로 환산. 표 하나로 양방향(외화→원화, 원화→외화) 모두 처리한다.
 * 값을 만들 수 없으면 **null**(0이나 추정치로 얼버무리지 않는다 — 정직).
 */
export function convertAmount(
  amount: number,
  from: string,
  to: string,
  table: FxRateTable,
): number | null {
  if (!Number.isFinite(amount)) return null;
  if (from.toUpperCase() === to.toUpperCase()) return amount;
  const rFrom = rateOf(table, from);
  const rTo = rateOf(table, to);
  if (rFrom === null || rTo === null) return null;
  const inBase = amount / rFrom; // from → 기준통화
  return inBase * rTo; // 기준통화 → to
}

/**
 * 캐시 신선도. **과거 날짜 표는 영구 유효**(확정된 기준환율은 안 바뀐다).
 * 오늘 날짜 표만 ttl 시간이 지나면 다시 받는다.
 */
export function isFxFresh(
  table: FxRateTable,
  todayDate: string,
  nowIso: string,
  ttlHours = 6,
): boolean {
  if (table.date < todayDate) return true; // 과거 = 확정
  const fetched = new Date(table.fetchedAt).getTime();
  const now = new Date(nowIso).getTime();
  if (Number.isNaN(fetched) || Number.isNaN(now)) return false;
  return now - fetched < ttlHours * 3600 * 1000;
}

/**
 * 요청할 환율 날짜를 정한다. 미래 날짜는 존재하지 않으므로 오늘로 당긴다.
 * (사용자가 발생 시각을 미래로 적어둔 경우를 조용히 실패시키지 않기 위함)
 */
export function fxDateFor(occurredAtIso: string, todayDate: string): string {
  const d = localDate(occurredAtIso);
  if (!d) return todayDate;
  return d > todayDate ? todayDate : d;
}

/** 1 from = ? to (단위 환율). 환산 상세를 사용자가 검산할 수 있게 노출하는 값. */
export function unitRate(from: string, to: string, table: FxRateTable): number | null {
  return convertAmount(1, from, to, table);
}

/**
 * 환율 숫자 표시 — 통화 소수자릿수(KRW=0)를 쓰면 0.1233이 "₩0"으로 뭉개지므로 별도 규칙.
 * 1 이상은 소수 2~4자리, 1 미만은 유효숫자 4자리(작은 환율도 의미 있는 자리까지 보인다).
 */
export function formatRate(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  const s = n.toPrecision(4);
  if (!s.includes('.') || s.includes('e')) return s; // 지수표기는 그대로(극단값)
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

/** 통화별 합계를 기준통화 하나로 환산해 더한다. 환산 불가 통화는 skipped에 남긴다(숨기지 않음). */
export function convertTotals(
  totals: Record<string, number>,
  base: string,
  table: FxRateTable,
): { total: number; skipped: string[] } {
  let total = 0;
  const skipped: string[] = [];
  for (const [cur, amt] of Object.entries(totals)) {
    const v = convertAmount(amt, cur, base, table);
    if (v === null) skipped.push(cur);
    else total += v;
  }
  return { total, skipped };
}
