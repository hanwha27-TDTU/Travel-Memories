import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '../../src/offline/db';
import { createMomentLocalFirst, updateMomentLocalFirst } from '../../src/services/moments';
import { listPlaces, reconcileMomentPlaces, savePlace, updatePlace } from '../../src/services/places';

beforeEach(async () => {
  const d = db();
  await Promise.all([
    d.localPlaces.clear(),
    d.localMoments.clear(),
    d.syncQueue.clear(),
  ]);
});

describe('기존 순간 장소 소급 등록', () => {
  it('새 순간 저장 서비스가 입력 이름을 기준으로 장소 대장에 즉시 등록한다', async () => {
    const moment = await createMomentLocalFirst({
      tripId: 'trip-1', title: '새 순간', placeName: '전망 좋은 창가', placeLat: 37.5, placeLng: 127,
    });
    const place = await db().localPlaces.get(moment.placeId!);
    expect(place).toMatchObject({ name: '전망 좋은 창가', latitude: 37.5, longitude: 127 });
    expect((await db().syncQueue.where('entityId').equals(place!.id).toArray())[0]?.entityType).toBe('place');
  });

  it('순간에 저장된 이름과 좌표로 연결된 대장 항목을 직접 고친다', async () => {
    const old = await savePlace({ name: '자동 주소', latitude: 37.5, longitude: 127, mapPicked: true });
    const moment = await createMomentLocalFirst({ tripId: 'trip-1', title: '사진 순간', placeId: old.id });
    await db().localMoments.update(moment.id, {
      placeName: '내가 붙인 이름', placeLat: 37.5001, placeLng: 127.0001,
    });
    await db().syncQueue.clear();

    expect(await reconcileMomentPlaces()).toBe(1);
    const [place, updatedMoment] = await Promise.all([
      db().localPlaces.get(old.id), db().localMoments.get(moment.id),
    ]);
    expect(place).toMatchObject({ name: '내가 붙인 이름', latitude: 37.5001, longitude: 127.0001 });
    expect(updatedMoment?.placeId).toBe(old.id);

    await db().syncQueue.clear();
    expect(await reconcileMomentPlaces()).toBe(0);
    expect(await db().syncQueue.count()).toBe(0);
  });

  it('같은 옛 대장을 공유해도 순간 기준명이 다르면 별도 장소로 분리한다', async () => {
    const old = await savePlace({ name: '자동 주소', latitude: 37.5, longitude: 127, mapPicked: true });
    const first = await createMomentLocalFirst({
      tripId: 'trip-1', title: '첫 순간', placeId: old.id, occurredAt: '2026-01-01T09:00:00.000Z',
    });
    const second = await createMomentLocalFirst({
      tripId: 'trip-1', title: '둘째 순간', placeId: old.id, occurredAt: '2026-01-01T18:00:00.000Z',
    });
    await db().localMoments.update(first.id, { placeName: '아침의 장소', placeLat: 37.5, placeLng: 127 });
    await db().localMoments.update(second.id, { placeName: '저녁의 장소', placeLat: 37.5, placeLng: 127 });

    await reconcileMomentPlaces();
    const [firstBack, secondBack, places] = await Promise.all([
      db().localMoments.get(first.id), db().localMoments.get(second.id), listPlaces(),
    ]);
    expect(firstBack?.placeId).toBe(old.id);
    expect(secondBack?.placeId).not.toBe(old.id);
    expect(new Set(places.map((p) => p.name))).toEqual(new Set(['아침의 장소', '저녁의 장소']));
  });

  it('대장 지도에서 고친 좌표는 다음 소급 실행이 순간의 옛 좌표로 되돌리지 않는다', async () => {
    const moment = await createMomentLocalFirst({
      tripId: 'trip-1', title: '핀 이동', placeName: '내 장소', placeLat: 37.5, placeLng: 127,
    });
    await updatePlace(moment.placeId!, { latitude: 37.6, longitude: 127.1, mapPicked: true });
    await db().syncQueue.clear();

    expect(await reconcileMomentPlaces()).toBe(0);
    expect(await db().localPlaces.get(moment.placeId!)).toMatchObject({ latitude: 37.6, longitude: 127.1 });
    expect(await db().syncQueue.count()).toBe(0);
  });

  it('연결된 순간에서 이름을 바꾸면 placeId·당시 좌표를 유지하고 대장·형제 순간에 원자 전파한다', async () => {
    const place = await savePlace({ name: 'TSMU 대학병원 4번 건물 7층', latitude: 41.3505, longitude: 69.1720 });
    const first = await createMomentLocalFirst({
      tripId: 'trip-1', title: '종강기념', placeId: place.id,
      placeName: place.name, placeLat: 41.3505, placeLng: 69.1720,
    });
    const second = await createMomentLocalFirst({
      tripId: 'trip-1', title: '다른 날', placeId: place.id,
      placeName: place.name, placeLat: 41.3506, placeLng: 69.1721,
    });
    await db().localMoments.update(second.id, { deletedAt: '2026-08-07T00:00:00.000Z' });
    await db().syncQueue.clear();

    const updated = await updateMomentLocalFirst(first.id, { placeName: 'TSMU 대학병원 4번 건물' });
    const [placeBack, siblingBack, ops] = await Promise.all([
      db().localPlaces.get(place.id), db().localMoments.get(second.id), db().syncQueue.toArray(),
    ]);

    expect(updated).toMatchObject({
      placeId: place.id, placeName: 'TSMU 대학병원 4번 건물',
      placeLat: 41.3505, placeLng: 69.1720,
    });
    expect(placeBack?.name).toBe('TSMU 대학병원 4번 건물');
    expect(siblingBack).toMatchObject({ placeName: 'TSMU 대학병원 4번 건물', deletedAt: '2026-08-07T00:00:00.000Z' });
    expect(ops.filter((op) => op.entityType === 'place' && op.entityId === place.id)).toHaveLength(1);
    expect(ops.filter((op) => op.entityType === 'moment')).toHaveLength(2);
  });

  it('대장에서 이름을 바꾸면 연결된 순간 이름만 함께 바꾸고 당시 좌표는 보존한다', async () => {
    const moment = await createMomentLocalFirst({
      tripId: 'trip-1', title: '연결된 순간', placeName: '옛 이름', placeLat: 37.5, placeLng: 127,
    });
    await db().syncQueue.clear();

    const result = await updatePlace(moment.placeId!, { name: '새 이름' });
    const back = await db().localMoments.get(moment.id);

    expect(result.renamedMomentCount).toBe(1);
    expect(back).toMatchObject({ placeId: moment.placeId, placeName: '새 이름', placeLat: 37.5, placeLng: 127 });
  });

  it('위치 해제를 명시하면 이름·좌표·placeId가 모두 비고 새 대장 행을 만들지 않는다', async () => {
    const moment = await createMomentLocalFirst({
      tripId: 'trip-1', title: '연결 해제', placeName: '기존 장소', placeLat: 37.5, placeLng: 127,
    });
    const before = await db().localPlaces.count();

    const back = await updateMomentLocalFirst(moment.id, {
      placeName: '', placeLat: null, placeLng: null, placeId: null,
    });

    expect(back).toMatchObject({ placeName: '', placeLat: null, placeLng: null, placeId: null });
    expect(await db().localPlaces.count()).toBe(before);
  });

  it('같은 장소 저장이 동시에 겹쳐도 대장 행과 insert op은 하나뿐이다', async () => {
    await Promise.all(Array.from({ length: 4 }, () => savePlace({
      name: '동시 저장 장소', latitude: 37.5, longitude: 127, mapPicked: true,
    })));

    expect(await db().localPlaces.count()).toBe(1);
    expect((await db().syncQueue.toArray()).filter((op) => op.entityType === 'place')).toHaveLength(1);
  });
});
