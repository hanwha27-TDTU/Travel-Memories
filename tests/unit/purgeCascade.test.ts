// tests/unit/purgeCascade.test.ts — 🔴 M-0107: **순간도 부모다.**
//
// ── 무슨 일이 있었나 (2026-08-05 · 사용자 실기기 Windows PC) ─────────────────
// 서버 스키마는 `media/expenses/audio → moments → trips`로 두 단계 `ON DELETE CASCADE`인데,
// 앱은 가족 개념을 **여행에만** 뒀다(`if (domain === 'trip')`). 그래서 순간을 영구삭제하면
// 서버는 자식 사진을 지우는데 앱은 몰랐고, 남은 자식은:
//
//   ① 영구삭제 원장에 못 들어가 → R2 바이트가 「설명할 수 없는 사진 파일」로 영원히 남고
//   ② 부모가 없어 → 「되살릴 곳이 없는 항목」이 되고
//   ③ 그 행의 delete op이 서버에서 FK 위반(4xx) → `permanent_failed`로 굳어
//      push가 **영원히 건너뛴다** → 「막힌 작업 13건」
//
// 바로 옆 `restoreTrashedChild`는 순간을 되살릴 때 자식을 **이미 데려가고 있었다** —
// 되살리기는 가족을 알고 지우기는 몰랐다. §7이 말하는 형제 비대칭이 정확히 이 형태다.
//
// 이 파일은 그 계약을 **양방향으로** 잠근다: 데려가야 할 때 데려가는가, 데려가면 안 될 때
// 가만두는가.

import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { db, type LocalMedia, type SyncQueueItem } from '../../src/offline/db';
import {
  asPurgeParent,
  cascadeChildDomains,
  collectPurgeTargets,
  sweepPurgedOrphans,
  purgedIdSet,
  purgeOpType,
} from '../../src/services/purge';
import { purgeChildPermanently, PendingChildSyncError } from '../../src/services/trash';
import { pushPurges, type PurgeRemote } from '../../src/services/sync';

const TRIP = 'aaaaaaaa-0000-4000-8000-000000000001';
const MOMENT = 'bbbbbbbb-0000-4000-8000-000000000002';
const OTHER_MOMENT = 'bbbbbbbb-0000-4000-8000-000000000003';

beforeEach(async () => {
  const d = db();
  await Promise.all([
    d.localTrips.clear(),
    d.localMoments.clear(),
    d.localMedia.clear(),
    d.localExpenses.clear(),
    d.localAudio.clear(),
    d.syncQueue.clear(),
    d.purgedIds.clear(),
  ]);
});

const stamp = (deleted: string | null) => ({
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  version: 1,
  deletedAt: deleted,
});

async function seedMoment(momentId = MOMENT, deleted: string | null = '2026-08-02T00:00:00.000Z'): Promise<void> {
  const d = db();
  await d.localTrips.put({
    id: TRIP, title: '여행', startDate: '', endDate: '', status: 'active', ...stamp(null),
  });
  await d.localMoments.put({
    id: momentId, tripId: TRIP, occurredAt: '2026-08-01T00:00:00.000Z',
    title: '순간', note: '', emotion: '', placeName: '', ...stamp(deleted),
  });
}

async function seedMedia(id: string, momentId = MOMENT, path?: string): Promise<void> {
  const blob = new Blob(['x'], { type: 'image/webp' });
  const row: LocalMedia = {
    id, momentId, tripId: TRIP, mime: 'image/webp',
    displayBlob: blob, thumbBlob: blob, width: 1, height: 1,
    takenAt: '2026-08-01T00:00:00.000Z', gpsLat: null, gpsLng: null, sortOrder: null,
    bytesOriginal: 1, bytesDisplay: 1,
    ...(path ? { storagePath: path } : {}),
    ...stamp('2026-08-02T00:00:00.000Z'),
  };
  await db().localMedia.put(row);
}

const deadOp = (entityId: string): SyncQueueItem => ({
  operationId: crypto.randomUUID(),
  entityType: 'media',
  entityId,
  operationType: 'delete',
  // 사용자 기기에 실제로 박혀 있던 상태 — push가 **영원히 건너뛴다**.
  state: 'permanent_failed',
  attempts: 5,
  createdAt: '2026-08-03T00:00:00.000Z',
});

describe('등록부가 부모를 안다 (손으로 적은 `=== \'trip\'`을 대신한다)', () => {
  it('순간도 부모다 — 자식은 사진·비용·소리', () => {
    expect(asPurgeParent('moment')).toBe('moment');
    expect(cascadeChildDomains('moment').sort()).toEqual(['audio', 'expense', 'media', 'video']);
  });

  it('사진·비용·소리·장소는 잎이다 — 가족 쓸기를 하지 않는다', () => {
    for (const leaf of ['media', 'expense', 'audio', 'place'] as const) {
      expect(asPurgeParent(leaf)).toBeNull();
    }
  });

  it('여행의 자식에는 장소가 없다(C-1) — 순간의 자식에도 없다', () => {
    expect(cascadeChildDomains('trip')).not.toContain('place');
    expect(cascadeChildDomains('moment')).not.toContain('place');
    expect(cascadeChildDomains('moment')).not.toContain('moment');
  });
});

describe('🔴 순간 영구삭제가 자식을 데려간다 (M-0107)', () => {
  it('가족 모으기가 순간 + 그 사진을 준다', async () => {
    await seedMoment();
    await seedMedia('cccccccc-0000-4000-8000-000000000010', MOMENT, 'u/a.webp');
    await seedMedia('cccccccc-0000-4000-8000-000000000011', OTHER_MOMENT); // 다른 순간의 사진

    const targets = await collectPurgeTargets('moment', MOMENT);
    expect(targets.map((t) => t.id)).toEqual([MOMENT, 'cccccccc-0000-4000-8000-000000000010']);
    // 🔴 바이트 경로를 **행이 사라지기 전에** 실어 둔다 — 서버 행이 없으면 유일한 근거다.
    expect(targets[1]?.bytePath).toBe('u/a.webp');
    // 뿌리는 자기 가족을 쓸고, 자식은 뿌리에 업혀 간다(요청 낭비 방지).
    expect(targets[0]?.underRoot).toBeUndefined();
    expect(targets[1]?.underRoot).toBe(true);
  });

  it('로컬 행·표식·전파 op이 자식까지 함께 만들어진다', async () => {
    await seedMoment();
    const photo = 'cccccccc-0000-4000-8000-000000000010';
    await seedMedia(photo, MOMENT, 'u/a.webp');

    await purgeChildPermanently('moment', MOMENT);

    expect(await db().localMoments.get(MOMENT)).toBeUndefined();
    expect(await db().localMedia.get(photo)).toBeUndefined(); // ← 옛 코드였다면 남았다
    const marks = await purgedIdSet();
    expect(marks.has(MOMENT)).toBe(true);
    expect(marks.has(photo)).toBe(true);
    const purges = (await db().syncQueue.toArray()).filter((o) => o.operationType === 'purge');
    expect(purges.map((o) => o.entityType).sort()).toEqual([purgeOpType('media'), purgeOpType('moment')].sort());
    expect(purges.find((o) => o.entityId === photo)?.bytePath).toBe('u/a.webp');
  });

  it('사전 조건이 **가족의** 대기 작업을 센다 — 자식 op을 놓치면 그게 영원히 막힌다', async () => {
    await seedMoment();
    const photo = 'cccccccc-0000-4000-8000-000000000010';
    await seedMedia(photo, MOMENT);
    await db().syncQueue.add(deadOp(photo)); // 순간 자신에는 op이 없다

    await expect(purgeChildPermanently('moment', MOMENT)).rejects.toBeInstanceOf(PendingChildSyncError);
    expect(await db().localMoments.get(MOMENT)).toBeDefined(); // 아무것도 지우지 않았다
  });

  it('사진 하나만 영구삭제하면 형제 사진은 건드리지 않는다 (없어야 할 때 없는가)', async () => {
    await seedMoment();
    const a = 'cccccccc-0000-4000-8000-000000000010';
    const b = 'cccccccc-0000-4000-8000-000000000011';
    await seedMedia(a, MOMENT, 'u/a.webp');
    await seedMedia(b, MOMENT, 'u/b.webp');

    await purgeChildPermanently('media', a);

    expect(await db().localMedia.get(a)).toBeUndefined();
    expect(await db().localMedia.get(b)).toBeDefined();
    expect(await db().localMoments.get(MOMENT)).toBeDefined(); // 부모를 데려가지 않는다
  });
});

describe('🔴 부모가 영구삭제된 자식을 데려간다 — 이미 벌어진 상태의 복구 (M-0107)', () => {
  /** 사용자 기기에 실제로 있던 상태: 순간은 원장으로 사라졌고 사진 tombstone + 죽은 op만 남았다. */
  async function orphanState(path = 'u/orphan.webp'): Promise<string> {
    const photo = 'cccccccc-0000-4000-8000-000000000020';
    await seedMoment();
    await seedMedia(photo, MOMENT, path);
    // 다른 기기의 영구삭제를 원장으로 배운 상태 — 순간 행만 사라지고 표식이 남는다.
    await db().localMoments.delete(MOMENT);
    await db().purgedIds.put({ id: MOMENT, entityType: 'unknown', purgedAt: '2026-08-03T00:00:00.000Z' });
    await db().syncQueue.add(deadOp(photo));
    return photo;
  }

  it('고아를 영구삭제로 마무리하고 막힌 op을 걷어낸다', async () => {
    const photo = await orphanState();

    expect(await sweepPurgedOrphans()).toBe(1);

    expect(await db().localMedia.get(photo)).toBeUndefined();
    expect((await purgedIdSet()).has(photo)).toBe(true);
    const ops = await db().syncQueue.toArray();
    // 영원히 막혀 있던 delete op은 사라지고, 전파 op이 그 자리를 대신한다.
    expect(ops.filter((o) => o.operationType === 'delete')).toEqual([]);
    const purge = ops.find((o) => o.operationType === 'purge' && o.entityId === photo);
    expect(purge?.bytePath).toBe('u/orphan.webp'); // R2 고아를 지울 유일한 근거
  });

  it('부모가 이 기기에 살아 있으면 건드리지 않는다 (복원됐을 수 있다)', async () => {
    const photo = await orphanState();
    await seedMoment(MOMENT); // 부모가 되살아난 상태

    expect(await sweepPurgedOrphans()).toBe(0);
    expect(await db().localMedia.get(photo)).toBeDefined();
  });

  it('복원 대기 중인 부모는 건드리지 않는다 (복원을 조용히 무효화하지 않는다)', async () => {
    const photo = await orphanState();
    await db().syncQueue.add({
      operationId: crypto.randomUUID(), entityType: 'unpurge:ledger', entityId: MOMENT,
      operationType: 'unpurge', state: 'local_only', attempts: 0, createdAt: '2026-08-04T00:00:00.000Z',
    });

    expect(await sweepPurgedOrphans()).toBe(0);
    expect(await db().localMedia.get(photo)).toBeDefined();
  });

  it('표식이 없는 부모(아직 못 받았을 뿐)는 건드리지 않는다', async () => {
    const photo = await orphanState();
    await db().purgedIds.clear();

    expect(await sweepPurgedOrphans()).toBe(0);
    expect(await db().localMedia.get(photo)).toBeDefined();
  });

  it('멱등 — 두 번 돌려도 두 번째는 0건이다', async () => {
    await orphanState();
    expect(await sweepPurgedOrphans()).toBe(1);
    expect(await sweepPurgedOrphans()).toBe(0);
  });

  it('전파가 op에 적힌 경로로 R2 바이트를 지운다 — 서버 행이 없어 물어볼 곳이 없다', async () => {
    await orphanState('u/orphan.webp');
    await sweepPurgedOrphans();

    const removed: string[] = [];
    const remote: PurgeRemote = {
      ledgerAdd: () => Promise.resolve({}),
      ledgerHas: () => Promise.resolve({ found: true }),
      ledgerAll: () => Promise.resolve({ ids: [] }),
      ledgerRemove: () => Promise.resolve({ removed: 0 }),
      familyIds: () => Promise.resolve({ ids: [] }),
      familyBytePaths: () => Promise.resolve({ paths: [] }),
      // 🔴 서버 행이 이미 없다 — 부모 cascade가 데려갔기 때문이다. 경로를 물어도 답이 없다.
      bytePath: () => Promise.resolve({ path: null }),
      hardDelete: () => Promise.resolve({}),
      hardDeleteFamily: () => Promise.resolve({}),
      stillThere: () => Promise.resolve({ found: false }),
      remainingInFamily: () => Promise.resolve({ count: 0 }),
    };
    const r = await pushPurges(remote, {
      remove: (p) => {
        removed.push(p);
        return Promise.resolve({});
      },
    });

    expect(r.failed).toBe(0);
    expect(removed).toEqual(['u/orphan.webp']); // 옛 코드였다면 []였고 파일은 영원히 남았다
  });
});
