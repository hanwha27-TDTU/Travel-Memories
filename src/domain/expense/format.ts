// domain/expense/format.ts — 비용 표시·합계의 순수 함수(테스트로 잠금 — 미러 아닌 운영함수).
// 금액은 원금액(original_amount>0)·ISO 4217 통화. 환율/기준통화 환산은 후속(H-04: 원금액 불변).

export interface CurrencyMeta {
  code: string;
  symbol: string;
  decimals: number;
  /** 심볼을 금액 뒤에 붙인다(예: 우즈벡 soʻm은 "1,000,000 soʻm"이 관례). 기본은 앞. */
  suffix?: boolean;
}

/** 지원 통화. 자주 쓰는 통화를 위에, 그 아래로 세계 통화(코드 알파벳순).
 * 표시 소수자릿수는 통화 관례를 따른다(KRW·JPY·UZS·IDR·KZT·TWD·VND=0).
 * 심볼이 없으면(빈 문자열) 금액 뒤에 통화 코드를 붙인다(정직: 심볼 위조 안 함).
 * 일부 통화는 관례상 심볼을 뒤에 둔다(suffix: UZS soʻm, 북유럽 kr, PLN zł, VND ₫ 등). */
export const CURRENCIES: readonly CurrencyMeta[] = [
  // 자주 쓰는(우선)
  { code: 'KRW', symbol: '₩', decimals: 0 },
  { code: 'USD', symbol: '$', decimals: 2 },
  { code: 'UZS', symbol: 'soʻm', decimals: 0, suffix: true },
  { code: 'JPY', symbol: '¥', decimals: 0 },
  { code: 'EUR', symbol: '€', decimals: 2 },
  // 그 외 세계 통화(코드 알파벳순)
  { code: 'AED', symbol: '', decimals: 2 },
  { code: 'AUD', symbol: 'A$', decimals: 2 },
  { code: 'BRL', symbol: 'R$', decimals: 2 },
  { code: 'CAD', symbol: 'C$', decimals: 2 },
  { code: 'CHF', symbol: '', decimals: 2 },
  { code: 'CNY', symbol: '¥', decimals: 2 },
  { code: 'CZK', symbol: 'Kč', decimals: 2, suffix: true },
  { code: 'DKK', symbol: 'kr', decimals: 2, suffix: true },
  { code: 'EGP', symbol: '', decimals: 2 },
  { code: 'GBP', symbol: '£', decimals: 2 },
  { code: 'HKD', symbol: 'HK$', decimals: 2 },
  { code: 'IDR', symbol: 'Rp', decimals: 0 },
  { code: 'ILS', symbol: '₪', decimals: 2 },
  { code: 'INR', symbol: '₹', decimals: 2 },
  { code: 'KZT', symbol: '₸', decimals: 0 },
  { code: 'MXN', symbol: 'MX$', decimals: 2 },
  { code: 'MYR', symbol: 'RM', decimals: 2 },
  { code: 'NOK', symbol: 'kr', decimals: 2, suffix: true },
  { code: 'NZD', symbol: 'NZ$', decimals: 2 },
  { code: 'PHP', symbol: '₱', decimals: 2 },
  { code: 'PLN', symbol: 'zł', decimals: 2, suffix: true },
  { code: 'RUB', symbol: '₽', decimals: 2 },
  { code: 'SAR', symbol: '', decimals: 2 },
  { code: 'SEK', symbol: 'kr', decimals: 2, suffix: true },
  { code: 'SGD', symbol: 'S$', decimals: 2 },
  { code: 'THB', symbol: '฿', decimals: 2 },
  { code: 'TRY', symbol: '₺', decimals: 2 },
  { code: 'TWD', symbol: 'NT$', decimals: 0 },
  { code: 'UAH', symbol: '₴', decimals: 2 },
  { code: 'VND', symbol: '₫', decimals: 0, suffix: true },
  { code: 'ZAR', symbol: 'R', decimals: 2 },
] as const;

export const DEFAULT_CURRENCY = 'KRW';

/** 국기를 못 만드는 통화 접두어 — ISO 4217의 'X..'는 초국가·특수코드(XAF·XOF·XDR 등)라 나라가 없다. */
const NO_FLAG_PREFIX = /^X/;

/**
 * 통화코드 → 국기 이모지. **손으로 36개를 적지 않는다**(§7): ISO 4217 통화코드의 앞 두 글자가
 * 곧 ISO 3166-1 alpha-2 국가코드라서 코드에서 파생한다(KRW→KR→🇰🇷, EUR→EU→🇪🇺).
 * 새 통화를 CURRENCIES에 넣으면 국기도 자동으로 따라온다.
 * 만들 수 없으면 빈 문자열(위조하지 않는다).
 *
 * 정직: Windows는 국기 이모지를 그리지 않고 글자쌍('KR')로 표시한다 — 정보는 남으므로 그대로 둔다.
 */
export function currencyFlag(code: string): string {
  const cc = code.slice(0, 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc) || NO_FLAG_PREFIX.test(cc)) return '';
  return String.fromCodePoint(...[...cc].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

/** 선택 UI용 한 줄 라벨: '🇰🇷 ₩ KRW' / 심볼 없으면 '🇦🇪 AED'. */
export function currencyLabel(c: CurrencyMeta): string {
  const flag = currencyFlag(c.code);
  return [flag, c.symbol, c.code].filter(Boolean).join(' ');
}

function meta(code: string): CurrencyMeta | undefined {
  return CURRENCIES.find((c) => c.code === code);
}

function groupThousands(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 금액+통화 → 표시 문자열. 알 수 없는 통화(또는 심볼 없는 통화)는 코드를 뒤에 붙인다(정직: 심볼 위조 안 함). */
export function formatMoney(amount: number, currency: string): string {
  const m = meta(currency);
  const decimals = m ? m.decimals : 2;
  const safe = Number.isFinite(amount) ? amount : 0;
  const fixed = safe.toFixed(decimals);
  const [intPart, frac] = fixed.split('.');
  const grouped = groupThousands(intPart ?? '0');
  const num = frac ? `${grouped}.${frac}` : grouped;
  if (!m || !m.symbol) return `${num} ${currency}`;
  return m.suffix ? `${num} ${m.symbol}` : `${m.symbol}${num}`;
}

/** 통화별 합계. 서로 다른 통화는 섞지 않는다(환율 없이 합산 금지 — 정직). */
export function sumByCurrency(
  items: readonly { originalAmount: number; originalCurrency: string }[],
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const it of items) {
    if (!Number.isFinite(it.originalAmount)) continue;
    totals[it.originalCurrency] = (totals[it.originalCurrency] ?? 0) + it.originalAmount;
  }
  return totals;
}

/** 통화별 합계를 표시 문자열 배열로. 예: ['₩120,000', '$15.00']. */
export function formatTotals(totals: Record<string, number>): string[] {
  return Object.keys(totals)
    .sort()
    .map((cur) => formatMoney(totals[cur]!, cur));
}
