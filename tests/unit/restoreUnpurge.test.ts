// tests/unit/restoreUnpurge.test.ts — **백업 복원이 영구삭제 원장에 막혀 조용히 무효화되던 것**.
//
// 실제 사고(2026-07-26 사용자 실기기): 백업을 복원했는데
//   *"복원 내용은 앱에는 하나도 없고 서버에만 좀비처럼 살아났어요."*
// 실측: 서버 행 전부 0 · 원장 24건 · R2에 고아 사진 파일 10개.
//
// 그때 벌어진 순서:
//   ① 복원이 로컬에 행을 만들고 **로컬** 표식만 걷어낸다
//   ② push → 서버 원장을 보는 BEFORE INSERT 트리거가 **거부**
//   ③ 사진 바이트는 행과 별개로 먼저 올라가 R2에 착지 → 고아 파일
//   ④ 원장 pull → `applyPurgedLedger`가 **로컬 행까지 삭제**
//   ⑤ 사용자에겐 아무 오류도 안 보인다
//
// 근본형: **규칙을 한쪽에만 구현했다**(§7 비대칭). "복원은 영구삭제 의사보다 우선한다"를
// 로컬에는 구현하고 서버에는 구현하지 않았다.
//
// 이 검사가 잠그는 것:
//  ① 복원이 **서버 원장 되돌리기 의사를 남긴다**(큐에) — 오프라인·실패에도 살아남게
//  ② 그 의사가 있는 동안 `applyPurgedLedger`가 그 id를 **건드리지 않는다**(④를 막는 층)
//  ③ 되돌리기가 성공하면 큐에서 사라지고, **실패하면 남는다**(재시도 가능해야 한다)
//  ④ 되읽기로 확인한다 — "지웠다"는 응답을 완료로 치지 않는다

import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '../../src/offline/db';
import { requestUnpurge, pendingUnpurgeIds, applyPurgedLedger, UNPURGE_OP } from '../../src/services/purge';
import { pushUnpurges, type PurgeRemote } from '../../src/services/sync';

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';

beforeEach(async () => {
  const d = db();
  await Promise.all([
    d.localTrips.clear(),
    d.localMoments.clear(),
    d.localMedia.clear(),
    d.localExpenses.clear(),
    d.syncQueue.clear(),
    d.purgedIds.clear(),
  ]);
});

/** 원장 되돌리기만 흉내내는 최소 포트. 나머지는 이 검사의 관심이 아니다. */
function remote(opts: { removeError?: string; after?: string[]; allError?: string } = {}): PurgeRemote {
  return {
    ledgerAdd: () => Promise.resolve({}),
    ledgerHas: () => Promise.resolve({ found: false }),
    ledgerAll: () => Promise.resolve(opts.allError ? { ids: [], error: opts.allError } : { ids: opts.after ?? [] }),
    ledgerRemove: (ids: string[]) =>
      Promise.resolve(opts.removeError ? { removed: 0, error: opts.removeError } : { removed: ids.length }),
    familyIds: () => Promise.resolve({ ids: [] }),
    familyBytePaths: () => Promise.resolve({ paths: [] }),
    bytePath: () => Promise.resolve({ path: null }),
    hardDelete: () => Promise.resolve({}),
    hardDeleteFamily: () => Promise.resolve({}),
    stillThere: () => Promise.resolve({ found: false }),
    remainingInFamily: () => Promise.resolve({ count: 0 }),
  } as unknown as PurgeRemote;
}

describe('① 복원은 서버 원장 되돌리기 의사를 남긴다', () => {
  it('id마다 큐에 작업을 만든다', async () => {
    expect(await requestUnpurge([A, B])).toBe(2);
    const ops = await db().syncQueue.toArray();
    expect(ops.map((o) => o.operationType)).toEqual(['unpurge', 'unpurge']);
    expect(ops.map((o) => o.entityType)).toEqual([UNPURGE_OP, UNPURGE_OP]);
    expect(ops.map((o) => o.state)).toEqual(['local_only', 'local_only']);
  });

  it('멱등 — 이미 있으면 다시 넣지 않는다', async () => {
    await requestUnpurge([A]);
    expect(await requestUnpurge([A, B])).toBe(1);
    expect(await db().syncQueue.count()).toBe(2);
  });

  it('빈 목록이면 아무 일도 하지 않는다', async () => {
    expect(await requestUnpurge([])).toBe(0);
    expect(await db().syncQueue.count()).toBe(0);
  });
});

describe('② 되돌리기 대기 중인 id를 원장 적용이 건드리지 않는다 (④를 막는 층)', () => {
  it('복원한 행을 원장 pull이 지우지 않는다 — 이게 실제로 일어난 일이다', async () => {
    const d = db();
    const now = '2026-07-26T00:00:00.000Z';
    await d.localTrips.put({
      id: A, title: '복원한 여행', status: 'completed', startDate: null, endDate: null,
      createdAt: now, updatedAt: now, deletedAt: null, version: 1,
    } as never);
    await requestUnpurge([A]);

    // 서버 원장이 아직 A를 들고 있다(되돌리기 push 전).
    const applied = await applyPurgedLedger([A]);

    expect(applied).toBe(0); // 표식을 새로 찍지 않는다
    expect(await d.localTrips.get(A)).toBeDefined(); // **행이 살아 있어야 한다**
    expect(await d.purgedIds.get(A)).toBeUndefined();
  });

  it('되돌리기 대기가 없으면 평소대로 지운다(좀비 차단은 그대로 산다)', async () => {
    const d = db();
    const now = '2026-07-26T00:00:00.000Z';
    await d.localTrips.put({
      id: B, title: '남의 기기가 지운 여행', status: 'completed', startDate: null, endDate: null,
      createdAt: now, updatedAt: now, deletedAt: null, version: 1,
    } as never);

    expect(await applyPurgedLedger([B])).toBe(1);
    expect(await d.localTrips.get(B)).toBeUndefined();
    expect(await d.purgedIds.get(B)).toBeTruthy();
  });

  it('pendingUnpurgeIds가 대기 중인 id를 그대로 돌려준다', async () => {
    await requestUnpurge([A, B]);
    expect([...(await pendingUnpurgeIds())].sort()).toEqual([A, B].sort());
  });
});

describe('③ 성공하면 큐에서 사라지고 실패하면 남는다', () => {
  it('원장에서 실제로 빠졌으면 작업을 지운다(되읽기로 확인)', async () => {
    await requestUnpurge([A, B]);
    const r = await pushUnpurges(remote({ after: [] })); // 되읽으니 둘 다 없다
    expect(r).toEqual({ pushed: 2, failed: 0 });
    expect(await db().syncQueue.count()).toBe(0);
  });

  it('되돌리기 호출이 실패하면 **작업을 남긴다** — 남겨야 재시도된다', async () => {
    await requestUnpurge([A]);
    const r = await pushUnpurges(remote({ removeError: 'permission denied' }));
    expect(r.failed).toBe(1);
    expect(await db().syncQueue.count()).toBe(1); // 조용히 포기하면 복원이 또 사라진다
  });

  it('"지웠다"고 응답해도 **원장에 아직 있으면** 완료로 치지 않는다', async () => {
    await requestUnpurge([A]);
    const r = await pushUnpurges(remote({ after: [A] })); // 응답은 성공, 되읽으니 남아 있다
    expect(r.pushed).toBe(0);
    expect(await db().syncQueue.count()).toBe(1);
  });

  it('되읽기 자체를 못 하면 완료로 치지 않는다(모르는 것을 성공으로 반올림 금지)', async () => {
    await requestUnpurge([A]);
    const r = await pushUnpurges(remote({ allError: '네트워크 오류' }));
    expect(r.pushed).toBe(0);
    expect(await db().syncQueue.count()).toBe(1);
  });

  it('일부만 빠졌으면 빠진 것만 지운다', async () => {
    await requestUnpurge([A, B]);
    const r = await pushUnpurges(remote({ after: [B] })); // A만 빠짐
    expect(r).toEqual({ pushed: 1, failed: 1 });
    expect((await db().syncQueue.toArray()).map((o) => o.entityId)).toEqual([B]);
  });

  it('할 일이 없으면 서버를 부르지 않는다', async () => {
    const r = await pushUnpurges(remote({ removeError: '불려서는 안 된다' }));
    expect(r).toEqual({ pushed: 0, failed: 0 });
  });
});

describe('④ 원장에 막혀 죽은 전파 작업을 되살린다', () => {
  // 트리거 거부는 4xx라 classifyError가 'permanent'로 본다 → op이 permanent_failed가 되고
  // push는 그 상태를 **영원히 건너뛴다.** 원장을 풀어도 그 행은 두 번 다시 안 올라간다.
  // 그 판정은 그 순간엔 옳았고, 틀린 것은 **영구로 굳힌 것**이다 — 사유가 방금 사라졌다.
  const deadOp = async (id: string, state: 'permanent_failed' | 'retryable_failed' | 'local_only') => {
    await db().syncQueue.add({
      operationId: `op-${id}-${state}`, entityType: 'trip', entityId: id,
      operationType: 'update', state, attempts: 3, createdAt: '2026-07-26T00:00:00.000Z',
    } as never);
  };

  it('되돌리기가 성공한 id의 막힌 작업을 **다시 보낼 수 있게** 만든다', async () => {
    await deadOp(A, 'permanent_failed');
    await requestUnpurge([A]);

    await pushUnpurges(remote({ after: [] }));

    const op = (await db().syncQueue.toArray()).find((q) => q.operationType === 'update');
    expect(op?.state).toBe('local_only');
    expect(op?.attempts).toBe(0);
  });

  it('되돌리기가 **실패하면** 막힌 작업을 건드리지 않는다(사유가 아직 살아 있다)', async () => {
    await deadOp(A, 'permanent_failed');
    await requestUnpurge([A]);

    await pushUnpurges(remote({ after: [A] })); // 원장에 아직 남아 있다

    const op = (await db().syncQueue.toArray()).find((q) => q.operationType === 'update');
    expect(op?.state).toBe('permanent_failed');
  });

  it('남의 id의 막힌 작업까지 되살리지 않는다', async () => {
    await deadOp(B, 'permanent_failed');
    await requestUnpurge([A]);

    await pushUnpurges(remote({ after: [] }));

    const op = (await db().syncQueue.toArray()).find((q) => q.entityId === B);
    expect(op?.state).toBe('permanent_failed');
  });
});
