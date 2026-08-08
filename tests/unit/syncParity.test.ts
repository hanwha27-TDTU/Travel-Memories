// tests/unit/syncParity.test.ts — 비동기 대조의 최종값이 캐시에만 머물지 않게 한다.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const currentUserMock = vi.fn();
const supabaseMock = vi.fn();
const storeStateRemoteMock = vi.fn();
const compareStoreMock = vi.fn();
const onSyncStatusMock = vi.fn();

vi.mock('../../src/services/auth', () => ({ currentUser: () => currentUserMock() }));
vi.mock('../../src/services/supabase/client', () => ({ supabase: () => supabaseMock() }));
vi.mock('../../src/services/storeState', () => ({
  storeStateRemote: (...args: unknown[]) => storeStateRemoteMock(...args),
  compareStore: (...args: unknown[]) => compareStoreMock(...args),
}));
vi.mock('../../src/services/autoSync', () => ({ onSyncStatus: (listener: unknown) => onSyncStatusMock(listener) }));

const mod = await import('../../src/services/syncParity');
const {
  __resetParityForTests,
  installParityWatch,
  isParityRefreshing,
  lastParity,
  onParityChange,
  refreshParity,
  refreshParityAfterSync,
} = mod;

beforeEach(() => {
  __resetParityForTests();
  currentUserMock.mockReset().mockResolvedValue({ id: 'u1' });
  supabaseMock.mockReset().mockReturnValue({});
  storeStateRemoteMock.mockReset().mockReturnValue({});
  compareStoreMock.mockReset().mockResolvedValue({ counts: { trips: { cloud: 1, local: 1 } } });
  onSyncStatusMock.mockReset().mockReturnValue(() => undefined);
});

describe('대조 완료 신호', () => {
  it('성공 대조의 시작과 완료를 알리고, 완료 후 최신 캐시를 읽게 한다', async () => {
    const changes: boolean[] = [];
    onParityChange(() => changes.push(isParityRefreshing()));

    await refreshParity();

    expect(changes).toEqual([true, false]);
    expect(lastParity()?.same).toBe(true);
  });

  it('대조 실패도 완료 신호를 내고 낡은 대조값을 남기지 않는다', async () => {
    await refreshParity();
    compareStoreMock.mockRejectedValueOnce(new Error('network'));
    const changes: boolean[] = [];
    onParityChange(() => changes.push(isParityRefreshing()));

    await refreshParity();

    expect(changes).toEqual([true, false]);
    expect(lastParity()).toBeNull();
  });

  it('동기화 성공 뒤 대조 완료도 구독자에게 전달하고, 해지 뒤에는 다시 그리지 않는다', async () => {
    let syncListener!: (status: { phase: string }) => void;
    onSyncStatusMock.mockImplementation((listener) => {
      syncListener = listener as typeof syncListener;
      return () => undefined;
    });
    const offWatch = installParityWatch();
    const repaint = vi.fn();
    const offChange = onParityChange(repaint);

    syncListener({ phase: 'ok' });
    await Promise.resolve();
    await Promise.resolve();

    expect(repaint).toHaveBeenCalledTimes(2);
    expect(lastParity()?.same).toBe(true);

    offChange();
    await refreshParity();
    expect(repaint).toHaveBeenCalledTimes(2);
    offWatch();
  });

  it('동기화 전에 시작한 대조가 있으면 성공 뒤 새 스냅샷을 반드시 한 번 더 읽는다', async () => {
    let release!: () => void;
    compareStoreMock.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ counts: { trips: { cloud: 1, local: 0 } } });
    }));
    compareStoreMock.mockResolvedValueOnce({ counts: { trips: { cloud: 1, local: 1 } } });

    const oldComparison = refreshParity();
    const afterSync = refreshParityAfterSync();
    await Promise.resolve();
    await Promise.resolve();
    release();
    await oldComparison;
    await afterSync;

    expect(compareStoreMock).toHaveBeenCalledTimes(2);
    expect(lastParity()?.same).toBe(true);
  });
});
