// services/supabase/client.ts — Supabase 클라이언트 (docs/SECURITY.md)
// 브라우저에는 publishable 키만. service_role/secret 키는 절대 금지.
// PKCE 플로우(정적 하위경로 OAuth 콜백, ADR-0012). 미설정 시 null 반환(오프라인 우선).

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

let _client: SupabaseClient | null = null;

/** 환경변수가 있을 때만 클라이언트를 만든다. 없으면 null(로컬 전용 동작). */
export function supabase(): SupabaseClient | null {
  if (_client) return _client;
  if (!url || !publishableKey) return null;
  _client = createClient(url, publishableKey, {
    auth: {
      flowType: 'pkce',
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
  return _client;
}

export function isConfigured(): boolean {
  return Boolean(url && publishableKey);
}
