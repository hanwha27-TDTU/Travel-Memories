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
