// tests/unit/purgePropagation.test.ts — 영구삭제가 **모든 기기에서** 사라지는가(ADR-0027).
//
// 사용자 지적(2026-07-26): "다른 기기에서 휴지통을 비웠으면 연동기기에서도 사라져 있어야 되는
// 거 아닌가요?" — 맞다. ADR-0025는 영구삭제를 기기별로 뒀고 그래서 다른 기기 휴지통에 남았다.
//
// 이 검사가 잠그는 불변식(전부 실제 사고 형태에서 역산했다):
//  ① 영구삭제는 **네 도메인 전부**에 전파 op를 만든다 — 한 종류만 빠지면 그 종류가 다른 기기에
//     남는다(M-0006과 같은 형태의 재발 방지).
//  ② 전파 op는 **도메인 push 루프가 건드리면 안 된다** — 로컬 행이 이미 없어서 "고아 작업"으로
//     조용히 폐기되고, 그러면 전파가 영영 일어나지 않는다. 이게 가장 위험한 함정이다.
//  ③ 서버가 알려준 영구삭제를 받으면 로컬 행을 **하드 삭제하고 표식을 남긴다**(멱등).
//  ④ 등록부가 네 도메인을 모두 덮는다 — 빠지면 컴파일 오류지만, 개수도 실행으로 확인한다.

import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '../../src/offline/db';
import { createTripLocalFirst, softDeleteTripLocalFirst, purgeTripPermanently } from '../../src/services/trips';
import { createMomentLocalFirst } from '../../src/services/moments';
import {
  applyRemotePurge,
  purgedIdSet,
  purgeDomainOf,
  purgeOpType,
  DOMAIN_PURGE,
  PURGE_DOMAINS,
} from '../../src/services/purge';
import { pushPending, pushPendingMoments, pushPurges, type PurgeRemote } from '../../src/services/sync';

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

/** 여행 하나 + 순간 하나를 만들고, 삭제까지 마친 뒤 큐를 비운다(= 서버에 반영된 상태를 흉내). */
async function deletedTripWithChild(): Promise<{ tripId: string; momentId: string }> {
  const trip = await createTripLocalFirst({ title: '테스트 여행' });
  const moment = await createMomentLocalFirst({ tripId: trip.id, title: '테스트 순간', occurredAt: '2026-07-01T00:00:00.000Z' });
  await softDeleteTripLocalFirst(trip.id);
  await db().syncQueue.clear(); // 영구삭제 사전조건: 보낼 것이 없어야 한다
  return { tripId: trip.id, momentId: moment.id };
}

describe('① 영구삭제는 네 도메인 전부에 전파 op를 만든다', () => {
  it('여행·순간 각각에 purge 작업이 생긴다', async () => {
    const { tripId, momentId } = await deletedTripWithChild();
    await purgeTripPermanently(tripId);

    const ops = await db().syncQueue.toArray();
    const purges = ops.filter((o) => o.operationType === 'purge');
    expect(purges.length).toBe(2);
    expect(purges.map((o) => o.entityType).sort()).toEqual([purgeOpType('moment'), purgeOpType('trip')].sort());
    expect(purges.map((o) => o.entityId).sort()).toEqual([tripId, momentId].sort());
  });

  it('로컬 행은 실제로 사라지고 표식이 남는다', async () => {
    const { tripId, momentId } = await deletedTripWithChild();
    await purgeTripPermanently(tripId);

    expect(await db().localTrips.get(tripId)).toBeUndefined();
    expect(await db().localMoments.get(momentId)).toBeUndefined();
    const marks = await purgedIdSet();
    expect(marks.has(tripId)).toBe(true);
    expect(marks.has(momentId)).toBe(true);
  });
});

describe('② 전파 op를 도메인 push 루프가 삼키지 않는다 (가장 위험한 함정)', () => {
  it('pushPending(trip)·pushPendingMoments가 purge 작업을 폐기하지 않는다', async () => {
    const { tripId } = await deletedTripWithChild();
    await purgeTripPermanently(tripId);
    const before = (await db().syncQueue.toArray()).filter((o) => o.operationType === 'purge').length;
    expect(before).toBe(2);

    // 도메인 remote는 호출되면 안 된다 — 호출되면 그 자체가 결함이다.
    const boom = {
      upsert: () => Promise.reject(new Error('purge 작업이 도메인 push로 샜다')),
      getById: () => Promise.reject(new Error('purge 작업이 도메인 push로 샜다')),
      listAll: () => Promise.reject(new Error('purge 작업이 도메인 push로 샜다')),
    };
    await pushPending(boom as never, 'u1');
    await pushPendingMoments(boom as never, 'u1');

    const after = (await db().syncQueue.toArray()).filter((o) => o.operationType === 'purge').length;
    expect(after).toBe(2); // 그대로 남아 있어야 한다
  });
});

describe('② 전파 push — 서버에 표식을 찍고 read-back으로 확인한다', () => {
  const okRemote = (): PurgeRemote & { marked: string[]; families: string[] } => {
    const marked: string[] = [];
    const families: string[] = [];
    return {
      marked,
      families,
      mark: (domain, id) => {
        marked.push(`${domain}:${id}`);
        return Promise.resolve({});
      },
      readBack: () => Promise.resolve({ found: true, purgedAt: '2026-07-26T00:00:00.000Z' }),
      markFamily: (tripId) => {
        families.push(tripId);
        return Promise.resolve({});
      },
      unmarkedInFamily: () => Promise.resolve({ count: 0 }),
    };
  };

  it('성공하면 작업이 큐에서 사라진다', async () => {
    const { tripId } = await deletedTripWithChild();
    await purgeTripPermanently(tripId);
    const remote = okRemote();

    const r = await pushPurges(remote);
    expect(r.pushed).toBe(2);
    expect(r.failed).toBe(0);
    expect(remote.marked.some((m) => m.startsWith('trip:'))).toBe(true);
    expect(remote.marked.some((m) => m.startsWith('moment:'))).toBe(true);
    expect((await db().syncQueue.toArray()).filter((o) => o.operationType === 'purge')).toEqual([]);
  });

  it('서버에 행이 없으면(한 번도 동기화 안 된 기록) 완료로 본다 — 영원히 큐에 남지 않게', async () => {
    const { tripId } = await deletedTripWithChild();
    await purgeTripPermanently(tripId);

    const r = await pushPurges({
      mark: () => Promise.resolve({}),
      readBack: () => Promise.resolve({ found: false, purgedAt: null }),
      markFamily: () => Promise.resolve({}),
      unmarkedInFamily: () => Promise.resolve({ count: 0 }),
    });
    expect(r.pushed).toBe(2);
    expect((await db().syncQueue.toArray()).filter((o) => o.operationType === 'purge')).toEqual([]);
  });

  it('서버 오류면 작업을 남긴다 — 다음 동기화에서 다시 시도한다', async () => {
    const { tripId } = await deletedTripWithChild();
    await purgeTripPermanently(tripId);

    const r = await pushPurges({
      mark: () => Promise.resolve({ error: '네트워크 실패' }),
      readBack: () => Promise.resolve({ found: false, purgedAt: null }),
      markFamily: () => Promise.resolve({}),
      unmarkedInFamily: () => Promise.resolve({ count: 0 }),
    });
    expect(r.failed).toBe(2);
    expect((await db().syncQueue.toArray()).filter((o) => o.operationType === 'purge').length).toBe(2);
  });
});


describe('② 서버 기준 가족 쓸기 — 로컬에 없는 자식도 표식을 받는다 (실제 결함)', () => {
  // 실제 사고(2026-07-26): 여행 "R2 테스트"를 영구삭제했더니 여행·순간엔 purged_at이 찍혔는데
  // **사진만 안 찍혔다.** purgeTripPermanently가 자식을 로컬 Dexie에서만 찾는데, tombstone된
  // 사진은 그 기기에 로컬 행이 없을 수 있다(pullMedia가 비파괴 규율로 건너뛴다).
  // 그 사진은 어느 기기에서도 영구삭제되지 않고 서버에 영영 남는다.
  it('여행 purge는 markFamily로 서버 자식까지 쓸어 담는다', async () => {
    const { tripId } = await deletedTripWithChild();
    await purgeTripPermanently(tripId);
    const families: string[] = [];
    const r = await pushPurges({
      mark: () => Promise.resolve({}),
      readBack: () => Promise.resolve({ found: true, purgedAt: '2026-07-26T00:00:00.000Z' }),
      markFamily: (t) => {
        families.push(t);
        return Promise.resolve({});
      },
      unmarkedInFamily: () => Promise.resolve({ count: 0 }),
    });
    expect(r.failed).toBe(0);
    expect(families).toEqual([tripId]); // 여행에 대해 **한 번** 호출
  });

  it('가족에 표식 못 받은 행이 남으면 완료로 치지 않는다(read-back)', async () => {
    const { tripId } = await deletedTripWithChild();
    await purgeTripPermanently(tripId);
    const r = await pushPurges({
      mark: () => Promise.resolve({}),
      readBack: () => Promise.resolve({ found: true, purgedAt: '2026-07-26T00:00:00.000Z' }),
      markFamily: () => Promise.resolve({}),
      unmarkedInFamily: () => Promise.resolve({ count: 1 }), // 사진 하나가 안 찍힘
      // → 실패로 남겨 다음 동기화에서 다시 시도한다. 조용히 완료 처리하면 그 사진은 영영 남는다.
    });
    expect(r.failed).toBeGreaterThan(0);
    const left = (await db().syncQueue.toArray()).filter((o) => o.entityType === purgeOpType('trip'));
    expect(left.length).toBe(1);
  });

  it('자식(순간·사진) purge는 가족 쓸기를 하지 않는다 — 여행 단위로 한 번만', async () => {
    const { tripId } = await deletedTripWithChild();
    await purgeTripPermanently(tripId);
    const families: string[] = [];
    await pushPurges({
      mark: () => Promise.resolve({}),
      readBack: () => Promise.resolve({ found: true, purgedAt: '2026-07-26T00:00:00.000Z' }),
      markFamily: (t) => {
        families.push(t);
        return Promise.resolve({});
      },
      unmarkedInFamily: () => Promise.resolve({ count: 0 }),
    });
    expect(families.length).toBe(1); // 순간 op가 있어도 가족 쓸기는 여행에서만
  });
});

describe('③ 서버가 알려준 영구삭제를 이 기기에 적용한다', () => {
  it('로컬 행을 하드 삭제하고 표식을 남긴다', async () => {
    const trip = await createTripLocalFirst({ title: '다른 기기에서 비운 여행' });
    expect(await db().localTrips.get(trip.id)).toBeDefined();

    const applied = await applyRemotePurge('trip', trip.id);
    expect(applied).toBe(true);
    expect(await db().localTrips.get(trip.id)).toBeUndefined();
    expect((await purgedIdSet()).has(trip.id)).toBe(true);
  });

  it('멱등 — 두 번째 호출은 아무 일도 하지 않는다', async () => {
    const trip = await createTripLocalFirst({ title: 'x' });
    expect(await applyRemotePurge('trip', trip.id)).toBe(true);
    expect(await applyRemotePurge('trip', trip.id)).toBe(false);
  });

  it('로컬에 없는 id여도 표식은 남긴다 — 나중에 pull이 되살리지 못하게', async () => {
    const ghost = '00000000-1111-4222-8333-444444444444';
    expect(await applyRemotePurge('media', ghost)).toBe(true);
    expect((await purgedIdSet()).has(ghost)).toBe(true);
  });
});

describe('④ 도메인 등록부가 완전한가', () => {
  it('네 도메인 전부가 등록부에 있다', () => {
    expect(Object.keys(DOMAIN_PURGE).sort()).toEqual([...PURGE_DOMAINS].sort());
    expect(PURGE_DOMAINS.length).toBe(4);
  });

  it('각 도메인이 로컬 테이블과 서버 테이블 이름을 갖는다', () => {
    for (const dm of PURGE_DOMAINS) {
      expect(typeof DOMAIN_PURGE[dm].table).toBe('function');
      expect(DOMAIN_PURGE[dm].remoteTable.length).toBeGreaterThan(0);
    }
  });

  it('purgeOpType ↔ purgeDomainOf 왕복이 성립한다', () => {
    for (const dm of PURGE_DOMAINS) expect(purgeDomainOf(purgeOpType(dm))).toBe(dm);
    expect(purgeDomainOf('trip')).toBeNull();
    expect(purgeDomainOf('purge:없는도메인')).toBeNull();
  });
});
