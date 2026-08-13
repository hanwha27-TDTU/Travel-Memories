// tests/unit/screenSession.test.ts — 운영 순수함수 직접 테스트(TEST_PLAN: 미러 테스트 금지).
//
// 🔴 이 파일이 없었기 때문에 결함이 살아 있었다. 기존 `router.test.ts`는 **경로 파싱만** 봤고,
//    「늦게 온 화면이 새 화면을 덮는가」와 「떠난 화면이 정리되는가」는 아무도 안 쟀다.
//    각 케이스는 **고치기 전 코드에서 실제로 실패하는** 것들이다(§4 — 대조군).
import { describe, it, expect } from 'vitest';
import { createScreenSession } from '../../src/app/screenSession';

describe('createScreenSession — 늦게 온 비동기가 새 화면을 덮지 않는다(#2)', () => {
  it('🔴 다른 화면으로 넘어간 뒤에는 이전 세대가 「현재」가 아니다', () => {
    const s = createScreenSession();
    const first = s.begin(); // /trip/A 진입 — 인증 확인을 기다리는 중
    const second = s.begin(); // 사용자가 뒤로 감 → 홈
    expect(first.isCurrent()).toBe(false); // 늦게 끝난 확인은 그리면 안 된다
    expect(second.isCurrent()).toBe(true);
  });

  it('🔴 늦게 온 화면이 mount하면 **즉시 정리되고** 현재 화면의 정리 함수를 덮지 않는다', () => {
    const s = createScreenSession();
    const late = s.begin();
    const current = s.begin();

    let currentDisposed = 0;
    let lateDisposed = 0;
    current.mount(() => { currentDisposed += 1; });
    late.mount(() => { lateDisposed += 1; }); // 늦게 도착

    expect(lateDisposed).toBe(1); // 스스로 정리됐다
    expect(currentDisposed).toBe(0); // 현재 화면은 아직 살아 있다

    s.disposeCurrent();
    expect(currentDisposed).toBe(1); // 덮이지 않았으므로 제때 정리된다
  });
});

describe('createScreenSession — 떠난 화면이 정리된다(#3)', () => {
  it('🔴 새 화면을 시작하면 이전 화면의 구독이 해지된다', () => {
    const s = createScreenSession();
    let homeDisposed = 0;
    s.begin().mount(() => { homeDisposed += 1; });

    expect(homeDisposed).toBe(0); // 아직 홈에 있다
    s.begin(); // 여행 상세로 이동
    expect(homeDisposed).toBe(1); // 홈 구독이 살아남지 않는다
  });

  it('정리는 **한 번만** 돈다 — 같은 화면을 두 번 정리하지 않는다', () => {
    const s = createScreenSession();
    let disposed = 0;
    s.begin().mount(() => { disposed += 1; });
    s.begin();
    s.disposeCurrent();
    expect(disposed).toBe(1);
  });

  it('mount하지 않은 화면(막혀서 안 그린 갈래)이 있어도 다음 전환이 깨지지 않는다', () => {
    const s = createScreenSession();
    let disposed = 0;
    s.begin().mount(() => { disposed += 1; });
    s.begin(); // 인증 실패로 아무것도 mount하지 않음
    expect(disposed).toBe(1);
    expect(() => s.begin()).not.toThrow();
  });
});

describe('createScreenSession — 세션끼리 간섭하지 않는다', () => {
  it('세대는 세션마다 따로 센다(모듈 전역이 아니다)', () => {
    const a = createScreenSession();
    const b = createScreenSession();
    a.begin();
    a.begin();
    b.begin();
    expect(a.generation()).toBe(2);
    expect(b.generation()).toBe(1);
  });
});
