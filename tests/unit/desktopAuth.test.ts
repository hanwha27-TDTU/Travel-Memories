import { describe, expect, it } from 'vitest';
import { isAllowedDesktopOAuthUrl } from '../../src/services/desktopAuth';

describe('isAllowedDesktopOAuthUrl — Windows 외부 브라우저 경계', () => {
  it('이 앱의 Supabase OAuth 시작 주소만 허용한다', () => {
    expect(isAllowedDesktopOAuthUrl(
      'https://ihxiywffzmvrwmqvatzt.supabase.co/auth/v1/authorize?provider=google',
    )).toBe(true);
  });

  it('다른 host와 http와 다른 path를 거부한다', () => {
    expect(isAllowedDesktopOAuthUrl('https://example.com/auth/v1/authorize')).toBe(false);
    expect(isAllowedDesktopOAuthUrl('http://ihxiywffzmvrwmqvatzt.supabase.co/auth/v1/authorize')).toBe(false);
    expect(isAllowedDesktopOAuthUrl('https://ihxiywffzmvrwmqvatzt.supabase.co/auth/v1/token')).toBe(false);
  });
});
