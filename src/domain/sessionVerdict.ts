// domain/sessionVerdict.ts — 「세션·로그인」의 판정과 문장(순수 함수).
//
// 이 도구가 묻는 질문(§7-E):
//
//   **「로그인이 유지되고 있고, 로그아웃했을 때 내 기록이 실제로 가려지는가?」**
//
// 사각지대 3건을 한 번에 덮는다(`BLIND_SPOTS`의 device 그룹) — 셋 다 **로그인 상태를 읽어야**
// 답할 수 있어서 따로 두면 사용자가 같은 것을 세 번 묻게 된다:
//   ① 로그인 세션이 얼마나 유지되는가(사용자 요청 2026-08-05: "6개월간 로그인을 유지")
//   ② 로그아웃하면 이 기기의 기록이 실제로 가려지는가(M-0102 수정이 실제로 도는가)
//   ③ 딥링크(/trip/<id>)로 들어와도 그 잠금이 걸리는가
//
// 🔴 ②③은 **지금 상태**가 아니라 **잠금 배선이 살아 있는가**를 묻는다. 로그인 중에는 잠금이
//    발화하지 않는 것이 정상이므로, "지금 가려져 있나"를 재면 늘 「아니오」다 — 그건 결함이
//    아니라 질문이 틀린 것이다(§7-E: 지표가 묻는 질문에 판정을 맞춰라).

export type SessionLevel = 'ok' | 'todo' | 'problem' | 'unknown';

export interface SessionMetricView {
  actual: string;
  expected: string;
  level: SessionLevel;
  meaning?: string;
}

/** 사용자가 요청한 유지 기간(2026-08-05). 이보다 짧으면 자주 다시 로그인하게 된다. */
export const WANTED_SESSION_DAYS = 180;

/**
 * 관측값 — 서비스가 채운다.
 *
 * 🔴 `null`은 **0이 아니라 「모름」**이다. 만료 시각을 못 읽었는데 「곧 끊긴다」고 말하면
 * 사용자가 멀쩡한 세션을 의심하고, 「괜찮다」고 말하면 진짜 만료를 놓친다(§8).
 */
export interface SessionObservation {
  cloudConfigured: boolean;
  signedIn: boolean;
  /** 지금 세션이 만료되기까지 남은 초. 못 읽었으면 null. */
  expiresInSec: number | null;
  /**
   * 자동 갱신 토큰이 있는가. 이게 있으면 만료 시각이 짧아도 **앱이 알아서 늘린다** —
   * 그래서 남은 시간만 보고 판정하면 정상을 문제라 부른다(실제 유지 기간은 이쪽이 정한다).
   */
  hasRefreshToken: boolean | null;
  /** 세션을 저장해 두는 설정이 켜져 있는가(꺼져 있으면 새로고침마다 로그아웃된다). */
  persistSession: boolean;
  /**
   * 🔴 로그아웃 잠금 배선이 코드에 살아 있는가 — 앱이 자기 배선을 **스스로 확인**한 결과.
   * `null`이면 확인하지 못한 것이다.
   */
  lockWired: boolean | null;
  /** 딥링크 가드가 살아 있는가. */
  deepLinkGuardWired: boolean | null;
}

/** ① 로그인이 얼마나 유지되는가. */
export function sessionLifetimeMetric(o: SessionObservation): SessionMetricView {
  if (!o.cloudConfigured) {
    return { actual: '해당 없음(클라우드를 쓰지 않는 배포)', expected: '해당 없음', level: 'ok' };
  }
  if (!o.signedIn) {
    return {
      actual: '로그인 전',
      expected: `${WANTED_SESSION_DAYS}일 유지`,
      level: 'unknown',
      meaning: '로그인하면 이 기기에서 얼마나 유지되는지 여기에 나옵니다.',
    };
  }
  if (!o.persistSession) {
    return {
      actual: '세션을 저장하지 않음',
      expected: `${WANTED_SESSION_DAYS}일 유지`,
      level: 'problem',
      meaning: '앱을 닫거나 새로고침하면 매번 다시 로그인해야 해요.',
    };
  }
  // 🔴 자동 갱신이 있으면 **남은 시간은 유지 기간이 아니다.** 액세스 토큰은 원래 1시간짜리고,
  //    앱이 그걸 계속 갱신한다 — 실제 유지 기간은 서버의 refresh token 정책이 정한다.
  if (o.hasRefreshToken) {
    return {
      actual: '자동 갱신 켜짐 — 쓰는 동안 계속 유지',
      expected: `${WANTED_SESSION_DAYS}일 유지`,
      level: 'ok',
      // 여기서 「180일 보장」이라고 말하면 거짓이다. 실제 상한은 서버가 정하고 앱은 모른다(§8).
    };
  }
  if (o.expiresInSec === null) {
    return {
      actual: '만료 시각을 읽지 못함',
      expected: `${WANTED_SESSION_DAYS}일 유지`,
      level: 'unknown',
      meaning: '세션 정보를 읽지 못했어요. 다시 로그인하면 정상으로 돌아옵니다.',
    };
  }
  const days = Math.floor(o.expiresInSec / 86400);
  const hours = Math.floor(o.expiresInSec / 3600);
  return {
    actual: days >= 1 ? `${days}일 남음` : `${hours}시간 남음`,
    expected: `${WANTED_SESSION_DAYS}일 유지`,
    level: 'todo',
    meaning: '자동 갱신이 꺼져 있어 이 시간이 지나면 다시 로그인해야 해요.',
  };
}

/**
 * ②③ 로그아웃 잠금 배선이 살아 있는가.
 *
 * **지금 가려져 있는가를 묻지 않는다** — 로그인 중에는 안 가려지는 것이 정상이다.
 * 묻는 것은 *"로그아웃하면 가려질 배선이 코드에 있는가"*이고, 그건 앱이 자기 자신을 봐서 안다.
 */
export function lockWiringMetric(o: SessionObservation): SessionMetricView {
  if (!o.cloudConfigured) {
    // 클라우드가 없으면 「다른 계정」 개념이 없어 잠글 것도 없다.
    return { actual: '해당 없음(클라우드를 쓰지 않는 배포)', expected: '해당 없음', level: 'ok' };
  }
  if (o.lockWired === null || o.deepLinkGuardWired === null) {
    return {
      actual: '확인하지 못함',
      expected: '목록·딥링크 둘 다 잠김',
      level: 'unknown',
      meaning: '잠금 배선을 확인하지 못했어요.',
    };
  }
  const missing = [!o.lockWired ? '여행 목록' : '', !o.deepLinkGuardWired ? '딥링크' : ''].filter(Boolean);
  if (missing.length) {
    return {
      actual: `${missing.join('·')}이 안 잠김`,
      expected: '목록·딥링크 둘 다 잠김',
      level: 'problem',
      // 🔴 이건 개인정보 노출 표면이다 — 공유 기기에서 남이 이전 계정 기록을 본다(§0).
      meaning: '로그아웃해도 이 기기에 남은 기록이 보일 수 있어요. 앱을 최신으로 업데이트해 주세요.',
    };
  }
  return { actual: '목록·딥링크 둘 다 잠김', expected: '목록·딥링크 둘 다 잠김', level: 'ok' };
}

/** 두 지표를 계약된 순서로. */
export function sessionMetrics(o: SessionObservation): SessionMetricView[] {
  return [sessionLifetimeMetric(o), lockWiringMetric(o)];
}

/** 판정 한 문장 — 무리별 개수에서 만든다(§7-C). */
export function sessionHeadline(o: SessionObservation): string {
  if (!o.cloudConfigured) return '이 배포는 클라우드를 쓰지 않아요';
  const ms = sessionMetrics(o);
  const bad = ms.filter((m) => m.level === 'problem').length;
  if (bad) {
    if (lockWiringMetric(o).level === 'problem') return '로그아웃해도 기록이 보일 수 있어요';
    return `로그인 설정에 확인할 것이 ${bad}가지 있어요`;
  }
  if (!o.signedIn) return '로그인 전입니다';
  const todo = ms.filter((m) => m.level === 'todo').length;
  if (todo) return '로그인이 언젠가 끊길 수 있어요';
  const unknown = ms.filter((m) => m.level === 'unknown').length;
  if (unknown === ms.length) return '로그인 상태를 확인하지 못했어요';
  return '로그인이 유지되고, 로그아웃하면 기록이 가려집니다';
}
