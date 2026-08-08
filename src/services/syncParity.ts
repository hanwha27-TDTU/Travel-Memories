// services/syncParity.ts — 「이 기기가 서버와 같은가」의 **캐시된 대조**.
//
// 첫 화면 배지가 「동기화됨」이라고 말하려면 이 답이 필요하다(사용자 지적 2026-08-05:
// *"'동기화됨' 표시도 클라우드랑 동일하게 표시되었을 때에 한해서만"*).
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 왜 캐시하는가 — 배지가 서버를 매번 때리면 안 된다
// ─────────────────────────────────────────────────────────────────────────────
// 배지는 홈이 다시 그려질 때마다 판정된다(여행 하나 만들 때마다, 필터 누를 때마다).
// 그때마다 `compareStore()`를 부르면 **여러 표를 매번 조회**하게 되고, 이 앱은 사진 앱이라
// egress가 실제 제약이다(map-place-dev §1 6항의 저트래픽 예의와 같은 규율).
//
// 그래서: **동기화가 끝났을 때만** 다시 재고, 그 사이에는 마지막 값을 쓴다. 동기화가
// 돌지 않았으면 서버와의 관계도 안 바뀌었을 가능성이 높다 — 다른 기기가 올렸다면
// 다음 자동 동기화(온라인 복귀·화면 복귀·주기)가 그걸 데려오고 그때 다시 잰다.
//
// 🔴 **낡은 값을 「지금」인 척하지 않는다**: `at`을 함께 들고 다니고, 너무 오래된 값은
//    `null`(모름)로 만료시킨다. 낡은 초록은 초록이 아니다(§8).

import { supabase } from './supabase/client';
import { currentUser } from './auth';
import { compareStore, storeStateRemote } from './storeState';
import { onSyncStatus } from './autoSync';
import type { ParitySnapshot } from '../domain/syncBadgeVerdict';

/**
 * 이보다 오래된 대조는 「모름」으로 본다.
 *
 * 왜 30분인가: 성공한 동기화가 대조값을 갱신한다. 30분이 지났다는 것은 **동기화가 그동안
 * 한 번도 성공하지 못했다**는 뜻이고,
 * 그러면 그 대조값도 믿을 수 없다.
 */
export const PARITY_TTL_MS = 30 * 60 * 1000;

let cached: ParitySnapshot | null = null;
let inFlight: Promise<ParitySnapshot | null> | null = null;
const listeners = new Set<() => void>();

/** 대조의 시작·완료·실패를 배지처럼 캐시 소비자에게 알린다. */
function notifyParityChange(): void {
  for (const listener of listeners) listener();
}

/** 대조 캐시가 바뀌었거나 대조 중인지 바뀔 때 화면이 다시 읽을 수 있게 한다. */
export function onParityChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 동기화 성공 직후에는 대조가 끝날 때까지 「확인 중」으로만 보인다. */
export function isParityRefreshing(): boolean {
  return inFlight !== null;
}

/** 마지막 대조 — 만료됐으면 null. **동기 함수**라 화면이 그리는 중에 바로 읽는다. */
export function lastParity(now = Date.now()): ParitySnapshot | null {
  if (!cached) return null;
  const t = Date.parse(cached.at);
  if (Number.isNaN(t) || now - t > PARITY_TTL_MS) return null;
  return cached;
}

/**
 * 서버와 대조해 캐시를 갱신한다. 실패하면 캐시를 **비운다** —
 * 조회에 실패했는데 옛 「같음」을 들고 있으면 그게 곧 거짓 초록이다(§8).
 *
 * 동시에 여러 번 불려도 한 번만 돈다(single-flight) — 홈이 여러 번 다시 그려질 때
 * 요청이 겹치는 것을 막는다(`autoSync`의 같은 규율).
 */
export function refreshParity(): Promise<ParitySnapshot | null> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const c = supabase();
      if (!c || !(await currentUser())) {
        cached = null;
        return null;
      }
      const cmp = await compareStore(storeStateRemote(c));
      // 어긋난 도메인 수를 센다 — 개수가 아니라 **가짓수**다. 「사진 3장 차이」보다
      // 「2가지가 다름」이 사용자가 다음에 할 일(진단 열기)로 이어진다.
      const differing = Object.values(cmp.counts).filter((d) => d.cloud !== d.local).length;
      cached = { same: differing === 0, differing, at: new Date().toISOString() };
      return cached;
    } catch {
      cached = null;
      return null;
    } finally {
      inFlight = null;
      // 캐시만 갱신하면 화면은 이전의 「대조 확인 중」에 그대로 남는다(M-0022).
      // 완료·실패 모두 다시 그려야 same/different/unknown 중 최종 판정으로 도달한다.
      notifyParityChange();
    }
  })();
  notifyParityChange();
  return inFlight;
}

let installed = false;

/**
 * 동기화가 **성공으로 끝날 때마다** 대조를 다시 잰다.
 *
 * 왜 여기서 거는가: 서버와의 관계가 바뀌는 유일한 계기가 동기화다. 화면이 스스로
 * 주기를 만들면 그 주기가 또 하나의 관리 대상이 되고, 두 주기가 어긋나면 배지가
 * 낡은 값을 보여준다(§7 — 같은 규율을 두 곳에 두지 않는다).
 */
export function installParityWatch(): () => void {
  if (installed) return () => undefined;
  installed = true;
  const off = onSyncStatus((s) => {
    if (s.phase === 'ok') void refreshParity();
    // 실패·로그아웃이면 옛 대조는 못 믿는다 — 비운다(낡은 초록 금지).
    if (s.phase === 'failed' || s.phase === 'signed-out') cached = null;
  });
  return () => {
    off();
    installed = false;
  };
}

/** 테스트용 초기화(모듈 상태를 갖는 모듈의 의무). */
export function __resetParityForTests(): void {
  cached = null;
  inFlight = null;
  installed = false;
  listeners.clear();
}
