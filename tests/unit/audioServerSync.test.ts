// tests/unit/audioServerSync.test.ts — **소리가 실제로 서버를 왕복하는가.**
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 이 층이 필요한가
// ─────────────────────────────────────────────────────────────────────────────
// 정적 게이트는 "op를 넣는 코드가 있다"까지만 본다(§10 ①). **바이트를 언제 올리고 언제
// 안 올리는지, tombstone이 로컬 blob을 지키는지, 빈 클라우드가 로컬을 덮지 않는지**는
// 실제로 돌려봐야 안다. 그리고 이것들은 전부 **기억 손실**로 끝나는 갈래다.
//
// M-0033의 교훈이 이 파일의 존재 이유다: *새로 만든 것은 형제의 규율을 물려받지 않는다.*
// 그래서 사진(`pushPendingMedia`/`pullMedia`)이 이미 지키는 계약을 **소리에 대해 다시 잰다.**
//
// 🔴 여기서 잡는 실제 위험 셋:
//   ① tombstone을 밀 때 바이트를 지우면 → 휴지통에 있는 동안 파일이 없어 **복원이 반쪽**이 된다
//      (사진에서 2026-07-26에 정확히 그 사고가 났고, 정책을 바꿔 영구삭제 때만 지우게 했다).
//   ② pull의 tombstone이 로컬 blob을 파괴하면 → 되살렸을 때 소리가 안 난다(비파괴 불변식 #8).
//   ③ 백필이 없으면 v1.20 이전 녹음은 **영원히** 로컬에만 남는다 — 앱은 조용하다(M-0023 형태).

import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { db, type LocalAudio } from '../../src/offline/db';
import {
  pushPendingAudio,
  pullAudio,
  backfillAudioOps,
  requeueMissingBytes,
  type AudioRemote,
} from '../../src/services/sync';
import { addAudioToMoment, softDeleteAudio } from '../../src/services/audio';
import { toAudioRow, type AudioRow } from '../../src/domain/audio/rowmap';

const USER = 'c9ff5188-51a7-4c01-b653-b6e1d73d0790';
const TRIP = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70';
const MOMENT = '22222222-2222-4222-8222-222222222222';

/** 서버 흉내 — 표(rows)와 저장소(objects)를 따로 들고 있어야 "행은 갔는데 파일이 안 갔다"를 잰다. */
function fakeRemote(opts: { downloadFails?: boolean } = {}): AudioRemote & {
  rows: Map<string, AudioRow>;
  objects: Map<string, Blob>;
  uploads: string[];
  removed: string[];
} {
  const rows = new Map<string, AudioRow>();
  const objects = new Map<string, Blob>();
  const uploads: string[] = [];
  const removed: string[] = [];
  return {
    rows,
    objects,
    uploads,
    removed,
    upsert: (row) => {
      rows.set(row.id, row);
      return Promise.resolve({});
    },
    getById: (id) => Promise.resolve({ data: rows.get(id) ?? null }),
    listAll: () => Promise.resolve({ data: [...rows.values()] }),
    upload: (path, blob) => {
      uploads.push(path);
      objects.set(path, blob);
      return Promise.resolve({});
    },
    download: (path) =>
      Promise.resolve(
        opts.downloadFails ? { data: null, error: '내려받기 실패' } : { data: objects.get(path) ?? null },
      ),
    remove: (path) => {
      removed.push(path);
      objects.delete(path);
      return Promise.resolve({});
    },
  };
}

async function seedTrip(): Promise<void> {
  const now = new Date().toISOString();
  await db().localTrips.add({
    id: TRIP,
    title: '제주여행',
    startDate: '',
    endDate: '',
    status: 'active',
    version: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
}

const rec = (): Promise<LocalAudio> =>
  addAudioToMoment({ momentId: MOMENT, tripId: TRIP }, new Blob([new Uint8Array(512)], { type: 'audio/webm' }), 5, 'audio/webm');

beforeEach(async () => {
  const d = db();
  await Promise.all([d.localTrips.clear(), d.localAudio.clear(), d.syncQueue.clear(), d.purgedIds.clear()]);
  await seedTrip();
});

describe('① push — 바이트와 메타가 함께 간다', () => {
  it('활성 녹음은 바이트를 올리고 행을 만들고 **op을 지운다**', async () => {
    const a = await rec();
    const remote = fakeRemote();
    const r = await pushPendingAudio(remote, USER);

    expect(r).toEqual({ pushed: 1, failed: 0 });
    expect(remote.uploads).toHaveLength(1);
    expect(remote.rows.get(a.id)!.storage_path).toBe(remote.uploads[0]);
    expect(await db().syncQueue.count()).toBe(0);
  });

  it('🔴 착지한 키를 로컬에 **같은 커밋에서** 기억한다(다시 계산하지 않는다)', async () => {
    const a = await rec();
    const remote = fakeRemote();
    await pushPendingAudio(remote, USER);
    const back = await db().localAudio.get(a.id);
    expect(back!.storagePath).toBe(remote.uploads[0]);
    // 제목이 바뀌어도 키가 안 움직인다 — 옛 파일이 고아로 남지 않는다.
    await db().localTrips.update(TRIP, { title: '완전히다른제목' });
    await softDeleteAudio(a.id);
    await pushPendingAudio(remote, USER);
    expect(remote.rows.get(a.id)!.storage_path).toBe(remote.uploads[0]);
  });

  it('🔴 이미 올라간 것을 tombstone으로 밀 때는 다시 올리지도 지우지도 않는다', async () => {
    const a = await rec();
    const remote = fakeRemote();
    await pushPendingAudio(remote, USER);
    const path = remote.uploads[0]!;

    await softDeleteAudio(a.id);
    await pushPendingAudio(remote, USER);

    expect(remote.uploads).toHaveLength(1); // 다시 올리지 않았다
    expect(remote.removed).toEqual([]); // 지우지도 않았다(영구삭제만이 지운다)
    expect(remote.objects.has(path)).toBe(true);
    expect(remote.rows.get(a.id)!.deleted_at).not.toBeNull();
  });

  // 🔴 M-0046 — 이 케이스가 없어서 실기기에서 났다. 백필이 **한 번도 올라간 적 없는** 옛
  //    tombstone을 밀었고, 업로드는 건너뛰면서 `storage_path`는 적었다. 파일이 없는데
  //    「여기 있다」고 주장하는 행이 생겼고, 진단은 그걸 「정리하세요」로 띄웠다.
  it('🔴 한 번도 안 올라간 tombstone은 **올린다** — 휴지통 자료도 서버에 있어야 복원된다(ADR-0029)', async () => {
    const a = await rec();
    await db().syncQueue.clear(); // 아직 한 번도 push되지 않은 상태를 만든다
    await softDeleteAudio(a.id); // 올라가기 전에 지웠다(오프라인 녹음 → 삭제, 또는 v1.20 이전 녹음)

    const remote = fakeRemote();
    const r = await pushPendingAudio(remote, USER);

    expect(r.pushed).toBe(1);
    expect(remote.uploads).toHaveLength(1); // tombstone이어도 바이트가 갔다
    const path = remote.rows.get(a.id)!.storage_path!;
    expect(remote.objects.get(path)!.size).toBe(512); // 그 경로에 실제로 파일이 있다
  });

  it('🔴 경로를 적었으면 그 자리에 파일이 있어야 한다 — 「있다」고만 하고 안 올리는 갈래가 없다', async () => {
    const a = await rec();
    await db().syncQueue.clear();
    await softDeleteAudio(a.id);
    const remote = fakeRemote();
    await pushPendingAudio(remote, USER);

    for (const row of remote.rows.values()) {
      if (row.storage_path) expect(remote.objects.has(row.storage_path), `${row.id} 경로에 파일 없음`).toBe(true);
    }
    expect(remote.rows.get(a.id)!.storage_path).toBeTruthy();
  });

  it('🔴 확장자를 모르는 형식은 올리지 않고 **op을 남긴다** — 조용히 성공으로 치지 않는다', async () => {
    const a = await rec();
    await db().localAudio.update(a.id, { mime: 'audio/exotic-codec' });
    const remote = fakeRemote();
    const r = await pushPendingAudio(remote, USER);

    expect(r.pushed).toBe(0);
    expect(r.failed).toBe(1);
    expect(remote.uploads).toEqual([]);
    expect(await db().syncQueue.count()).toBe(1); // 남아 있어야 진단이 말할 수 있다
  });

  it('로컬에 행이 없는 고아 op은 폐기한다(무한 재시도를 만들지 않는다)', async () => {
    const a = await rec();
    await db().localAudio.delete(a.id);
    const remote = fakeRemote();
    await pushPendingAudio(remote, USER);
    expect(await db().syncQueue.count()).toBe(0);
  });
});

describe('② pull — 비파괴 (불변식 #8)', () => {
  it('로컬에 없는 활성 소리를 바이트까지 받아 만든다', async () => {
    const a = await rec();
    const remote = fakeRemote();
    await pushPendingAudio(remote, USER);
    await db().localAudio.clear(); // 다른 기기인 척

    const r = await pullAudio(remote);
    expect(r.pulled).toBe(1);
    const got = await db().localAudio.get(a.id);
    expect(got!.blob.size).toBe(512);
    expect(got!.durationSec).toBe(5);
    expect(got!.storagePath).toBe(remote.uploads[0]);
  });

  it('🔴 서버 tombstone은 로컬 blob을 지우지 않는다 — 되살리면 소리가 나야 한다', async () => {
    const a = await rec();
    const remote = fakeRemote();
    await pushPendingAudio(remote, USER);
    // 다른 기기가 지운 상황을 만든다(서버 행만 tombstone).
    const row = remote.rows.get(a.id)!;
    remote.rows.set(a.id, { ...row, deleted_at: new Date().toISOString(), version: row.version + 1 });

    await pullAudio(remote);
    const got = await db().localAudio.get(a.id);
    expect(got!.deletedAt).not.toBeNull();
    expect(got!.blob.size).toBe(512); // 바이트는 그대로다
  });

  it('로컬에 없는 tombstone은 만들지 않는다(빈 껍데기를 만들지 않는다)', async () => {
    const a = await rec();
    const remote = fakeRemote();
    await pushPendingAudio(remote, USER);
    const row = remote.rows.get(a.id)!;
    remote.rows.set(a.id, { ...row, deleted_at: new Date().toISOString(), version: row.version + 1 });
    await db().localAudio.clear();

    await pullAudio(remote);
    expect(await db().localAudio.count()).toBe(0);
  });

  it('🔴 내려받기 실패는 로컬을 그대로 둔다 — 실패가 자료를 지우면 안 된다', async () => {
    const a = await rec();
    const ok = fakeRemote();
    await pushPendingAudio(ok, USER);

    const broken = fakeRemote({ downloadFails: true });
    broken.rows.set(a.id, ok.rows.get(a.id)!);
    await db().localAudio.clear();

    const r = await pullAudio(broken);
    expect(r.pulled).toBe(0);
    expect(await db().localAudio.count()).toBe(0); // 만들지도, 깨진 것을 넣지도 않는다
  });

  it('🔴 빈-클라우드 가드 — 서버가 비었다고 로컬을 지우지 않는다', async () => {
    await rec();
    await rec();
    const r = await pullAudio(fakeRemote()); // 서버에 행이 하나도 없다
    expect(r.skippedEmptyCloud).toBe(true);
    expect(await db().localAudio.count()).toBe(2);
  });

  it('영구삭제 표식이 있는 id는 되살리지 않는다', async () => {
    const a = await rec();
    const remote = fakeRemote();
    await pushPendingAudio(remote, USER);
    await db().localAudio.clear();
    await db().purgedIds.put({ id: a.id, entityType: 'audio', purgedAt: new Date().toISOString() });

    await pullAudio(remote);
    expect(await db().localAudio.count()).toBe(0);
  });

  it('같은 키의 바이트를 이미 갖고 있으면 다시 받지 않는다(egress 낭비 없이)', async () => {
    const a = await rec();
    const remote = fakeRemote();
    await pushPendingAudio(remote, USER);
    // 서버가 더 최신이 되게 version만 올린다(내용은 같다).
    const row = remote.rows.get(a.id)!;
    remote.rows.set(a.id, { ...row, version: row.version + 1, updated_at: new Date(Date.now() + 1000).toISOString() });

    let downloads = 0;
    const counting: AudioRemote = { ...remote, download: (p) => { downloads++; return remote.download(p); } };
    await pullAudio(counting);
    expect(downloads).toBe(0);
  });
});

describe('🔴 ③ 백필 — v1.20 이전 녹음을 데려온다 (§9 4단계)', () => {
  /** op 없이 로컬에만 존재하는 옛 행을 만든다(예전 `addAudioToMoment`가 만들던 모양). */
  async function legacyRow(id: string, deleted = false): Promise<void> {
    const now = new Date().toISOString();
    await db().localAudio.add({
      id,
      momentId: MOMENT,
      tripId: TRIP,
      blob: new Blob([new Uint8Array(64)], { type: 'audio/webm' }),
      mime: 'audio/webm',
      durationSec: 3,
      recordedAt: now,
      version: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: deleted ? now : null,
    });
  }

  it('큐 op가 없는 옛 녹음에 op을 만든다 — 없으면 영원히 안 올라간다', async () => {
    await legacyRow('11111111-1111-4111-8111-111111111111');
    expect(await backfillAudioOps()).toBe(1);
    const ops = await db().syncQueue.toArray();
    expect(ops[0]!.entityType).toBe('audio');
    expect(ops[0]!.operationType).toBe('insert');
  });

  it('tombstone된 옛 녹음도 데려온다 — 지운 사실도 서버가 알아야 한다', async () => {
    await legacyRow('11111111-1111-4111-8111-111111111112', true);
    await backfillAudioOps();
    expect((await db().syncQueue.toArray())[0]!.operationType).toBe('delete');
  });

  it('멱등 — 이미 op이 있으면 다시 넣지 않는다', async () => {
    await rec(); // 새 경로로 만든 것(이미 op이 있다)
    expect(await backfillAudioOps()).toBe(0);
    expect(await db().syncQueue.count()).toBe(1);
  });

  it('백필한 것이 그대로 push된다(백필 → 전송이 이어진다)', async () => {
    await legacyRow('11111111-1111-4111-8111-111111111113');
    await backfillAudioOps();
    const remote = fakeRemote();
    expect((await pushPendingAudio(remote, USER)).pushed).toBe(1);
    expect(remote.objects.size).toBe(1);
  });
});

describe('🔴 ④ 다시 올리기 — 서버에 없는 것을 이 기기가 고친다 (M-0046 복구 경로)', () => {
  it('경로 기억을 잊게 하고 op을 넣는다 → 다음 push가 바이트를 올린다', async () => {
    const a = await rec();
    const remote = fakeRemote();
    await pushPendingAudio(remote, USER);
    const path = remote.rows.get(a.id)!.storage_path!;
    // 서버에서 파일만 사라진 상태를 만든다(행은 경로를 적은 채 남아 있다).
    remote.objects.delete(path);
    await db().syncQueue.clear();

    expect(await requeueMissingBytes('audio', [a.id])).toBe(1);
    expect((await db().localAudio.get(a.id))!.storagePath).toBeUndefined();

    await pushPendingAudio(remote, USER);
    expect(remote.objects.has(remote.rows.get(a.id)!.storage_path!)).toBe(true);
  });

  it('🔴 자료를 건드리지 않는다 — 잊는 것은 *키의 기억*이지 녹음이 아니다', async () => {
    const a = await rec();
    const remote = fakeRemote();
    await pushPendingAudio(remote, USER);
    await requeueMissingBytes('audio', [a.id]);
    const back = await db().localAudio.get(a.id);
    expect(back!.blob.size).toBe(512);
    expect(back!.deletedAt).toBeNull();
  });

  it('로컬에 사본이 없으면 건너뛴다 — 이 경로로는 고칠 수 없는 상태다', async () => {
    expect(await requeueMissingBytes('audio', ['11111111-1111-4111-8111-111111111119'])).toBe(0);
    expect(await db().syncQueue.count()).toBe(0);
  });

  it('바이트가 없는 도메인에는 아무 일도 하지 않는다(등록부가 정한다)', async () => {
    const a = await rec();
    expect(await requeueMissingBytes('moment', [a.id])).toBe(0);
  });
});

describe('⑤ 행 모양 — 서버가 받는 것이 사실인가', () => {
  it('업로드한 바이트 수가 행의 bytes와 같다(대조가 거짓이 되지 않게)', async () => {
    const a = await rec();
    const remote = fakeRemote();
    await pushPendingAudio(remote, USER);
    const path = remote.rows.get(a.id)!.storage_path!;
    expect(remote.rows.get(a.id)!.bytes).toBe(remote.objects.get(path)!.size);
  });

  it('toAudioRow가 만드는 값과 서버에 실린 값이 같다(어댑터가 몰래 바꾸지 않는다)', async () => {
    const a = await rec();
    const remote = fakeRemote();
    await pushPendingAudio(remote, USER);
    const expected = toAudioRow(a, USER, remote.rows.get(a.id)!.storage_path);
    const got = remote.rows.get(a.id)!;
    expect(got.moment_id).toBe(expected.moment_id);
    expect(got.duration_sec).toBe(expected.duration_sec);
    expect(got.recorded_at).toBe(expected.recorded_at);
  });
});
