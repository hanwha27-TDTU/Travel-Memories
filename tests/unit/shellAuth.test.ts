// tests/unit/shellAuth.test.ts — 셸 로그인 복귀(ADR-0037)의 웹 쪽 절반.
//
// 왜 유닛이 필요한가: 딥링크 판별(authCodeFromUrl)이 틀리면 로그인이 **조용히** 안 된다 —
// 화면에는 아무것도 안 나오고 사용자는 브라우저에 남는다. 이 부류의 조용한 결함이 이
// 저장소에서 가장 비쌌다(§9-B). 네이티브 절반(intent-filter)은 여기서 못 돌린다 —
// 그 층은 실기기 확인이 유일하고, 정직하게 그렇게 적는다(§13 3항).

import { describe, it, expect, afterEach } from 'vitest';
import { authCodeFromUrl, wireShellAuthReturn, SHELL_AUTH_REDIRECT } from '../../src/services/auth';

const g = globalThis as { window?: unknown };

afterEach(() => {
  delete g.window;
});

describe('authCodeFromUrl — 딥링크에서 PKCE code만', () => {
  it('복귀 딥링크에서 code를 꺼낸다', () => {
    expect(authCodeFromUrl(`${SHELL_AUTH_REDIRECT}?code=abc-123`)).toBe('abc-123');
  });

  it('🔴 다른 스킴(https)은 null — 아무 URL이나 세션 교환에 넣지 않는다', () => {
    expect(authCodeFromUrl('https://example.com/?code=evil')).toBeNull();
  });

  it('code가 없으면 null(오류 복귀 등) — 지어내지 않는다', () => {
    expect(authCodeFromUrl(`${SHELL_AUTH_REDIRECT}?error=access_denied`)).toBeNull();
  });

  it('깨진 URL은 조용히 null — 예외가 부트를 죽이면 안 된다', () => {
    expect(authCodeFromUrl('not a url')).toBeNull();
  });
});

describe('wireShellAuthReturn — 크롬에서는 비켜선다', () => {
  it('window가 없어도(유닛) 조용히 무행동 — 부트에서 무조건 불리기 때문이다', () => {
    expect(() => wireShellAuthReturn()).not.toThrow();
  });

  it('셸인데 App 플러그인이 없는 옛 APK에서도 조용히 무행동', () => {
    g.window = { Capacitor: { isNativePlatform: () => true, Plugins: {} } };
    expect(() => wireShellAuthReturn()).not.toThrow();
  });

  it('셸이면 appUrlOpen을 구독한다(딥링크가 와야 세션 교환이 시작된다)', () => {
    const events: string[] = [];
    g.window = {
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: { App: { addListener: (ev: string) => events.push(ev) }, OriginalPhotos: {} },
      },
    };
    wireShellAuthReturn();
    expect(events).toEqual(['appUrlOpen']);
  });
});
