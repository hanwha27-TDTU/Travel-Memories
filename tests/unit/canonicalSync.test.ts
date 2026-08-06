// canonicalSync.test.ts — 일반 병합과 사용자 지정 최종본 교체가 섞이지 않는가.

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, type LocalMedia, type LocalTrip, type SyncQueueItem } from '../../src/offline/db';
import {
  canonicalRemote,
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

  it('앱 선배포 중 canonical RPC를 확인할 수 없으면 server read-only 문만 연다', async () => {
    await db().localTrips.put(localTrip());
    const remote = fakeRemote();
    remote.ensureMeta = async () => ({
      data:null,
      error:'Could not find the function journey.ensure_sync_meta without parameters in the schema cache',
      errorCode:'PGRST202',
    });

    await expect(ensureCanonicalBeforeSync(remote,USER)).resolves.toEqual({
      mode:'legacy',version:'legacy',pulled:0,
    });
    expect((await db().localTrips.get(LOCAL_ID))?.title).toBe('로컬 전용');
    expect(await db().syncState.get(`canonical:${USER}`)).toBeUndefined();
  });

  it('canonical 세대나 미완료 게시가 있으면 RPC 부재를 legacy로 낮추지 않는다', async () => {
    const remote = fakeRemote();
    remote.ensureMeta = async () => ({ data:null,error:'schema cache miss',errorCode:'PGRST202' });
    await db().syncState.put({
      id:`canonical:${USER}`,userId:USER,canonicalVersion:VERSION,updatedAt:'2026-08-02T00:00:00.000Z',
    });
    await expect(ensureCanonicalBeforeSync(remote,USER)).rejects.toThrow('legacy 모드로 낮출 수 없습니다');

    await db().syncState.put({
      id:`canonical:${USER}`,userId:USER,canonicalVersion:'legacy',updatedAt:'2026-08-02T00:00:00.000Z',
      pendingCanonical:{
        expectedVersion:'legacy',nextVersion:VERSION,operationId:'99999999-9999-4999-8999-999999999999',
        device:'test',stage:'publishing',createdAt:'2026-08-02T00:00:00.000Z',queuedOperationIds:[],
        stagedPaths:[],previousPaths:[],trips:[],places:[],moments:[],media:[],expenses:[],audio:[],purgedIds:[],
      },
    });
    await expect(ensureCanonicalBeforeSync(remote,USER)).rejects.toThrow('legacy 모드로 낮출 수 없습니다');
  });

  it('RPC 부재가 아닌 서버 오류는 일반 동기화로 반올림하지 않는다', async () => {
    const remote = fakeRemote();
    remote.ensureMeta = async () => ({ data:null,error:'권한 거부',errorCode:'42501' });
    await expect(ensureCanonicalBeforeSync(remote,USER)).rejects.toThrow('canonical 메타 조회 실패: 권한 거부');
  });

  it('RPC schema cache가 뒤처져도 sync_meta 직접 읽기로 non-legacy 세대를 확인한다', async () => {
    const client = {
      rpc:async () => ({ data:null,error:{ message:'schema cache miss',code:'PGRST202' } }),
      from:() => ({
        select:() => ({
          maybeSingle:async () => ({
            data:{
              canonical_version:VERSION,canonical_operation_id:null,canonical_device_id:'tablet',
              updated_at:'2026-08-03T00:00:00.000Z',
            },
            error:null,
          }),
        }),
      }),
      functions:{ invoke:async () => ({ data:null,error:null }) },
    };

    await expect(canonicalRemote(client as never).ensureMeta()).resolves.toEqual({
      data:{
        canonicalVersion:VERSION,canonicalOperationId:null,canonicalDeviceId:'tablet',
        updatedAt:'2026-08-03T00:00:00.000Z',
      },
    });
  });

  it('sync_meta 0행은 legacy로 추측하지 않고 capability 불명으로 남긴다', async () => {
    const client = {
      rpc:async () => ({ data:null,error:{ message:'schema cache miss',code:'PGRST202' } }),
      from:() => ({ select:() => ({ maybeSingle:async () => ({ data:null,error:null }) }) }),
      functions:{ invoke:async () => ({ data:null,error:null }) },
    };

    await expect(canonicalRemote(client as never).ensureMeta()).resolves.toEqual({
      data:null,error:'schema cache miss',errorCode:'PGRST202',
    });
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
      storage_path:`${USER}/trip/photo__66666666666646668666666666666666.webp`,gps_lat:null,gps_lng:null,sort_order:null,
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
      gpsLat:null,gpsLng:null,sortOrder:null,bytesOriginal:12,bytesDisplay:oldDisplay.size,
      storagePath:`${USER}/old.webp`,version:1,createdAt:'2026-08-01T00:00:00.000Z',
      updatedAt:'2026-08-01T00:00:00.000Z',deletedAt:null,
    });
    await db().syncState.put({ id:`canonical:${USER}`,userId:USER,canonicalVersion:'legacy',updatedAt:'2026-08-01T00:00:00.000Z' });
    const row: MediaRow = {
      id:mediaId,user_id:USER,moment_id:MOMENT_ID,trip_id:SERVER_ID,
      storage_path:`${USER}/new.webp`,gps_lat:null,gps_lng:null,sort_order:null,width:10,height:10,taken_at:null,
      bytes_display:12,source:'user',version:2,base_version:2,base_canonical_version:VERSION,
      created_at:'2026-08-01T00:00:00.000Z',updated_at:'2026-08-02T00:00:00.000Z',
      deleted_at:null,client_operation_id:null,
    };

    await ensureCanonicalBeforeSync(fakeRemote({ version:VERSION,media:[row] }),USER);
    const local = await db().localMedia.get(mediaId);
    expect(local?.originalBlob).toBeUndefined();
    expect(await local?.displayBlob.text()).toBe('server-bytes');
    expect(local?.storagePath).toBe(`${USER}/new.webp`);
  });

  // 🔴 M-0101(2026-08-05, 실사용자 계정) — 죽은 휴지통 사진 하나가 **새 기기 전체를 0건으로
  // 만들었다.** M-0100(첫 push 전 삭제)이 서버에 남긴 storage_path-없는-바이트 tombstone
  // 행이, 이 소비 경로(`materializeMedia`)에서는 활성/휴지통 구분 없이 다운로드 실패 시
  // 무조건 throw했다. 그 결과 `replaceLocalSnapshot` 전체가 시작도 못 하고, 완전히 새로
  // 로그인한 기기가 트립 8개짜리 계정에서 **0개**를 받았다 — "동기화됨"이라고 표시하면서.
  it('🔴 M-0101 — tombstone 사진의 바이트가 없어도 최종본 전체를 막지 않는다', async () => {
    const deadMediaId = '88888888-8888-4888-8888-888888888888';
    const deadMedia: MediaRow = {
      id: deadMediaId, user_id: USER, moment_id: MOMENT_ID, trip_id: SERVER_ID,
      storage_path: `${USER}/trip/dead__88888888888848888888888888888888.webp`, gps_lat: null, gps_lng: null, sort_order: null,
      width: 100, height: 100, taken_at: null, bytes_display: 10, source: 'user', version: 2, base_version: 2,
      base_canonical_version: VERSION, created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-02T00:00:00.000Z', deleted_at: '2026-08-02T00:00:00.000Z', client_operation_id: null,
    };

    await ensureCanonicalBeforeSync(
      fakeRemote({ version: VERSION, trips: [tripRow()], media: [deadMedia], downloadError: 'R2 GET 404' }),
      USER,
    );

    // 트립은 정상적으로 최종본에 반영됐다(옛 코드는 여기가 db().localTrips.count() === 0이었다).
    expect(await db().localTrips.get(SERVER_ID)).toBeDefined();
    const local = await db().localMedia.get(deadMediaId);
    expect(local).toBeDefined();
    expect(local?.bytesMissing).toBe(true);
    expect(local?.displayBlob.size).toBe(0);
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
      takenAt:'2026-08-01T00:00:00.000Z',gpsLat:null,gpsLng:null,sortOrder:null,
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

  it('RPC capability가 불명확하면 read-only pull로 server 쓰기·ledger·R2를 막는다', async () => {
    const purgedTripId = '88888888-8888-4888-8888-888888888888';
    const mediaId = '99999999-9999-4999-8999-999999999999';
    const unpurgeId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const pulledTripId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const opLessDeleteId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const now = '2026-08-03T00:00:00.000Z';
    const media: MediaRow = {
      id:mediaId,user_id:USER,moment_id:MOMENT_ID,trip_id:purgedTripId,
      storage_path:`${USER}/trip/photo__99999999999949998999999999999999.webp`,gps_lat:null,gps_lng:null,sort_order:null,
      width:100,height:100,taken_at:null,bytes_display:10,source:'user',version:2,base_version:1,
      base_canonical_version:VERSION,created_at:'2026-08-01T00:00:00.000Z',updated_at:now,
      deleted_at:null,client_operation_id:null,
    };
    await db().localTrips.put(localTrip(SERVER_ID,'기기에서 수정 중'));
    await db().localTrips.put({
      ...localTrip(opLessDeleteId, '서버 대조 전 로컬 삭제'),
      version: 4,
      updatedAt: now,
      deletedAt: now,
    });
    await db().purgedIds.put({ id:purgedTripId,entityType:'trip',purgedAt:now });
    await db().syncQueue.bulkAdd([
      {
        operationId:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',entityType:'trip',entityId:SERVER_ID,
        operationType:'update',state:'local_only',attempts:0,createdAt:now,
      },
      {
        operationId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',entityType:'purge:trip',entityId:purgedTripId,
        operationType:'purge',state:'local_only',attempts:0,createdAt:now,
      },
      {
        operationId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',entityType:'unpurge',entityId:unpurgeId,
        operationType:'unpurge',state:'local_only',attempts:0,createdAt:now,
      },
    ]);

    const mutations = { upsert:0,delete:0,rpc:0,r2:0 };
    const rows: Record<string, unknown[]> = {
      trips:[
        tripRow(),
        tripRow(pulledTripId,'서버에서 새로 받은 여행'),
        tripRow(opLessDeleteId,'서버에는 아직 활성'),
      ],
      // read-only 분기에 ledgerAll/applyPurgedLedger가 다시 연결되면 SERVER_ID 로컬 행을
      // 지우게 만드는 적대값. 현재 경로는 이 표를 읽지도, 로컬에 적용하지도 않아야 한다.
      places:[],moments:[],media:[media],expenses:[],audio:[],purged_ids:[{ id:SERVER_ID }],
    };
    const client = {
      async rpc(name: string) {
        if (name === 'ensure_sync_meta') {
          return {
            data:null,
            error:{
              message:'Could not find the function journey.ensure_sync_meta without parameters in the schema cache',
              code:'PGRST202',
            },
          };
        }
        mutations.rpc += 1;
        return { data:0,error:null };
      },
      from(table: string) {
        const result = table === 'sync_meta'
          ? { data:null,error:{ message:'schema cache miss',code:'PGRST205' },status:404 }
          : { data:rows[table] ?? [],error:null,status:200 };
        let query: unknown;
        const target = {
          then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
            return Promise.resolve(result).then(resolve,reject);
          },
        };
        query = new Proxy(target, {
          get(obj, prop) {
            if (prop === 'then') return obj.then.bind(obj);
            return (..._args: unknown[]) => {
              if (prop === 'upsert') mutations.upsert += 1;
              if (prop === 'delete') mutations.delete += 1;
              return query;
            };
          },
        });
        return query;
      },
      functions:{
        invoke:async () => {
          mutations.r2 += 1;
          return { data:null,error:null };
        },
      },
    };

    const result = await runSync(client as never,USER);

    expect(result).toMatchObject({ canonicalApplied:false,pushed:0,failed:0,pulled:1 });
    expect(mutations).toEqual({ upsert:0,delete:0,rpc:0,r2:0 });
    expect(await db().syncQueue.count()).toBe(3);
    expect((await db().syncQueue.where('entityId').equals(opLessDeleteId).count())).toBe(0);
    expect((await db().localTrips.get(opLessDeleteId))?.deletedAt).toBe(now);
    expect((await db().localTrips.get(SERVER_ID))?.title).toBe('기기에서 수정 중');
    expect((await db().localTrips.get(pulledTripId))?.title).toBe('서버에서 새로 받은 여행');
    expect(await db().purgedIds.get(purgedTripId)).toBeDefined();
    expect(await db().localMedia.get(mediaId)).toBeUndefined();
  });

  it('pull에서 발견한 op 없는 삭제를 같은 runSync의 안전한 후행 push로 끝낸다', async () => {
    const id = 'abababab-abab-4bab-8bab-abababababab';
    const now = '2026-08-03T00:00:00.000Z';
    await db().localTrips.put({
      ...localTrip(id, '로컬에서 지운 여행'),
      version: 4,
      baseVersion: 3,
      updatedAt: now,
      deletedAt: now,
    });
    let serverTrip = tripRow(id, '서버에는 아직 활성');
    const rowsOf = (table: string): unknown[] => table === 'trips' ? [serverTrip] : [];
    const client = {
      rpc: async () => ({
        data: {
          canonical_version: 'legacy',
          canonical_operation_id: null,
          canonical_device_id: null,
          updated_at: now,
        },
        error: null,
      }),
      from(table: string) {
        let selectedId: string | null = null;
        const query: Record<string, unknown> = {
          select: () => query,
          order: () => query,
          eq: (_column: string, value: string) => { selectedId = value; return query; },
          range: async () => ({ data: rowsOf(table), error: null, status: 200 }),
          maybeSingle: async () => ({
            data: rowsOf(table).find((row) => (row as { id?: string }).id === selectedId) ?? null,
            error: null,
            status: 200,
          }),
          upsert: async (row: TripRow) => {
            if (table === 'trips') serverTrip = { ...row, version: row.version, updated_at: row.updated_at };
            return { data: null, error: null, status: 200 };
          },
        };
        return query;
      },
      functions: { invoke: async () => ({ data: null, error: null }) },
    };

    const result = await runSync(client as never, USER);

    expect(result).toMatchObject({ pushed: 1, failed: 0, canonicalApplied: false });
    expect(serverTrip.deleted_at).toBe(now);
    expect(await db().syncQueue.count()).toBe(0);
  });
});
