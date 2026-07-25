// tests/unit/cascadeOps.test.ts — cascade 삭제/복원이 **모든 자식 종류**에 sync op를 만드는가
//
// 실제 사고(2026-07-25): 여행을 지웠는데 서버의 사진 행이 활성으로 남고 R2 객체도 잔류했다.
// 원인은 `softDeleteTripLocalFirst`가 사진·비용을 tombstone하면서 **op는 순간만** 만든 것.
// 옛 주석("미디어는 로컬 전용")이 사진 동기화 도입 후에도 남아 있었다 — 낡은 전제의 화석.
// 순간 삭제(`softDeleteMomentLocalFirst`)는 처음부터 올발랐다: 같은 규율을 두 곳에 손으로
// 구현한 것이 뿌리다.
//
// 이 검사가 잠그는 불변식(결함군 형태로 추상화):
//   **로컬에서 tombstone/복원한 엔티티는 그 종류가 무엇이든 sync 큐 op를 갖는다.**
//   op가 없으면 push가 영원히 일어나지 않고, 서버·바이트 저장소에 고아가 남는다.

import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '../../src/offline/db';
import {
  createTripLocalFirst,
  softDeleteTripLocalFirst,
  restoreTripLocalFirst,
  purgeTripPermanently,
  PendingSyncError,
} from '../../src/services/trips';
import { requeueOrphanTombstones, pullTrips, retryFailedOps } from '../../src/services/sync';
import { importMergeRows } from '../../src/services/backup';

/** 큐에서 (종류 → id 집합) 맵을 만든다. */
async function queued(): Promise<Map<string, Set<string>>> {
  const m = new Map<string, Set<string>>();
  for (const q of await db().syncQueue.toArray()) {
    if (!m.has(q.entityType)) m.set(q.entityType, new Set());
    m.get(q.entityType)!.add(q.entityId);
  }
  return m;
}

/** 여행 + 순간 + 사진 + 비용을 한 벌 만든다(사진·비용은 서비스 우회로 직접 넣는다 — 압축/EXIF 불필요). */
async function seedTrip(): Promise<{ tripId: string; momentId: string; mediaId: string; expenseId: string }> {
  const trip = await createTripLocalFirst({ title: '테스트 여행' });
  const now = new Date().toISOString();
  const momentId = crypto.randomUUID();
  const mediaId = crypto.randomUUID();
  const expenseId = crypto.randomUUID();
  const d = db();
  await d.localMoments.put({
    id: momentId, tripId: trip.id, note: '순간', occurredAt: now, placeName: null, lat: null, lng: null,
    mood: null, createdAt: now, updatedAt: now, deletedAt: null, version: 1, baseVersion: 0, clientOperationId: null,
  } as never);
  await d.localMedia.put({
    id: mediaId, tripId: trip.id, momentId, mime: 'image/webp', width: 10, height: 10,
    originalBlob: new Blob(['o']), displayBlob: new Blob(['d']), thumbBlob: new Blob(['t']),
    takenAt: now, lat: null, lng: null, createdAt: now, updatedAt: now, deletedAt: null,
    version: 1, baseVersion: 0, clientOperationId: null,
  } as never);
  await d.localExpenses.put({
    id: expenseId, tripId: trip.id, momentId, amount: 1000, currency: 'KRW', category: null, note: null,
    occurredAt: now, createdAt: now, updatedAt: now, deletedAt: null, version: 1, baseVersion: 0, clientOperationId: null,
  } as never);
  // 생성 시 큐에 남은 op를 비워, 이후에 생기는 op가 오직 cascade의 결과임을 분명히 한다.
  await d.syncQueue.clear();
  return { tripId: trip.id, momentId, mediaId, expenseId };
}

beforeEach(async () => {
  const d = db();
  await d.localTrips.clear();
  await d.localMoments.clear();
  await d.localMedia.clear();
  await d.localExpenses.clear();
  await d.syncQueue.clear();
  await d.purgedIds.clear();
  try {
    localStorage.clear();
  } catch {
    /* 없어도 무방 */
  }
});

describe('여행 삭제 cascade — 자식 종류가 하나도 빠지지 않는다', () => {
  it('순간·사진·비용 **전부**에 delete op가 생긴다', async () => {
    const { tripId, momentId, mediaId, expenseId } = await seedTrip();
    await softDeleteTripLocalFirst(tripId);

    const q = await queued();
    expect(q.get('trip')?.has(tripId)).toBe(true);
    expect(q.get('moment')?.has(momentId)).toBe(true);
    expect(q.get('media')?.has(mediaId)).toBe(true); // ← 실제로 빠져 있던 자리
    expect(q.get('expense')?.has(expenseId)).toBe(true); // ← 함께 빠져 있던 자리
  });

  it('tombstone된 자식은 모두 op를 갖는다(종류 무관 — 결함군 형태)', async () => {
    const { tripId } = await seedTrip();
    await softDeleteTripLocalFirst(tripId);

    const q = await queued();
    const d = db();
    const orphans: string[] = [];
    for (const m of await d.localMedia.toArray()) {
      if (m.deletedAt !== null && !q.get('media')?.has(m.id)) orphans.push(`media:${m.id}`);
    }
    for (const e of await d.localExpenses.toArray()) {
      if (e.deletedAt !== null && !q.get('expense')?.has(e.id)) orphans.push(`expense:${e.id}`);
    }
    for (const m of await d.localMoments.toArray()) {
      if (m.deletedAt !== null && !q.get('moment')?.has(m.id)) orphans.push(`moment:${m.id}`);
    }
    expect(orphans).toEqual([]); // 하나라도 있으면 그 종류는 서버에 고아로 남는다
  });

  it('복원은 삭제와 대칭이다 — 자식 전부에 update op', async () => {
    const { tripId, momentId, mediaId, expenseId } = await seedTrip();
    const ids = await softDeleteTripLocalFirst(tripId);
    await db().syncQueue.clear(); // 삭제 op를 걷어내고 복원만 관찰
    await restoreTripLocalFirst(tripId, ids); // 묶음 통째로 — 누락이 구조적으로 불가능

    const q = await queued();
    expect(q.get('moment')?.has(momentId)).toBe(true);
    expect(q.get('media')?.has(mediaId)).toBe(true);
    expect(q.get('expense')?.has(expenseId)).toBe(true);
    // 복원 op가 빠지면 서버 tombstone이 남아 다음 pull에서 되살린 것이 도로 지워진다.
  });
});

describe('정합 복구 — 이미 발생한 고아를 되돌린다', () => {
  it('tombstone인데 op가 없는 사진·비용을 재큐잉한다', async () => {
    const { mediaId, expenseId } = await seedTrip();
    const d = db();
    const now = new Date().toISOString();
    // 옛 결함이 만들어낸 상태를 그대로 재현: 로컬은 tombstone인데 큐에는 op가 없다.
    const m = (await d.localMedia.get(mediaId))!;
    await d.localMedia.put({ ...m, deletedAt: now, version: m.version + 1 });
    const e = (await d.localExpenses.get(expenseId))!;
    await d.localExpenses.put({ ...e, deletedAt: now, version: e.version + 1 });
    expect((await queued()).size).toBe(0);

    const r = await requeueOrphanTombstones();
    expect(r).toEqual({ media: 1, expenses: 1 });
    const q = await queued();
    expect(q.get('media')?.has(mediaId)).toBe(true);
    expect(q.get('expense')?.has(expenseId)).toBe(true);
  });

  it('이미 op가 있으면 중복으로 넣지 않는다', async () => {
    const { tripId } = await seedTrip();
    await softDeleteTripLocalFirst(tripId); // 고친 코드는 op를 이미 만든다
    const before = (await db().syncQueue.toArray()).length;

    const r = await requeueOrphanTombstones();
    expect(r).toEqual({ media: 0, expenses: 0 });
    expect((await db().syncQueue.toArray()).length).toBe(before);
  });

  it('활성 항목은 건드리지 않는다 — 살아 있는 기억을 지우는 op를 만들지 않는다', async () => {
    await seedTrip(); // 삭제하지 않음
    expect(await requeueOrphanTombstones()).toEqual({ media: 0, expenses: 0 });
    expect((await db().syncQueue.toArray()).length).toBe(0);
  });
});

describe('영구삭제(A안) — 지운 것이 되살아나지 않는다', () => {
  it('대기 중인 동기화 작업이 있으면 거부한다 — 서버에 활성 행이 남는 갈래를 원천 차단', async () => {
    const { tripId } = await seedTrip();
    await softDeleteTripLocalFirst(tripId); // op가 큐에 쌓인 상태(= 서버 미반영)
    await expect(purgeTripPermanently(tripId)).rejects.toThrow(PendingSyncError);
    // 거부됐으니 로컬 행도 그대로 살아 있어야 한다(중간 상태 금지).
    expect(await db().localTrips.get(tripId)).toBeTruthy();
  });

  it('op가 비면 진행하고, 여행·자식 전부에 영구삭제 표식을 남긴다', async () => {
    const { tripId, momentId, mediaId, expenseId } = await seedTrip();
    await softDeleteTripLocalFirst(tripId);
    await db().syncQueue.clear(); // push 완료 상황을 흉내

    await purgeTripPermanently(tripId);
    const d = db();
    expect(await d.localTrips.get(tripId)).toBeUndefined();
    for (const id of [tripId, momentId, mediaId, expenseId]) {
      expect(await d.purgedIds.get(id), `표식 누락: ${id}`).toBeTruthy();
    }
  });

  it('영구삭제한 여행은 pull이 되살리지 않는다', async () => {
    const { tripId } = await seedTrip();
    await softDeleteTripLocalFirst(tripId);
    await db().syncQueue.clear();
    await purgeTripPermanently(tripId);

    // 서버에는 tombstone이 남아 있다(다른 기기 전파용) — 그걸 그대로 돌려주는 원격을 흉내낸다.
    const serverRow = {
      id: tripId, user_id: 'u', title: '테스트 여행', start_date: null, end_date: null,
      status: 'planned', cover_media_id: null, created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(), deleted_at: new Date().toISOString(),
      version: 9, base_version: 8, client_operation_id: null,
    };
    const remote = {
      upsert: async () => ({}),
      getById: async () => ({ data: null }),
      listAll: async () => ({ data: [serverRow] as never }),
    };
    const r = await pullTrips(remote as never);
    expect(r.pulled).toBe(0); // 건너뛴다
    expect(await db().localTrips.get(tripId)).toBeUndefined(); // 되살아나지 않는다
  });

  it('표식이 없으면 pull이 되살린다 — 이 검사가 공허하지 않음을 증명', async () => {
    const { tripId } = await seedTrip();
    await softDeleteTripLocalFirst(tripId);
    await db().syncQueue.clear();
    await purgeTripPermanently(tripId);
    await db().purgedIds.clear(); // 표식만 지운다(= 옛 결함 상태)

    const serverRow = {
      id: tripId, user_id: 'u', title: '테스트 여행', start_date: null, end_date: null,
      status: 'planned', cover_media_id: null, created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(), deleted_at: new Date().toISOString(),
      version: 9, base_version: 8, client_operation_id: null,
    };
    const remote = {
      upsert: async () => ({}),
      getById: async () => ({ data: null }),
      listAll: async () => ({ data: [serverRow] as never }),
    };
    await pullTrips(remote as never);
    expect(await db().localTrips.get(tripId)).toBeTruthy(); // 옛 결함이 그대로 재현된다
  });
});

describe('백업 복원 — 되살린 기억이 서버로도 간다(F2)', () => {
  it('병합된 행마다 sync op가 생긴다', async () => {
    const now = new Date().toISOString();
    const tripId = crypto.randomUUID();
    const rows = {
      trips: [{
        id: tripId, title: '복원된 여행', startDate: null, endDate: null, status: 'planned',
        coverMediaId: null, createdAt: now, updatedAt: now, deletedAt: null,
        version: 3, baseVersion: 2, clientOperationId: null,
      }],
      moments: [], media: [], expenses: [],
    };
    await importMergeRows(rows as never);

    const q = await queued();
    expect(q.get('trip')?.has(tripId)).toBe(true); // op가 없으면 이 기기에만 갇힌다
  });

  it('복원한 행의 영구삭제 표식은 걷어낸다 — 사용자 의사가 우선', async () => {
    const now = new Date().toISOString();
    const tripId = crypto.randomUUID();
    await db().purgedIds.put({ id: tripId, entityType: 'trip', purgedAt: now });

    await importMergeRows({
      trips: [{
        id: tripId, title: '되살린 여행', startDate: null, endDate: null, status: 'planned',
        coverMediaId: null, createdAt: now, updatedAt: now, deletedAt: null,
        version: 3, baseVersion: 2, clientOperationId: null,
      }],
      moments: [], media: [], expenses: [],
    } as never);

    expect(await db().purgedIds.get(tripId)).toBeUndefined(); // 남으면 pull이 계속 무시한다
    expect(await db().localTrips.get(tripId)).toBeTruthy();
  });
});

describe('pull 대조 재큐잉 — "1회 표식" 설계의 구멍을 막는다', () => {
  const serverTripRow = (id: string, deleted: string | null, version: number): unknown => ({
    id, user_id: 'u', title: '테스트 여행', start_date: null, end_date: null, status: 'planned',
    cover_media_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    deleted_at: deleted, version, base_version: version - 1, client_operation_id: null,
  });
  const remoteOf = (rows: unknown[]): unknown => ({
    upsert: async () => ({}),
    getById: async () => ({ data: null }),
    listAll: async () => ({ data: rows }),
  });

  it('로컬은 지웠는데 서버가 살아 있으면 삭제를 다시 대기열에 올린다', async () => {
    const { tripId } = await seedTrip();
    await softDeleteTripLocalFirst(tripId);
    await db().syncQueue.clear(); // 삭제 op가 유실된 상태(= 실제로 겪은 고아)

    // 서버는 아직 **활성**(version 1) — 삭제가 도달하지 못했다는 직접 증거
    await pullTrips(remoteOf([serverTripRow(tripId, null, 1)]) as never);

    expect((await queued()).get('trip')?.has(tripId)).toBe(true);
  });

  it('서버도 이미 tombstone이면 다시 올리지 않는다 — 완료된 것을 헛되이 밀지 않는다', async () => {
    const { tripId } = await seedTrip();
    await softDeleteTripLocalFirst(tripId);
    await db().syncQueue.clear();

    await pullTrips(remoteOf([serverTripRow(tripId, new Date().toISOString(), 2)]) as never);

    expect((await db().syncQueue.toArray()).length).toBe(0);
  });

  it('활성 항목은 건드리지 않는다', async () => {
    const { tripId } = await seedTrip(); // 삭제하지 않음
    await pullTrips(remoteOf([serverTripRow(tripId, null, 1)]) as never);
    expect((await db().syncQueue.toArray()).filter((q) => q.operationType === 'delete').length).toBe(0);
  });
});

describe('실패로 박힌 작업 재시도', () => {
  it('permanent_failed를 다시 시도 가능한 상태로 되돌린다', async () => {
    const d = db();
    await d.syncQueue.add({
      operationId: crypto.randomUUID(), entityType: 'moment', entityId: crypto.randomUUID(),
      operationType: 'delete', state: 'permanent_failed', attempts: 3, createdAt: new Date().toISOString(),
    });
    expect(await retryFailedOps()).toBe(1);
    expect((await d.syncQueue.toArray())[0]!.state).toBe('local_only');
  });
});
