// canonicalSync.test.ts — 일반 병합과 사용자 지정 최종본 교체가 섞이지 않는가.

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, type LocalMedia, type LocalTrip, type SyncQueueItem } from '../../src/offline/db';
import {
  ensureCanonicalBeforeSync,
  publishCanonicalWithRemote,
  type CanonicalMeta,
  type CanonicalRemote,
} from '../../src/services/canonicalSync';
import { runSync } from '../../src/services/sync';
import type { TripRow } from '../../src/domain/trip/rowmap';
import type { MediaRow } from '../../src/domain/media/rowmap';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOCAL_ID = '11111111-1111-4111-8111-111111111111';
const SERVER_ID = '22222222-2222-4222-8222-222222222222';
const MOMENT_ID = '33333333-3333-4333-8333-333333333333';
const VERSION = '44444444-4444-4444-8444-444444444444';

function localTrip(id = LOCAL_ID, title = '로컬 전용'): LocalTrip {
  return {
    id,title,startDate:'',endDate:'',status:'planned',version:1,
    createdAt:'2026-08-01T00:00:00.000Z',updatedAt:'2026-08-01T00:00:00.000Z',deletedAt:null,
  };
}

function tripRow(id = SERVER_ID, title = '클라우드 최종본'): TripRow {
  return {
    id,user_id:USER,title,start_date:null,time_zone:null,end_date:null,status:'completed',version:3,
    base_version:3,base_canonical_version:VERSION,created_at:'2026-08-01T00:00:00.000Z',
    updated_at:'2026-08-02T00:00:00.000Z',deleted_at:null,client_operation_id:null,
  };
}

function queue(): SyncQueueItem {
  return {
    operationId:'55555555-5555-4555-8555-555555555555',entityType:'trip',entityId:LOCAL_ID,
    operationType:'insert',state:'local_only',attempts:0,createdAt:'2026-08-01T00:00:00.000Z',
  };
}

function meta(version: string, operationId: string | null = null): CanonicalMeta {
  return { canonicalVersion:version,canonicalOperationId:operationId,canonicalDeviceId:null,updatedAt:'2026-08-02T00:00:00.000Z' };
}

function fakeRemote(options: {
  version?: string;
  trips?: TripRow[];
  media?: MediaRow[];
  downloadError?: string;
  commitWithResponseError?: boolean;
  uploadErrors?: string[];
} = {}): CanonicalRemote & { published: unknown[]; uploads: string[] } {
  let current = meta(options.version ?? 'legacy');
  const published: unknown[] = [];
  const uploads: string[] = [];
  return {
    published,uploads,
    ensureMeta: async () => ({ data:current }),
    listTrips: async () => ({ data:options.trips ?? [] }),
    listPlaces: async () => ({ data:[] }),
    listMoments: async () => ({ data:[] }),
    listMedia: async () => ({ data:options.media ?? [] }),
    listExpenses: async () => ({ data:[] }),
    listAudio: async () => ({ data:[] }),
    listPurgedIds: async () => ({ data:[] }),
    publish: async (snapshot) => {
      published.push(snapshot);
      current = meta(snapshot.nextVersion,snapshot.operationId);
      return options.commitWithResponseError ? { data:null,error:'응답 유실' } : { data:{ ok:true } };
    },
    upload: async (path) => {
      uploads.push(path);
      const error = options.uploadErrors?.shift();
      return error ? { error } : {};
    },
    download: async () => options.downloadError
      ? ({ data:null,error:options.downloadError })
      : ({ data:new Blob(['server-bytes'],{ type:'image/webp' }) }),
    remove: async () => ({}),
  };
}

beforeEach(async () => {
  const d = db();
  await Promise.all([
    d.localTrips.clear(),d.localPlaces.clear(),d.localMoments.clear(),d.localMedia.clear(),
    d.localExpenses.clear(),d.localAudio.clear(),d.syncQueue.clear(),d.purgedIds.clear(),d.syncState.clear(),
  ]);
});

describe('canonical 소비 기기', () => {
  it('legacy 첫 기준선은 로컬을 지우지 않고 현재 세대만 찍는다', async () => {
    await db().localTrips.put(localTrip());
    const result = await ensureCanonicalBeforeSync(fakeRemote(),USER);
    expect(result).toEqual({ mode:'normal',version:'legacy',pulled:0 });
    expect((await db().localTrips.get(LOCAL_ID))?.title).toBe('로컬 전용');
    expect((await db().localTrips.get(LOCAL_ID))?.baseCanonicalVersion).toBe('legacy');
  });

  it('세대가 바뀌면 로컬 전용·대기열을 보존하지 않고 클라우드 정확집합으로 교체한다', async () => {
    await db().localTrips.put(localTrip());
    await db().syncQueue.put(queue());
    await db().syncState.put({ id:`canonical:${USER}`,userId:USER,canonicalVersion:'legacy',updatedAt:'2026-08-01T00:00:00.000Z' });

    const remote = fakeRemote({ version:VERSION,trips:[tripRow()] });
    const result = await ensureCanonicalBeforeSync(remote,USER);
    expect(result).toEqual({ mode:'applied',version:VERSION,pulled:1 });
    expect(await db().localTrips.get(LOCAL_ID)).toBeUndefined();
    expect(await db().localTrips.get(SERVER_ID)).toMatchObject({ title:'클라우드 최종본',baseCanonicalVersion:VERSION });
    expect(await db().syncQueue.count()).toBe(0);
    expect(remote.published).toHaveLength(0);
  });

  it('바이트를 다 받지 못하면 로컬 교체를 시작하지 않는다', async () => {
    const media: MediaRow = {
      id:'66666666-6666-4666-8666-666666666666',user_id:USER,moment_id:MOMENT_ID,trip_id:SERVER_ID,
      storage_path:`${USER}/trip/photo__66666666666646668666666666666666.webp`,gps_lat:null,gps_lng:null,
      width:100,height:100,taken_at:null,bytes_display:10,source:'user',version:1,base_version:1,
      base_canonical_version:VERSION,created_at:'2026-08-01T00:00:00.000Z',
      updated_at:'2026-08-02T00:00:00.000Z',deleted_at:null,client_operation_id:null,
    };
    await db().localTrips.put(localTrip());
    await db().syncQueue.put(queue());
    await db().syncState.put({ id:`canonical:${USER}`,userId:USER,canonicalVersion:'legacy',updatedAt:'2026-08-01T00:00:00.000Z' });

    await expect(ensureCanonicalBeforeSync(fakeRemote({ version:VERSION,trips:[tripRow()],media:[media],downloadError:'offline' }),USER))
      .rejects.toThrow('다운로드 실패');
    expect(await db().localTrips.get(LOCAL_ID)).toBeDefined();
    expect(await db().syncQueue.count()).toBe(1);
    expect((await db().syncState.get(`canonical:${USER}`))?.canonicalVersion).toBe('legacy');
  });

  it('서버 객체 경로가 바뀌면 옛 로컬 원본을 새 최종본의 원본처럼 보존하지 않는다', async () => {
    const mediaId = '77777777-7777-4777-8777-777777777777';
    const oldDisplay = new Blob(['old-display'],{ type:'image/webp' });
    await db().localMedia.put({
      id:mediaId,momentId:MOMENT_ID,tripId:SERVER_ID,mime:'image/jpeg',
      originalBlob:new Blob(['old-original'],{ type:'image/jpeg' }),displayBlob:oldDisplay,
      thumbBlob:oldDisplay,width:10,height:10,takenAt:'2026-08-01T00:00:00.000Z',
      gpsLat:null,gpsLng:null,bytesOriginal:12,bytesDisplay:oldDisplay.size,
      storagePath:`${USER}/old.webp`,version:1,createdAt:'2026-08-01T00:00:00.000Z',
      updatedAt:'2026-08-01T00:00:00.000Z',deletedAt:null,
    });
    await db().syncState.put({ id:`canonical:${USER}`,userId:USER,canonicalVersion:'legacy',updatedAt:'2026-08-01T00:00:00.000Z' });
    const row: MediaRow = {
      id:mediaId,user_id:USER,moment_id:MOMENT_ID,trip_id:SERVER_ID,
      storage_path:`${USER}/new.webp`,gps_lat:null,gps_lng:null,width:10,height:10,taken_at:null,
      bytes_display:12,source:'user',version:2,base_version:2,base_canonical_version:VERSION,
      created_at:'2026-08-01T00:00:00.000Z',updated_at:'2026-08-02T00:00:00.000Z',
      deleted_at:null,client_operation_id:null,
    };

    await ensureCanonicalBeforeSync(fakeRemote({ version:VERSION,media:[row] }),USER);
    const local = await db().localMedia.get(mediaId);
    expect(await local?.originalBlob.text()).toBe('server-bytes');
    expect(local?.storagePath).toBe(`${USER}/new.webp`);
  });
});

describe('canonical 게시 기기', () => {
  it('RPC 응답을 잃어도 operation read-back으로 성공을 확정하고 옛 큐만 지운다', async () => {
    await db().localTrips.put(localTrip());
    await db().syncQueue.put(queue());
    const remote = fakeRemote({ commitWithResponseError:true });
    const result = await publishCanonicalWithRemote(remote,USER);

    expect(result.rows).toBe(1);
    expect(remote.published).toHaveLength(1);
    expect(await db().syncQueue.count()).toBe(0);
    expect((await db().localTrips.get(LOCAL_ID))?.baseCanonicalVersion).toBe(result.version);
    expect((await db().syncState.get(`canonical:${USER}`))?.canonicalVersion).toBe(result.version);
    expect((await db().syncState.get(`canonical:${USER}`))?.pendingCanonical).toBeUndefined();
  });

  it('캡처 뒤 로컬 바이트가 바뀌면 낡은 pending을 버려 새 작업으로 다시 시작할 수 있다', async () => {
    const mediaId = '66666666-6666-4666-8666-666666666666';
    const displayBlob = new Blob(['first'],{ type:'image/webp' });
    const media: LocalMedia = {
      id:mediaId,momentId:MOMENT_ID,tripId:LOCAL_ID,mime:'image/jpeg',
      originalBlob:new Blob(['original'],{ type:'image/jpeg' }),displayBlob,
      thumbBlob:new Blob(['thumb'],{ type:'image/webp' }),width:10,height:10,
      takenAt:'2026-08-01T00:00:00.000Z',gpsLat:null,gpsLng:null,
      bytesOriginal:8,bytesDisplay:displayBlob.size,version:1,
      createdAt:'2026-08-01T00:00:00.000Z',updatedAt:'2026-08-01T00:00:00.000Z',deletedAt:null,
    };
    await db().localTrips.put(localTrip());
    await db().localMedia.put(media);
    const remote = fakeRemote({ uploadErrors:['offline'] });

    await expect(publishCanonicalWithRemote(remote,USER)).rejects.toThrow('업로드 실패');
    expect((await db().syncState.get(`canonical:${USER}`))?.pendingCanonical?.stage).toBe('uploading');

    const changed = new Blob(['changed'],{ type:'image/webp' });
    await db().localMedia.update(mediaId,{ displayBlob:changed,bytesDisplay:changed.size,updatedAt:'2026-08-02T01:00:00.000Z' });
    await expect(publishCanonicalWithRemote(remote,USER)).rejects.toThrow('캡처 뒤 내용이 바뀌었습니다');
    expect((await db().syncState.get(`canonical:${USER}`))?.pendingCanonical).toBeUndefined();

    await expect(publishCanonicalWithRemote(remote,USER)).resolves.toMatchObject({ rows:2 });
    const publishedMedia = (remote.published.at(-1) as { media: MediaRow[] }).media[0];
    expect((await db().localMedia.get(mediaId))?.storagePath).toBe(publishedMedia.storage_path);
  });
});

describe('runSync 오케스트레이션 이음매', () => {
  it('canonical 변경을 본 실행은 어떤 upsert도 하지 않고 즉시 끝난다', async () => {
    await db().localTrips.put(localTrip());
    await db().syncQueue.put(queue());
    await db().syncState.put({ id:`canonical:${USER}`,userId:USER,canonicalVersion:'legacy',updatedAt:'2026-08-01T00:00:00.000Z' });
    let upserts = 0;
    const rows: Record<string, unknown[]> = { trips:[tripRow()],places:[],moments:[],media:[],expenses:[],audio:[],purged_ids:[] };
    const client = {
      rpc: async () => ({ data:{ canonical_version:VERSION,canonical_operation_id:null,canonical_device_id:null,updated_at:'2026-08-02T00:00:00.000Z' },error:null }),
      from(table: string) {
        const range = async () => ({ data:rows[table] ?? [],error:null });
        return {
          upsert: async () => { upserts += 1; return { data:null,error:null,status:200 }; },
          select: () => ({
            range,
            order: () => ({ range }),
          }),
        };
      },
      functions:{ invoke:async () => ({ data:null,error:null }) },
    };
    const result = await runSync(client as never,USER);
    expect(result).toMatchObject({ canonicalApplied:true,pushed:0,failed:0,pulled:1 });
    expect(upserts).toBe(0);
  });
});
