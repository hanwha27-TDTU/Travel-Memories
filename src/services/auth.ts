// services/auth.ts — Google 소셜 로그인 (ADR-0009 · invite-only 소유자 한정).
// PKCE 리다이렉트: 콜백은 앱 base URL로 돌아오며 supabase가 detectSessionInUrl로 처리.
// redirectTo는 Supabase Auth의 허용 리다이렉트 목록에 등록되어야 한다(대시보드 설정).

import { supabase } from './supabase/client';

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

/** Google 로그인 시작(전체 페이지 리다이렉트). */
export async function signInWithGoogle(): Promise<void> {
  const c = supabase();
  if (!c) throw new Error('Supabase 미설정 — 환경변수 필요');
  const redirectTo = window.location.origin + import.meta.env.BASE_URL;
  const { error } = await c.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo },
  });
  if (error) throw new Error(error.message);
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
