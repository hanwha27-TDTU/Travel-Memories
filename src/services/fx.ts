// services/fx.ts — 환율 취득(네트워크) + 로컬 캐시. 순수 계산은 domain/expense/fx.ts.
//
// 정직한 표기: 이건 **최신 기준환율**이지 실시간 시장가·은행 매매기준율이 아니다. 실제 결제액
// (카드 수수료·현찰 살 때/팔 때)과 다를 수 있으므로 화면에 "기준환율"과 날짜·출처를 함께 보인다.
//
// 제공자 선택 근거(2026-07 실측 불가 — 아래 '정직' 참조):
//  주(primary) = @fawazahmed0/currency-api — 200+ 통화(**UZS 포함**), 날짜 고정 URL로 과거 환율,
//                API 키·호출제한 없음, CC0. 우즈베크 솜이 필요한 우리 앱엔 이게 필수 조건이다.
//  보조(fallback) = Frankfurter — ECB 기준이라 주요 ~30개 통화의 품질이 높지만 **UZS는 없을 가능성**
//                이 크다(ECB가 솜 기준환율을 고시하지 않음). 그래서 보조로 둔다.
//  '정직': 이 샌드박스는 두 호스트를 네트워크 정책으로 차단해 **실제 응답을 검증하지 못했다.**
//          그래서 ① 어댑터를 갈아끼울 수 있게 분리하고 ② 실패해도 앱이 정상 동작하며(오프라인 우선)
//          ③ 순수 계산은 고정 픽스처로 유닛 검증한다. 실 네트워크 확인은 실기기 몫.

import { db } from '../offline/db';
import { fxKey, isFxFresh, localDate, type FxRateTable } from '../domain/expense/fx';

const BASE_KEY = 'bj.fxBase';
export const DEFAULT_FX_BASE = 'KRW';

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** 표시 기준통화(사용자 선호 — 기억 데이터가 아니라 표시 설정이라 localStorage). */
export function fxBase(): string {
  return (safeGet(BASE_KEY) || DEFAULT_FX_BASE).toUpperCase();
}

export function setFxBase(code: string): void {
  try {
    localStorage.setItem(BASE_KEY, code.toUpperCase());
  } catch {
    /* 저장 실패는 무시(선호값) */
  }
}

/** 오늘(로컬) 날짜. */
export function todayDate(): string {
  return localDate(new Date().toISOString());
}

// ── 제공자 어댑터 ────────────────────────────────────────────────
// 각 제공자는 (date, base) → FxRateTable | null. 실패는 예외가 아니라 null로 돌려 다음 제공자로 넘긴다.

type Provider = (date: string, base: string, today: string) => Promise<FxRateTable | null>;

async function fetchJson(url: string, timeoutMs = 8000): Promise<unknown | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null; // 네트워크·타임아웃·파싱 실패 — 조용히 다음 제공자
  }
}

/** 응답의 통화 맵을 대문자 키 + 유한 양수만 남겨 정규화(신뢰 경계). */
function normalizeRates(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n) && n > 0) out[k.toUpperCase()] = n;
  }
  return out;
}

/** 주 제공자 — fawazahmed0/currency-api. 과거 날짜는 URL에 날짜를 고정해 받는다. */
const fawaz: Provider = async (date, base, today) => {
  const b = base.toLowerCase();
  const ver = date >= today ? 'latest' : date;
  const urls = [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${ver}/v1/currencies/${b}.json`,
    `https://${ver}.currency-api.pages.dev/v1/currencies/${b}.json`,
  ];
  for (const url of urls) {
    const data = await fetchJson(url);
    if (!data || typeof data !== 'object') continue;
    const obj = data as Record<string, unknown>;
    const rates = normalizeRates(obj[b]);
    if (Object.keys(rates).length === 0) continue;
    const applied = typeof obj['date'] === 'string' ? obj['date'] : date;
    return {
      date: applied,
      base: base.toUpperCase(),
      rates,
      source: 'fawaz',
      fetchedAt: new Date().toISOString(),
    };
  }
  return null;
};

/** 보조 제공자 — Frankfurter(ECB). 주요 통화 품질은 높으나 지원 통화가 적다. */
const frankfurter: Provider = async (date, base, today) => {
  const path = date >= today ? 'latest' : date;
  const data = await fetchJson(`https://api.frankfurter.dev/v1/${path}?base=${base.toUpperCase()}`);
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  const rates = normalizeRates(obj['rates']);
  if (Object.keys(rates).length === 0) return null;
  const applied = typeof obj['date'] === 'string' ? obj['date'] : date;
  return {
    date: applied,
    base: base.toUpperCase(),
    rates,
    source: 'frankfurter',
    fetchedAt: new Date().toISOString(),
  };
};

const PROVIDERS: Provider[] = [fawaz, frankfurter];

// ── 캐시 + 취득 ─────────────────────────────────────────────────

/** 캐시에서만 읽는다(네트워크 없음) — 렌더 경로에서 즉시 표시용. */
export async function cachedTable(date: string, base: string): Promise<FxRateTable | null> {
  try {
    const row = await db().localFxRates.get(fxKey(date, base));
    if (!row) return null;
    return { date: row.date, base: row.base, rates: row.rates, source: row.source, fetchedAt: row.fetchedAt };
  } catch {
    return null;
  }
}

/**
 * 표를 확보한다: 신선한 캐시가 있으면 그대로, 없으면 제공자에서 받아 캐시에 넣는다.
 * 네트워크가 없거나 전부 실패하면 **오래된 캐시라도 반환**(있으면) — 없으면 null.
 * 어떤 경우에도 예외를 던지지 않는다(환율은 보조 정보이며 앱을 막지 않는다).
 */
export async function ensureTable(date: string, base = fxBase()): Promise<FxRateTable | null> {
  const today = todayDate();
  const cached = await cachedTable(date, base);
  if (cached && isFxFresh(cached, today, new Date().toISOString())) return cached;

  for (const p of PROVIDERS) {
    const t = await p(date, base, today);
    if (!t) continue;
    try {
      // 요청 날짜 키로 저장한다(주말·공휴일이면 applied date가 앞서지만, 그날 조회의 답은 이 표다).
      await db().localFxRates.put({ id: fxKey(date, base), ...t });
    } catch {
      /* 캐시 저장 실패는 표시를 막지 않는다 */
    }
    return t;
  }
  return cached; // 전부 실패 → 오래된 캐시라도(없으면 null)
}
