// tests/unit/strandedPurge.test.ts — **지웠는데 서버에 남은 항목**(sync-offline-dev §2-C).
//
// 실제 상태(2026-07-26 사용자 실기기): 휴지통을 열었더니 `휴지통이 비어 있어요.` 그런데 서버엔
// 삭제된 여행 `테스트`(07-25 14:09)가 순간 1 · 사진 1과 함께 tombstone으로 남아 있었다.
//
// 원인: ADR-0027 **이전**의 `purgeTripPermanently`는 로컬 표식만 남기고 서버엔 아무것도 알리지
// 않았다(ADR-0025 — "서버 행은 tombstone으로 남겨 둔다"). 전파 op가 **애초에 만들어진 적이
// 없으므로** 아무리 동기화해도 안 간다. 그리고 로컬 표식 때문에 pull이 그 id를 건너뛰어
// **휴지통에도 안 보인다** — 사용자는 "지웠다"고 믿고, 서버는 "안 지웠다"고 알고,
// 앱은 아무 말도 하지 않는 상태였다.
//
// 이 검사가 잠그는 것:
//  ① 어긋남을 **찾는다**(서버 tombstone ∩ 로컬 표식).
//  ② 복구는 **의도를 다시 실어 보내는 것뿐** — 로컬은 이미 사용자 뜻대로 지워져 있다.
//  ③ **표식 없는 남의 tombstone을 영구삭제로 바꾸지 않는다**(가장 위험한 오작동).
//  ④ 멱등 — 이미 큐에 있으면 다시 넣지 않는다.

import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '../../src/offline/db';
import { requeueUnpropagatedPurges, purgeServerOnly, purgeOpType } from '../../src/services/purge';
import { compareStore, type StoreStatePort } from '../../src/services/storeState';

const TRIP = 'e956fd01-8e30-4342-b149-a489773ba0f1'; // 실제로 남아 있던 그 여행
const OTHER = 'bbbbbbbb-2222-4222-8222-222222222222';

beforeEach(async () => {
  const d = db();
  await Promise.all([d.localTrips.clear(), d.localMoments.clear(), d.localMedia.clear(), d.localExpenses.clear(), d.syncQueue.clear(), d.purgedIds.clear()]);
});

/** 개수 대조 쪽은 이 검사의 관심이 아니라 전부 0으로 둔다. */
function port(tombstoned: string[]): StoreStatePort {
  return {
    activeCounts: () => Promise.resolve({ trip: 0, moment: 0, media: 0, expense: 0 }),
    deviceStamps: () => Promise.resolve([]),
    remnantCounts: () => Promise.resolve({ tombstoned: tombstoned.length, purged: 0 }),
    mediaRowIds: () => Promise.resolve([]),
    tombstonedIds: () => Promise.resolve(tombstoned),
  };
}

describe('① 어긋남을 찾는다', () => {
  it('서버 tombstone + 로컬 영구삭제 표식 = 전파 안 된 영구삭제', async () => {
    await db().purgedIds.put({ id: TRIP, entityType: 'trip', purgedAt: '2026-07-25T15:00:00.000Z' });
    const cmp = await compareStore(port([TRIP]));
    expect(cmp.unpropagatedPurges).toEqual([TRIP]);
  });

  it('표식이 없으면 그냥 휴지통 항목이다 — 어긋남이 아니다', async () => {
    const cmp = await compareStore(port([TRIP]));
    expect(cmp.unpropagatedPurges).toEqual([]);
  });

  it('서버에 없으면(이미 하드 삭제됨) 어긋남이 아니다', async () => {
    await db().purgedIds.put({ id: TRIP, entityType: 'trip', purgedAt: '2026-07-25T15:00:00.000Z' });
    const cmp = await compareStore(port([]));
    expect(cmp.unpropagatedPurges).toEqual([]);
  });
});

describe('② 복구는 의도를 다시 실어 보내는 것뿐', () => {
  it('purge op를 만든다 — 로컬 행은 건드리지 않는다(이미 사용자 뜻대로 지워져 있다)', async () => {
    const d = db();
    await d.purgedIds.put({ id: TRIP, entityType: 'trip', purgedAt: '2026-07-25T15:00:00.000Z' });
    expect(await requeueUnpropagatedPurges([TRIP])).toBe(1);

    const ops = await d.syncQueue.toArray();
    expect(ops.length).toBe(1);
    expect(ops[0]?.entityType).toBe(purgeOpType('trip'));
    expect(ops[0]?.entityId).toBe(TRIP);
    expect(ops[0]?.state).toBe('local_only'); // 다음 동기화가 바로 집어간다
    expect(await d.purgedIds.get(TRIP)).toBeTruthy(); // 표식은 그대로
  });

  it('표식의 종류를 그대로 쓴다(사진이면 사진 op)', async () => {
    await db().purgedIds.put({ id: OTHER, entityType: 'media', purgedAt: '2026-07-25T15:00:00.000Z' });
    await requeueUnpropagatedPurges([OTHER]);
    expect((await db().syncQueue.toArray())[0]?.entityType).toBe(purgeOpType('media'));
  });

  it("종류를 모르면('unknown') 여행으로 보낸다 — 가족까지 쓸어 담는 가장 넓은 갈래다", async () => {
    await db().purgedIds.put({ id: OTHER, entityType: 'unknown', purgedAt: '2026-07-25T15:00:00.000Z' });
    await requeueUnpropagatedPurges([OTHER]);
    expect((await db().syncQueue.toArray())[0]?.entityType).toBe(purgeOpType('trip'));
  });
});

describe('③ 표식 없는 남의 tombstone을 영구삭제로 바꾸지 않는다', () => {
  it('표식이 없는 id는 큐에 넣지 않는다 — 이 기기가 지운 것이 아니다', async () => {
    expect(await requeueUnpropagatedPurges([TRIP])).toBe(0);
    expect(await db().syncQueue.count()).toBe(0);
  });

  it('섞여 있으면 표식 있는 것만 골라 넣는다', async () => {
    await db().purgedIds.put({ id: TRIP, entityType: 'trip', purgedAt: '2026-07-25T15:00:00.000Z' });
    expect(await requeueUnpropagatedPurges([TRIP, OTHER])).toBe(1);
    const ops = await db().syncQueue.toArray();
    expect(ops.map((o) => o.entityId)).toEqual([TRIP]);
  });
});

describe('④ 멱등', () => {
  it('이미 큐에 있으면 다시 넣지 않는다', async () => {
    await db().purgedIds.put({ id: TRIP, entityType: 'trip', purgedAt: '2026-07-25T15:00:00.000Z' });
    expect(await requeueUnpropagatedPurges([TRIP])).toBe(1);
    expect(await requeueUnpropagatedPurges([TRIP])).toBe(0);
    expect(await db().syncQueue.count()).toBe(1);
  });

  it('빈 목록이면 아무 일도 하지 않는다', async () => {
    expect(await requeueUnpropagatedPurges([])).toBe(0);
  });
});

describe('⑤ 서버에만 있는 tombstone도 치울 수 있다 (2026-07-26 — 휴지통이 못 보던 것)', () => {
  // 사용자 실기기에서 드러났다: 서버엔 tombstone 사진이 있는데 **휴지통은 비어 있다**고 했다.
  // `listTrashedChildren`은 로컬 Dexie를 보는데 `pullMedia`가 "로컬에 없는 tombstone은 만들지
  // 않는다"(비파괴 규율)로 건너뛰어 그 행이 이 기기에 아예 없었다. 진단은 서버를 보고 "1개",
  // 휴지통은 로컬을 보고 "없음" — **두 화면이 다른 이야기를 했다.** M-0016과 같은 근본형.
  it('로컬에 행이 없어도 purge op와 표식을 만든다', async () => {
    const d = db();
    expect(await d.localMedia.get(OTHER)).toBeUndefined(); // 로컬엔 없다
    expect(await purgeServerOnly('media', [OTHER])).toBe(1);

    const ops = await d.syncQueue.toArray();
    expect(ops.map((o) => o.entityType)).toEqual([purgeOpType('media')]);
    expect(ops[0]?.entityId).toBe(OTHER);
    expect(await d.purgedIds.get(OTHER)).toBeTruthy();
  });

  it('로컬에 행이 있으면 함께 치운다', async () => {
    const d = db();
    const now = '2026-07-01T00:00:00.000Z';
    await d.localMedia.put({
      id: OTHER, tripId: TRIP, momentId: TRIP, width: 1, height: 1, takenAt: '',
      bytesDisplay: 1, createdAt: now, updatedAt: now, deletedAt: now, version: 1,
    } as never);
    await purgeServerOnly('media', [OTHER]);
    expect(await d.localMedia.get(OTHER)).toBeUndefined();
  });

  it('멱등 — 이미 큐에 있으면 다시 넣지 않는다', async () => {
    expect(await purgeServerOnly('media', [OTHER])).toBe(1);
    expect(await purgeServerOnly('media', [OTHER])).toBe(0);
    expect(await db().syncQueue.count()).toBe(1);
  });

  it('빈 목록이면 아무 일도 하지 않는다', async () => {
    expect(await purgeServerOnly('media', [])).toBe(0);
    expect(await db().syncQueue.count()).toBe(0);
  });
});
