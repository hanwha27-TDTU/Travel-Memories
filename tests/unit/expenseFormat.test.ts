import { describe, it, expect } from 'vitest';
import {
  formatMoney,
  sumByCurrency,
  formatTotals,
  DEFAULT_CURRENCY,
  CURRENCIES,
  currencyFlag,
  currencyLabel,
} from '../../src/domain/expense/format';

describe('formatMoney', () => {
  it('KRW: 소수 없음 + 천단위 구분', () => {
    expect(formatMoney(12000, 'KRW')).toBe('₩12,000');
    expect(formatMoney(1234567, 'KRW')).toBe('₩1,234,567');
  });
  it('USD: 소수 2자리', () => {
    expect(formatMoney(15, 'USD')).toBe('$15.00');
    expect(formatMoney(1234.5, 'USD')).toBe('$1,234.50');
  });
  it('UZS: 소수 없음 + 심볼 뒤(soʻm 관례) / JPY: 앞', () => {
    expect(formatMoney(1000000, 'UZS')).toBe('1,000,000 soʻm');
    expect(formatMoney(500, 'JPY')).toBe('¥500');
  });
  it('심볼 있는 통화는 앞에(£), 없는 통화는 코드를 뒤에(AED·CHF — 심볼 위조 안 함)', () => {
    expect(formatMoney(1000, 'GBP')).toBe('£1,000.00');
    expect(formatMoney(1000, 'AED')).toBe('1,000.00 AED');
    expect(formatMoney(1000, 'CHF')).toBe('1,000.00 CHF');
  });
  it('북유럽 kr·PLN zł은 관례상 심볼 뒤', () => {
    expect(formatMoney(1000, 'NOK')).toBe('1,000.00 kr');
    expect(formatMoney(1000, 'SEK')).toBe('1,000.00 kr');
    expect(formatMoney(1000, 'PLN')).toBe('1,000.00 zł');
  });
  it('진짜 알 수 없는 통화도 코드를 붙인다', () => {
    expect(formatMoney(100, 'XXX')).toBe('100.00 XXX');
  });
  it('기본 통화는 KRW', () => {
    expect(DEFAULT_CURRENCY).toBe('KRW');
  });
  it('국기는 코드에서 파생(손 테이블 없음) — 앞 두 글자 = 국가코드', () => {
    expect(currencyFlag('KRW')).toBe('🇰🇷');
    expect(currencyFlag('UZS')).toBe('🇺🇿');
    expect(currencyFlag('USD')).toBe('🇺🇸');
    expect(currencyFlag('EUR')).toBe('🇪🇺'); // EU도 유효한 지역 표시자쌍
    expect(currencyFlag('krw')).toBe('🇰🇷'); // 대소문자 무관
  });
  it('나라 없는 통화(X 접두 초국가 코드)는 빈 문자열 — 위조하지 않음', () => {
    expect(currencyFlag('XAF')).toBe('');
    expect(currencyFlag('XDR')).toBe('');
    expect(currencyFlag('')).toBe('');
  });
  it('currencyLabel: 국기 + 심볼 + 코드, 심볼 없으면 건너뜀', () => {
    expect(currencyLabel({ code: 'KRW', symbol: '₩', decimals: 0 })).toBe('🇰🇷 ₩ KRW');
    expect(currencyLabel({ code: 'AED', symbol: '', decimals: 2 })).toBe('🇦🇪 AED');
  });
  it('지원 통화 전부가 국기를 가진다(새 통화 추가 시 자동 검증)', () => {
    const missing = CURRENCIES.filter((c) => currencyFlag(c.code) === '').map((c) => c.code);
    expect(missing).toEqual([]);
  });
  it('통화 목록: 코드 유일 + 자주 쓰는 통화가 위(순서 KRW·USD·UZS·JPY·EUR)', () => {
    const codes = CURRENCIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length); // 중복 없음
    expect(codes.slice(0, 5)).toEqual(['KRW', 'USD', 'UZS', 'JPY', 'EUR']);
  });
});

describe('sumByCurrency', () => {
  it('같은 통화는 더하고 다른 통화는 분리', () => {
    const totals = sumByCurrency([
      { originalAmount: 12000, originalCurrency: 'KRW' },
      { originalAmount: 3000, originalCurrency: 'KRW' },
      { originalAmount: 15, originalCurrency: 'USD' },
    ]);
    expect(totals).toEqual({ KRW: 15000, USD: 15 });
  });
  it('빈 목록은 빈 합계', () => {
    expect(sumByCurrency([])).toEqual({});
  });
  it('NaN 금액은 건너뛴다', () => {
    expect(sumByCurrency([{ originalAmount: NaN, originalCurrency: 'KRW' }])).toEqual({});
  });
});

describe('formatTotals', () => {
  it('통화별 합계를 정렬해 표시 문자열로', () => {
    expect(formatTotals({ USD: 15, KRW: 15000 })).toEqual(['₩15,000', '$15.00']);
  });
});
