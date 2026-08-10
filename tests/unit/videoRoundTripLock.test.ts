import { describe, expect, it, vi } from 'vitest';
import { withVideoRoundTripLock, writeCrashJournal, type CrossTabLockManager } from '../../src/services/videoRoundTrip';

describe('영상 서버 왕복 cross-tab 잠금', () => {
  it('Web Lock을 얻지 못하면 본 작업을 한 줄도 실행하지 않는다', async () => {
    const task = vi.fn(async () => 'ran');
    const locks: CrossTabLockManager = {
      request: async (_name, options, callback) => {
        expect(options).toEqual({ mode: 'exclusive', ifAvailable: true });
        return callback(null);
      },
    };
    await expect(withVideoRoundTripLock(task, locks)).resolves.toEqual({ acquired: false });
    expect(task).not.toHaveBeenCalled();
  });

  it('독점 Lock 소유자 한 명에게만 작업을 맡긴다', async () => {
    const task = vi.fn(async () => 'done');
    const locks: CrossTabLockManager = {
      request: async (name, _options, callback) => {
        expect(name).toBe('bugeon:videoRoundTrip');
        return callback({ name });
      },
    };
    await expect(withVideoRoundTripLock(task, locks)).resolves.toEqual({ acquired: true, value: 'done' });
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('잠금 API가 없는 환경은 낙관적 동시 실행으로 내려가지 않는다', async () => {
    const task = vi.fn(async () => 'unsafe');
    await expect(withVideoRoundTripLock(task, null)).resolves.toEqual({ acquired: false });
    expect(task).not.toHaveBeenCalled();
  });

  it('crash journal 쓰기 예외를 삼키지 않고 서버 쓰기 전에 실패한다', () => {
    const storage = {
      setItem: () => { throw new DOMException('quota', 'QuotaExceededError'); },
      getItem: () => null,
    };
    expect(() => writeCrashJournal(storage, 'journal', { runToken: 'run-a' })).toThrow('journal을 저장하지 못했습니다');
  });

  it('저장 API가 조용히 버린 journal도 read-back 불일치로 거부한다', () => {
    const storage = { setItem: () => undefined, getItem: () => null };
    expect(() => writeCrashJournal(storage, 'journal', { runToken: 'run-a' })).toThrow('되읽었더니 원래 기록과 다릅니다');
  });
});
