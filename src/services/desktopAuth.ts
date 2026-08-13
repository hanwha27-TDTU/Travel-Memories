// services/desktopAuth.ts — Windows Tauri 인증 경계.
// 브라우저·Android 인증 경로에는 Tauri 플러그인을 노출하지 않고, Windows에서만 동적 로드한다.

const SUPABASE_AUTH_HOST = 'ihxiywffzmvrwmqvatzt.supabase.co';
const SUPABASE_AUTHORIZE_PATH = '/auth/v1/authorize';

/** 시스템 브라우저로 내보내도 되는 OAuth 시작 URL인지 좁게 판정한다. */
export function isAllowedDesktopOAuthUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && parsed.hostname === SUPABASE_AUTH_HOST
      && parsed.pathname === SUPABASE_AUTHORIZE_PATH;
  } catch {
    return false;
  }
}

/** Windows 기본 브라우저에서 Supabase OAuth를 시작한다. */
export async function openDesktopOAuthUrl(url: string): Promise<void> {
  if (!isAllowedDesktopOAuthUrl(url)) {
    throw new Error('허용되지 않은 로그인 주소라서 열지 않았어요.');
  }
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(url);
}

/** 앱 시작 URL과 실행 중 재진입 URL을 모두 같은 콜백으로 전달한다. */
export async function wireDesktopAuthUrls(onUrl: (url: string) => void): Promise<void> {
  const { getCurrent, onOpenUrl } = await import('@tauri-apps/plugin-deep-link');
  await onOpenUrl((urls) => urls.forEach(onUrl));
  const current = await getCurrent();
  current?.forEach(onUrl);
}
