// 실기기 복원 드릴 — importMergeRows를 실제 Dexie(fake-indexeddb)로 구워 db 접근층까지 검증.
// 감사관 교정 #3: 순수 직렬화층뿐 아니라 병합·put·read-back·빈가드·tombstone 우위를 실 DB로 확인.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../src/offline/db';
import { importMergeRows, exportCollectRows, type CollectedRows } from '../../src/services/backup';
import type { LocalTrip, LocalMoment, LocalMedia, LocalExpense } from '../../src/offline/db';

const mkBlob = (nums: number[]) => new Blob([new Uint8Array(nums)], { type: 'image/webp' });
const bytesOf = async (b: Blob) => [...new Uint8Array(await b.arrayBuffer())];

function trip(id: string, over: Partial<LocalTrip> = {}): LocalTrip {
  return {
    id, title: '여행 ' + id, startDate: '2024-05-01', endDate: '2024-05-05', status: 'completed',
    createdAt: '2024-05-01T00:00:00.000Z', updatedAt: '2024-05-06T00:00:00.000Z', version: 1, deletedAt: null, ...over,
  };
}
function moment(id: string, tripId: string): LocalMoment {
  return {
    id, tripId, occurredAt: '2024-05-02T03:00:00.000Z', title: '순간', note: '', emotion: '', placeName: '',
    placeLat: 35.7, placeLng: 139.7, createdAt: '2024-05-02T03:00:00.000Z', updatedAt: '2024-05-02T03:00:00.000Z',
    version: 1, deletedAt: null,
  };
}
function media(id: string): LocalMedia {
  return {
    id, momentId: 'm1', tripId: 't1', mime: 'image/jpeg', originalBlob: mkBlob([10, 20, 30]),
    displayBlob: mkBlob([1, 2, 3]), thumbBlob: mkBlob([9, 8]), width: 1600, height: 1200,
    takenAt: '2024-05-02T03:00:00.000Z', gpsLat: 35.7, gpsLng: 139.7, sortOrder: null, bytesOriginal: 3, bytesDisplay: 3,
    version: 1, createdAt: '2024-05-02T03:00:00.000Z', updatedAt: '2024-05-02T03:00:00.000Z', deletedAt: null,
  };
}
function expense(id: string): LocalExpense {
  return {
    id, momentId: 'm1', tripId: 't1', originalAmount: 1200, originalCurrency: 'JPY', category: '식비', note: '',
    createdAt: '2024-05-02T04:00:00.000Z', updatedAt: '2024-05-02T04:00:00.000Z', version: 1, deletedAt: null,
  };
}
const sample = (): CollectedRows => ({ trips: [trip('t1')], moments: [moment('m1', 't1')], media: [media('md1')], expenses: [expense('e1')], audio: [], places: [] });

beforeEach(async () => {
  const d = db();
  await Promise.all([d.localTrips.clear(), d.localMoments.clear(), d.localMedia.clear(), d.localExpenses.clear(), d.syncQueue.clear()]);
});

describe('실기기 복원 드릴(importMergeRows over Dexie)', () => {
  it('빈 db에 복원 → 실제로 저장되고 되읽힌다(사진 바이트 포함)', async () => {
    const src = sample();
    const res = await importMergeRows(src);
    expect(res).toMatchObject({ trips: 1, moments: 1, media: 1, expenses: 1, audio: 0, skippedEmptyGuard: false });

    const back = await exportCollectRows();
    expect(back.trips.map((t) => t.id)).toEqual(['t1']);
    expect(back.moments[0]!.placeLat).toBe(35.7);
    expect(back.expenses[0]!.category).toBe('식비');
    const bm = back.media.find((m) => m.id === 'md1')!;
    expect(await bytesOf(bm.originalBlob!)).toEqual([10, 20, 30]); // 동기화 전 임시 원본은 실 DB 왕복에서 보존
    expect(await bytesOf(bm.displayBlob)).toEqual([1, 2, 3]);
  });

  it('빈-데이터 가드: 활성 데이터가 있는데 빈 백업을 넣으면 건너뛰고 로컬 보존', async () => {
    await importMergeRows(sample());
    const res = await importMergeRows({ trips: [], moments: [], media: [], expenses: [], audio: [], places: [] });
    expect(res.skippedEmptyGuard).toBe(true);
    expect((await exportCollectRows()).trips.length).toBe(1); // 지워지지 않음
  });

  it('LWW: 더 오래된 version은 로컬을 덮어쓰지 않는다', async () => {
    await importMergeRows({ trips: [trip('t1', { version: 3, title: '최신' })], moments: [], media: [], expenses: [], audio: [], places: [] });
    const res = await importMergeRows({ trips: [trip('t1', { version: 2, title: '옛것' })], moments: [], media: [], expenses: [], audio: [], places: [] });
    expect(res.trips).toBe(0); // 반영 안 됨
    expect((await db().localTrips.get('t1'))!.title).toBe('최신');
  });

  it('tombstone 우위: 더 높은 version의 삭제는 활성 로컬을 삭제로 전이', async () => {
    await importMergeRows({ trips: [trip('t1', { version: 1 })], moments: [], media: [], expenses: [], audio: [], places: [] });
    await importMergeRows({
      trips: [trip('t1', { version: 2, deletedAt: '2024-07-01T00:00:00.000Z' })], moments: [], media: [], expenses: [], audio: [], places: []
    });
    expect((await db().localTrips.get('t1'))!.deletedAt).toBe('2024-07-01T00:00:00.000Z');
  });
});
