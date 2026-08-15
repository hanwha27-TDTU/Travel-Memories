import { describe, expect, it } from 'vitest';
import { accessVerdict } from '../../src/domain/authGate';

/**
 * 초대제 잠금 판정 — 🔴 **가장 중요한 검사는 「거절」이 아니라 「못 물어봤다」다.**
 *
 * T-033 조사 중 발견: 예전 코드는 오류·오프라인을 `false`로 접어 「초대되지 않음」과 같은 값으로
 * 만들었고, 그래서 **오프라인이면 소유자를 로그아웃**시켰다(§8 — unknown을 거절로 반올림).
 * 유닛이 하나도 없었고 라이브도 이 자리를 안 봤다. 그래서 세 갈래를 **전수로** 못박는다.
 */
describe('accessVerdict — 「거절」과 「못 물어봤다」는 다른 값이다', () => {
  it('물어봤고 허용이면 조용히 통과한다(정상은 침묵 — §8)', () => {
    expect(accessVerdict({ asked: true, allowed: true })).toEqual({ keepSession: true, note: null });
  });

  it('🔴 물어봤고 거절이면 — 그때만 — 로그아웃하고 이유를 말한다', () => {
    const v = accessVerdict({ asked: true, allowed: false });
    expect(v.keepSession).toBe(false);
    expect(v.note).toContain('초대된 사용자만');
  });

  // 🔴 여기 셋이 예전에 전부 「거절」로 반올림되던 자리다.
  for (const why of ['offline', 'error', 'no-client'] as const) {
    it(`🔴 못 물어봤다(${why})면 세션을 **끊지 않는다** — 비행기 안에서 앱을 잠그지 않는다`, () => {
      expect(accessVerdict({ asked: false, why }).keepSession).toBe(true);
    });
  }

  it('🔴 못 물어본 상태에서 「초대되지 않았다」고 말하지 않는다(그건 확인한 적 없는 사실이다)', () => {
    for (const why of ['offline', 'error', 'no-client'] as const) {
      expect(accessVerdict({ asked: false, why }).note ?? '').not.toContain('초대된 사용자만');
    }
  });

  it('🔴 연결이 멀쩡한데 실패했으면 연결 탓을 하지 않는다(§17 ②축 · M-0056)', () => {
    const note = accessVerdict({ asked: false, why: 'error' }).note ?? '';
    expect(note).not.toContain('연결');
    expect(note).not.toContain('오프라인');
    expect(note).toContain('확인하지 못했어요'); // 관측까지만 말한다
  });

  it('오프라인·로컬 전용은 **아무 말도 하지 않는다**(동기화 줄이 이미 말한다 — 두 번 말하지 않는다)', () => {
    expect(accessVerdict({ asked: false, why: 'offline' }).note).toBeNull();
    expect(accessVerdict({ asked: false, why: 'no-client' }).note).toBeNull();
  });
});
