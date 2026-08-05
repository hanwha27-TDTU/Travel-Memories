// tests/unit/serverContractVerdict.test.ts — 「서버 계약」의 판정과 문장을 잠근다.
//
// 🔴 이 도구의 ③(로그인 없는 접근)이 **이 앱에서 가장 무거운 지표**다. 뚫렸다면 남이 내
// 여행·사진·위치를 볼 수 있다는 뜻이므로(§0), 「모름」을 「막힘」으로 반올림하면 그 초록이
// 곧 거짓 안도감이 된다. 그 갈래를 유닛이 직접 돌린다.

import { describe, it, expect } from 'vitest';
import {
  anonBlockMetric,
  pageSizeMetric,
  paginationMetric,
  serverContractMetrics,
  serverContractHeadline,
  type ServerContractObservation,
} from '../../src/domain/serverContractVerdict';

/** 전부 정상인 기준값 — 각 검사가 필요한 곳만 덮어쓴다. */
const clean = (over: Partial<ServerContractObservation> = {}): ServerContractObservation => ({
  cloudConfigured: true,
  signedIn: true,
  observedPageSize: 1000,
  assumedPageSize: 1000,
  paginationSound: true,
  paginationNote: null,
  anonBlocked: true,
  anonRowsSeen: 0,
  anonNote: null,
  ...over,
});

describe('③ 로그인 없는 접근 — 가장 무거운 지표', () => {
  it('막혀 있으면 정상이고 침묵한다', () => {
    const m = anonBlockMetric(clean());
    expect(m.level).toBe('ok');
    expect(m.meaning).toBeUndefined();
  });

  it('🔴 뚫렸으면 problem이고 **몇 행이 새는지**까지 말한다', () => {
    const m = anonBlockMetric(clean({ anonBlocked: false, anonRowsSeen: 5 }));
    expect(m.level).toBe('problem');
    expect(m.actual).toContain('5행');
    expect(m.meaning).toContain('다른 사람이 기록을 볼 수 있는 상태');
  });

  it('🔴 못 쟀으면 「막힘」으로 반올림하지 않는다 — 거짓 안도감이 된다(§8)', () => {
    const m = anonBlockMetric(clean({ anonBlocked: null, anonNote: '네트워크가 끊겼어요' }));
    expect(m.level).toBe('unknown');
    expect(m.level).not.toBe('ok');
    expect(m.meaning).toContain('네트워크가 끊겼어요'); // 왜 모르는지 말한다(§7-E)
  });

  it('클라우드를 안 쓰는 배포는 해당 없음(정상) — 막을 서버가 없다', () => {
    const m = anonBlockMetric(clean({ cloudConfigured: false }));
    expect(m.level).toBe('ok');
    expect(m.actual).toContain('해당 없음');
  });
});

describe('① 한 번에 받는 행수', () => {
  it('가정 이상이면 정상 — 더 주는 것은 문제가 아니다', () => {
    expect(pageSizeMetric(clean({ observedPageSize: 1000 })).level).toBe('ok');
    expect(pageSizeMetric(clean({ observedPageSize: 2000 })).level).toBe('ok');
  });

  it('🔴 가정보다 적으면 problem — 페이지 사이로 행이 조용히 빠진다', () => {
    const m = pageSizeMetric(clean({ observedPageSize: 500 }));
    expect(m.level).toBe('problem');
    expect(m.meaning).toContain('조용히 빠질 수 있');
  });

  it('못 쟀으면 unknown이고, 로그인 전이면 **그게 정상이라고** 말한다', () => {
    const m = pageSizeMetric(clean({ observedPageSize: null, signedIn: false }));
    expect(m.level).toBe('unknown');
    // 로그인 전에 0행이 오는 건 RLS가 제대로 도는 것이다 — 실패처럼 말하면 안 된다.
    expect(m.meaning).toContain('정상');
  });
});

describe('② 페이지 경계', () => {
  it('빠짐이 없으면 정상이고 침묵한다', () => {
    const m = paginationMetric(clean());
    expect(m.level).toBe('ok');
    expect(m.meaning).toBeUndefined();
  });

  it('어긋나면 problem이고 사유를 함께 말한다', () => {
    const m = paginationMetric(clean({ paginationSound: false, paginationNote: '경계 행이 다릅니다(aaa ≠ bbb)' }));
    expect(m.level).toBe('problem');
    expect(m.meaning).toContain('경계 행이 다릅니다');
  });

  it('🔴 잴 조건이 안 되면 unknown이고 **왜인지** 말한다 — 「정상」이 아니다', () => {
    const m = paginationMetric(clean({ paginationSound: null, paginationNote: '여행이 3건 이상이어야 경계를 잴 수 있어요' }));
    expect(m.level).toBe('unknown');
    expect(m.meaning).toContain('3건 이상');
  });
});

describe('판정 한 문장', () => {
  it('전부 정상이면 그렇게 말한다', () => {
    expect(serverContractHeadline(clean())).toContain('가정대로 행동');
  });

  it('🔴 접근이 뚫린 것은 나머지보다 **먼저** 말한다 — 급이 다르다', () => {
    const o = clean({ anonBlocked: false, anonRowsSeen: 3, observedPageSize: 500 });
    expect(serverContractHeadline(o)).toContain('로그인 없이도');
  });

  it('접근은 멀쩡하고 다른 게 어긋나면 개수로 말한다(§7-C — 손으로 쓰지 않는다)', () => {
    const o = clean({ observedPageSize: 500 });
    expect(serverContractHeadline(o)).toContain('1가지');
  });

  it('로그인 전이면 그 사실을 말한다 — 실패처럼 보이지 않게', () => {
    const o = clean({ signedIn: false, observedPageSize: null, paginationSound: null, anonBlocked: null });
    expect(serverContractHeadline(o)).toContain('로그인하면');
  });
});

describe('지표 묶음 규율', () => {
  it('접근 차단이 **맨 위**다 — 화면 자리도 계약이다(§7 사용자 대면 대칭)', () => {
    const ms = serverContractMetrics(clean({ anonBlocked: false }));
    expect(ms[0].level).toBe('problem'); // 첫 지표가 접근 차단
    expect(ms).toHaveLength(3);
  });

  it('🔴 모든 갈래에 기대값이 있고 마크다운이 없다(§4 · §5 7항)', () => {
    const cases = [
      clean(),
      clean({ cloudConfigured: false }),
      clean({ anonBlocked: false, anonRowsSeen: 2 }),
      clean({ anonBlocked: null, anonNote: 'x' }),
      clean({ observedPageSize: 500 }),
      clean({ paginationSound: false, paginationNote: 'y' }),
      clean({ signedIn: false, observedPageSize: null, paginationSound: null, anonBlocked: null }),
    ];
    for (const o of cases) {
      for (const m of serverContractMetrics(o)) {
        expect(m.expected.length).toBeGreaterThan(0);
        expect(m.actual.length).toBeGreaterThan(0);
        expect(m.actual).not.toContain('**');
        expect(m.expected).not.toContain('**');
        expect(m.meaning ?? '').not.toContain('**');
      }
      expect(serverContractHeadline(o)).not.toContain('**');
    }
  });
});
