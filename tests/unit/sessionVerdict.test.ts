// tests/unit/sessionVerdict.test.ts — 「세션·로그인」 판정 + **잠금 판정 자체**를 잠근다.
//
// 🔴 `authGate`는 홈 목록 잠금과 딥링크 가드가 **공유하는 단일 판정**이다(M-0102가 두 곳에
// 손으로 있어 한쪽이 우회로가 됐던 자리). 이 유닛이 그 함수의 모든 갈래를 직접 돌린다 —
// 여기가 빨개지면 로그아웃해도 남의 기록이 보인다는 뜻이다(§0 개인자료 기본 비공개).

import { describe, it, expect } from 'vitest';
import {
  canViewLocalRecords,
  canRunLocalDataAction,
  authGateMismatches,
  AUTH_GATE_CASES,
  LOCAL_DATA_ACTION_CASES,
  type LocalDataAction,
} from '../../src/domain/authGate';
import {
  sessionLifetimeMetric,
  lockWiringMetric,
  sessionMetrics,
  sessionHeadline,
  WANTED_SESSION_DAYS,
  type SessionObservation,
} from '../../src/domain/sessionVerdict';

const clean = (over: Partial<SessionObservation> = {}): SessionObservation => ({
  cloudConfigured: true,
  signedIn: true,
  expiresInSec: 3600,
  hasRefreshToken: true,
  persistSession: true,
  lockWired: true,
  deepLinkGuardWired: true,
  ...over,
});

describe('🔴 기록을 볼 자격 판정 (authGate — 홈 잠금·딥링크 가드가 공유)', () => {
  it('클라우드 배포에서 로그아웃하면 **가려진다**', () => {
    expect(canViewLocalRecords(true, false)).toBe(false);
  });

  it('로그인하면 보인다', () => {
    expect(canViewLocalRecords(true, true)).toBe(true);
  });

  it('클라우드를 안 쓰는 배포는 언제나 보인다 — 가릴 상대가 없다', () => {
    expect(canViewLocalRecords(false, false)).toBe(true);
    expect(canViewLocalRecords(false, true)).toBe(true);
  });

  it('자가확인 표가 전부 통과한다 — 앱이 이걸 그대로 돌려 진단한다', () => {
    expect(authGateMismatches()).toEqual([]);
  });

  it('자가확인 표가 **네 갈래를 다 덮는다**(빠진 조합이 있으면 그 자리가 사각지대다)', () => {
    const seen = new Set(AUTH_GATE_CASES.map((c) => `${c.cloudConfigured}:${c.signedIn}`));
    expect(seen.size).toBe(4);
    for (const c of AUTH_GATE_CASES) expect(c.why.length).toBeGreaterThan(0);
  });
});

describe('🔴 로컬 자료 동작 잠금 (T-020 — 「보는 것」과 「하는 것」은 다른 판정)', () => {
  it('🔴 내보내기는 로그아웃에도 열린다 — 기억을 꺼낼 마지막 문을 막지 않는다', () => {
    expect(canRunLocalDataAction('export', true, false)).toBe(true);
  });

  it('🔴 복원은 로그아웃에서 막힌다 — 로컬 자료를 덮어쓰기 때문', () => {
    expect(canRunLocalDataAction('restore', true, false)).toBe(false);
    expect(canRunLocalDataAction('restore', true, true)).toBe(true);
  });

  it('🔴 영구삭제는 로그아웃에서 막힌다 — 되돌릴 수 없기 때문', () => {
    expect(canRunLocalDataAction('purge', true, false)).toBe(false);
    expect(canRunLocalDataAction('purge', true, true)).toBe(true);
  });

  it('클라우드를 안 쓰는 배포는 세 동작이 전부 열린다 — 막을 상대가 없다', () => {
    for (const action of ['export', 'restore', 'purge'] as LocalDataAction[]) {
      expect(canRunLocalDataAction(action, false, false)).toBe(true);
    }
  });

  it('자가확인 표가 전부 통과한다 — 진단이 이걸 그대로 돌린다', () => {
    expect(authGateMismatches()).toEqual([]);
  });

  it('🔴 표가 **모든 동작을 로그인/로그아웃 양쪽에서** 덮는다(빠진 동작이 곧 사각지대다)', () => {
    // 유니온에 새 동작을 넣고 표에 안 넣으면 여기가 빨개진다.
    // `Record<LocalDataAction, …>`의 컴파일 오류와 **두 층**으로 막는다.
    const actions: LocalDataAction[] = ['export', 'restore', 'purge'];
    for (const action of actions) {
      const rows = LOCAL_DATA_ACTION_CASES.filter((c) => c.action === action && c.cloudConfigured);
      const seen = new Set(rows.map((c) => String(c.signedIn)));
      expect(seen, `${action}이 클라우드 배포의 두 갈래를 다 덮지 않는다`).toEqual(new Set(['true', 'false']));
    }
    for (const c of LOCAL_DATA_ACTION_CASES) expect(c.why.length).toBeGreaterThan(0);
  });
});

describe('① 로그인 유지', () => {
  it('자동 갱신이 켜져 있으면 정상 — 남은 시간은 유지 기간이 아니다', () => {
    // 액세스 토큰은 원래 1시간짜리다. 그걸 「1시간 남음」이라 경고하면 정상을 문제라 부른다.
    const m = sessionLifetimeMetric(clean({ expiresInSec: 3600, hasRefreshToken: true }));
    expect(m.level).toBe('ok');
    expect(m.actual).toContain('자동 갱신');
  });

  it('🔴 「180일 보장」이라고 말하지 않는다 — 실제 상한은 서버가 정하고 앱은 모른다(§8)', () => {
    const m = sessionLifetimeMetric(clean({ hasRefreshToken: true }));
    expect(m.meaning ?? '').not.toContain(`${WANTED_SESSION_DAYS}일 보장`);
    expect(m.actual).not.toContain('보장');
  });

  it('자동 갱신이 꺼져 있으면 남은 시간을 말하고 할 일로 둔다', () => {
    const m = sessionLifetimeMetric(clean({ hasRefreshToken: false, expiresInSec: 86400 * 3 }));
    expect(m.level).toBe('todo');
    expect(m.actual).toContain('3일');
  });

  it('세션을 저장하지 않으면 problem — 새로고침마다 다시 로그인해야 한다', () => {
    const m = sessionLifetimeMetric(clean({ persistSession: false }));
    expect(m.level).toBe('problem');
  });

  it('로그인 전은 실패가 아니라 확인 불가다', () => {
    expect(sessionLifetimeMetric(clean({ signedIn: false })).level).toBe('unknown');
  });
});

describe('②③ 로그아웃 잠금 배선', () => {
  it('둘 다 살아 있으면 정상이고 침묵한다', () => {
    const m = lockWiringMetric(clean());
    expect(m.level).toBe('ok');
    expect(m.meaning).toBeUndefined();
  });

  it('🔴 하나라도 끊기면 problem이고 **어느 쪽인지** 말한다', () => {
    const m = lockWiringMetric(clean({ deepLinkGuardWired: false }));
    expect(m.level).toBe('problem');
    expect(m.actual).toContain('딥링크');
  });

  it('둘 다 끊기면 둘 다 이름을 부른다(숫자로 합치면 이름이 사라진다 — §7-G)', () => {
    const m = lockWiringMetric(clean({ lockWired: false, deepLinkGuardWired: false }));
    expect(m.actual).toContain('여행 목록');
    expect(m.actual).toContain('딥링크');
  });

  it('확인 못 했으면 「잠김」으로 반올림하지 않는다', () => {
    expect(lockWiringMetric(clean({ lockWired: null })).level).toBe('unknown');
  });
});

describe('판정 한 문장', () => {
  it('🔴 잠금이 끊긴 것은 나머지보다 먼저 말한다 — 개인정보 노출 표면이다', () => {
    const o = clean({ lockWired: false, persistSession: false });
    expect(sessionHeadline(o)).toContain('로그아웃해도 기록이 보일');
  });

  it('전부 정상이면 두 가지를 다 말한다(한쪽만 말하면 나머지를 안 잰 것처럼 읽힌다)', () => {
    const h = sessionHeadline(clean());
    expect(h).toContain('유지');
    expect(h).toContain('가려집니다');
  });

  it('로그인 전이면 그 사실을 말한다', () => {
    expect(sessionHeadline(clean({ signedIn: false }))).toContain('로그인 전');
  });
});

describe('지표 묶음 규율', () => {
  it('🔴 모든 갈래에 기대값이 있고 마크다운이 없다(§4 · §5 7항)', () => {
    const cases = [
      clean(),
      clean({ cloudConfigured: false }),
      clean({ signedIn: false }),
      clean({ persistSession: false }),
      clean({ hasRefreshToken: false, expiresInSec: 100 }),
      clean({ hasRefreshToken: false, expiresInSec: null }),
      clean({ lockWired: false }),
      clean({ lockWired: null, deepLinkGuardWired: null }),
    ];
    for (const o of cases) {
      for (const m of sessionMetrics(o)) {
        expect(m.expected.length).toBeGreaterThan(0);
        expect(m.actual.length).toBeGreaterThan(0);
        expect(m.actual).not.toContain('**');
        expect(m.meaning ?? '').not.toContain('**');
      }
      expect(sessionHeadline(o)).not.toContain('**');
    }
  });
});
