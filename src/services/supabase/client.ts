// services/supabase/client.ts — Supabase 클라이언트 (docs/SECURITY.md)
// 브라우저에는 publishable 키만. service_role/secret 키는 절대 금지.
// PKCE 플로우(정적 하위경로 OAuth 콜백, ADR-0012). 미설정 시 null 반환(오프라인 우선).
//
// 공유 프로젝트 내 스키마 분리(ADR-0020) — "한 집, 여러 방":
//   하나의 Supabase 프로젝트(한 집)를 여러 앱이 공유하되, 각 앱은 자기 Postgres 스키마(방)만
//   사용해 데이터가 섞이지 않는다. 여행 앱=journey, 회계 앱=public, 메디컬 앱=medical(예).
//   벽(엄격 격리)은 셋으로 선다: ① 클라이언트가 자기 스키마만 노출(db.schema, 아래) ②
//   각 스키마 테이블에 소유자 범위 RLS(auth.uid()) ③ Storage는 앱별 버킷(journey-media 등)+버킷
//   RLS. 스키마 간 FK·뷰로 새지 않게 한다. 인증(auth.users)만 공유 — RLS가 방을 가른다.

import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

function createJourneyClient(u: string, k: string) {
  return createClient(u, k, {
    // 여행 앱은 journey 스키마만 사용한다. public(회계 앱)은 접근하지 않는다.
    // 주의: 대시보드 Settings → Data API → Exposed schemas에 'journey' 추가 필요.
    db: { schema: 'journey' },
    auth: {
      flowType: 'pkce',
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
}

/** 여행 앱 클라이언트 타입 — journey 스키마 고정(추론 타입 그대로 사용). */
export type JourneyClient = ReturnType<typeof createJourneyClient>;

let _client: JourneyClient | null = null;

/** 환경변수가 있을 때만 클라이언트를 만든다. 없으면 null(로컬 전용 동작). */
export function supabase(): JourneyClient | null {
  if (_client) return _client;
  if (!url || !publishableKey) return null;
  _client = createJourneyClient(url, publishableKey);
  return _client;
}

export function isConfigured(): boolean {
  return Boolean(url && publishableKey);
}
