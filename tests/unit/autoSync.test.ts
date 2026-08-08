// tests/unit/autoSync.test.ts — 자동 동기화가 **겹쳐 돌지 않고, 실패를 숨기지 않는가**.
//
// 사용자 제안(2026-07-26): "저장, 삭제버튼을 누름과 동시에 … 즉시 … 휴먼에러를 방지하기 위해서"
// 자동화는 두 가지 새 위험을 만든다:
//   ① **중복 실행** — 사진 여러 장을 저장하면 요청이 겹친다. 겹쳐 돌면 큐를 두 번 훑고
//      push가 경쟁한다.
//   ② **실패가 숨는다** — 옛 `trySync`는 `catch {}`로 삼켰다. 자동이 유일 경로가 되면
//      사용자는 "당연히 됐겠지" 하고 믿는데 실제론 안 갔을 수 있다(M-0008과 같은 부류).
//
// 이 검사가 그 둘을 잠근다.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const runSyncMock = vi.fn();
const currentUserMock = vi.fn();
const supabaseMock = vi.fn();

vi.mock('../../src/services/sync', () => ({ runSync: (...a: unknown[]) => runSyncMock(...a) }));
vi.mock('../../src/services/auth', () => ({ currentUser: () => currentUserMock() }));
vi.mock('../../src/services/supabase/client', () => ({ supabase: () => supabaseMock() }));

const mod = await import('../../src/services/autoSync');
const { requestSync, syncStatus, onSyncStatus, __resetAutoSyncForTests } = mod;

/** 마이크로태스크를 흘려 보낸다(await 체인이 진행되도록). */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const deferred = (): { promise: Promise<unknown>; resolve: (v?: unknown) => void; reject: (e: unknown) => void } => {
  let resolve!: (v?: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res as (v?: unknown) => void;
    reject = rej;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  __resetAutoSyncForTests();
  runSyncMock.mockReset();
  currentUserMock.mockReset().mockResolvedValue({ id: 'u1', email: null });
  supabaseMock.mockReset().mockReturnValue({});
  runSyncMock.mockResolvedValue({ pushed: 1, failed: 0, pulled: 0, skippedEmptyCloud: false });
  vi.stubGlobal('navigator', { onLine: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('중복 실행 방지(single-flight)', () => {
  it('도는 중에 들어온 요청들은 하나로 합쳐져 **후행 1회**만 더 돈다', async () => {
    const d = deferred();
    runSyncMock.mockReturnValueOnce(d.promise).mockResolvedValue({ pushed: 0, failed: 0, pulled: 0, skippedEmptyCloud: false });

    const first = requestSync('저장');
    // runOnce는 client·user 확인(await)을 거치므로 runSync 호출까지 마이크로태스크를 흘려준다.
    await flush();
    // 아직 첫 실행이 안 끝난 상태에서 세 번 더 요청
    void requestSync('저장');
    void requestSync('저장');
    void requestSync('저장');
    await flush();
    expect(runSyncMock).toHaveBeenCalledTimes(1); // 겹쳐 돌지 않는다

    d.resolve({ pushed: 1, failed: 0, pulled: 0, skippedEmptyCloud: false });
    await first;
    // 세 번을 세 번 더 돌리지 않는다 — 후행 1회로 합친다
    expect(runSyncMock).toHaveBeenCalledTimes(2);
  });

  it('순차 호출은 각각 실행된다(합치기가 정상 동작을 삼키지 않는다)', async () => {
    await requestSync('a');
    await requestSync('b');
    expect(runSyncMock).toHaveBeenCalledTimes(2);
  });
});

describe('실패를 숨기지 않는다', () => {
  it('실패하면 phase=failed 와 사유를 남긴다', async () => {
    runSyncMock.mockRejectedValueOnce(new Error('네트워크 끊김'));
    await requestSync('저장');
    expect(syncStatus().phase).toBe('failed');
    expect(syncStatus().lastError).toBe('네트워크 끊김');
  });

  it('실패해도 예외를 밖으로 던지지 않는다(저장 흐름을 무르지 않는다)', async () => {
    runSyncMock.mockRejectedValueOnce(new Error('x'));
    await expect(requestSync('저장')).resolves.toBeUndefined();
  });

  it('성공하면 phase=ok 와 시각·결과를 남긴다', async () => {
    await requestSync('저장');
    expect(syncStatus().phase).toBe('ok');
    expect(syncStatus().lastOkAt).toBeTruthy();
    expect(syncStatus().lastResult?.pushed).toBe(1);
    expect(syncStatus().lastError).toBeNull();
  });

  it('구독자에게 상태 변화를 알린다(화면이 정직하게 표시할 수 있게)', async () => {
    const seen: string[] = [];
    onSyncStatus((s) => seen.push(s.phase));
    await requestSync('저장');
    expect(seen).toContain('running');
    expect(seen).toContain('ok');
  });

  it('forwards measurable progress and clears it after completion', async () => {
    const seen: number[] = [];
    const stop = onSyncStatus((s) => {
      if (s.progress) seen.push(s.progress.completed);
    });
    runSyncMock.mockImplementationOnce(async (
      _client: unknown,
      _userId: unknown,
      opts: { onProgress?: (progress: { phase: 'pulling'; completed: number; total: number; phaseCompleted: number; phaseTotal: number }) => void },
    ) => {
      opts.onProgress?.({ phase: 'pulling', completed: 9, total: 13, phaseCompleted: 3, phaseTotal: 6 });
      return { pushed: 0, failed: 0, pulled: 0, skippedEmptyCloud: false };
    });

    await requestSync('progress');
    stop();
    expect(seen).toEqual([9]);
    expect(syncStatus().progress).toBeNull();
  });
});

describe('돌 수 없는 상황은 실패가 아니다 — 정직하게 구분한다', () => {
  it('로그인 안 됨 → signed-out (오류로 겁주지 않는다)', async () => {
    currentUserMock.mockResolvedValue(null);
    await requestSync('저장');
    expect(syncStatus().phase).toBe('signed-out');
    expect(runSyncMock).not.toHaveBeenCalled();
  });

  it('Supabase 미설정 → signed-out', async () => {
    supabaseMock.mockReturnValue(null);
    await requestSync('저장');
    expect(syncStatus().phase).toBe('signed-out');
  });

  it('오프라인 → offline (기록은 로컬에 안전하고 복귀 트리거가 다시 부른다)', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    await requestSync('저장');
    expect(syncStatus().phase).toBe('offline');
    expect(runSyncMock).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 🔴 오프라인에 쌓인 것이 **연결되자마자 올라가는가** (사용자 확인 요청 2026-08-05)
// ────────────────────────────────────────────────────────────────────────────
//
// 사용자: *"인터넷이 안되는 지역에서 저장한 것들은 인터넷이 연결되자마자 자동으로 업로드
// 되도록 설계해야 의미가 있는데 그렇게 했겠지요? 당연히..."*
//
// 설계는 그렇게 돼 있었다 — `installAutoSync()`가 `online` 이벤트에 `requestSync`를 건다.
// 그런데 **그게 실제로 도는지 재는 검사가 없었다.** 이 저장소는 정확히 그 형태로 한 번
// 넘어졌다(M-0015: 전파 기능을 만들어 놓고 화면에서 부르지 않아 영구삭제가 큐에 앉아만 있었다).
//
// 이 층이 조용히 깨지면 **오프라인에서 적은 여행 기록이 영영 안 올라간다** — 비타협 원칙 #1이
// 지키는 것은 "로컬에 남는다"까지이고, "서버까지 간다"는 이 리스너가 지킨다. 그래서 잰다.
describe('오프라인 → 온라인 복귀 (사용자 확인 요청)', () => {
  /**
   * 유닛은 node 환경이라 `window`/`document`가 없다. jsdom을 통째로 끌어오는 대신 **이 검사가
   * 쓰는 것만** 세운다(`storeState.test.ts`가 localStorage에 쓴 것과 같은 규율).
   * 가짜라도 **진짜 EventTarget**이라 리스너 등록·해제·발화가 실제로 도는 것을 잰다 —
   * 여기서 `addEventListener`를 mock 함수로 두면 "불렸다"만 재고 **실제 배선은 못 잰다**.
   */
  const fakeHost = (): { target: EventTarget; dispose: () => void } => {
    const target = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as const });
    vi.stubGlobal('window', target);
    vi.stubGlobal('document', doc);
    return { target, dispose: () => vi.unstubAllGlobals() };
  };

  it('🔴 `online` 이벤트가 오면 **스스로** 동기화한다(사람이 버튼을 안 눌러도)', async () => {
    const host = fakeHost();
    vi.stubGlobal('navigator', { onLine: true });
    const uninstall = mod.installAutoSync();
    try {
      // 연결이 돌아왔다.
      host.target.dispatchEvent(new Event('online'));
      await flush();
      expect(runSyncMock).toHaveBeenCalledTimes(1);
      // 사유가 남아야 진단에서 "왜 돌았는지"를 읽을 수 있다(§8 — 관측 가능성).
      expect(syncStatus().lastReason).toBe('온라인 복귀');
    } finally {
      uninstall();
      host.dispose();
    }
  });

  it('🔴 오프라인 동안에는 안 돌고, 복귀하면 그때 돈다 (한 흐름으로 잰다)', async () => {
    // 오프라인: 저장이 동기화를 요청해도 서버로 가지 않는다 — 기록은 로컬에 남는다.
    const host = fakeHost();
    vi.stubGlobal('navigator', { onLine: false });
    const uninstall = mod.installAutoSync();
    try {
      await requestSync('저장');
      expect(runSyncMock).not.toHaveBeenCalled();
      expect(syncStatus().phase).toBe('offline');

      // 연결 복귀 — 아무도 버튼을 누르지 않았는데 올라가야 한다.
      vi.stubGlobal('navigator', { onLine: true });
      host.target.dispatchEvent(new Event('online'));
      await flush();
      expect(runSyncMock).toHaveBeenCalledTimes(1);
      expect(syncStatus().phase).toBe('ok');
    } finally {
      uninstall();
      host.dispose();
    }
  });

  it('화면으로 돌아올 때도 동기화한다(다른 기기의 변경을 받는 유일한 계기)', async () => {
    const host = fakeHost();
    vi.stubGlobal('navigator', { onLine: true });
    const uninstall = mod.installAutoSync();
    try {
      (globalThis.document as unknown as EventTarget).dispatchEvent(new Event('visibilitychange'));
      await flush();
      expect(runSyncMock).toHaveBeenCalledTimes(1);
      expect(syncStatus().lastReason).toBe('화면 복귀');
    } finally {
      uninstall();
      host.dispose();
    }
  });

  it('🔴 해제하면 더 이상 안 돈다 — 리스너가 쌓이면 한 번의 복귀가 여러 번 돈다', async () => {
    const host = fakeHost();
    vi.stubGlobal('navigator', { onLine: true });
    const uninstall = mod.installAutoSync();
    uninstall();
    host.target.dispatchEvent(new Event('online'));
    await flush();
    expect(runSyncMock).not.toHaveBeenCalled();
    host.dispose();
  });
});
