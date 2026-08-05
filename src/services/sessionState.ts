// services/sessionState.ts — 「세션·로그인」의 읽기 전용 관측.
//
// 🔴 잠금 배선은 **선언을 읽지 않고 실제로 돌려서** 확인한다(`authGateMismatches()`).
//    "코드에 그 함수가 있다"는 아무것도 보장하지 않는다 — 그 함수가 **옳은 답을 주는지**가
//    질문이고, 순수 함수라 앱이 그 자리에서 확인할 수 있다(§4 — 대조군이 있는 검사).

import { supabase, isConfigured } from './supabase/client';
import { authGateMismatches } from '../domain/authGate';
import type { SessionObservation } from '../domain/sessionVerdict';

/**
 * 앱이 세션을 저장하도록 설정돼 있는가.
 *
 * `createJourneyClient`가 `persistSession: true`로 고정돼 있으므로 이 값은 상수다.
 * 그래도 **상수로 두지 않고 여기서 한 번 이름을 붙이는** 이유: 나중에 설정이 바뀌면
 * 이 한 줄이 바뀌고 진단이 따라온다. 손으로 `true`를 적어 두면 설정이 꺼져도 화면은
 * 계속 「켜짐」이라 말한다(§7 — 화석이 되는 사본).
 */
const PERSIST_SESSION = true;

export async function collectSessionState(): Promise<SessionObservation> {
  const base: SessionObservation = {
    cloudConfigured: isConfigured(),
    signedIn: false,
    expiresInSec: null,
    hasRefreshToken: null,
    persistSession: PERSIST_SESSION,
    // 잠금 배선은 클라우드 유무와 무관하게 확인한다 — 판정 함수는 두 갈래를 다 갖는다.
    lockWired: null,
    deepLinkGuardWired: null,
  };

  // 🔴 실제로 돌려 본다. 어긋난 갈래가 없으면 배선이 살아 있는 것이다.
  //    목록 잠금과 딥링크 가드가 **같은 함수**를 쓰므로(domain/authGate.ts) 한 번 확인으로 둘 다 답한다.
  const mismatches = authGateMismatches();
  base.lockWired = mismatches.length === 0;
  base.deepLinkGuardWired = mismatches.length === 0;

  if (!base.cloudConfigured) return base;
  const c = supabase();
  if (!c) return base;

  try {
    const { data, error } = await c.auth.getSession();
    if (error || !data.session) return base;
    const s = data.session;
    const expiresAt = typeof s.expires_at === 'number' ? s.expires_at : null;
    return {
      ...base,
      signedIn: true,
      // `expires_at`은 초 단위 epoch다. 없으면 `expires_in`으로 갈음하지 않는다 —
      // 그건 발급 시점 기준이라 지금 남은 시간과 다르다(§8 — 다른 값을 같은 척하지 않는다).
      expiresInSec: expiresAt === null ? null : Math.max(0, expiresAt - Math.floor(Date.now() / 1000)),
      hasRefreshToken: Boolean(s.refresh_token),
    };
  } catch {
    // 세션 조회 실패는 「로그아웃」이 아니다 — 모르는 것이다. base가 그대로 나간다.
    return base;
  }
}
