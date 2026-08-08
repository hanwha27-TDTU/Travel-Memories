// tests/unit/syncBadgeVerdict.test.ts — 첫 화면 배지의 판정과 **문장**을 잠근다.
//
// 🔴 이 한 줄이 사용자가 앱을 열 때 **가장 먼저 읽는 문장**이다. 여기가 거짓말하면 나머지
// 진단이 아무리 정확해도 사용자는 열어 보지 않는다.
//
// 그리고 이 파일의 존재 이유는 M-0101이다: 서버에 여행 8개가 있는데 이 기기는 0개를 받은
// 상태에서, **보낼 것도 없고 실패 표시도 없어서** 화면이 "☁️ 동기화됨"이라고 말했다.
// 「보낼 게 없다」와 「같다」를 같은 말로 쓴 것이 그 사고였다 — 아래 검사가 그 재발을 막는다.

import { describe, it, expect } from 'vitest';
import { syncBadge, badgeActionLabel, type BadgeInput } from '../../src/domain/syncBadgeVerdict';

const IN = (over: Partial<BadgeInput> = {}): BadgeInput => ({
  cloudConfigured: true,
  signedIn: true,
  pending: 0,
  phase: 'ok',
  lastError: null,
  parity: { same: true, differing: 0, at: '2026-08-05T12:00:00.000Z' },
  parityRefreshing: false,
  lastResult: null,
  lastReason: '',
  progress: null,
  ...over,
});

describe('🔴 M-0101 재발 방지 — 「보낼 게 없다」는 「같다」가 아니다', () => {
  it('보낼 것 없고 서버와 **같을 때만** 「동기화됨」이다', () => {
    const v = syncBadge(IN());
    expect(v.text).toBe('☁️ 동기화됨');
    expect(v.level).toBe('ok');
    expect(v.go).toBeNull(); // 정상은 침묵(목적지 없음)
    expect(v.syncOnTap).toBe(true);
  });

  it('🔴 보낼 것이 없어도 **서버와 다르면** 「동기화됨」이 아니다 — 이게 M-0101이었다', () => {
    const v = syncBadge(IN({ pending: 0, parity: { same: false, differing: 3, at: '2026-08-05T12:00:00.000Z' } }));
    expect(v.text).not.toContain('동기화됨');
    expect(v.text).toContain('클라우드와 다름');
    expect(v.text).toContain('3가지');
    expect(v.level).toBe('error');
    // 막다른 문장으로 끝내지 않는다 — 어디를 볼지 준다(§7-D).
    expect(v.go).toBe('store');
  });

  it('🔴 대조를 **못 했으면** 「동기화됨」이라 하지 않는다 — 모르는 것을 정상으로 반올림 금지(§8)', () => {
    const v = syncBadge(IN({ parity: null }));
    expect(v.text).not.toContain('동기화됨');
    expect(v.text).toContain('확인 전');
    expect(v.level).toBe('info');
    // 누르면 대조가 돌아야 한다 — 「확인 전」에서 벗어날 길을 준다.
    expect(v.syncOnTap).toBe(true);
  });
});

describe('우선순위 — 위에 있는 것이 더 급하다', () => {
  it('🔴 실패는 pending이 0이어도 먼저 말한다', () => {
    const v = syncBadge(IN({ phase: 'failed', lastError: '네트워크 끊김', pending: 0 }));
    expect(v.level).toBe('error');
    expect(v.text).toContain('네트워크 끊김');
    expect(v.go).toBe('sync');
  });

  it('🔴 실패는 **보낼 것이 남아 있어도** 먼저다 — 옛 순서(pending 우선)를 잡는다', () => {
    // 이 갈래가 없으면 「pending이 0일 때만 실패를 본다」는 주입이 조용히 통과한다.
    // 실제로 그 구멍을 §4 주입에서 발견했다(2026-08-05) — 통과만으로는 검사가 산 게 아니다.
    const v = syncBadge(IN({ phase: 'failed', lastError: '서버 거절', pending: 7 }));
    expect(v.level).toBe('error');
    expect(v.text).toContain('서버 거절');
    expect(v.text).not.toContain('보낼 것 7건');
  });

  it('실패 사유를 조용히 삼키지 않는다 — 없으면 「원인 미상」이라 적는다', () => {
    expect(syncBadge(IN({ phase: 'failed', lastError: null })).text).toContain('원인 미상');
  });

  it('돌고 있으면 또 돌리지 않는다', () => {
    const v = syncBadge(IN({ phase: 'running' }));
    expect(v.syncOnTap).toBe(false);
    expect(v.go).toBeNull();
  });

  it('실패가 「다름」보다 먼저다 — 실패하면 대조값 자체를 못 믿는다', () => {
    const v = syncBadge(IN({ phase: 'failed', parity: { same: false, differing: 2, at: 'x' } }));
    expect(v.text).toContain('동기화 실패');
  });
});

describe('오프라인은 실패가 아니다 — 겁주지 않는다', () => {
  it('오프라인은 error가 아니라 info', () => {
    expect(syncBadge(IN({ phase: 'offline' })).level).toBe('info');
  });

  it('🔴 보낼 것이 있으면 **자동으로 올라간다**고 말한다 — 사용자가 뭘 해야 하는지 몰라 불안해지지 않게', () => {
    const v = syncBadge(IN({ phase: 'offline', pending: 4 }));
    expect(v.text).toContain('4건');
    expect(v.text).toContain('자동으로');
    expect(v.syncOnTap).toBe(false); // 오프라인에서 누르게 하면 실패만 본다
  });
});

describe('보낼 것이 남았을 때', () => {
  it('누르면 지금 보낸다 — [동기화] 버튼이 하던 일을 배지가 받았다', () => {
    const v = syncBadge(IN({ pending: 2 }));
    expect(v.text).toContain('2건');
    expect(v.syncOnTap).toBe(true);
  });
});

describe('수동 동기화 완료 결과', () => {
  it('대조까지 같으면 방금 보낸/받은 결과를 즉시, 짧게 보여 준다', () => {
    const v = syncBadge(IN({
      lastReason: '배지',
      lastResult: { pushed: 3, pulled: 2, failed: 0 },
    }));
    expect(v.text).toBe('✓ 동기화 완료 · 보냄 3건 · 받음 2건');
    expect(v.level).toBe('info');
    expect(v.go).toBeNull();
    expect(v.syncOnTap).toBe(true);
  });

  it('실제 변경이 없었던 수동 동기화도 성공 여부를 명확히 남긴다', () => {
    expect(syncBadge(IN({
      lastReason: '배지',
      lastResult: { pushed: 0, pulled: 0, failed: 0 },
    })).text).toBe('✓ 동기화 완료 · 변경 없음');
  });

  it('대조가 끝나지 않았으면 전송 성공을 전체 동기화 성공으로 과장하지 않는다', () => {
    const v = syncBadge(IN({
      parity: null,
      parityRefreshing: true,
      lastReason: '배지',
      lastResult: { pushed: 1, pulled: 0, failed: 0 },
    }));
    expect(v.text).toBe('✓ 전송 완료 · 대장 대조 확인 중');
    expect(v.level).toBe('info');
    expect(v.go).toBe('store');
    expect(v.syncOnTap).toBe(false);
  });

  it('대조가 실패해 끝났으면 「확인 중」에 남지 않고 확인 전으로 돌아간다', () => {
    const v = syncBadge(IN({
      parity: null,
      parityRefreshing: false,
      lastReason: '배지',
      lastResult: { pushed: 1, pulled: 0, failed: 0 },
    }));
    expect(v.text).toContain('확인 전');
    expect(v.text).not.toContain('확인 중');
    expect(v.syncOnTap).toBe(true);
  });

  it('자동 동기화의 이전 결과는 평소 상태를 시끄럽게 만들지 않는다', () => {
    expect(syncBadge(IN({
      lastReason: '로그인 확인',
      lastResult: { pushed: 3, pulled: 2, failed: 0 },
    })).text).toBe('☁️ 동기화됨');
  });
});

describe('로컬 전용·로그인 전', () => {
  it('클라우드를 안 쓰면 왜 서버로 안 가는지는 환경이 답한다', () => {
    expect(syncBadge(IN({ cloudConfigured: false })).go).toBe('env');
  });

  it('🔴 로그인 전은 목적지가 없다 — 조치 버튼([로그인])이 헤더에 이미 있다', () => {
    const v = syncBadge(IN({ signedIn: false }));
    expect(v.go).toBeNull();
    expect(v.syncOnTap).toBe(false);
  });
});

describe('화면읽기 라벨', () => {
  it('무엇을 하는 버튼인지 말한다', () => {
    expect(badgeActionLabel(syncBadge(IN({ parity: { same: false, differing: 1, at: 'x' } })))).toContain('클라우드 대조');
  });

  it('목적지도 동기화도 없으면 빈 라벨(버튼을 안 붙인다)', () => {
    expect(badgeActionLabel(syncBadge(IN()))).toBe('지금 동기화');
  });
});

describe('문장 규율', () => {
  it('🔴 마크다운을 쓰지 않는다 — textContent로 그려진다(§5 7항)', () => {
    const cases: Partial<BadgeInput>[] = [
      {},
      { parity: null },
      { parity: { same: false, differing: 2, at: 'x' } },
      { phase: 'failed', lastError: 'x' },
      { phase: 'offline', pending: 3 },
      { phase: 'running' },
      { pending: 5 },
      { signedIn: false },
      { cloudConfigured: false },
    ];
    for (const c of cases) {
      expect(syncBadge(IN(c)).text).not.toContain('**');
      expect(syncBadge(IN(c)).text.length).toBeGreaterThan(0);
    }
  });
});

describe('measurable sync progress', () => {
  it('reports only settled domain stages as a percentage', () => {
    const v = syncBadge(IN({
      phase: 'running',
      progress: { phase: 'pulling', completed: 9, total: 13, phaseCompleted: 3, phaseTotal: 6 },
    }));
    expect(v.text).toContain('69%');
    expect(v.text).toContain('3/6');
    expect(v.progressPercent).toBe(69);
  });
});
