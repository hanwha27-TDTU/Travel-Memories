// tests/unit/diagnoseItems.test.ts — 진단 목록이 **정상 항목으로 뒤덮이지 않는가**.
//
// 실제 사고(2026-07-26, 사용자 실기기 지적): 동기화 진단 화면이 정상 활성 사진 10개 + 비용 1개를
// 이상 항목과 똑같은 알약으로 나열했다. "뭐가 문제인지도 잘 모르겠고 너무 나열되어 있기도 하구요."
// 더 나쁜 것은 상한이 없다는 점이었다 — 이 앱은 여행 사진 앱이라 수백 장이 정상이고, 그러면
// 수리 버튼이 목록 뒤로 밀려 **진단 도구가 스스로 수리 경로를 막는다.**
//
// 이 검사가 잠그는 불변식:
//   ① 정상(활성 + 큐 없음)은 목록에 담기지 않는다 — 남아 있는 것이 곧 설명이 필요한 것.
//   ② 목록은 ITEM_CAP을 넘지 않고, 생략했으면 **생략했다고 개수로 말한다**(조용한 절단 금지).

import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '../../src/offline/db';
import { diagnoseSync, ITEM_CAP } from '../../src/services/diagnostics';
import { PURGE_DOMAINS } from '../../src/services/purge';

const U = (n: number): string => `${String(n).padStart(8, '0')}-1111-4222-8333-444444444444`;

function mediaRow(id: string, deleted: boolean): Record<string, unknown> {
  return {
    id,
    tripId: U(900),
    momentId: U(901),
    storagePath: `p/${id}.webp`,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    deletedAt: deleted ? '2026-07-02T00:00:00.000Z' : null,
    version: 1,
  };
}

beforeEach(async () => {
  const d = db();
  await Promise.all([
    d.localMedia.clear(),
    d.localExpenses.clear(),
    d.localTrips.clear(),
    d.localMoments.clear(),
    d.localAudio.clear(),
    d.localVideos.clear(),
    d.localPlaces.clear(),
    d.syncQueue.clear(),
  ]);
});

describe('진단 목록 — 정상은 나열하지 않는다', () => {
  it('활성이고 큐에도 없는 사진은 목록에 담기지 않는다', async () => {
    await db().localMedia.bulkPut([mediaRow(U(1), false), mediaRow(U(2), false)] as never[]);
    const d = await diagnoseSync();
    expect(d.items).toEqual([]);
    expect(d.itemsOmitted).toBe(0);
  });

  it('지운 항목은 목록에 담긴다 — 정말 서버로 갔는지 설명이 필요하다', async () => {
    await db().localMedia.bulkPut([mediaRow(U(1), false), mediaRow(U(2), true)] as never[]);
    const d = await diagnoseSync();
    expect(d.items.map((i) => i.id)).toEqual([U(2)]);
    expect(d.items[0]?.deleted).toBe(true);
    expect(d.opLessItems.map((i) => i.id)).toEqual([U(2)]);
  });

  it('큐에 남아 있으면 활성이어도 목록에 담긴다 — 왜 아직 안 갔는지 설명이 필요하다', async () => {
    await db().localMedia.put(mediaRow(U(3), false) as never);
    await db().syncQueue.add({
      operationId: U(500),
      entityType: 'media',
      entityId: U(3),
      operationType: 'update',
      state: 'local_only',
      attempts: 0,
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    const d = await diagnoseSync();
    expect(d.items.map((i) => i.id)).toEqual([U(3)]);
    expect(d.items[0]?.queued).toBe(true);
  });
});

describe('진단 목록 — 여섯 동기화 형제 대칭', () => {
  it('큐 없는 tombstone을 trip·moment·media·expense·audio·place에서 모두 서버 대조 대상으로 낸다', async () => {
    const d = db();
    const base = {
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
      deletedAt: '2026-07-02T00:00:00.000Z',
      version: 1,
    };
    await Promise.all([
      d.localTrips.put({ ...base, id: U(801) } as never),
      d.localMoments.put({ ...base, id: U(802) } as never),
      d.localMedia.put({ ...base, id: U(803) } as never),
      d.localExpenses.put({ ...base, id: U(804) } as never),
      d.localAudio.put({ ...base, id: U(805) } as never),
      d.localVideos.put({ ...base, id: U(807) } as never),
      d.localPlaces.put({ ...base, id: U(806) } as never),
    ]);
    const result = await diagnoseSync();
    expect(result.opLessItems.map((x) => x.domain)).toEqual(PURGE_DOMAINS);
    expect(result.items.map((x) => x.type)).toEqual(PURGE_DOMAINS);
  });
});

describe('진단 목록 — 상한과 정직한 절단', () => {
  it(`설명 대상이 많아도 ${ITEM_CAP}개를 넘지 않고, 생략분을 개수로 알린다`, async () => {
    const rows = Array.from({ length: ITEM_CAP + 7 }, (_, i) => mediaRow(U(100 + i), true));
    await db().localMedia.bulkPut(rows as never[]);
    const d = await diagnoseSync();
    expect(d.items.length).toBe(ITEM_CAP);
    expect(d.itemsOmitted).toBe(7);
  });

  it('정상 항목은 상한을 소모하지 않는다 — 이상 항목이 정상에 밀려 잘리면 안 된다', async () => {
    const alive = Array.from({ length: 200 }, (_, i) => mediaRow(U(300 + i), false));
    const dead = Array.from({ length: 3 }, (_, i) => mediaRow(U(700 + i), true));
    await db().localMedia.bulkPut([...alive, ...dead] as never[]);
    const d = await diagnoseSync();
    expect(d.items.length).toBe(3);
    expect(d.itemsOmitted).toBe(0);
  });
});
