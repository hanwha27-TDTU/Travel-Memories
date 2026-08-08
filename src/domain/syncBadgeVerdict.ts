// domain/syncBadgeVerdict.ts — 첫 화면 동기화 배지의 **판정과 문장**(순수 함수).
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 왜 이 파일이 생겼나 (사용자 지적 2026-08-05)
// ─────────────────────────────────────────────────────────────────────────────
// *"'동기화됨' 표시도 클라우드랑 동일하게 표시되었을 때에 한해서만 동기화됨으로 표기하면
//  문제 없을 듯(클라우드가 정본이므로)"*
//
// 정확한 지적이다. 그 전까지 배지의 판정은 이랬다:
//
//     보낼 게 없다(pending === 0) + 최근 실패 아님  →  "☁️ 동기화됨"
//
// **「보낼 게 없다」는 「같다」가 아니다.** 그리고 그 차이가 정확히 M-0101이었다 — 서버에
// 여행 8개가 있는데 이 기기는 0개를 받은 상태에서, 보낼 것도 없고 실패 표시도 안 났으니
// 화면은 **"동기화됨"**이라고 말했다. 사용자가 잃은 것은 데이터가 아니라
// **앱이 하는 말을 믿을 수 있다는 것**이었다.
//
// 이제 판정은 「서버와 실제로 같은가」를 본다. 그리고 **모르면 모른다고 말한다**(§8) —
// 대조를 아직 못 했으면 「동기화됨」이라 하지 않는다.
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 순수 함수인가
// ─────────────────────────────────────────────────────────────────────────────
// 이 문장은 **사용자가 앱을 열 때마다 가장 먼저 읽는 한 줄**이다. 여기가 거짓말하면
// 나머지 진단이 아무리 정확해도 사용자는 열어 보지 않는다. 그래서 갈래를 전부 유닛으로
// 돌린다(§10 ③ — 자료구조는 옳고 화면 문장만 틀린 부류가 이 저장소의 최빈 결함군이다).

/** `services/autoSync.ts`의 phase 중 이 판정이 쓰는 것만. */
export type SyncPhaseLike = 'idle' | 'running' | 'ok' | 'failed' | 'offline' | 'signed-out';

/** 서버와의 대조 결과. 아직 안 했거나 못 했으면 `null`. */
export interface ParitySnapshot {
  /** 이 기기와 서버의 활성 기록 수가 같은가. */
  same: boolean;
  /** 어긋난 도메인 수(0이면 같다). 사용자에게 「N가지가 다르다」로 나간다. */
  differing: number;
  /** 언제 잰 값인가(ISO). 낡은 초록을 믿지 않게 화면이 이걸 쓴다. */
  at: string;
}

export interface BadgeInput {
  /** 클라우드를 쓰는 배포인가. */
  cloudConfigured: boolean;
  /** 로그인했는가. */
  signedIn: boolean;
  /** 아직 서버로 안 보낸 로컬 변경 수. */
  pending: number;
  phase: SyncPhaseLike;
  /** 최근 실패 사유(phase==='failed'일 때만 의미). */
  lastError: string | null;
  /** 서버 대조 결과. **`null`은 「같다」가 아니라 「모른다」**다. */
  parity: ParitySnapshot | null;
  /** Most recent sync result; shown only after a user-initiated badge sync. */
  lastResult: { pushed: number; pulled: number; failed: number } | null;
  /** Source of the most recent sync request. */
  lastReason: string;
}

export type BadgeLevel = 'ok' | 'info' | 'error';

export interface BadgeView {
  text: string;
  level: BadgeLevel;
  /**
   * 배지를 눌렀을 때 갈 곳. `null`이면 목적지 없음(정상은 침묵 — 진단 §5.1).
   *  · `'sync'`  = 동기화 상태 도구
   *  · `'env'`   = 환경·기능 도구
   *  · `'store'` = 저장 상태(클라우드 대조) 도구
   */
  go: 'sync' | 'env' | 'store' | null;
  /**
   * 🔴 누르면 **동기화도 함께 돌리는가.** [동기화] 버튼을 없애고 그 일을 배지가 받았으므로
   * (사용자 제안 2026-08-05), 「지금 확인」이 필요한 상태에서는 배지가 그 버튼 노릇을 한다.
   */
  syncOnTap: boolean;
}

/**
 * 배지 한 줄.
 *
 * 순서가 곧 우선순위다 — 위에 있는 것이 더 급하다. 아래로 갈수록 조용해진다.
 */
export function syncBadge(i: BadgeInput): BadgeView {
  // ① 클라우드를 안 쓰는 배포 — 실패가 아니라 **그런 배포**다. 왜 서버로 안 가는지는 환경이 답한다.
  if (!i.cloudConfigured) {
    return { text: `📴 로컬 저장 모드 · 대기 ${i.pending}건`, level: 'info', go: 'env', syncOnTap: false };
  }

  // ② 로그인 전 — 조치 버튼(로그인)이 이 화면 헤더에 이미 있으므로 진단으로 보내지 않는다.
  if (!i.signedIn) {
    return { text: `🔒 로그인하면 기기 간 동기화 · 로컬 대기 ${i.pending}건`, level: 'info', go: null, syncOnTap: false };
  }

  // ③ 지금 돌고 있다 — 누르면 또 돌리는 것이 아니라 기다리게 한다.
  if (i.phase === 'running') {
    return { text: '↻ 동기화 중…', level: 'info', go: null, syncOnTap: false };
  }

  // ④ 최근 실패 — pending이 0이어도 이게 먼저다(M-0101: 보낼 게 없어서 조용한 것과
  //    실패했는데 보낼 것도 없어서 조용한 것을 같은 초록으로 칠했다).
  if (i.phase === 'failed') {
    return { text: `⚠️ 동기화 실패: ${i.lastError ?? '원인 미상'}`, level: 'error', go: 'sync', syncOnTap: true };
  }

  // ⑤ 오프라인 — 실패가 아니다. 기록은 로컬에 안전하고 복귀하면 자동으로 올라간다.
  if (i.phase === 'offline') {
    return {
      text: i.pending > 0 ? `📴 오프라인 · 보낼 것 ${i.pending}건 (연결되면 자동으로 올라가요)` : '📴 오프라인',
      level: 'info',
      go: null,
      syncOnTap: false,
    };
  }

  // ⑥ 보낼 것이 남았다 — 누르면 지금 보낸다.
  if (i.pending > 0) {
    return { text: `☁️ 보낼 것 ${i.pending}건 · 눌러서 지금 보내기`, level: 'info', go: null, syncOnTap: true };
  }

  // ── 여기부터는 보낼 것이 없다. 그럼 **정말 같은가?** ──

  // ⑦ 🔴 대조를 못 했다 — **「동기화됨」이라 하지 않는다.** 모르는 것을 정상으로 반올림하는
  //    것이 M-0101이 사용자를 속인 방식이다(§8 · 비타협 원칙 #4).
  if (!i.parity) {
    // Never promote a completed transfer to a full sync before the store comparison returns.
    if (i.phase === 'ok' && i.lastReason === '배지' && i.lastResult) {
      return { text: '✓ 전송 완료 · 대장 대조 확인 중', level: 'info', go: 'store', syncOnTap: false };
    }
    return { text: '☁️ 보낼 것 없음 · 클라우드와 같은지는 확인 전', level: 'info', go: 'store', syncOnTap: true };
  }

  // ⑧ 대조했는데 다르다 — 이게 M-0101이 조용히 지나갔던 자리다.
  if (!i.parity.same) {
    return {
      text: `⚠️ 클라우드와 다름 — ${i.parity.differing}가지`,
      level: 'error',
      go: 'store',
      syncOnTap: true,
    };
  }

  // ⑨ 보낼 것도 없고 서버와도 같다 — **이때만** 동기화됨이다. 정상은 침묵(목적지 없음).
  // Automatic successes stay quiet; an explicit badge tap receives an immediate result.
  if (i.phase === 'ok' && i.lastReason === '배지' && i.lastResult) {
    const { pushed, pulled } = i.lastResult;
    const text = pushed === 0 && pulled === 0
      ? '✓ 동기화 완료 · 변경 없음'
      : `✓ 동기화 완료 · 보냄 ${pushed}건 · 받음 ${pulled}건`;
    return { text, level: 'info', go: null, syncOnTap: false };
  }

  return { text: '☁️ 동기화됨', level: 'ok', go: null, syncOnTap: false };
}

/** 배지의 화면읽기 라벨 — 「›」만 보이는 이동 버튼이 무엇을 하는지 말한다. */
export function badgeActionLabel(v: BadgeView): string {
  const parts: string[] = [];
  if (v.syncOnTap) parts.push('지금 동기화');
  if (v.go === 'sync') parts.push('동기화 상태 열기');
  else if (v.go === 'store') parts.push('클라우드 대조 열기');
  else if (v.go === 'env') parts.push('환경·기능 열기');
  return parts.join(' · ') || '';
}
