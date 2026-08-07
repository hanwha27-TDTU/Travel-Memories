// tests/unit/placeSiblingDiscipline.test.ts — **장소가 형제의 규율을 실제로 받는가.**
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 이 파일이 따로 있나 (2026-07-30)
// ─────────────────────────────────────────────────────────────────────────────
// `audioSiblingDiscipline`과 **같은 이유**다. 오디오는 기능으로는 완성돼 있었는데 형제들이
// 이미 지키던 계약 다섯 개를 하나도 안 받은 채 태어났다. 그게 이 저장소의 최빈 결함군이고,
// 장소는 그 다음 형제다 — 같은 자리를 다시 재지 않으면 같은 사고가 난다.
//
// 🔴 다만 장소에는 **의도적 비대칭이 하나 있다**: 장소는 여행의 자식이 아니다(0022).
//    그래서 이 파일은 오디오처럼 "cascade로 함께 지워지는가"를 재지 **않고**, 반대로
//    **"부모를 지워도 장소가 살아남는가"**를 잰다. 비대칭은 설계 판단이므로 검사도
//    그 판단을 명시적으로 못박아야 한다 — 안 그러면 다음 사람이 "형제들처럼" 고치고
//    그때 사용자의 장소가 조용히 사라진다.

import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '../../src/offline/db';
import { createTripLocalFirst, softDeleteTripLocalFirst, purgeTripPermanently } from '../../src/services/trips';
import { createMomentLocalFirst } from '../../src/services/moments';
import { listTrashedChildren, restoreTrashedChild, purgeChildPermanently, CHILD_DOMAINS, CHILD_LABEL } from '../../src/services/trash';
import { savePlace, softDeletePlace, restorePlace, updatePlace, listPlaces, placesNear, findExistingPlace, deleteUnusedPlace } from '../../src/services/places';
import { PURGE_DOMAINS, DOMAIN_PURGE } from '../../src/services/purge';
import { exportCollectRows } from '../../src/services/backup';
import { SOURCES, selfCheck } from '../../src/app/blueprint';

const DAEHAKRO = {
  name: '대학로',
  latitude: 37.587,
  longitude: 127.0016,
  provider: 'nominatim',
  providerPlaceId: 'way/520463101',
  region: '서울특별시',
  district: '종로구',
  precision: 'street',
  spanMeters: 1480,
};

beforeEach(async () => {
  const d = db();
  await Promise.all([
    d.localPlaces.clear(),
    d.localTrips.clear(),
    d.localMoments.clear(),
    d.syncQueue.clear(),
    d.purgedIds.clear(),
  ]);
});

describe('① 변경마다 큐 op — 안 만들면 그 장소는 이 기기에 갇힌다', () => {
  it('🔴 저장하면 insert op가 **같은 트랜잭션에** 생긴다(M-0033)', async () => {
    const p = await savePlace(DAEHAKRO);
    const ops = await db().syncQueue.where('entityId').equals(p.id).toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0]!.entityType).toBe('place');
    expect(ops[0]!.operationType).toBe('insert');
  });

  it('수정하면 update op가 생긴다', async () => {
    const p = await savePlace(DAEHAKRO);
    await db().syncQueue.clear();
    await updatePlace(p.id, { memo: '연극 보러' });
    const ops = await db().syncQueue.where('entityId').equals(p.id).toArray();
    expect(ops.map((o) => o.operationType)).toEqual(['update']);
  });

  it('삭제/되살리기도 각각 op를 만든다', async () => {
    const p = await savePlace(DAEHAKRO);
    await db().syncQueue.clear();
    await softDeletePlace(p.id);
    await restorePlace(p.id);
    const ops = await db().syncQueue.where('entityId').equals(p.id).toArray();
    expect(ops.map((o) => o.operationType).sort()).toEqual(['delete', 'update']);
  });
});

describe('② 하드 삭제 없음 — 삭제는 tombstone, 되살리기는 쌍', () => {
  it('삭제해도 행이 남고 deletedAt만 선다', async () => {
    const p = await savePlace(DAEHAKRO);
    await softDeletePlace(p.id);
    const row = await db().localPlaces.get(p.id);
    expect(row).toBeDefined();
    expect(row!.deletedAt).not.toBeNull();
    expect(await listPlaces()).toHaveLength(0); // 목록에서는 사라진다
  });

  it('되살리면 돌아온다 — version이 올라 좀비 차단 규율을 만족한다', async () => {
    const p = await savePlace(DAEHAKRO);
    await softDeletePlace(p.id);
    await restorePlace(p.id);
    const row = await db().localPlaces.get(p.id);
    expect(row!.deletedAt).toBeNull();
    expect(row!.version).toBeGreaterThan(p.version);
  });

  it('두 번 지워도 같다(멱등)', async () => {
    const p = await savePlace(DAEHAKRO);
    await softDeletePlace(p.id);
    const v = (await db().localPlaces.get(p.id))!.version;
    await softDeletePlace(p.id);
    expect((await db().localPlaces.get(p.id))!.version).toBe(v);
  });

  it('직접 연결된 순간이 없으면 장소만 휴지통으로 보내고 delete op을 남긴다', async () => {
    const p = await savePlace(DAEHAKRO);
    await db().syncQueue.clear();

    expect(await deleteUnusedPlace(p.id)).toEqual({ status: 'deleted' });
    expect((await db().localPlaces.get(p.id))!.deletedAt).not.toBeNull();
    expect((await db().syncQueue.where('entityId').equals(p.id).toArray()).map((op) => op.operationType)).toEqual(['delete']);
  });

  it('사진이 없어도 직접 연결된 글 순간이면 삭제하지 않는다', async () => {
    const moment = await createMomentLocalFirst({
      tripId: 'trip-1', title: '사진 없는 기억', placeName: DAEHAKRO.name,
      placeLat: DAEHAKRO.latitude, placeLng: DAEHAKRO.longitude,
    });
    await db().syncQueue.clear();

    expect(await deleteUnusedPlace(moment.placeId!)).toEqual({
      status: 'linked', activeMomentCount: 1, trashedMomentCount: 0,
    });
    expect((await db().localPlaces.get(moment.placeId!))!.deletedAt).toBeNull();
    expect(await db().syncQueue.count()).toBe(0);
  });

  it('휴지통 순간의 링크도 복원될 수 있으므로 삭제를 막는다', async () => {
    const moment = await createMomentLocalFirst({
      tripId: 'trip-1', title: '휴지통의 기억', placeName: DAEHAKRO.name,
      placeLat: DAEHAKRO.latitude, placeLng: DAEHAKRO.longitude,
    });
    await db().localMoments.update(moment.id, { deletedAt: '2026-08-07T00:00:00.000Z' });
    await db().syncQueue.clear();

    expect(await deleteUnusedPlace(moment.placeId!)).toEqual({
      status: 'linked', activeMomentCount: 0, trashedMomentCount: 1,
    });
    expect((await db().localPlaces.get(moment.placeId!))!.deletedAt).toBeNull();
  });

  it('이름만 같은 순간은 실제 링크가 아니므로 미연결 장소 삭제를 막지 않는다', async () => {
    const p = await savePlace(DAEHAKRO);
    await createMomentLocalFirst({ tripId: 'trip-1', title: '이름만 같음', placeName: DAEHAKRO.name });
    await db().syncQueue.clear();

    expect(await deleteUnusedPlace(p.id)).toEqual({ status: 'deleted' });
    expect((await db().localMoments.toArray())[0]!.deletedAt).toBeNull();
  });
});

describe('③ 휴지통 — 지운 장소에 손이 닿는다', () => {
  it('🔴 지운 장소가 휴지통에 보인다(안 보이면 복구 경로가 없다)', async () => {
    const p = await savePlace(DAEHAKRO);
    await softDeletePlace(p.id);
    const rows = await listTrashedChildren();
    expect(rows.some((r) => r.domain === 'place' && r.id === p.id)).toBe(true);
  });

  it('휴지통 줄이 사람 말로 읽힌다 — 이름 + 어느 동네인지', async () => {
    const p = await savePlace(DAEHAKRO);
    await softDeletePlace(p.id);
    const row = (await listTrashedChildren()).find((r) => r.id === p.id)!;
    expect(row.label).toContain('대학로');
    expect(row.label).toContain('서울특별시');
  });

  it('휴지통에서 되살리면 활성으로 돌아온다', async () => {
    const p = await savePlace(DAEHAKRO);
    await softDeletePlace(p.id);
    await restoreTrashedChild('place', p.id);
    expect(await listPlaces()).toHaveLength(1);
  });

  it('🔴 도메인 목록·이름표에 장소가 든다 — 빠뜨리면 화면에서 사라진다', () => {
    expect(CHILD_DOMAINS).toContain('place');
    expect(CHILD_LABEL.place).toBe('장소');
    expect(PURGE_DOMAINS).toContain('place');
    expect(DOMAIN_PURGE.place.remoteTable).toBe('places');
    expect(DOMAIN_PURGE.place.hasRemoteBytes).toBe(false); // 바이트가 없다
  });
});

describe('④ 🔴 의도적 비대칭 — 장소는 여행의 자식이 **아니다**', () => {
  it('여행을 지워도 장소는 살아남는다(한 장소는 여러 여행에 걸친다)', async () => {
    const trip = await createTripLocalFirst({ title: '서울', startDate: '2026-07-01', endDate: '2026-07-03' });
    const p = await savePlace(DAEHAKRO);
    await softDeleteTripLocalFirst(trip.id);
    expect((await db().localPlaces.get(p.id))!.deletedAt).toBeNull();
    expect(await listPlaces()).toHaveLength(1);
  });

  it('여행을 **영구삭제**해도 장소는 남는다 — 작년 여행을 지웠다고 그 카페를 잊지 않는다', async () => {
    const trip = await createTripLocalFirst({ title: '서울', startDate: '2026-07-01', endDate: '2026-07-03' });
    const p = await savePlace(DAEHAKRO);
    await softDeleteTripLocalFirst(trip.id);
    await db().syncQueue.clear(); // 사전조건: 대기 중인 작업이 없어야 영구삭제가 허용된다
    await purgeTripPermanently(trip.id);
    expect(await db().localPlaces.get(p.id)).toBeDefined();
  });

  it('장소 하나만 영구삭제하면 그 행은 사라진다(형제와 같다)', async () => {
    const p = await savePlace(DAEHAKRO);
    await softDeletePlace(p.id);
    await db().syncQueue.clear(); // 사전조건: 대기 중인 작업 없음
    await purgeChildPermanently('place', p.id);
    expect(await db().localPlaces.get(p.id)).toBeUndefined();
    expect(await db().purgedIds.get(p.id)).toBeDefined(); // 표식이 남아 되살아나지 않는다
  });
});

describe('⑤ 중복 접기 — 같은 곳을 열 번 골라도 행은 하나', () => {
  it('제공자 id와 좌표가 같아도 순간의 기준 장소명이 다르면 별도 장소다', async () => {
    const a = await savePlace(DAEHAKRO);
    const b = await savePlace({ ...DAEHAKRO, name: '대학로 (혜화)' });
    expect(b.id).not.toBe(a.id);
    expect(await listPlaces()).toHaveLength(2);
  });

  it('🔴 제공자 id가 없으면 이름이 같아도 **멀면 다른 곳**이다', async () => {
    const seoul = await savePlace({ name: '대학로', latitude: 37.587, longitude: 127.0016, mapPicked: true });
    const daejeon = await savePlace({ name: '대학로', latitude: 36.35, longitude: 127.34, mapPicked: true });
    expect(daejeon.id).not.toBe(seoul.id);
    expect(await listPlaces()).toHaveLength(2);
  });

  it('지운 장소는 중복 판정에서 빠진다(다시 담는 것은 정상 흐름이다)', async () => {
    const a = await savePlace(DAEHAKRO);
    await softDeletePlace(a.id);
    const b = await savePlace(DAEHAKRO);
    expect(b.id).not.toBe(a.id);
  });

  it('findExistingPlace는 없으면 null(있는 척하지 않는다)', async () => {
    expect(await findExistingPlace({ name: '없는곳', latitude: 0, longitude: 0 })).toBeNull();
  });
});

describe('⑥ 근처 검색 — 오프라인에서도 답이 나온다', () => {
  it('반경 안의 장소만, 가까운 순으로', async () => {
    await savePlace(DAEHAKRO); // 종로
    await savePlace({ name: '광화문', latitude: 37.5759, longitude: 126.9769, mapPicked: true });
    await savePlace({ name: '부산역', latitude: 35.1151, longitude: 129.0413, mapPicked: true });
    // 광화문은 중심에서 약 2.1km라 1km 반경 밖이다(경도 폭은 cos 보정으로 줄어든다).
    const near = await placesNear({ lat: 37.58, lng: 127.0 }, 1_000);
    expect(near.map((r) => r.place.name)).toEqual(['대학로']);
    const wider = await placesNear({ lat: 37.58, lng: 127.0 }, 50_000);
    expect(wider.map((r) => r.place.name)).toEqual(['대학로', '광화문']); // 가까운 순
    expect(wider[0]!.distanceMeters).toBeLessThan(wider[1]!.distanceMeters);
  });

  it('지운 장소는 근처 검색에 안 나온다', async () => {
    const p = await savePlace(DAEHAKRO);
    await softDeletePlace(p.id);
    expect(await placesNear({ lat: 37.58, lng: 127.0 }, 5_000)).toHaveLength(0);
  });
});

describe('⑦ 백업 — 장소가 담긴다(빠지면 복원한 기기에서 라이브러리만 텅 빈다)', () => {
  it('export가 장소를 수집한다', async () => {
    await savePlace(DAEHAKRO);
    const rows = await exportCollectRows();
    expect(rows.places).toHaveLength(1);
    expect(rows.places[0]!.name).toBe('대학로');
  });

  it('tombstone도 담긴다 — 안 담으면 복원이 지운 것을 되살린다', async () => {
    const p = await savePlace(DAEHAKRO);
    await softDeletePlace(p.id);
    const rows = await exportCollectRows();
    expect(rows.places).toHaveLength(1);
    expect(rows.places[0]!.deletedAt).not.toBeNull();
  });
});

describe('⑧ 배선 — 데이터가 화면까지 닿는가', () => {
  it('장소가 실장 도메인으로 선언돼 있다', () => {
    const place = SOURCES.find((s) => s.key === 'place')!;
    expect(place.implemented).toBe(true);
    expect(place.hasRowmap).toBe(true);
    expect(place.hasSync).toBe(true);
    expect(place.localTable).toBe('localPlaces');
  });

  it('🔴 끊긴 배선이 없다 — 어느 화면에도 안 닿는 도메인은 사용자에게 없는 기능이다', () => {
    const check = selfCheck();
    expect(check.gaps).toEqual([]);
  });
});
