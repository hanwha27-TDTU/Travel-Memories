// services/auth.ts — Google 소셜 로그인 (ADR-0009 · invite-only 소유자 한정).
// PKCE 리다이렉트: 콜백은 앱 base URL로 돌아오며 supabase가 detectSessionInUrl로 처리.
// redirectTo는 Supabase Auth의 허용 리다이렉트 목록에 등록되어야 한다(대시보드 설정).
//
// 🔴 셸(ADR-0036) 안에서는 복귀가 **딥링크**다(ADR-0037). 구글은 WebView 로그인을 거부해
// OAuth가 시스템 브라우저로 나가는데, 복귀를 웹 URL로 두면 세션이 **브라우저에** 생기고
// 사용자는 위치가 지워지는 옛 경로에 남는다(실측 2026-08-01 12:52). 그래서 셸에서는
// `app.bugeon.journey://auth-callback`으로 돌아오게 하고(안드로이드가 셸을 다시 연다),
// appUrlOpen에서 PKCE code를 세션으로 교환한다 — code_verifier는 로그인을 시작한 이
// WebView의 저장소에 있으므로 교환도 여기서만 성립한다.

import { supabase } from './supabase/client';
import { shellPlugin, shellState } from './capacitorShell';
import { nativePlatform } from './nativePlatform';
import { openDesktopOAuthUrl, wireDesktopAuthUrls } from './desktopAuth';

/** 셸 딥링크 복귀 주소 — AndroidManifest의 intent-filter·Supabase 허용 목록과 1:1이다. */
export const SHELL_AUTH_REDIRECT = 'app.bugeon.journey://auth-callback';

export interface SessionUser {
  id: string;
  email: string | null;
}

/** 현재 로그인 사용자(없으면 null). */
export async function currentUser(): Promise<SessionUser | null> {
  const c = supabase();
  if (!c) return null;
  const { data } = await c.auth.getUser();
  if (!data.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}

/** Google 로그인 시작(전체 페이지 리다이렉트 · 셸에서는 딥링크 복귀 — ADR-0037). */
export async function signInWithGoogle(): Promise<void> {
  const c = supabase();
  if (!c) throw new Error('Supabase 미설정 — 환경변수 필요');
  const platform = nativePlatform();
  const redirectTo =
    platform === 'browser' && shellState() === 'browser'
      ? window.location.origin + import.meta.env.BASE_URL
      : SHELL_AUTH_REDIRECT;
  const { data, error } = await c.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo, skipBrowserRedirect: platform === 'windows' },
  });
  if (error) throw new Error(error.message);
  if (platform === 'windows') {
    if (!data.url) throw new Error('로그인 주소를 만들지 못했어요.');
    await openDesktopOAuthUrl(data.url);
  }
}

/**
 * 딥링크 URL에서 PKCE code를 꺼낸다. 순수 함수(§10 ③) — 이 판별이 틀리면 로그인이
 * 조용히 안 되므로 유닛이 직접 돌린다. 다른 스킴·code 없음·깨진 URL은 전부 null.
 */
export function authCodeFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'app.bugeon.journey:') return null;
    if (u.hostname !== 'auth-callback') return null;
    if (u.pathname !== '' && u.pathname !== '/') return null;
    const code = u.searchParams.get('code');
    return code?.trim() ? code : null;
  } catch {
    return null;
  }
}

/** 셸의 App 플러그인 최소 모양 — 딥링크 수신(appUrlOpen)만 쓴다. */
interface AppPlugin {
  addListener(event: 'appUrlOpen', cb: (data: { url: string }) => void): unknown;
}

/**
 * 셸에서 브라우저 로그인이 딥링크로 돌아오면 code→세션 교환을 배선한다.
 * 크롬·옛 APK(App 플러그인 없음)에서는 무행동 — 기존 경로에 손대지 않는다(ADR-0036과
 * 같은 규율). 성공은 onAuthStateChange가 화면에 알린다(홈이 이미 구독 중).
 */
export const SHELL_AUTH_ERROR_EVENT = 'journey:shell-auth-error';

const authCodesInFlight = new Set<string>();

function reportShellAuthError(message: string): void {
  console.error('앱 로그인 복귀 실패:', message);
  window.dispatchEvent(new CustomEvent<string>(SHELL_AUTH_ERROR_EVENT, { detail: message }));
}

function exchangeShellAuthUrl(url: string): void {
  const code = authCodeFromUrl(url);
  if (!code) {
    reportShellAuthError('우리 앱의 로그인 주소가 아니어서 열지 않았어요.');
    return;
  }
  if (authCodesInFlight.has(code)) return;
  const c = supabase();
  if (!c) {
    reportShellAuthError('Supabase 설정을 찾지 못했어요.');
    return;
  }
  authCodesInFlight.add(code);
  void c.auth.exchangeCodeForSession(code).then(({ error }) => {
    if (error) {
      authCodesInFlight.delete(code);
      reportShellAuthError(error.message);
    }
  });
}

export function wireShellAuthReturn(): void {
  const platform = nativePlatform();
  if (platform === 'android') {
    const app = shellPlugin<AppPlugin>('App');
    if (!app) return;
    app.addListener('appUrlOpen', ({ url }) => exchangeShellAuthUrl(url));
    return;
  }
  if (platform === 'windows') {
    void wireDesktopAuthUrls(exchangeShellAuthUrl).catch((error) => {
      reportShellAuthError(error instanceof Error ? error.message : String(error));
    });
  }
}

/**
 * 초대 여부를 **물어본 결과**. 🔴 `boolean`이 아니라 유니온인 이유가 이 파일의 핵심이다.
 *
 * 예전엔 `Promise<boolean>`이었고 머리말에 *"오류/미설정 시 false(보수적)"*라고 적혀 있었다.
 * 그 한 줄이 **「거절당했다」와 「물어보지 못했다」를 같은 값으로** 만들었고, 호출부는 그 false를
 * 받아 화면에 「초대된 사용자만 쓸 수 있어요」를 적고 **로그아웃시켰다.** 즉 **비행기 안에서
 * 앱을 열면 소유자가 「당신은 초대되지 않았습니다」를 읽고 세션을 잃었다** — 그리고 다시
 * 로그인하려면 네트워크가 필요하다.
 *
 * 🔴 이건 §8이 이름 붙인 결함이다 — *"모르는 것은 '확인 불가'다. 정상으로도 문제로도
 * 반올림하지 않는다."* 그리고 **이 저장소는 이미 이 규율을 세웠다**: T-025/M-0148의
 * `ProviderProbe`(`{asked:true,…} | {asked:false, why}`)가 같은 모양이고, 그때도 원인은
 * *"「못 물어봤다」를 「없다」로 접은 것"*이었다. 여기만 그 규율을 안 물려받았다(§7 최빈형).
 *
 * **보수적이라는 말이 어느 방향인지 물어야 한다.** DB의 `journey.is_allowed()`가 진짜 방어이고
 * 이 호출은 **친절 안내**다 — 서버는 초대 안 된 사람에게 어차피 한 행도 주지 않는다. 그러니
 * 못 물어본 상태에서 세션을 끊는 것은 **안전을 사는 게 아니라 소유자의 접근을 잃는 것**이다.
 */
export type AllowProbe =
  /** 물어봤고 답을 받았다. `allowed:false`는 **진짜 거절**이다. */
  | { asked: true; allowed: boolean }
  /** 못 물어봤다. 이 상태를 「거절」로 반올림하지 않는다. */
  | { asked: false; why: AllowProbeFailure };

/** 왜 못 물어봤나. 화면 문장은 **이 값 하나에서 파생**된다 — 그래야 모순이 불가능하다(§17 ②). */
export type AllowProbeFailure =
  /** 서버 설정이 없다(로컬 전용 모드). 초대 판정 자체가 성립하지 않는다. */
  | 'no-client'
  /** 브라우저가 오프라인이라고 말한다. */
  | 'offline'
  /** 연결은 있다는데 호출이 실패했다 — 🔴 이때 「연결이 돌아오면」이라고 말하면 거짓이다(§17 ②축). */
  | 'error';

/**
 * 초대 허용 사용자 여부를 **물어본다**(초대제 잠금 — ADR-0021).
 * 🔴 이 함수는 판정을 하지 않는다 — **관측만 돌려주고 판정은 호출부가 한다**(§8).
 */
export async function probeAllowed(): Promise<AllowProbe> {
  const c = supabase();
  if (!c) return { asked: false, why: 'no-client' };
  // 오프라인은 **호출하기 전에** 가른다. 안 그러면 네트워크 실패가 'error'로 뭉뚱그려지고,
  // 화면이 「연결은 멀쩡한데 서버가 이상해요」라는 틀린 말을 하게 된다.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { asked: false, why: 'offline' };
  }
  const { data, error } = await c.rpc('is_allowed');
  if (error) return { asked: false, why: 'error' };
  return { asked: true, allowed: data === true };
}

/** 로그아웃(세션 종료). H-14 로컬 데이터 keep/delete 선택은 후속 구현. */
export async function signOut(): Promise<void> {
  const c = supabase();
  if (!c) return;
  await c.auth.signOut();
}

/** 인증 상태 변화 구독. 반환값 호출로 해지. 미설정 시 즉시 null 통지. */
export function onAuthChange(cb: (user: SessionUser | null) => void): () => void {
  const c = supabase();
  if (!c) {
    cb(null);
    return () => {};
  }
  const { data } = c.auth.onAuthStateChange((_event, session) => {
    const u = session?.user;
    cb(u ? { id: u.id, email: u.email ?? null } : null);
  });
  return () => data.subscription.unsubscribe();
}
