// tests/unit/purgePropagation.test.ts — 영구삭제가 **모든 기기에서** 사라지는가(ADR-0030).
//
// 사용자 지적(2026-07-26): "다른 기기에서 휴지통을 비웠으면 연동기기에서도 사라져 있어야 되는
// 거 아닌가요?" — 맞다. ADR-0025는 영구삭제를 기기별로 뒀고 그래서 다른 기기 휴지통에 남았다.
//
// 이어서(같은 날): "의도를 가지고 삭제하는건데 서버에 왜 살려두나요? 자료를.. 2번 이상 클릭으로
// 삭제한거라면 영원히 복구가 안되도록 기록줄까지도 삭제시켜야 되는게 맞는거 아닌가요?"
// → ADR-0030. 서버 행을 **하드 삭제**하고 id 원장만 남긴다. 좀비는 원장+트리거가 막는다.
//
// 이 검사가 잠그는 불변식(전부 실제 사고 형태에서 역산했다):
//  ① 영구삭제는 **네 도메인 전부**에 전파 op를 만든다 — 한 종류만 빠지면 그 종류가 다른 기기에
//     남는다(M-0006과 같은 형태의 재발 방지).
//  ② 전파 op는 **도메인 push 루프가 건드리면 안 된다** — 로컬 행이 이미 없어서 "고아 작업"으로
//     조용히 폐기되고, 그러면 전파가 영영 일어나지 않는다. 이게 가장 위험한 함정이다.
//  ②-b **순서가 곧 안전이다** — 사진 경로·자식 id는 지우기 **전에** 읽고, 원장은 지우기 **전에**
//     적는다. 뒤집히면 각각 "R2 고아 파일"과 "다른 기기가 다시 올림"이 된다.
//  ③ 서버 원장이 알려준 영구삭제를 받으면 로컬 행을 **하드 삭제하고 표식을 남긴다**(멱등).
//  ④ 등록부가 네 도메인을 모두 덮는다 — 빠지면 컴파일 오류지만, 개수도 실행으로 확인한다.

import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '../../src/offline/db';
import { createTripLocalFirst, softDeleteTripLocalFirst, purgeTripPermanently } from '../../src/services/trips';
import { createMomentLocalFirst } from '../../src/services/moments';
import {
  applyPurgedLedger,
  purgedIdSet,
  purgeDomainOf,
  purgeOpType,
  DOMAIN_PURGE,
  PURGE_DOMAINS,
  tripScopedChildDomains,
} from '../../src/services/purge';
import { pushPending, pushPendingMoments, pushPendingMedia, pushPurges, purgeRemote, type PurgeRemote } from '../../src/services/sync';

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

/**
 * 정상 동작하는 가짜 서버. **호출 순서를 기록한다** — 이 검사의 절반은 순서에 관한 것이다.
 *
 * 기본값은 전부 "성공·아무것도 안 남음"이고, 개별 검사가 필요한 것만 덮어쓴다.
 * 이렇게 하지 않으면 포트에 메서드가 하나 늘 때마다 가짜를 열 곳에서 손으로 고쳐야 하고,
 * 그 손 중복이 바로 이 저장소가 반복해 온 결함의 형태다(§7).
 */
function fakePurge(over: Partial<PurgeRemote> = {}): PurgeRemote & { calls: string[]; ledger: string[]; deleted: string[] } {
  const calls: string[] = [];
  const ledger: string[] = [];
  const deleted: string[] = [];
  const base: PurgeRemote = {
    ledgerAdd: (ids) => {
      calls.push('ledgerAdd');
      ledger.push(...ids);
      return Promise.resolve({});
    },
    ledgerHas: () => {
      calls.push('ledgerHas');
      return Promise.resolve({ found: true });
    },
    ledgerAll: () => Promise.resolve({ ids: [] }),
    ledgerRemove: () => Promise.resolve({ removed: 0 }),
    familyIds: () => {
      calls.push('familyIds');
      return Promise.resolve({ ids: [] });
    },
    familyBytePaths: () => {
      calls.push('familyBytePaths');
      return Promise.resolve({ paths: [] });
    },
    bytePath: () => {
      calls.push('bytePath');
      return Promise.resolve({ path: null });
    },
    hardDelete: (domain, id) => {
      calls.push('hardDelete');
      deleted.push(`${domain}:${id}`);
      return Promise.resolve({});
    },
    hardDeleteFamily: (tripId) => {
      calls.push('hardDeleteFamily');
      deleted.push(`family:${tripId}`);
      return Promise.resolve({});
    },
    stillThere: () => {
      calls.push('stillThere');
      return Promise.resolve({ found: false });
    },
    remainingInFamily: () => {
      calls.push('remainingInFamily');
      return Promise.resolve({ count: 0 });
    },
  };
  return { ...base, ...over, calls, ledger, deleted };
}

describe('② 전파 push — 서버 행을 지우고 원장에 id만 남긴다 (ADR-0030)', () => {
  it('성공하면 작업이 큐에서 사라지고, 여행·순간 행이 모두 지워진다', async () => {
    const { tripId, momentId } = await deletedTripWithChild();
    await purgeTripPermanently(tripId);
    const remote = fakePurge();

    const r = await pushPurges(remote);
    expect(r.pushed).toBe(2);
    expect(r.failed).toBe(0);
    expect(remote.deleted).toContain(`trip:${tripId}`);
    expect(remote.deleted).toContain(`moment:${momentId}`);
    expect(remote.ledger).toContain(tripId);
    expect(remote.ledger).toContain(momentId);
    expect((await db().syncQueue.toArray()).filter((o) => o.operationType === 'purge')).toEqual([]);
  });

  // 순서 검사는 **작업 하나**로 돌린다. 여러 op가 섞이면 앞 op의 삭제가 뒤 op의 조회보다
  // 앞서는 게 정상인데, 그걸 위반으로 읽으면 게이트가 거짓말을 한다(순서 계약은 op 단위다).
  it('원장을 **지우기 전에** 적는다 — 뒤집히면 그 틈에 다른 기기가 사본을 다시 올린다', async () => {
    const trip = await createTripLocalFirst({ title: '자식 없는 여행' });
    await softDeleteTripLocalFirst(trip.id);
    await db().syncQueue.clear();
    await purgeTripPermanently(trip.id);
    const remote = fakePurge();
    await pushPurges(remote);

    const ledger = remote.calls.indexOf('ledgerAdd');
    const del = remote.calls.findIndex((c) => c.startsWith('hardDelete'));
    expect(ledger).toBeGreaterThanOrEqual(0);
    expect(del).toBeGreaterThanOrEqual(0);
    expect(ledger).toBeLessThan(del);
  });

  it('사진 경로·자식 id를 **지우기 전에** 읽는다 — 행이 사라지면 경로도 사라진다', async () => {
    const trip = await createTripLocalFirst({ title: '자식 없는 여행' });
    await softDeleteTripLocalFirst(trip.id);
    await db().syncQueue.clear();
    await purgeTripPermanently(trip.id);
    const remote = fakePurge();
    await pushPurges(remote);

    const del = remote.calls.findIndex((c) => c.startsWith('hardDelete'));
    expect(remote.calls.indexOf('familyBytePaths')).toBeLessThan(del);
    expect(remote.calls.indexOf('familyIds')).toBeLessThan(del);
  });

  it('여행 purge는 서버에만 있는 자식 id까지 원장에 담는다 (M-0016과 같은 사각지대)', async () => {
    const { tripId } = await deletedTripWithChild();
    await purgeTripPermanently(tripId);
    const ghost = '99999999-9999-4999-8999-999999999999'; // 로컬엔 없고 서버에만 있는 사진
    const remote = fakePurge({ familyIds: () => Promise.resolve({ ids: [ghost] }) });
    await pushPurges(remote);
    expect(remote.ledger).toContain(ghost);
    expect(remote.deleted).toContain(`family:${tripId}`);
  });

  it('서버에 행이 없으면(한 번도 동기화 안 된 기록) 완료로 본다 — 영원히 큐에 남지 않게', async () => {
    const { tripId } = await deletedTripWithChild();
    await purgeTripPermanently(tripId);

    const r = await pushPurges(fakePurge({ stillThere: () => Promise.resolve({ found: false }) }));
    expect(r.pushed).toBe(2);
    expect((await db().syncQueue.toArray()).filter((o) => o.operationType === 'purge')).toEqual([]);
  });

  it('원장 기록이 실패하면 **아무것도 지우지 않고** 작업을 남긴다', async () => {
    const { tripId } = await deletedTripWithChild();
    await purgeTripPermanently(tripId);

    const remote = fakePurge({ ledgerAdd: () => Promise.resolve({ error: '네트워크 실패' }) });
    const r = await pushPurges(remote);
    expect(r.failed).toBe(2);
    expect(remote.deleted).toEqual([]); // 원장 없이 지우면 좀비가 돌아온다
    expect((await db().syncQueue.toArray()).filter((o) => o.operationType === 'purge').length).toBe(2);
  });

  it('원장 read-back이 비면 지우지 않는다 — 성공 응답이 아니라 되읽어 확인한다', async () => {
    const { tripId } = await deletedTripWithChild();
    await purgeTripPermanently(tripId);

    const remote = fakePurge({ ledgerHas: () => Promise.resolve({ found: false }) });
    const r = await pushPurges(remote);
    expect(r.failed).toBe(2);
    expect(remote.deleted).toEqual([]);
  });

  it('삭제 오류면 작업을 남긴다 — 다음 동기화에서 다시 시도한다', async () => {
    const { tripId } = await deletedTripWithChild();
    await purgeTripPermanently(tripId);

    const r = await pushPurges(fakePurge({ hardDelete: () => Promise.resolve({ error: '네트워크 실패' }) }));
    expect(r.failed).toBe(2);
    expect((await db().syncQueue.toArray()).filter((o) => o.operationType === 'purge').length).toBe(2);
  });

  it('되읽었더니 행이 남아 있으면 완료로 치지 않는다', async () => {
    const { tripId } = await deletedTripWithChild();
    await purgeTripPermanently(tripId);

    const r = await pushPurges(fakePurge({ stillThere: () => Promise.resolve({ found: true }) }));
    expect(r.failed).toBe(2);
  });

  it('가족에 행이 남으면 완료로 치지 않는다(read-back) — 조용히 넘기면 그 사진은 영영 남는다', async () => {
    const { tripId } = await deletedTripWithChild();
    await purgeTripPermanently(tripId);

    const r = await pushPurges(fakePurge({ remainingInFamily: () => Promise.resolve({ count: 1 }) }));
    expect(r.failed).toBeGreaterThan(0);
    const left = (await db().syncQueue.toArray()).filter((o) => o.entityType === purgeOpType('trip'));
    expect(left.length).toBe(1);
  });

  it('자식(순간·사진) purge는 가족 쓸기를 하지 않는다 — 여행 단위로 한 번만', async () => {
    const { tripId } = await deletedTripWithChild();
    await purgeTripPermanently(tripId);
    const remote = fakePurge();
    await pushPurges(remote);
    expect(remote.calls.filter((c) => c === 'hardDeleteFamily').length).toBe(1);
  });
});

describe('② 사진 바이트는 **영구삭제 때만** 지운다 (정책 2026-07-26)', () => {
  // 사용자 결정: "휴지통에 있는 동안은 서버에 남겨둔다."
  // 예전에는 삭제(휴지통행) 즉시 서버 사진을 지워서, 휴지통에 있는 동안 이미 사진이 없었다.
  // 복원은 "사본을 가진 기기가 다시 올리는" 방식이라 그 기기가 없으면 사진이 영영 안 돌아왔다 —
  // 휴지통이 사진에 대해서는 휴지통이 아니었다(비타협 원칙 #1과 어긋남).
  const withPaths = (paths: string[]): PurgeRemote => fakePurge({ familyBytePaths: () => Promise.resolve({ paths }) });

  it('영구삭제 push가 서버에서 받은 경로의 바이트를 지운다', async () => {
    const { tripId } = await deletedTripWithChild();
    await purgeTripPermanently(tripId);
    const removed: string[] = [];
    const r = await pushPurges(withPaths(['u/a.webp', 'u/b.webp']), {
      remove: (p) => {
        removed.push(p);
        return Promise.resolve({});
      },
    });
    expect(r.failed).toBe(0);
    expect(removed.sort()).toEqual(['u/a.webp', 'u/b.webp']);
  });

  it('바이트 삭제가 실패해도 작업을 되돌리지 않는다 — 잉여 파일은 기억 손실이 아니다', async () => {
    const { tripId } = await deletedTripWithChild();
    await purgeTripPermanently(tripId);
    const r = await pushPurges(withPaths(['u/a.webp']), {
      remove: () => Promise.resolve({ error: '네트워크 실패' }),
    });
    expect(r.failed).toBe(0); // 행 삭제는 이미 끝났고 되읽어 확인했다
    expect((await db().syncQueue.toArray()).filter((o) => o.operationType === 'purge')).toEqual([]);
  });

  it('바이트 포트를 안 주면 파일은 건드리지 않는다(행 삭제만)', async () => {
    const { tripId } = await deletedTripWithChild();
    await purgeTripPermanently(tripId);
    const r = await pushPurges(withPaths(['u/a.webp'])); // bytes 생략
    expect(r.failed).toBe(0);
  });
});

describe('② 삭제(휴지통행)는 서버 사진을 지우지 않는다', () => {
  it('tombstone push에서 remove가 호출되지 않는다 — 휴지통이 진짜 휴지통이어야 한다', async () => {
    const trip = await createTripLocalFirst({ title: '사진 보존 확인' });
    const moment = await createMomentLocalFirst({ tripId: trip.id, title: 'x', occurredAt: '2026-07-01T00:00:00.000Z' });
    const blob = new Blob(['x'], { type: 'image/webp' });
    await db().localMedia.put({
      id: '11111111-1111-4111-8111-111111111111',
      tripId: trip.id,
      momentId: moment.id,
      displayBlob: blob,
      thumbBlob: blob,
      width: 1,
      height: 1,
      takenAt: '',
      bytesDisplay: 1,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      deletedAt: null,
      version: 1,
    } as never);
    await softDeleteTripLocalFirst(trip.id);

    const removed: string[] = [];
    await pushPendingMedia(
      {
        upsert: () => Promise.resolve({}),
        getById: () =>
          Promise.resolve({
            data: {
              id: '11111111-1111-4111-8111-111111111111',
              updated_at: '2026-07-01T00:00:00.000Z',
              version: 2,
              deleted_at: '2026-07-01T00:00:00.000Z',
            } as never,
          }),
        listAll: () => Promise.resolve({ data: [] }),
        uploadDisplay: () => Promise.resolve({}),
        download: () => Promise.resolve({ data: null }),
        remove: (p: string) => {
          removed.push(p);
          return Promise.resolve({});
        },
      } as never,
      'u1',
    );
    expect(removed).toEqual([]); // **한 번도 지우지 않아야 한다**
  });
});

describe('③ 서버 원장이 알려준 영구삭제를 이 기기에 적용한다', () => {
  it('로컬 행을 하드 삭제하고 표식을 남긴다', async () => {
    const trip = await createTripLocalFirst({ title: '다른 기기에서 비운 여행' });
    expect(await db().localTrips.get(trip.id)).toBeDefined();

    expect(await applyPurgedLedger([trip.id])).toBe(1);
    expect(await db().localTrips.get(trip.id)).toBeUndefined();
    expect((await purgedIdSet()).has(trip.id)).toBe(true);
  });

  it('종류를 몰라도 네 테이블을 모두 훑어 지운다 — 원장은 id만 담기 때문이다', async () => {
    const trip = await createTripLocalFirst({ title: '가족 여행' });
    const moment = await createMomentLocalFirst({ tripId: trip.id, title: 'x', occurredAt: '2026-07-01T00:00:00.000Z' });

    expect(await applyPurgedLedger([trip.id, moment.id])).toBe(2);
    expect(await db().localTrips.get(trip.id)).toBeUndefined();
    expect(await db().localMoments.get(moment.id)).toBeUndefined();
  });

  it('멱등 — 두 번째 호출은 아무 일도 하지 않는다', async () => {
    const trip = await createTripLocalFirst({ title: 'x' });
    expect(await applyPurgedLedger([trip.id])).toBe(1);
    expect(await applyPurgedLedger([trip.id])).toBe(0);
  });

  it('로컬에 없는 id여도 표식은 남긴다 — 나중에 pull이 되살리지 못하게', async () => {
    const ghost = '00000000-1111-4222-8333-444444444444';
    expect(await applyPurgedLedger([ghost])).toBe(1);
    expect((await purgedIdSet()).has(ghost)).toBe(true);
  });

  it('빈 목록이면 아무 일도 하지 않는다', async () => {
    expect(await applyPurgedLedger([])).toBe(0);
  });

  it("종류를 모르면 'unknown'으로 적는다 — 거짓 종류를 지어내지 않는다(원칙 #4)", async () => {
    const ghost = '00000000-2222-4222-8333-555555555555';
    await applyPurgedLedger([ghost]);
    expect((await db().purgedIds.get(ghost))?.entityType).toBe('unknown');
  });
});

describe('④ 도메인 등록부가 완전한가', () => {
  it('여섯 도메인 전부가 등록부에 있다', () => {
    expect(Object.keys(DOMAIN_PURGE).sort()).toEqual([...PURGE_DOMAINS].sort());
    // 🔴 2026-07-27에 4→5가 됐고(소리가 서버로 간다), 2026-07-30에 5→6이 됐다(장소가 1급
    //    도메인이 된다). 이 숫자를 손으로 적는 이유는 "도메인이 조용히 사라지는 것"도
    //    결함이기 때문이다 — 전제가 바뀌면 여기를 먼저 고친다.
    expect(PURGE_DOMAINS.length).toBe(6);
    expect(PURGE_DOMAINS).toContain('audio');
    expect(PURGE_DOMAINS).toContain('place');
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

// ─────────────────────────────────────────────────────────────────────────────
// C-1(2026-08-01 감사·실서버 확정): 여행 영구삭제가 서버에 영영 전파되지 않았다 — 자식을
// 「trip 빼고 전부」로 뽑아 **trip_id 없는 places**에 trip_id로 질의했고 PostgREST가 42703을
// 냈다. 아래는 그 자리를 **행동으로** 잠근다: places는 trip_id로 질의되지 않아야 한다.
// ─────────────────────────────────────────────────────────────────────────────

/** places를 trip_id로 질의하면 42703을 내는 가짜 클라이언트. 어느 테이블이 질의됐는지 기록한다. */
function fakeClientRecording(): { client: unknown; tripIdTables: string[] } {
  const tripIdTables: string[] = [];
  const makeBuilder = (table: string) => {
    const res = () => {
      // 실서버 재현: places를 trip_id로 치면 «컬럼 없음». 옛 코드는 여기서 무너졌다.
      if (table === 'places') return { data: null, count: null, error: { message: 'column "trip_id" does not exist' } };
      return { data: [], count: 0, error: null };
    };
    const builder: Record<string, unknown> = {
      select: () => builder,
      delete: () => builder,
      not: () => builder,
      eq: (col: string) => {
        if (col === 'trip_id') tripIdTables.push(table);
        return builder;
      },
      then: (resolve: (v: unknown) => unknown) => resolve(res()),
    };
    return builder;
  };
  return { client: { from: (t: string) => makeBuilder(t) }, tripIdTables };
}

describe('C-1 · 여행 영구삭제는 places를 trip_id로 건드리지 않는다', () => {
  it('tripScopedChildDomains는 place를 빼고 자식 넷을 준다', () => {
    const kids = tripScopedChildDomains();
    expect(kids).not.toContain('place');
    expect(kids).not.toContain('trip');
    expect(kids.sort()).toEqual(['audio', 'expense', 'media', 'moment']);
  });

  it('familyIds가 places를 질의하지 않고 성공한다 (옛 코드였다면 42703으로 실패)', async () => {
    const { client, tripIdTables } = fakeClientRecording();
    const r = await purgeRemote(client as never).familyIds('trip-123');
    expect(r.error).toBeUndefined();
    expect(tripIdTables).not.toContain('places');
    expect(tripIdTables).toEqual(expect.arrayContaining(['moments', 'media', 'expenses', 'audio']));
  });

  it('hardDeleteFamily·remainingInFamily·familyBytePaths도 places를 건드리지 않는다', async () => {
    const a = fakeClientRecording();
    expect((await purgeRemote(a.client as never).hardDeleteFamily('t')).error).toBeUndefined();
    expect(a.tripIdTables).not.toContain('places');

    const b = fakeClientRecording();
    const rem = await purgeRemote(b.client as never).remainingInFamily('t');
    expect(rem.error).toBeUndefined();
    expect(b.tripIdTables).not.toContain('places');

    const c = fakeClientRecording();
    const bp = await purgeRemote(c.client as never).familyBytePaths('t');
    expect(bp.error).toBeUndefined();
    expect(c.tripIdTables).not.toContain('places'); // 바이트 도메인도 tripScoped만
  });
});
