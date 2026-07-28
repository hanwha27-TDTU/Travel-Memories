// bytesReconcileRun.test.ts — **대조가 실제로 도는가.** (주기 판정은 `bytesReconcile.test.ts`)
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 이 층이 따로 필요한가
// ─────────────────────────────────────────────────────────────────────────────
// `reconcileDue`는 **언제** 재는지만 잰다. 그런데 M-0048의 실제 위험은 **무엇을 하는가**에
// 있다 — 서버 목록과 로컬 바이트를 맞춰 보고 *올릴 것만* 골라내는가.
//
// 이건 §2-E가 말하는 **이음매**다: 부품(`r2ListObjects`·`localBytesIds`·`requeueMissingBytes`)은
// 각자 유닛이 있지만, 그 셋을 **올바른 순서와 경계로 부르는지**는 부품 유닛이 원리적으로
// 못 본다. M-0033이 정확히 그 자리에서 났다.
//
// 🔴 여기서 잡는 실제 위험 넷:
//   ① 서버에 있는 것까지 다시 올린다 → 멀쩡한 파일을 재업로드해 **요금만 쓴다**
//   ② 목록이 잘렸는데 「없다」로 단정한다 → 뒤쪽 페이지에 있는 파일을 다시 올린다
//   ③ 서버 함수가 소리 목록을 안 주는데 **빈 집합**으로 읽는다 → 소리를 전부 다시 올린다
//   ④ 지우는 방향으로 손을 댄다 → **자동으로 자료를 버린다**(비타협 원칙 #1)

import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';

// `reconcileMissingBytes`는 `r2ListObjects`를 직접 부른다(포트 주입이 아니다). 그 한 함수만
// 갈아 끼우고 **나머지는 진짜**를 쓴다 — 통째로 가짜를 만들면 이음매가 아니라 내 모형을 재게 된다.
const listing = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../../src/services/r2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/r2')>()),
  r2ListObjects: async () => listing.value,
}));

import { db } from '../../src/offline/db';
import { reconcileMissingBytes } from '../../src/services/sync';
import { addAudioToMoment } from '../../src/services/audio';

const TRIP = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70';
const MOMENT = '22222222-2222-4222-8222-222222222222';
const client = {} as never;

/** 실제로 디코드되는 바이트를 준다 — 0바이트 더미면 `localBytesIds`가 「사본 없음」으로 본다. */
const blob = (): Blob => new Blob([new Uint8Array(64)], { type: 'audio/webm' });

/** 이 기기에 소리 한 건을 만든다(진짜 서비스 경로로 — 손으로 행을 넣으면 계약을 건너뛴다). */
async function makeAudio(): Promise<string> {
  const a = await addAudioToMoment({ momentId: MOMENT, tripId: TRIP }, blob(), 3, 'audio/webm');
  return a.id;
}

/** 큐에 「다시 올리기」가 걸렸는지 — 그게 이 함수의 유일한 산출물이다. */
async function queuedIds(): Promise<string[]> {
  const q = await db().syncQueue.toArray();
  return q.filter((o) => o.entityType === 'audio').map((o) => o.entityId);
}

/** 착지 키 기억을 심는다 — 「이미 올렸다」 상태를 만드는 유일한 근거다. */
async function markUploaded(id: string): Promise<void> {
  const cur = await db().localAudio.get(id);
  await db().localAudio.put({ ...cur!, storagePath: `u/trip/${id}.webm` });
}

beforeEach(async () => {
  for (const t of [db().localAudio, db().localMedia, db().syncQueue]) await t.clear();
  listing.value = { ids: [], audioIds: [], foreign: 0, truncated: false, outside: 0, outsideKnown: true, bytes: 0, multipart: { mine: 0, outside: 0, known: true }, version: 6 };
});

describe('바이트 대조가 실제로 도는가 (M-0048 · 이음매)', () => {
  it('🔴 로컬에 있는데 서버에 없으면 **다시 올리기 큐에 넣는다**', async () => {
    const id = await makeAudio();
    await markUploaded(id);
    await db().syncQueue.clear(); // 생성 op은 치우고 **대조가 만든 것만** 본다

    const r = await reconcileMissingBytes(client);

    expect(r.requeued.audio).toBe(1);
    expect(await queuedIds()).toEqual([id]);
    // 자료는 그대로다 — 잊는 것은 *키의 기억*이지 녹음이 아니다.
    expect((await db().localAudio.get(id))?.blob?.size).toBeGreaterThan(0);
    expect((await db().localAudio.get(id))?.storagePath).toBeUndefined();
  });

  it('🔴 서버에 이미 있으면 **건드리지 않는다**(멀쩡한 파일을 다시 올려 요금 쓰지 않는다)', async () => {
    const id = await makeAudio();
    await markUploaded(id);
    await db().syncQueue.clear();
    listing.value = { ...(listing.value as object), audioIds: [id] };

    const r = await reconcileMissingBytes(client);

    expect(r.requeued.audio).toBeUndefined();
    expect(await queuedIds()).toEqual([]);
    expect((await db().localAudio.get(id))?.storagePath).toBeTruthy(); // 기억을 안 지웠다
  });

  it('🔴 목록이 잘렸으면 **아무것도 하지 않는다**(뒤쪽 페이지에 있을 수 있다)', async () => {
    const id = await makeAudio();
    await markUploaded(id);
    await db().syncQueue.clear();
    listing.value = { ...(listing.value as object), truncated: true };

    const r = await reconcileMissingBytes(client);

    expect(await queuedIds()).toEqual([]);
    expect(r.note).toContain('잘려서');
  });

  it('🔴 서버 함수가 소리 목록을 안 주면 **확인 불가**다 — 빈 집합으로 읽지 않는다', async () => {
    // 이걸 틀리면 소리 전부가 「서버에 없음」이 되어 통째로 재업로드된다.
    const id = await makeAudio();
    await markUploaded(id);
    await db().syncQueue.clear();
    listing.value = { ...(listing.value as object), audioIds: undefined };

    const r = await reconcileMissingBytes(client);

    expect(await queuedIds()).toEqual([]);
    expect(r.note).toContain('audio');
  });

  it('목록 조회가 실패하면 조용히 넘기지 않고 사유를 돌려준다', async () => {
    listing.value = { ...(listing.value as object), error: '함수가 응답하지 않아요' };
    const r = await reconcileMissingBytes(client);
    expect(r.note).toBe('함수가 응답하지 않아요');
    expect(r.requeued).toEqual({});
  });

  it('🔴 반대 방향(서버에만 있는 파일)은 **손대지 않는다** — 자동으로 자료를 버리지 않는다', async () => {
    // 기록 없는 파일을 치우는 것은 사람이 정할 일이다(비타협 원칙 #1·#5). 진단이 보여 준다.
    listing.value = { ...(listing.value as object), audioIds: ['9f9f9f9f-1111-4111-8111-111111111111'] };
    const r = await reconcileMissingBytes(client);
    expect(r.requeued).toEqual({});
    expect(await queuedIds()).toEqual([]);
  });

  it('로컬에 사본이 없으면 올릴 것이 없다(이 경로로는 고칠 수 없는 상태)', async () => {
    const id = await makeAudio();
    await db().localAudio.update(id, { blob: new Blob([]) });
    await db().syncQueue.clear();
    const r = await reconcileMissingBytes(client);
    expect(r.requeued.audio).toBeUndefined();
  });
});
