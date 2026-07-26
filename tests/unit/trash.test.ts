// tests/unit/trash.test.ts — 휴지통의 **여행 아닌 것들**(F5, 2026-07-26 해소).
//
// 왜: 휴지통이 여행 단위만 다뤄서, 순간·사진·비용을 개별로 지우면 실행취소 토스트가 사라지는
// 순간 **복구 경로가 완전히 사라졌다.** 진단이 「파일이 없는 사진 기록 2건」을 가리키는데
// 사용자가 손댈 곳이 없던 것이 그 구멍의 실물이었다.
//
// 이 검사가 잠그는 것:
//  ① **고아만 보여준다** — 부모가 함께 휴지통이면 여행 휴지통이 이미 보여주므로 중복이고,
//     자식만 복원하면 부모 없는 자식이 생긴다.
//  ② 복원은 **딸린 것까지** 데려온다 — 화면이 목록을 만지면 언젠가 빠뜨린다(M-0007).
//  ③ 영구삭제는 여행과 **같은 규율** — 사전 조건·표식 먼저·전파 op·read-back.

import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '../../src/offline/db';
import { createTripLocalFirst, softDeleteTripLocalFirst } from '../../src/services/trips';
import { createMomentLocalFirst, softDeleteMomentLocalFirst } from '../../src/services/moments';
import {
  listTrashedChildren,
  purgeChildPermanently,
  restoreTrashedChild,
  PendingChildSyncError,
  CHILD_DOMAINS,
} from '../../src/services/trash';
import { purgeOpType } from '../../src/services/purge';

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

async function tripWithMoment(): Promise<{ tripId: string; momentId: string }> {
  const trip = await createTripLocalFirst({ title: '살아 있는 여행' });
  const moment = await createMomentLocalFirst({
    tripId: trip.id,
    title: '지울 순간',
    occurredAt: '2026-07-01T00:00:00.000Z',
  });
  return { tripId: trip.id, momentId: moment.id };
}

describe('① 고아 tombstone만 보여준다', () => {
  it('부모가 살아 있는데 혼자 지워진 순간이 보인다 — 여기 말고는 어디에도 안 보인다', async () => {
    const { momentId } = await tripWithMoment();
    await softDeleteMomentLocalFirst(momentId);

    const list = await listTrashedChildren();
    expect(list.map((c) => c.id)).toEqual([momentId]);
    expect(list[0]?.domain).toBe('moment');
    expect(list[0]?.label).toBe('지울 순간');
  });

  it('부모가 함께 휴지통이면 **안 보인다** — 여행 휴지통이 이미 보여준다', async () => {
    const { tripId, momentId } = await tripWithMoment();
    await softDeleteTripLocalFirst(tripId);

    // 여행 cascade가 순간도 tombstone 했지만, 여기서 또 보이면 같은 것이 두 줄이 된다.
    expect(await db().localMoments.get(momentId)).toBeDefined();
    expect(await listTrashedChildren()).toEqual([]);
  });

  it('살아 있는 항목은 안 보인다', async () => {
    await tripWithMoment();
    expect(await listTrashedChildren()).toEqual([]);
  });

  it('최근 삭제가 먼저 온다', async () => {
    const trip = await createTripLocalFirst({ title: 't' });
    const a = await createMomentLocalFirst({ tripId: trip.id, title: 'A', occurredAt: '2026-07-01T00:00:00.000Z' });
    const b = await createMomentLocalFirst({ tripId: trip.id, title: 'B', occurredAt: '2026-07-01T00:00:00.000Z' });
    await softDeleteMomentLocalFirst(a.id);
    await new Promise((r) => setTimeout(r, 5));
    await softDeleteMomentLocalFirst(b.id);

    expect((await listTrashedChildren()).map((c) => c.label)).toEqual(['B', 'A']);
  });

  it('세 도메인을 모두 다룬다 — 하나만 빠지는 게 이 저장소의 최빈 결함군이다', () => {
    expect([...CHILD_DOMAINS].sort()).toEqual(['expense', 'media', 'moment']);
  });
});

describe('② 복원은 딸린 것까지 데려온다 (M-0007 재발 방지)', () => {
  it('순간을 되살리면 그 순간의 tombstone 사진·비용도 함께 살아난다', async () => {
    const d = db();
    const { tripId, momentId } = await tripWithMoment();
    const now = '2026-07-01T00:00:00.000Z';
    await d.localMedia.put({
      id: '11111111-1111-4111-8111-111111111111',
      tripId,
      momentId,
      width: 1,
      height: 1,
      takenAt: '',
      bytesDisplay: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      version: 1,
    } as never);
    await d.localExpenses.put({
      id: '22222222-2222-4222-8222-222222222222',
      tripId,
      momentId,
      originalAmount: 1000,
      originalCurrency: 'KRW',
      category: '기타',
      note: '',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      version: 1,
    } as never);

    await softDeleteMomentLocalFirst(momentId); // cascade가 사진·비용도 tombstone
    expect((await d.localMedia.toArray())[0]?.deletedAt).not.toBeNull();
    expect((await d.localExpenses.toArray())[0]?.deletedAt).not.toBeNull();

    await restoreTrashedChild('moment', momentId);

    expect((await d.localMoments.get(momentId))?.deletedAt).toBeNull();
    // ← M-0007이 정확히 이 자리에서 났다: 비용만 복원되지 않아 복구 경로가 소멸했다.
    expect((await d.localMedia.toArray())[0]?.deletedAt).toBeNull();
    expect((await d.localExpenses.toArray())[0]?.deletedAt).toBeNull();
  });

  it('복원하면 휴지통에서 사라진다', async () => {
    const { momentId } = await tripWithMoment();
    await softDeleteMomentLocalFirst(momentId);
    await restoreTrashedChild('moment', momentId);
    expect(await listTrashedChildren()).toEqual([]);
  });
});

describe('③ 영구삭제는 여행과 같은 규율', () => {
  it('로컬 행을 지우고 · 표식을 남기고 · 전파 op를 만든다', async () => {
    const d = db();
    const { momentId } = await tripWithMoment();
    await softDeleteMomentLocalFirst(momentId);
    await d.syncQueue.clear(); // 사전 조건: 보낼 것이 없어야 한다

    await purgeChildPermanently('moment', momentId);

    expect(await d.localMoments.get(momentId)).toBeUndefined();
    expect(await d.purgedIds.get(momentId)).toBeTruthy();
    const ops = await d.syncQueue.toArray();
    expect(ops.map((o) => o.entityType)).toEqual([purgeOpType('moment')]);
    expect(ops[0]?.entityId).toBe(momentId);
  });

  it('아직 서버에 안 간 변경이 있으면 거부한다 — 지운 것이 되살아나지 않게', async () => {
    const { momentId } = await tripWithMoment();
    await softDeleteMomentLocalFirst(momentId); // 큐에 tombstone op가 남는다

    await expect(purgeChildPermanently('moment', momentId)).rejects.toBeInstanceOf(PendingChildSyncError);
    expect(await db().localMoments.get(momentId)).toBeDefined(); // 아무것도 안 지웠다
  });

  it('삭제되지 않은 항목은 영구삭제할 수 없다', async () => {
    const { momentId } = await tripWithMoment();
    await db().syncQueue.clear();
    await expect(purgeChildPermanently('moment', momentId)).rejects.toThrow('삭제되지 않은');
  });

  it('이미 없으면 조용히 끝난다(멱등)', async () => {
    await expect(purgeChildPermanently('media', '33333333-3333-4333-8333-333333333333')).resolves.toBeUndefined();
  });

  it('영구삭제하면 휴지통에서 사라진다', async () => {
    const { momentId } = await tripWithMoment();
    await softDeleteMomentLocalFirst(momentId);
    await db().syncQueue.clear();
    await purgeChildPermanently('moment', momentId);
    expect(await listTrashedChildren()).toEqual([]);
  });
});
