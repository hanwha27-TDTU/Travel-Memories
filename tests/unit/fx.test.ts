import { describe, it, expect } from 'vitest';
import {
  convertAmount,
  convertTotals,
  fxDateFor,
  fxKey,
  isFxFresh,
  localDate,
  rateOf,
  unitRate,
  formatRate,
  type FxRateTable,
} from '../../src/domain/expense/fx';

// 기준통화 KRW 표(고정 픽스처 — 네트워크 없이 계산을 잠근다).
// 1 KRW = 9.2 UZS, 1 KRW = 0.00072 USD
const T: FxRateTable = {
  date: '2026-07-16',
  base: 'KRW',
  rates: { UZS: 9.2, USD: 0.00072, JPY: 0.11 },
  source: 'test',
  fetchedAt: '2026-07-16T09:00:00.000Z',
};

describe('rateOf', () => {
  it('기준통화 자신은 1', () => {
    expect(rateOf(T, 'KRW')).toBe(1);
    expect(rateOf(T, 'krw')).toBe(1); // 대소문자 무관
  });
  it('표에 있는 통화는 그 비율', () => {
    expect(rateOf(T, 'UZS')).toBe(9.2);
  });
  it('없는 통화는 null(위조하지 않음)', () => {
    expect(rateOf(T, 'XXX')).toBeNull();
  });
  it('0·음수·비정상 비율은 null', () => {
    const bad: FxRateTable = { ...T, rates: { A: 0, B: -1, C: NaN } };
    expect(rateOf(bad, 'A')).toBeNull();
    expect(rateOf(bad, 'B')).toBeNull();
    expect(rateOf(bad, 'C')).toBeNull();
  });
});

describe('convertAmount — 표 하나로 양방향', () => {
  it('외화 → 원화 (솜을 원화로)', () => {
    // 92,000 UZS ÷ 9.2 = 10,000 KRW
    expect(convertAmount(92000, 'UZS', 'KRW', T)).toBeCloseTo(10000, 6);
  });
  it('원화 → 외화 (원화를 솜으로)', () => {
    expect(convertAmount(10000, 'KRW', 'UZS', T)).toBeCloseTo(92000, 6);
  });
  it('외화 → 외화 (기준통화 경유)', () => {
    // 1 USD = 1/0.00072 KRW ≈ 1388.89 KRW → ×9.2 UZS
    const v = convertAmount(1, 'USD', 'UZS', T);
    expect(v).toBeCloseTo((1 / 0.00072) * 9.2, 6);
  });
  it('같은 통화는 그대로(환율 없어도)', () => {
    expect(convertAmount(500, 'XXX', 'XXX', T)).toBe(500);
  });
  it('왕복하면 원래 값(정보 손실 없음)', () => {
    const there = convertAmount(12345, 'KRW', 'UZS', T)!;
    expect(convertAmount(there, 'UZS', 'KRW', T)).toBeCloseTo(12345, 6);
  });
  it('모르는 통화는 null — 0으로 얼버무리지 않는다', () => {
    expect(convertAmount(100, 'XXX', 'KRW', T)).toBeNull();
    expect(convertAmount(100, 'KRW', 'XXX', T)).toBeNull();
  });
  it('비정상 금액은 null', () => {
    expect(convertAmount(NaN, 'UZS', 'KRW', T)).toBeNull();
  });
});

describe('isFxFresh — 과거는 확정, 오늘만 만료', () => {
  it('과거 날짜 표는 영구 유효(오래 전에 받았어도)', () => {
    const old: FxRateTable = { ...T, date: '2026-07-01', fetchedAt: '2026-07-01T00:00:00.000Z' };
    expect(isFxFresh(old, '2026-07-16', '2026-07-16T23:00:00.000Z')).toBe(true);
  });
  it('오늘 표는 TTL 안이면 유효', () => {
    expect(isFxFresh(T, '2026-07-16', '2026-07-16T12:00:00.000Z', 6)).toBe(true);
  });
  it('오늘 표는 TTL 지나면 만료', () => {
    expect(isFxFresh(T, '2026-07-16', '2026-07-16T20:00:00.000Z', 6)).toBe(false);
  });
});

describe('날짜 처리', () => {
  it('fxKey는 날짜+기준통화(대문자)', () => {
    expect(fxKey('2026-07-16', 'krw')).toBe('2026-07-16|KRW');
  });
  it('localDate는 YYYY-MM-DD', () => {
    expect(localDate('2026-07-16T06:48:00.000Z')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it('잘못된 ISO는 빈 문자열', () => {
    expect(localDate('nope')).toBe('');
  });
  it('fxDateFor: 사용일을 쓰되 미래는 오늘로 당긴다', () => {
    expect(fxDateFor('2026-07-10T00:00:00.000Z', '2026-07-16')).toBe(
      localDate('2026-07-10T00:00:00.000Z'),
    );
    expect(fxDateFor('2027-01-01T00:00:00.000Z', '2026-07-16')).toBe('2026-07-16');
  });
});

describe('unitRate / formatRate — 사용자가 검산할 수 있는 표시', () => {
  it('unitRate: 1 UZS = ? KRW (양방향 역수 관계)', () => {
    const a = unitRate('UZS', 'KRW', T)!;
    const b = unitRate('KRW', 'UZS', T)!;
    expect(a).toBeCloseTo(1 / 9.2, 10);
    expect(b).toBeCloseTo(9.2, 10);
    expect(a * b).toBeCloseTo(1, 10); // 서로 역수
  });
  it('unitRate: 모르는 통화는 null', () => {
    expect(unitRate('XXX', 'KRW', T)).toBeNull();
  });
  it('formatRate: 1 미만은 유효숫자 4자리(0으로 뭉개지지 않음)', () => {
    expect(formatRate(0.1233)).toBe('0.1233');
    expect(formatRate(0.00072)).toBe('0.00072');
  });
  it('formatRate: 1 이상은 소수 4자리까지', () => {
    expect(formatRate(9.2)).toBe('9.2');
    expect(formatRate(1388.888888)).toBe('1,388.89');
  });
  it('formatRate: 비정상 값은 —', () => {
    expect(formatRate(0)).toBe('—');
    expect(formatRate(NaN)).toBe('—');
  });
  it('환산값과 단위환율이 일치(검산 가능)', () => {
    const amount = 50000;
    const conv = convertAmount(amount, 'UZS', 'KRW', T)!;
    const r = unitRate('UZS', 'KRW', T)!;
    expect(amount * r).toBeCloseTo(conv, 6);
  });
});

describe('convertTotals — 환산 못 한 통화를 숨기지 않는다', () => {
  it('환산 가능한 것만 더하고 나머지는 skipped', () => {
    const { total, skipped } = convertTotals({ KRW: 10000, UZS: 92000, XXX: 5 }, 'KRW', T);
    expect(total).toBeCloseTo(20000, 6);
    expect(skipped).toEqual(['XXX']);
  });
  it('빈 합계는 0·빈 skipped', () => {
    expect(convertTotals({}, 'KRW', T)).toEqual({ total: 0, skipped: [] });
  });
});
