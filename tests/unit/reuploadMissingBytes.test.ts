// tests/unit/reuploadMissingBytes.test.ts — **[다시 올리기]가 정말로 올리는가.** (M-0059)
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 이 층이 필요한가 (2026-08-01 사용자 실기기)
// ─────────────────────────────────────────────────────────────────────────────
// 진단은 「서버에 없는 사진 3개」를 **정확히** 짚었고, 복구 버튼도 있었고, 누르면
// *"3건을 다시 올렸어요"* 라고 답했다. 그런데 재판정은 **영원히 3개**였다.
//
// 원인은 형제 차별이었다(§7). 두 push의 업로드 조건이 **손으로 따로 쓰여 있었고**:
//
//   소리: if (audio.deletedAt === null || !audio.storagePath)   ← 2026-07-28에 고침(M-0046)
//   사진: if (media.deletedAt === null)                          ← 안 고침
//
// 그래서 **휴지통 사진의 바이트는 어떤 경로로도 서버에 다시 올라가지 못했다** — 복구
// 버튼도, 자동 대조(`reconcileMissingBytes`)도. 업로드를 건너뛰고 **행만** 다시 쓴 뒤
// op을 지웠으니, 앱은 「보냈다」고 믿고 사용자에게도 그렇게 말했다(§8이 금지하는 거짓 완료).
//
// 🔴 여기서 잡는 실제 위험 넷:
//   ① 휴지통 자료가 조용히 안 올라간다 → 그 기기가 사라지면 **기억이 사라진다**(원칙 #1)
//   ② 「올렸다」고 말하고 안 올린다 → 사용자가 같은 화면을 보고 또 누른다(§12)
//   ③ 옛 키 형식 사진을 「올라간 적 없음」으로 오해해 다시 올린다 → **고아 사본**이 생긴다
//   ④ 표시를 걷지 않아 이미 올린 것을 매번 다시 올린다 → 요금이 조용히 샌다

import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '../../src/offline/db';
import { mustUploadBytes } from '../../src/sync/merge';
import { pushPendingMedia, requeueMissingBytes, backfillMediaGpsOps, type MediaRemote } from '../../src/services/sync';
import { toMediaRow, type MediaRow } from '../../src/domain/media/rowmap';

const USER = 'c9ff5188-51a7-4c01-b653-b6e1d73d0790';
const TRIP = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70';
const MOMENT = '22222222-2222-4222-8222-222222222222';

/** 표(rows)와 저장소(objects)를 **따로** 든다 — "행은 갔는데 파일이 안 갔다"를 재려면 필수다. */
function fakeRemote(): MediaRemote & { rows: Map<string, MediaRow>; uploads: string[]; removed: string[] } {
  const rows = new Map<string, MediaRow>();
  const objects = new Map<string, Blob>();
  const uploads: string[] = [];
  const removed: string[] = [];
  return {
    rows,
    uploads,
    removed,
    upsert: (row) => {
      rows.set(row.id, row);
      return Promise.resolve({});
    },
    getById: (id) => Promise.resolve({ data: rows.get(id) ?? null }),
    listAll: () => Promise.resolve({ data: [...rows.values()] }),
    uploadDisplay: (path, blob) => {
      uploads.push(path);
      objects.set(path, blob);
      return Promise.resolve({});
    },
    download: (path) => Promise.resolve({ data: objects.get(path) ?? null }),
    remove: (path) => {
      removed.push(path);
      objects.delete(path);
      return Promise.resolve({});
    },
  };
}

async function seedPhoto(over: Record<string, unknown> = {}): Promise<string> {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await db().localMedia.put({
    id,
    tripId: TRIP,
    momentId: MOMENT,
    mime: 'image/webp',
    width: 10,
    height: 10,
    originalBlob: new Blob(['o']),
    displayBlob: new Blob(['d']),
    thumbBlob: new Blob(['t']),
    takenAt: now,
    gpsLat: null,
    gpsLng: null,
    bytesOriginal: 1,
    bytesDisplay: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    version: 1,
    ...over,
  } as never);
  return id;
}

async function enqueue(id: string): Promise<void> {
  await db().syncQueue.add({
    operationId: crypto.randomUUID(),
    entityType: 'media',
    entityId: id,
    operationType: 'update',
    state: 'local_only',
    attempts: 0,
    createdAt: new Date().toISOString(),
  } as never);
}

beforeEach(async () => {
  const d = db();
  await Promise.all([d.localTrips.clear(), d.localMedia.clear(), d.localAudio.clear(), d.syncQueue.clear()]);
  await d.localTrips.put({
    id: TRIP, title: '제주여행', startDate: '', endDate: '', status: 'active',
    version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null,
  } as never);
});

// ── ① 판정 자체 (순수) ──────────────────────────────────────────────────────
describe('mustUploadBytes — 사진·소리가 지나는 하나의 문', () => {
  const DEL = '2026-08-01T00:00:00.000Z';

  it('살아 있는 자료는 언제나 올린다(두 형제 모두)', () => {
    expect(mustUploadBytes({ deletedAt: null }, false)).toBe(true);
    expect(mustUploadBytes({ deletedAt: null }, true)).toBe(true);
  });

  it('🔴 tombstone이어도 **서버에 없음이 확인**되면 올린다 — M-0059의 핵심', () => {
    expect(mustUploadBytes({ deletedAt: DEL, bytesMissing: true }, false)).toBe(true);
    expect(mustUploadBytes({ deletedAt: DEL, bytesMissing: true }, true)).toBe(true);
  });

  it('이미 올라간 tombstone은 다시 올리지 않는다(요금이 새지 않게)', () => {
    expect(mustUploadBytes({ deletedAt: DEL, storagePath: 'u/a.webp' }, false)).toBe(false);
    expect(mustUploadBytes({ deletedAt: DEL, storagePath: 'u/a.webp' }, true)).toBe(false);
  });

  it('🔴 경로 기억이 없을 때의 해석이 형제마다 다르고, 그 비대칭은 **인자로 드러나 있다**', () => {
    // 사진: 옛 키 형식 행은 경로를 기억하지 않으면서 바이트는 서버에 **있다** → 올리면 고아
    expect(mustUploadBytes({ deletedAt: DEL }, false)).toBe(false);
    // 소리: 키 형식이 하나뿐 → 「기억 없음 = 올라간 적 없음」이 성립
    expect(mustUploadBytes({ deletedAt: DEL }, true)).toBe(true);
  });
});

// ── ② 실제 push가 그 문을 지나는가 (이음매) ────────────────────────────────
describe('pushPendingMedia — 휴지통 사진의 바이트', () => {
  it('🔴 tombstone + 확인된 부재 → **바이트를 올린다**(옛 코드는 여기서 건너뛰었다)', async () => {
    const id = await seedPhoto({ deletedAt: '2026-08-01T00:00:00.000Z', version: 2, bytesMissing: true });
    await enqueue(id);
    const remote = fakeRemote();

    const r = await pushPendingMedia(remote, USER);

    expect(r).toEqual({ pushed: 1, failed: 0 });
    expect(remote.uploads).toHaveLength(1); // ← 옛 조건(`deletedAt === null`)이면 0이 된다
    expect(remote.rows.get(id)!.storage_path).toBe(remote.uploads[0]);
  });

  it('🔴 올린 뒤 표시를 **같은 커밋에서** 걷는다 — 매번 다시 올리지 않게', async () => {
    const id = await seedPhoto({ deletedAt: '2026-08-01T00:00:00.000Z', version: 2, bytesMissing: true });
    await enqueue(id);
    const remote = fakeRemote();
    await pushPendingMedia(remote, USER);

    const back = await db().localMedia.get(id);
    expect(back!.bytesMissing).toBeUndefined();
    expect(back!.storagePath).toBe(remote.uploads[0]);

    // 두 번째 push는 아무것도 올리지 않는다.
    await enqueue(id);
    await pushPendingMedia(remote, USER);
    expect(remote.uploads).toHaveLength(1);
  });

  it('표시가 없는 tombstone은 그대로 두 번 올리지 않는다(옛 키 형식 보호)', async () => {
    const id = await seedPhoto({ deletedAt: '2026-08-01T00:00:00.000Z', version: 2 });
    await enqueue(id);
    const remote = fakeRemote();
    await pushPendingMedia(remote, USER);
    expect(remote.uploads).toHaveLength(0);
  });
});

// ── ③ 복구 버튼이 표시를 남기는가 ──────────────────────────────────────────
describe('requeueMissingBytes — 잊는 것만으로는 부족하다', () => {
  it('🔴 경로를 잊고 **확인한 사실을 적는다**(둘 다 되읽어 확인)', async () => {
    const id = await seedPhoto({ deletedAt: '2026-08-01T00:00:00.000Z', version: 2, storagePath: 'u/old.webp' });

    const n = await requeueMissingBytes('media', [id]);

    expect(n).toBe(1);
    const back = await db().localMedia.get(id);
    expect(back!.storagePath).toBeUndefined();
    expect(back!.bytesMissing).toBe(true);
    expect(await db().syncQueue.count()).toBe(1);
  });

  it('🔴 버튼 → push 왕복이 **실제로 바이트를 서버에 놓는다**(사용자가 겪은 그 경로)', async () => {
    const id = await seedPhoto({ deletedAt: '2026-08-01T00:00:00.000Z', version: 2, storagePath: 'u/gone.webp' });
    const remote = fakeRemote();

    await requeueMissingBytes('media', [id]);
    await pushPendingMedia(remote, USER);

    expect(remote.uploads).toHaveLength(1);
    // 그리고 행이 가리키는 경로가 **실제로 올린 그 경로**다(행만 고치고 끝내지 않는다).
    expect(remote.rows.get(id)!.storage_path).toBe(remote.uploads[0]);
  });

  it('로컬에 사본이 없으면 조용히 건너뛴다(올릴 것이 없다)', async () => {
    expect(await requeueMissingBytes('media', [crypto.randomUUID()])).toBe(0);
  });
});

// ── ④ 사진 GPS 서버 동기화 (2026-08-01 · 마이그레이션 0024 · [user-decided]) ──
//
// 왜 이 파일에 두나: 같은 `fakeRemote`(표와 저장소를 따로 드는 것)가 **행은 갔는데 좌표가
// 안 갔다**를 재는 데도 그대로 필요하다. 그리고 두 변경 모두 같은 push를 지난다.
//
// 🔴 여기서 잡는 실제 위험 셋:
//   ① 좌표가 행에 안 실린다 → 다른 기기에서 **사진이 찍힌 자리를 영영 모른다**
//   ② 옛 서버 행(컬럼 없음)이 pull될 때 **로컬의 진짜 좌표를 null로 덮는다**(기억 손실)
//   ③ 백필이 없다 → 이미 있는 사진 수십 장은 **앞으로도 로컬에만** 남는다(M-0023의 근본형)
describe('사진 GPS — 모든 기기에서 보이게', () => {
  it('🔴 push가 좌표를 행에 실어 보낸다', async () => {
    const id = await seedPhoto({ gpsLat: 36.60916, gpsLng: 127.50248 });
    await enqueue(id);
    const remote = fakeRemote();

    await pushPendingMedia(remote, USER);

    expect(remote.rows.get(id)!.gps_lat).toBe(36.60916);
    expect(remote.rows.get(id)!.gps_lng).toBe(127.50248);
  });

  it('🔴 백필이 **좌표를 가진 사진만** 큐에 넣는다(왕복을 헛되이 늘리지 않게)', async () => {
    const withGps = await seedPhoto({ gpsLat: 36.60916, gpsLng: 127.50248, storagePath: 'u/a.webp' });
    await seedPhoto({ gpsLat: null, gpsLng: null }); // 좌표 없음 → 대상 아님
    await seedPhoto({ gpsLat: 0, gpsLng: 0 }); // 0,0은 좌표가 아니다(M-0057)
    await db().syncQueue.clear();

    const n = await backfillMediaGpsOps([], new Set());

    expect(n).toBe(1);
    const ops = await db().syncQueue.toArray();
    expect(ops.map((o) => o.entityId)).toEqual([withGps]);
  });

  it('서버에 같은 좌표가 확인된 활성 사진은 queue와 R2 재업로드가 0이다', async () => {
    const id = await seedPhoto({ gpsLat: 36.60916, gpsLng: 127.50248, storagePath: 'u/same.webp' });
    await db().syncQueue.clear();
    const local = (await db().localMedia.get(id))!;
    const serverRow = toMediaRow(local, USER, 'u/same.webp');
    expect(await backfillMediaGpsOps([serverRow], new Set())).toBe(0);
    const remote = fakeRemote();
    await pushPendingMedia(remote, USER);
    expect(remote.uploads).toEqual([]);
  });

  it('영구삭제 원장의 활성 로컬 사진은 GPS 백필로 재삽입하거나 업로드하지 않는다', async () => {
    const id = await seedPhoto({ gpsLat: 36.60916, gpsLng: 127.50248 });
    await db().syncQueue.clear();
    expect(await backfillMediaGpsOps([], new Set([id]))).toBe(0);
    const remote = fakeRemote();
    await pushPendingMedia(remote, USER);
    expect(remote.uploads).toEqual([]);
  });

  it('로컬 tombstone 사진은 GPS 백필로 queue나 R2 업로드를 되살리지 않는다', async () => {
    const deletedAt = new Date().toISOString();
    await seedPhoto({
      gpsLat: 36.60916,
      gpsLng: 127.50248,
      deletedAt,
      updatedAt: deletedAt,
      storagePath: 'u/deleted.webp',
    });
    await db().syncQueue.clear();

    expect(await backfillMediaGpsOps([], new Set())).toBe(0);
    expect(await db().syncQueue.count()).toBe(0);
    const remote = fakeRemote();
    await pushPendingMedia(remote, USER);
    expect(remote.uploads).toEqual([]);
  });

  // 🔴 **내 가정이 여기서 반증됐다**(2026-08-01). 처음엔 *"백필은 바이트를 다시 올리지
  // 않는다"*를 잠그려 했는데 **틀렸다** — 활성 사진은 push마다 표시본을 다시 올린다
  // (`mustUploadBytes(m, false)` → `deletedAt === null` → 항상 true).
  //
  // 그리고 그 동작은 **옳다**: 사진은 편집(재굽기)될 수 있고, 그때 표시본이 바뀐 것을
  // 서버에 반영하는 길이 이것뿐이다. "경로가 있으면 건너뛴다"로 바꾸면 **편집한 사진이
  // 서버에서 영영 옛 모습**으로 남는다. 통과시키려고 코드를 바꾸지 않고 계약을 사실대로 적는다.
  //
  // 🔴 같은 키 덮어쓰기는 DB OCC보다 먼저 실행되어 stale 기기가 최신 바이트를 망가뜨릴 수 있다.
  // 작업별 새 키에 올리고 DB read-back 성공 뒤 옛 키를 걷는다(M-0087).
  it('백필 재업로드도 작업별 새 키에 착지한 뒤 옛 키를 정리한다', async () => {
    const id = await seedPhoto({ gpsLat: 36.6, gpsLng: 127.5, storagePath: 'u/already.webp' });
    await db().syncQueue.clear();
    const remote = fakeRemote();

    const local = (await db().localMedia.get(id))!;
    const serverWithoutGps = {
      ...toMediaRow(local, USER, 'u/already.webp'),
      gps_lat: null,
      gps_lng: null,
    };
    await backfillMediaGpsOps([serverWithoutGps], new Set());
    await pushPendingMedia(remote, USER);

    expect(remote.uploads).toHaveLength(1);
    expect(remote.uploads[0]).not.toBe('u/already.webp');
    expect(remote.rows.get(id)!.storage_path).toBe(remote.uploads[0]);
    expect(remote.removed).toContain('u/already.webp');
    expect(remote.rows.get(id)!.gps_lat).toBe(36.6);
  });
});
