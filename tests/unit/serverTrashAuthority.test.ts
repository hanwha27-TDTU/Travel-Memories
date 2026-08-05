// tests/unit/serverTrashAuthority.test.ts — 휴지통 화면이 **서버 기준**인가 (2026-08-05 사용자 결정).
//
// "휴지통 개념을 아예 서버로 확정짓자 — 절대절대절대 기기끼리 내용이 다르면 안 됩니다."
//
// 배경: 같은 계정의 두 기기(같은 기기의 Android 앱 vs Chrome조차)가 서로 다른 휴지통을 보였다.
// 원인은 불변식 #8("로컬에 없는 tombstone을 만들지 않는다")을 일반 동기화뿐 아니라 **화면
// 표시**에도 그대로 물려쓴 것 — "이 기기가 언제 그 항목을 마지막으로 봤는가"가 "휴지통에
// 뭐가 보이는가"가 됐다. 여기서는 그 처방(서버 직접 조회)이 실제로 잠그는 계약을 검사한다.
//
//   ① 서버 조회는 로컬 Dexie를 절대 건드리지 않는다(표시 전용).
//   ② 라벨은 로컬 경로와 **같은 함수**를 지나 절대 갈라지지 않는다.
//   ③ 부모 여행이 tombstone이면 자식은 (여행 휴지통이 이미 보여주므로) 숨긴다 — 서버 기준으로도.
//   ④ 영구삭제 원장에 있는 id는 휴지통에 다시 나타나지 않는다.
//   ⑤ 부분 실패(모임 실패)는 "일부만 서버 기준"으로 반올림하지 않고 전체를 `null`로 던진다.
//   ⑥ 서버에만 있던 항목도 `ensureLocalTombstone`으로 채운 뒤에는 정상적으로 행동(복원)할 수 있다.

import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '../../src/offline/db';
import {
  fetchServerDomainEntities,
  ensureLocalTombstone,
} from '../../src/services/purge';
import { listTrashedChildren, listTrashedChildrenFromServer } from '../../src/services/trash';
import { listDeletedTripsFromServer } from '../../src/services/trips';
import type { JourneyClient } from '../../src/services/supabase/client';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TRIP = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MOMENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MOMENT2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/** `.select('*').order().range()`(전체 목록)와 `.select('*').eq('id',x).maybeSingle()`(단건)를 모두 지원. */
function fakeClient(tables: Record<string, Record<string, unknown>[]>): JourneyClient {
  return {
    from(table: string) {
      const rows = tables[table] ?? [];
      return {
        select() {
          return {
            order: () => ({
              range: (fromIdx: number, toIdx: number) =>
                Promise.resolve({ data: rows.slice(fromIdx, toIdx + 1), error: null }),
            }),
            eq: (col: string, val: unknown) => ({
              maybeSingle: () => Promise.resolve({ data: rows.find((r) => r[col] === val) ?? null, error: null }),
            }),
          };
        },
      };
    },
  } as unknown as JourneyClient;
}

function tripRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TRIP, user_id: USER, title: '우즈베키스탄', start_date: null, time_zone: null, end_date: null,
    status: 'active', version: 1, base_version: 1, base_canonical_version: null,
    created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
    deleted_at: null, client_operation_id: null,
    ...over,
  };
}

function momentRow(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, user_id: USER, trip_id: TRIP, occurred_at: '2026-08-01T00:00:00.000Z', tz_offset_min: null,
    title: '지운 순간', note: '', emotion: '', place_name: '', place_lat: null, place_lng: null, place_id: null,
    version: 2, base_version: 1, base_canonical_version: null,
    created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-02T00:00:00.000Z',
    deleted_at: '2026-08-02T00:00:00.000Z', client_operation_id: null,
    ...over,
  };
}

beforeEach(async () => {
  const d = db();
  await Promise.all([
    d.localTrips.clear(), d.localMoments.clear(), d.localMedia.clear(),
    d.localExpenses.clear(), d.localAudio.clear(), d.localPlaces.clear(),
    d.syncQueue.clear(), d.purgedIds.clear(),
  ]);
});

describe('fetchServerDomainEntities — 서버 조회는 표시 전용', () => {
  it('서버 행을 로컬과 같은 모양으로 변환한다 — 로컬 Dexie는 건드리지 않는다', async () => {
    const client = fakeClient({ moments: [momentRow(MOMENT)], purged_ids: [] });
    const rows = await fetchServerDomainEntities<{ id: string; title: string; deletedAt: string | null }>('moment', client);
    expect(rows).toHaveLength(1);
    expect(rows![0]!.title).toBe('지운 순간');
    expect(rows![0]!.deletedAt).toBe('2026-08-02T00:00:00.000Z');
    // 표시 전용 — 이 호출만으로는 아무것도 로컬에 쓰이지 않는다.
    expect(await db().localMoments.count()).toBe(0);
  });

  it('영구삭제 원장에 있는 id는 제외한다', async () => {
    const client = fakeClient({ moments: [momentRow(MOMENT)], purged_ids: [{ id: MOMENT }] });
    const rows = await fetchServerDomainEntities('moment', client);
    expect(rows).toEqual([]);
  });

  it('🔴 조회 실패는 빈 배열이 아니라 null이다 — "몰라서 비었다"와 "정말 비었다"를 같은 값으로 뭉개지 않는다', async () => {
    const client = {
      from: () => ({ select: () => ({ order: () => ({ range: () => Promise.resolve({ data: null, error: { message: '네트워크 오류' } }) }) }) }),
    } as unknown as JourneyClient;
    expect(await fetchServerDomainEntities('moment', client)).toBeNull();
  });
});

describe('ensureLocalTombstone — 행동하려면 먼저 이 기기에 채운다', () => {
  it('이 기기에 없던 tombstone 행을 메타데이터만으로 채운다', async () => {
    const client = fakeClient({ moments: [momentRow(MOMENT)] });
    expect(await ensureLocalTombstone('moment', MOMENT, client)).toBe(true);
    const local = await db().localMoments.get(MOMENT);
    expect(local?.title).toBe('지운 순간');
    expect(local?.deletedAt).not.toBeNull();
  });

  it('이미 로컬에 있으면 그대로 둔다(멱등) — 서버 호출 없이 즉시 true', async () => {
    await db().localMoments.put({
      id: MOMENT, tripId: TRIP, title: '내가 가진 최신본', note: '', emotion: null,
      placeName: '', placeLat: null, placeLng: null,
      version: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', deletedAt: null,
    } as never);
    const client = fakeClient({ moments: [momentRow(MOMENT, { title: '서버가 주장하는 다른 제목' })] });
    expect(await ensureLocalTombstone('moment', MOMENT, client)).toBe(true);
    expect((await db().localMoments.get(MOMENT))?.title).toBe('내가 가진 최신본'); // 안 덮임
  });

  it('🔴 활성(살아 있는) 서버 행은 이 경로로 만들지 않는다 — 그건 비파괴 pull의 일이다', async () => {
    const client = fakeClient({ moments: [momentRow(MOMENT, { deleted_at: null })] });
    expect(await ensureLocalTombstone('moment', MOMENT, client)).toBe(false);
    expect(await db().localMoments.get(MOMENT)).toBeUndefined();
  });

  it('서버에도 없으면 false', async () => {
    const client = fakeClient({ moments: [] });
    expect(await ensureLocalTombstone('moment', MOMENT, client)).toBe(false);
  });
});

describe('listTrashedChildrenFromServer — 로컬판과 같은 라벨, 기기 무관 동일 목록', () => {
  it('② 로컬 경로와 정확히 같은 라벨을 만든다(SSOT) — 같은 자료를 로컬/서버 양쪽에 넣고 대조', async () => {
    await db().localTrips.put({
      id: TRIP, title: '우즈베키스탄', startDate: '', endDate: '', status: 'active',
      version: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', deletedAt: null,
    } as never);
    await db().localMoments.put({
      id: MOMENT, tripId: TRIP, title: '지운 순간', note: '', emotion: null,
      placeName: '', placeLat: null, placeLng: null,
      version: 2, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z',
      deletedAt: '2026-08-02T00:00:00.000Z',
    } as never);
    const localList = await listTrashedChildren();

    const client = fakeClient({ trips: [tripRow()], moments: [momentRow(MOMENT)], media: [], expenses: [], audio: [], places: [], purged_ids: [] });
    const serverList = await listTrashedChildrenFromServer(client);

    expect(serverList).not.toBeNull();
    expect(serverList).toEqual(localList); // 문구까지 정확히 같아야 한다
  });

  it('③ 부모 여행이 tombstone이면 서버 기준으로도 자식을 숨긴다(여행 휴지통이 이미 보여준다)', async () => {
    const client = fakeClient({
      trips: [tripRow({ deleted_at: '2026-08-02T00:00:00.000Z' })],
      moments: [momentRow(MOMENT)], media: [], expenses: [], audio: [], places: [], purged_ids: [],
    });
    expect(await listTrashedChildrenFromServer(client)).toEqual([]);
  });

  it('④ 영구삭제 원장의 id는 다시 나타나지 않는다', async () => {
    const client = fakeClient({
      trips: [tripRow()],
      moments: [momentRow(MOMENT), momentRow(MOMENT2)],
      media: [], expenses: [], audio: [], places: [], purged_ids: [{ id: MOMENT2 }],
    });
    const list = await listTrashedChildrenFromServer(client);
    expect(list!.map((c) => c.id)).toEqual([MOMENT]);
  });

  it('⑤ 여행 조회 자체가 실패하면 전체를 null로 — 일부만 서버 기준인 목록을 만들지 않는다', async () => {
    const client = {
      from: (t: string) =>
        t === 'trips'
          ? { select: () => ({ order: () => ({ range: () => Promise.resolve({ data: null, error: { message: '오류' } }) }) }) }
          : { select: () => ({ order: () => ({ range: () => Promise.resolve({ data: [], error: null }) }) }) },
    } as unknown as JourneyClient;
    expect(await listTrashedChildrenFromServer(client)).toBeNull();
  });

  it('⑤ 자식 도메인 중 하나라도 조회 실패하면 전체를 null로', async () => {
    const client = {
      from: (t: string) =>
        t === 'media'
          ? { select: () => ({ order: () => ({ range: () => Promise.resolve({ data: null, error: { message: '오류' } }) }) }) }
          : { select: () => ({ order: () => ({ range: () => Promise.resolve({ data: [], error: null }) }) }) },
    } as unknown as JourneyClient;
    expect(await listTrashedChildrenFromServer(client)).toBeNull();
  });
});

describe('listDeletedTripsFromServer — 여행 휴지통도 같은 규율', () => {
  it('tombstone 여행만, 영구삭제 원장 제외하고 반환', async () => {
    const client = fakeClient({
      trips: [tripRow({ deleted_at: '2026-08-02T00:00:00.000Z' }), tripRow({ id: 'e', deleted_at: null })],
      purged_ids: [],
    });
    const rows = await listDeletedTripsFromServer(client);
    expect(rows).toHaveLength(1);
    expect(rows![0]!.id).toBe(TRIP);
  });

  it('조회 실패 시 null', async () => {
    const client = { from: () => ({ select: () => ({ order: () => ({ range: () => Promise.resolve({ data: null, error: { message: '오류' } }) }) }) }) } as unknown as JourneyClient;
    expect(await listDeletedTripsFromServer(client)).toBeNull();
  });
});

describe('⑥ 서버에서만 보이던 항목도 채운 뒤에는 정상 행동할 수 있다', () => {
  it('ensureLocalTombstone 뒤 restoreTrashedChild가 실제로 되살린다', async () => {
    const { restoreTrashedChild } = await import('../../src/services/trash');
    const client = fakeClient({ moments: [momentRow(MOMENT)] });
    expect(await ensureLocalTombstone('moment', MOMENT, client)).toBe(true);
    await restoreTrashedChild('moment', MOMENT);
    expect((await db().localMoments.get(MOMENT))?.deletedAt).toBeNull();
  });
});
