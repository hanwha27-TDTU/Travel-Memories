import { describe, expect, it } from 'vitest';
import {
  PULL_SYNC_PLAN,
  PUSH_SYNC_PLAN,
  SYNC_DOMAINS,
  runSyncPlan,
  type SyncDomain,
} from '../../src/services/syncPlan';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('sync dependency plan', () => {
  it('push는 독립 부모와 순간 자식을 각각 병렬로 실행하고 FK 경계만 기다린다', async () => {
    const pending = Object.fromEntries(SYNC_DOMAINS.map((domain) => [domain, deferred<string>()])) as Record<
      SyncDomain,
      ReturnType<typeof deferred<string>>
    >;
    const started: SyncDomain[] = [];
    const tasks = Object.fromEntries(
      SYNC_DOMAINS.map((domain) => [
        domain,
        () => {
          started.push(domain);
          return pending[domain].promise;
        },
      ]),
    ) as Record<SyncDomain, () => Promise<string>>;

    const running = runSyncPlan(PUSH_SYNC_PLAN, tasks);
    await flush();
    expect(started).toEqual(['trip', 'place']);

    pending.trip.resolve('trip');
    await flush();
    expect(started).toEqual(['trip', 'place']);

    pending.place.resolve('place');
    await flush();
    expect(started).toEqual(['trip', 'place', 'moment']);

    pending.moment.resolve('moment');
    await flush();
    expect(started).toEqual(['trip', 'place', 'moment', 'media', 'expense', 'audio', 'video']);

    pending.media.resolve('media');
    pending.expense.resolve('expense');
    pending.audio.resolve('audio');
    pending.video.resolve('video');
    await expect(running).resolves.toEqual({
      trip: 'trip',
      place: 'place',
      moment: 'moment',
      media: 'media',
      expense: 'expense',
      audio: 'audio',
      video: 'video',
    });
  });

  it('pull은 결과 의존성이 없으므로 여섯 도메인을 한 번에 시작한다', async () => {
    const started: SyncDomain[] = [];
    const settled: SyncDomain[] = [];
    const tasks = Object.fromEntries(
      SYNC_DOMAINS.map((domain) => [
        domain,
        async () => {
          started.push(domain);
          return domain;
        },
      ]),
    ) as Record<SyncDomain, () => Promise<SyncDomain>>;

    await runSyncPlan(PULL_SYNC_PLAN, tasks, { onDomainSettled: (domain) => settled.push(domain) });
    expect(started).toEqual(SYNC_DOMAINS);
    expect(settled.slice().sort()).toEqual(SYNC_DOMAINS.slice().sort());
  });

  it('한 형제가 실패해도 같은 단계의 나머지 부수효과가 끝날 때까지 실패를 반환하지 않는다', async () => {
    const trip = deferred<string>();
    const place = deferred<string>();
    let settled = false;
    const neverReached = async () => 'unexpected';
    const running = runSyncPlan(PUSH_SYNC_PLAN, {
      trip: () => trip.promise,
      place: () => place.promise,
      moment: neverReached,
      media: neverReached,
      expense: neverReached,
      audio: neverReached,
      video: neverReached,
    });
    void running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await flush();
    trip.reject(new Error('trip failed'));
    await flush();
    expect(settled).toBe(false);

    place.resolve('place completed');
    await expect(running).rejects.toThrow("동기화 단계 'roots' 실패 — trip: trip failed");
    expect(settled).toBe(true);
  });

  it('모든 직렬 경계는 구체적인 FK 사유를 갖고 모든 도메인은 정확히 한 번 나온다', () => {
    const domains = PUSH_SYNC_PLAN.flatMap((level) => [...level.domains]);
    expect(domains.slice().sort()).toEqual(SYNC_DOMAINS.slice().sort());
    expect(new Set(domains).size).toBe(SYNC_DOMAINS.length);
    for (const level of PUSH_SYNC_PLAN.slice(1)) {
      if (level.waitsFor === null) throw new Error(`${level.id} 직렬 경계 사유가 없습니다.`);
      expect(level.waitsFor.reason.length).toBeGreaterThan(40);
      expect(level.waitsFor.reason).toMatch(/복합 FK/);
    }
  });
});
