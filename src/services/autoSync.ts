// services/autoSync.ts — **동기화를 사람이 기억하지 않아도 되게 만든다.**
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 (사용자 제안 2026-07-26)
// ─────────────────────────────────────────────────────────────────────────────
// "기본적으로 저장, 삭제버튼을 누름과 동시에 모든 기기에 동기화가 즉시 되어야 된다고 생각합니다.
//  … 삭제버튼을 누를 때 이미 한 번 확인하는데다 휴지통으로 가는 것이기에 문제가 없고,
//  휴지통 완전삭제의 경우도 한 번 확인절차를 거치므로 상관없다고 생각해요."
//
// 동의한다. 그리고 실제로 **구멍이 있었다**: `dataManager.ts`는 `runSync`를 아예 import하지
// 않아서 **휴지통 복원·영구삭제·백업 복원 뒤에 동기화가 일어나지 않았다.** 영구삭제 전파
// (ADR-0027)를 만들어 놓고도 그 op가 큐에 앉아만 있었다 — 다른 화면에서 뭔가 저장할 때까지.
// 게다가 `trySync`가 두 화면에 **손으로 중복 구현**돼 있었고(§7), 둘 다 오류를 조용히 삼켰다.
//
// ─────────────────────────────────────────────────────────────────────────────
// 정직한 범위 — "즉시 모든 기기"가 뜻하는 것
// ─────────────────────────────────────────────────────────────────────────────
// 우리 구조에서 **다른 기기는 자기가 당겨와야 안다**(pull). 그래서 이 모듈이 보장하는 것은
//   ① 내가 한 일은 **즉시 올라간다**(push)
//   ② 다른 기기는 **열릴 때·온라인 복귀·화면 복귀·주기**로 받는다
// 진짜 실시간 전파를 원하면 Supabase Realtime 구독이 필요하고 그건 별도 결정이다.
// 이 한계를 숨기면 사용자가 "모든 기기에 즉시 갔다"고 믿게 되는데, 그건 거짓말이다.
//
// ─────────────────────────────────────────────────────────────────────────────
// 자동화가 만드는 새 위험과 그 처방
// ─────────────────────────────────────────────────────────────────────────────
//  · **실패가 숨는다.** 자동이 유일 경로가 되면 사용자는 "당연히 됐겠지" 하고 믿는다.
//    옛 `trySync`는 `catch {}`로 삼켰다 — M-0008(실패가 숨는 지표)과 같은 부류.
//    → 결과·오류를 **상태로 보관**하고 화면·진단이 읽게 한다. 조용히 넘기지 않는다.
//  · **연타/중복 실행.** 사진 여러 장을 저장하면 runSync가 겹쳐 돈다.
//    → **단일 실행(single-flight) + 디바운스 + 후행 1회 예약.**
//  · **비용.** pull은 4개 테이블 전체 조회다. 저장할 때마다 전부 당기면 낭비다.
//    → 지금은 runSync가 push/pull을 함께 하므로 디바운스로 합쳐 호출 수를 줄인다.
//      (push/pull 분리는 후속 — 지금 나누면 "올렸는데 안 받은" 상태가 새로 생긴다.)

import { supabase } from './supabase/client';
import { currentUser, onAuthChange, type SessionUser } from './auth';
import { runSync, type SyncResult } from './sync';
import type { SyncProgress } from '../domain/syncProgress';
import { db, type LocalSyncState, type SyncQueueItem } from '../offline/db';
import { isRetryDue } from '../sync/merge';

export type SyncPhase = 'idle' | 'running' | 'ok' | 'failed' | 'offline' | 'signed-out';

export interface SyncStatus {
  phase: SyncPhase;
  /** 마지막 성공 시각(ISO). 없으면 이 세션에서 한 번도 성공 못 함. */
  lastOkAt: string | null;
  /** 마지막 실패 사유 — **조용히 삼키지 않는다**. */
  lastError: string | null;
  lastResult: SyncResult | null;
  /** 마지막으로 동기화를 부른 이유(진단용). */
  lastReason: string;
  /** 실행 중인 경우에만 실제 도메인 완료 단위를 담는다. */
  progress: SyncProgress | null;
}

let status: SyncStatus = { phase: 'idle', lastOkAt: null, lastError: null, lastResult: null, lastReason: '', progress: null };
const listeners = new Set<(s: SyncStatus) => void>();

export function syncStatus(): SyncStatus {
  return status;
}

export function onSyncStatus(cb: (s: SyncStatus) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function setStatus(patch: Partial<SyncStatus>): void {
  status = { ...status, ...patch };
  for (const cb of listeners) {
    try {
      cb(status);
    } catch {
      /* 구독자 예외가 동기화를 막지 않는다 */
    }
  }
}

// ── 단일 실행 + 디바운스 ────────────────────────────────────────────────────
/** 저장 연타(사진 여러 장 등)를 한 번으로 합치는 창. */
export const DEBOUNCE_MS = 400;

let running: Promise<void> | null = null;
let trailing = false; // 도는 중에 들어온 요청 → 끝난 뒤 **한 번만** 더 돈다
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * 이 실행이 **사용자가 직접 부른 것**인지. 디바운스·후행 실행이 요청을 합치므로 플래그도
 * 합친다 — **창 안의 어느 요청 하나라도 deep이면 그 실행은 deep이다.** 합치면서 잃으면
 * 사용자가 누른 버튼이 조용히 얕은 동기화가 된다.
 */
let deepPending = false;

async function runOnce(reason: string): Promise<void> {
  const c = supabase();
  if (!c) {
    setStatus({ phase: 'signed-out', lastReason: reason });
    return;
  }
  const u = await currentUser();
  if (!u) {
    setStatus({ phase: 'signed-out', lastReason: reason });
    return;
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    // 오프라인은 결함이 아니다 — 기록은 로컬에 안전하고 온라인 복귀 트리거가 다시 부른다.
    setStatus({ phase: 'offline', lastReason: reason });
    return;
  }

  setStatus({ phase: 'running', lastReason: reason, progress: null });
  try {
    // 소비하면서 내린다 — 이 실행이 그 요청을 덮었으므로 다음 실행까지 끌고 가지 않는다.
    const deep = deepPending;
    deepPending = false;
    const r = await runSync(c, u.id, { deep, onProgress: (progress) => setStatus({ progress }) });
    // **실패한 작업이 있으면 성공이 아니다.** `runSync`는 개별 작업 실패를 예외로 던지지 않고
    // 개수로 돌려준다 — 그걸 안 보면 "3건이 안 갔는데 동기화 성공"이라고 말하게 된다.
    // 실제로 그랬다(2026-07-26): 서버 DELETE 권한이 없어 영구삭제 3건이 막혔는데 화면은
    // 성공처럼 읽혔다. 자동화의 가장 큰 위험이 "안 갔는데 갔다고 믿는 것"이라고 바로 위
    // catch에 적어 놓고도, 예외가 아닌 실패는 세지 않고 있었다.
    if (r.failed > 0) {
      setStatus({
        phase: 'failed',
        lastError: `${r.failed}건이 서버에 반영되지 않았어요(나머지 ${r.pushed}건은 갔습니다)`,
        lastResult: r,
        progress: null,
      });
    } else {
      setStatus({ phase: 'ok', lastOkAt: new Date().toISOString(), lastError: null, lastResult: r, progress: null });
    }
  } catch (e) {
    // **조용히 삼키지 않는다.** 자동 동기화의 가장 큰 위험이 "안 갔는데 갔다고 믿는 것"이다.
    setStatus({ phase: 'failed', lastError: e instanceof Error ? e.message : String(e), progress: null });
  }
}

/**
 * 동기화를 요청한다 — **모든 상태 변경 뒤에 부른다.**
 *
 * 겹쳐 불러도 안전하다: 도는 중이면 끝난 뒤 **한 번만** 더 돈다(후행 1회).
 * 반환 프로미스는 "이 요청을 덮는 동기화가 끝났을 때" 풀린다.
 */
export function requestSync(reason: string, opts: { deep?: boolean } = {}): Promise<void> {
  if (opts.deep) deepPending = true;
  if (running) {
    trailing = true;
    return running.then(() => running ?? Promise.resolve());
  }
  running = (async () => {
    try {
      await runOnce(reason);
      while (trailing) {
        trailing = false;
        await runOnce(`${reason}(후행)`);
      }
    } finally {
      running = null;
    }
  })();
  return running;
}

/** 디바운스 요청 — 연타를 한 번으로 합친다(저장 루프 등). */
export function requestSyncSoon(reason: string, opts: { deep?: boolean } = {}): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void requestSync(reason, opts);
  }, DEBOUNCE_MS);
}

// ── 자동 트리거 ─────────────────────────────────────────────────────────────
let installed = false;
/** A browser session checks a signed-in account once, then only flushes real queued work. */
let initiallyCheckedUsers = new Set<string>();

/** True only for work that can safely be retried now, never for permanent failures. */
export function hasDueAutoSyncWork(
  queue: readonly SyncQueueItem[],
  state: Pick<LocalSyncState, 'pendingCanonical'> | undefined,
  nowIso: string,
): boolean {
  if (state?.pendingCanonical) return true;
  return queue.some((op) => op.state === 'local_only'
    || (op.state === 'retryable_failed' && isRetryDue(op, nowIso)));
}

/**
 * online/visibility are recovery signals, not permission for another full pull.
 *
 * A first signed-in check receives an existing cloud archive on a new device. Afterwards this
 * starts only for a pending local operation or canonical job. Server-to-device instant delivery
 * needs a separate Realtime contract; until then we keep manual badge sync rather than pretend
 * that a repeated blind pull is change detection.
 */
async function requestSyncIfNeeded(reason: string, knownUser?: SessionUser): Promise<void> {
  if (!supabase()) return;
  const user = knownUser ?? await currentUser();
  if (!user || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;

  const initial = !initiallyCheckedUsers.has(user.id);
  try {
    const [queue, state] = await Promise.all([
      db().syncQueue.toArray(),
      db().syncState.get(`canonical:${user.id}`),
    ]);
    if (!initial && !hasDueAutoSyncWork(queue, state, new Date().toISOString())) return;
  } catch {
    // A queue-read failure is unknown, not proof of no work. A single sync is safer than skipping it.
  }

  initiallyCheckedUsers.add(user.id);
  await requestSync(reason);
}

/**
 * 로그인 직후 1회, 또는 실제 미전송 변경이 있을 때만 자동 동기화한다.
 *
 * 트리거를 이렇게 고른 이유:
 *  · `online`     — 대기열에 쌓인 변경을 연결되자마자 올린다.
 *  · `visibility` — 대기열이 남아 있을 때만 복구를 재개한다.
 *
 * 완료된 동기화를 5분마다 다시 읽으면 첫 동기화가 느리고 끝나지 않는 것처럼 보인다. 다른
 * 기기의 즉시 변경 감지는 별도 Realtime 계약의 몫이므로, 이 경로에서 근거 없는 전체 pull로
 * 흉내 내지 않는다. 필요하면 사용자가 배지에서 명시적으로 지금 확인한다.
 */
export function installAutoSync(): () => void {
  if (installed) return () => undefined;
  installed = true;

  const onOnline = (): void => void requestSyncIfNeeded('온라인 복귀');
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') void requestSyncIfNeeded('화면 복귀');
  };
  const stopAuth = onAuthChange((user) => {
    if (user) void requestSyncIfNeeded('로그인 확인', user);
  });
  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisible);

  return () => {
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisible);
    stopAuth();
    installed = false;
  };
}

/** 테스트용 초기화(모듈 상태를 갖는 모듈의 의무). */
export function __resetAutoSyncForTests(): void {
  running = null;
  trailing = false;
  if (timer) clearTimeout(timer);
  timer = null;
  installed = false;
  initiallyCheckedUsers = new Set<string>();
  status = { phase: 'idle', lastOkAt: null, lastError: null, lastResult: null, lastReason: '', progress: null };
  listeners.clear();
}
