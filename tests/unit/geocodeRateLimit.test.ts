// geocodeRateLimit.test.ts — 지오코딩 자원 남용 상한 (T-022).
//
// 🔴 인증과 초대제는 「누가」를 막지 「얼마나」를 막지 않는다. 허용목록 안의 계정 하나가
// 반복 호출하면 우리 지도 API 키의 쿼터와 비용이 그대로 나간다(카카오는 한 요청이 상류로 2번).
// 판정을 순수 함수로 뽑았으니 시계를 직접 먹여 경계를 잰다.

import { describe, it, expect } from 'vitest';
import {
  allowRequest,
  MAX_QUERY_LEN,
  RATE_MAX_PER_WINDOW,
  RATE_WINDOW_MS,
  type RateState,
} from '../../supabase/functions/geocode/index';

const T0 = 1_000_000;

describe('🔴 지오코딩 속도 한도', () => {
  it('처음 요청은 언제나 통과하고 창을 연다', () => {
    const r = allowRequest(undefined, T0);
    expect(r.ok).toBe(true);
    expect(r.next).toEqual({ windowStart: T0, count: 1 });
  });

  it('창 안에서 한도까지는 통과한다', () => {
    let state: RateState | undefined;
    for (let i = 0; i < RATE_MAX_PER_WINDOW; i++) {
      const r = allowRequest(state, T0 + i);
      expect(r.ok, `${i + 1}번째는 통과해야 한다`).toBe(true);
      state = r.next;
    }
    expect(state?.count).toBe(RATE_MAX_PER_WINDOW);
  });

  it('🔴 한도를 넘으면 막고, **언제 다시 되는지** 알려준다', () => {
    const full: RateState = { windowStart: T0, count: RATE_MAX_PER_WINDOW };
    const r = allowRequest(full, T0 + 10_000);
    expect(r.ok).toBe(false);
    expect(r.retryAfterSec).toBe(50); // 60초 창에서 10초 지남
    expect(r.next).toEqual(full); // 막힌 요청은 카운터를 더 올리지 않는다
  });

  it('🔴 막힌 요청이 창을 연장하지 않는다 — 계속 두드려도 풀리는 시각은 그대로다', () => {
    const full: RateState = { windowStart: T0, count: RATE_MAX_PER_WINDOW };
    const a = allowRequest(full, T0 + 10_000);
    const b = allowRequest(a.next, T0 + 20_000);
    expect(b.ok).toBe(false);
    expect(b.retryAfterSec).toBe(40); // 늘어나지 않고 줄어든다
  });

  it('창이 지나면 새 창이 열린다', () => {
    const full: RateState = { windowStart: T0, count: RATE_MAX_PER_WINDOW };
    const r = allowRequest(full, T0 + RATE_WINDOW_MS);
    expect(r.ok).toBe(true);
    expect(r.next).toEqual({ windowStart: T0 + RATE_WINDOW_MS, count: 1 });
  });

  it('경계 직전(창 끝 1ms 전)은 아직 막힌다 — 경계를 흐리지 않는다', () => {
    const full: RateState = { windowStart: T0, count: RATE_MAX_PER_WINDOW };
    expect(allowRequest(full, T0 + RATE_WINDOW_MS - 1).ok).toBe(false);
  });

  it('사람이 손으로 검색하는 속도는 넉넉히 덮는다 — 정상 사용을 막으면 그것도 결함이다', () => {
    // 2초에 한 번씩 1분간 검색해도(30회) 막히지 않는다.
    let state: RateState | undefined;
    for (let i = 0; i < 30; i++) {
      const r = allowRequest(state, T0 + i * 2000);
      expect(r.ok, `${i + 1}번째 정상 검색이 막혔다`).toBe(true);
      state = r.next;
    }
  });
});

describe('질의 길이 상한', () => {
  it('실제 주소·상호를 덮을 만큼은 길다', () => {
    expect(MAX_QUERY_LEN).toBeGreaterThanOrEqual(50);
    expect('서울특별시 강남구 테헤란로 152 강남파이낸스센터'.length).toBeLessThan(MAX_QUERY_LEN);
  });
});
