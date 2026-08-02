// staleSyncWrite.test.ts — 오래된 기기 push가 서버 최신본을 되돌리지 않는가(0026).
import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { db, type LocalMedia, type LocalTrip, type SyncQueueItem } from '../../src/offline/db';
import {
  collapseSyncAttempts,
  pullTrips,
  pushPending,
  pushPendingMedia,
  type MediaRemote,
  type TripsRemote,
} from '../../src/services/sync';
import type { TripRow } from '../../src/domain/trip/rowmap';
import type { MediaRow } from '../../src/domain/media/rowmap';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = '11111111-1111-4111-8111-111111111111';
const LOCAL_OP = '22222222-2222-4222-8222-222222222222';
const SERVER_OP = '33333333-3333-4333-8333-333333333333';
const MEDIA_ID = '44444444-4444-4444-8444-444444444444';
const MOMENT_ID = '55555555-5555-4555-8555-555555555555';

function queue(
  operationId: string,
  createdAt: string,
  state: SyncQueueItem['state'] = 'local_only',
  nextRetryAt?: string,
): SyncQueueItem {
  return {
    operationId,
    entityType: 'trip',
    entityId: ID,
    operationType: 'update',
    state,
    attempts: 0,
    createdAt,
    ...(nextRetryAt ? { nextRetryAt } : {}),
  };
}

function mediaQueue(): SyncQueueItem {
  return {
    operationId: LOCAL_OP,
    entityType: 'media',
    entityId: MEDIA_ID,
    operationType: 'update',
    state: 'local_only',
    attempts: 0,
    createdAt: '2026-08-02T09:00:00.000Z',
  };
}

beforeEach(async () => {
  const d = db();
  await Promise.all([d.localTrips.clear(), d.localMedia.clear(), d.syncQueue.clear(), d.purgedIds.clear()]);
});

describe('stale media push R2 fence', () => {
  it('DB guard가 stale 메타를 거절해도 최신 R2 바이트를 덮지 않고 작업 키만 정리한다', async () => {
    const previousPath = `${USER}/trip/20260802_1200_latest__44444444444444448444444444444444.webp`;
    const local: LocalMedia = {
      id: MEDIA_ID,
      momentId: MOMENT_ID,
      tripId: ID,
      mime: 'image/webp',
      originalBlob: new Blob(['old-original'], { type: 'image/jpeg' }),
      displayBlob: new Blob(['stale-display'], { type: 'image/webp' }),
      thumbBlob: new Blob(['stale-thumb'], { type: 'image/webp' }),
      width: 100,
      height: 100,
      takenAt: '2026-08-02T09:00:00.000Z',
      gpsLat: null,
      gpsLng: null,
      bytesOriginal: 12,
      bytesDisplay: 13,
      storagePath: previousPath,
      version: 2,
      baseVersion: 1,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-02T09:00:00.000Z',
      deletedAt: null,
      clientOperationId: LOCAL_OP,
    };
    const server: MediaRow = {
      id: MEDIA_ID,
      user_id: USER,
      moment_id: MOMENT_ID,
      trip_id: ID,
      storage_path: previousPath,
      gps_lat: null,
      gps_lng: null,
      width: 200,
      height: 200,
      taken_at: '2026-08-02T10:00:00.000Z',
      bytes_display: 14,
      source: 'user',
      version: 3,
      base_version: 2,
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-02T10:00:00.000Z',
      deleted_at: null,
      client_operation_id: SERVER_OP,
    };
    const objects = new Map<string, Blob>([
      [previousPath, new Blob(['latest-display'], { type: 'image/webp' })],
    ]);
    const uploads: string[] = [];
    const removed: string[] = [];
    const remote: MediaRemote = {
      upsert: async () => ({}), // 0026이 stale row를 no-op으로 거절한 응답
      getById: async () => ({ data: server }),
      listAll: async () => ({ data: [server] }),
      uploadDisplay: async (path, blob) => {
        uploads.push(path);
        objects.set(path, blob);
        return {};
      },
      download: async (path) => ({ data: objects.get(path) ?? null }),
      remove: async (path) => {
        removed.push(path);
        objects.delete(path);
        return {};
      },
    };

    await db().localMedia.put(local);
    await db().syncQueue.put(mediaQueue());

    expect(await pushPendingMedia(remote, USER)).toEqual({ pushed: 0, failed: 1 });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).not.toBe(previousPath);
    expect(removed).toEqual([uploads[0]]);
    expect(await objects.get(previousPath)!.text()).toBe('latest-display');
    expect(objects.has(uploads[0]!)).toBe(false);
    expect((await db().syncQueue.get(LOCAL_OP))?.state).toBe('retryable_failed');
  });
});

describe('collapseSyncAttempts', () => {
  it('같은 엔티티의 연속 편집은 최신 op 하나만 보내고 옛 op을 접는다', () => {
    const old = queue('op-old', '2026-08-02T10:00:00.000Z');
    const latest = queue('op-latest', '2026-08-02T10:01:00.000Z');
    const [attempt] = collapseSyncAttempts([old, latest], 'trip', '2026-08-02T10:02:00.000Z');

    expect(attempt?.op.operationId).toBe('op-latest');
    expect(attempt?.supersededOperationIds).toEqual(['op-old']);
  });

  it('최신 op이 백오프 중이면 옛 op으로 우회해 최신 payload를 조기 전송하지 않는다', () => {
    const old = queue('op-old', '2026-08-02T10:00:00.000Z');
    const latest = queue(
      'op-latest',
      '2026-08-02T10:01:00.000Z',
      'retryable_failed',
      '2026-08-02T11:00:00.000Z',
    );
    expect(collapseSyncAttempts([old, latest], 'trip', '2026-08-02T10:02:00.000Z')).toEqual([]);
  });

  it('최신 op이 permanent면 옛 op도 보내지 않는다', () => {
    const old = queue('op-old', '2026-08-02T10:00:00.000Z');
    const latest = queue('op-latest', '2026-08-02T10:01:00.000Z', 'permanent_failed');
    expect(collapseSyncAttempts([old, latest], 'trip', '2026-08-02T10:02:00.000Z')).toEqual([]);
  });
});

describe('stale push 거부 후 서버 최신본 수용', () => {
  it('옛 큐의 operation id가 로컬 행에 없더라도 현재 snapshot을 보내고 성공 stamp를 원자 반영한다', async () => {
    const local: LocalTrip = {
      id: ID,
      title: '옛 버전에서 만든 대기 작업',
      startDate: '',
      endDate: '',
      status: 'planned',
      version: 2,
      baseVersion: 1,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-02T09:00:00.000Z',
      deletedAt: null,
      clientOperationId: SERVER_OP,
    };
    let server: TripRow | null = null;
    await db().localTrips.put(local);
    await db().syncQueue.put(queue(LOCAL_OP, local.updatedAt));

    const remote: TripsRemote = {
      upsert: async (row) => {
        server = { ...row, version: 2, updated_at: '2026-08-02T10:00:00.000Z' };
        return {};
      },
      getById: async () => ({ data: server }),
      listAll: async () => ({ data: server ? [server] : [] }),
    };

    expect(await pushPending(remote, USER)).toEqual({ pushed: 1, failed: 0 });
    expect(await db().syncQueue.get(LOCAL_OP)).toBeUndefined();
    expect(await db().localTrips.get(ID)).toMatchObject({
      version: 2,
      baseVersion: 2,
      clientOperationId: LOCAL_OP,
      updatedAt: '2026-08-02T10:00:00.000Z',
    });
  });

  it('서버 v3을 로컬 옛 v2가 덮지 못하고, pull이 큐와 로컬을 서버 기준으로 정리한다', async () => {
    const local: LocalTrip = {
      id: ID,
      title: '오래된 기기 v2',
      startDate: '',
      endDate: '',
      status: 'planned',
      version: 2,
      baseVersion: 1,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-02T09:00:00.000Z',
      deletedAt: null,
      clientOperationId: LOCAL_OP,
    };
    const server: TripRow = {
      id: ID,
      user_id: USER,
      title: '서버 최신 v3',
      start_date: null,
      time_zone: null,
      end_date: null,
      status: 'planned',
      version: 3,
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-02T10:00:00.000Z',
      deleted_at: null,
      client_operation_id: SERVER_OP,
      updated_by_device: '기기A#server',
    };
    await db().localTrips.put(local);
    await db().syncQueue.put(queue(LOCAL_OP, local.updatedAt));

    const attempted: TripRow[] = [];
    const remote: TripsRemote = {
      // 0026 trigger가 stale update를 no-op으로 처리한 서버를 모사한다.
      upsert: async (row) => {
        attempted.push(row);
        return {};
      },
      getById: async () => ({ data: server }),
      listAll: async () => ({ data: [server] }),
    };

    expect(await pushPending(remote, USER)).toEqual({ pushed: 0, failed: 1 });
    expect(attempted[0]?.client_operation_id).toBe(LOCAL_OP);
    expect(attempted[0]?.base_version).toBe(1);
    expect((await db().syncQueue.get(LOCAL_OP))?.state).toBe('retryable_failed');
    expect((await db().localTrips.get(ID))?.title).toBe('오래된 기기 v2');

    expect(await pullTrips(remote)).toEqual({ pulled: 1, skippedEmptyCloud: false });
    expect((await db().localTrips.get(ID))?.title).toBe('서버 최신 v3');
    expect(await db().syncQueue.where('entityId').equals(ID).count()).toBe(0);
  });

  it('로컬 시계가 앞선 충돌은 서버 version에 재기반화한 뒤 다음 재시도에서 보낸다', async () => {
    const local: LocalTrip = {
      id: ID,
      title: '오프라인에서 고친 제목',
      startDate: '',
      endDate: '',
      status: 'planned',
      version: 2,
      baseVersion: 1,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-02T11:00:00.000Z',
      deletedAt: null,
      clientOperationId: LOCAL_OP,
    };
    let server: TripRow = {
      id: ID,
      user_id: USER,
      title: '다른 기기의 서버 제목',
      start_date: null,
      time_zone: null,
      end_date: null,
      status: 'planned',
      version: 3,
      base_version: 2,
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-02T10:00:00.000Z',
      deleted_at: null,
      client_operation_id: SERVER_OP,
    };
    await db().localTrips.put(local);
    await db().syncQueue.put(queue(LOCAL_OP, local.updatedAt));

    let attempts = 0;
    const remote: TripsRemote = {
      upsert: async (row) => {
        attempts += 1;
        // 첫 요청은 base=1 대 server=3이라 guard가 거절한다. 재기반화된 두 번째 요청만 수용한다.
        if (row.base_version === server.version) server = { ...row };
        return {};
      },
      getById: async () => ({ data: server }),
      listAll: async () => ({ data: [server] }),
    };

    expect(await pushPending(remote, USER)).toEqual({ pushed: 0, failed: 1 });
    const rebased = await db().localTrips.get(ID);
    expect(rebased).toMatchObject({
      title: local.title,
      version: 4,
      baseVersion: 3,
      clientOperationId: LOCAL_OP,
    });

    // LWW상 로컬이 최신이므로 pull은 로컬 변경을 버리지 않고 같은 op을 유지한다.
    expect(await pullTrips(remote)).toEqual({ pulled: 0, skippedEmptyCloud: false });
    const waiting = await db().syncQueue.get(LOCAL_OP);
    expect(waiting).toBeDefined();
    const retryNow = { ...waiting! };
    delete retryNow.nextRetryAt;
    await db().syncQueue.put({ ...retryNow, state: 'local_only' });

    expect(await pushPending(remote, USER)).toEqual({ pushed: 1, failed: 0 });
    expect(attempts).toBe(2);
    expect(server).toMatchObject({
      title: local.title,
      version: 4,
      base_version: 3,
      client_operation_id: LOCAL_OP,
    });
    expect(await db().syncQueue.get(LOCAL_OP)).toBeUndefined();
    expect(await db().localTrips.get(ID)).toMatchObject({ version: 4, baseVersion: 4 });
  });
});
