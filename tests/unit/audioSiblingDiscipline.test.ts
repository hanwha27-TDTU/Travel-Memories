// tests/unit/audioSiblingDiscipline.test.ts — **소리가 형제의 규율을 실제로 받는가.**
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 이 파일이 따로 있나 (2026-07-27)
// ─────────────────────────────────────────────────────────────────────────────
// 오디오는 기능으로는 완성돼 있었다 — 녹음되고, 재생되고, 백업에 담기고, 왕복 검사도 통과했다.
// 그런데 **형제들이 이미 지키고 있던 계약 다섯 개를 하나도 안 받은 채** 태어났다:
//
//   ① 부모(순간·여행)를 지워도 소리만 활성으로 남았다        → cascade
//   ② 개별로 지운 소리는 휴지통 어디에도 안 보였다(복구 소멸) → 휴지통·복원
//   ③ 여행을 영구삭제해도 blob이 IndexedDB에 영원히 남았다   → 영구삭제
//   ④ 저장 용량 화면의 「합계」가 소리만큼 작게 나왔다        → 용량 집계
//   ⑤ 무결성 점검이 소리를 안 보고 「0건」이라 말했다         → 무결성
//
// M-0033과 **같은 근본형**이다: *새로 만든 것은 형제의 규율을 물려받지 않는다.* 그때는 op
// 하나였고 이번엔 도메인 하나였을 뿐이다. 그리고 다섯 곳이 **동시에** 빈 이유는 하나다 —
// `check-domain-symmetry`가 `LocalFirst` 접미사에 기대고 있어서 **소리를 검사 대상으로조차
// 보지 않았다.** 게이트를 넓혔고(행동 기준), 그 위에 이 실행 검사를 둔다.
//
// 정적 게이트는 "op를 넣는 코드가 있다"까지만 본다(§10 ①). **자식 종류를 빠짐없이 쓸어담는지,
// 되살릴 때 정확히 그것만 돌아오는지**는 실제로 돌려봐야 안다 — 여기가 그 층이다.
//
// 🔴 2026-07-27에 마지막 비대칭도 사라졌다: 소리도 **서버로 간다**(마이그레이션 0019).
//    그래서 이 파일의 전제를 뒤집었다 — 예전엔 "소리엔 큐 op가 없다"를 **정상으로 못박고**
//    있었고, 그 케이스를 그대로 두면 서버 동기화를 붙여도 게이트가 GREEN인 채로 남는다.
//    전제가 바뀌면 **케이스를 먼저 뒤집는다**(§11 ② — 통과시키려고 로직을 되돌리지 마라).

import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '../../src/offline/db';
import { createTripLocalFirst, softDeleteTripLocalFirst, restoreTripLocalFirst, purgeTripPermanently } from '../../src/services/trips';
import { softDeleteMomentLocalFirst, restoreMomentLocalFirst } from '../../src/services/moments';
import { listTrashedChildren, restoreTrashedChild, purgeChildPermanently, CHILD_DOMAINS, CHILD_LABEL } from '../../src/services/trash';
import { softDeleteAudio } from '../../src/services/audio';
import { computeStorageUsage } from '../../src/services/storage';
import { checkIntegrity } from '../../src/domain/integrity';
import { loadIntegritySnapshot } from '../../src/services/diagnostics';

interface Seed {
  tripId: string;
  momentId: string;
  audioId: string;
}

/** 여행 + 순간 + 소리 한 벌. 소리는 서비스를 우회해 직접 넣는다(마이크·권한 불필요). */
async function seed(bytes = 40): Promise<Seed> {
  const trip = await createTripLocalFirst({ title: '소리 여행' });
  const now = new Date().toISOString();
  const momentId = crypto.randomUUID();
  const audioId = crypto.randomUUID();
  const d = db();
  await d.localMoments.put({
    id: momentId, tripId: trip.id, note: '순간', occurredAt: now, placeName: null, lat: null, lng: null,
    mood: null, createdAt: now, updatedAt: now, deletedAt: null, version: 1, baseVersion: 0, clientOperationId: null,
  } as never);
  await d.localAudio.put({
    id: audioId, momentId, tripId: trip.id, blob: new Blob([new Uint8Array(bytes)]),
    mime: 'audio/webm;codecs=opus', durationSec: 12, recordedAt: now,
    createdAt: now, updatedAt: now, deletedAt: null, version: 1,
  });
  await d.syncQueue.clear();
  return { tripId: trip.id, momentId, audioId };
}

const audioRow = (id: string) => db().localAudio.get(id);

beforeEach(async () => {
  const d = db();
  await Promise.all([
    d.localTrips.clear(), d.localMoments.clear(), d.localMedia.clear(),
    d.localExpenses.clear(), d.localAudio.clear(), d.syncQueue.clear(), d.purgedIds.clear(),
  ]);
});

describe('① cascade — 부모가 사라지면 소리도 함께 사라진다', () => {
  it('🔴 순간을 지우면 그 순간의 소리도 tombstone된다', async () => {
    const { momentId, audioId } = await seed();
    await softDeleteMomentLocalFirst(momentId);
    expect((await audioRow(audioId))!.deletedAt).not.toBeNull();
  });

  it('순간 삭제가 지운 소리 id를 **돌려준다**(실행취소가 정확히 그것만 되살리도록)', async () => {
    const { momentId, audioId } = await seed();
    const r = await softDeleteMomentLocalFirst(momentId);
    expect(r.audioIds).toEqual([audioId]);
  });

  it('순간 되살리기는 소리도 되살린다 — 되살릴 수 없는 삭제는 계약 위반이다', async () => {
    const { momentId, audioId } = await seed();
    const r = await softDeleteMomentLocalFirst(momentId);
    await restoreMomentLocalFirst(momentId, r);
    expect((await audioRow(audioId))!.deletedAt).toBeNull();
  });

  it('🔴 여행을 지우면 그 여행의 소리도 tombstone된다', async () => {
    const { tripId, audioId } = await seed();
    await softDeleteTripLocalFirst(tripId);
    expect((await audioRow(audioId))!.deletedAt).not.toBeNull();
  });

  it('여행 삭제 묶음에 audioIds가 담긴다(누락이 컴파일 오류가 되는 그 필드)', async () => {
    const { tripId, audioId } = await seed();
    const children = await softDeleteTripLocalFirst(tripId);
    expect(children.audioIds).toEqual([audioId]);
  });

  it('여행 되살리기는 소리도 되살린다', async () => {
    const { tripId, audioId } = await seed();
    const children = await softDeleteTripLocalFirst(tripId);
    await restoreTripLocalFirst(tripId, children);
    expect((await audioRow(audioId))!.deletedAt).toBeNull();
  });

  // 🔴 **뒤집힌 케이스**(2026-07-27). 예전 이 자리는 *"소리는 큐 op를 만들지 않는다"*를
  //    정상으로 못박고 있었다 — 그 전제가 사라진 지금 그대로 두면, 서버 전파를 빠뜨려도
  //    검사가 GREEN으로 통과한다(§11 ② — 전제가 바뀌면 케이스를 먼저 뒤집는다).
  it('🔴 여행 cascade가 소리 op도 만든다 — 안 만들면 서버 행이 활성으로 남는다(M-0006과 같은 형태)', async () => {
    const { tripId, audioId } = await seed();
    await softDeleteTripLocalFirst(tripId);
    const ops = await db().syncQueue.toArray();
    const audioOps = ops.filter((q) => q.entityType === 'audio');
    expect(audioOps.map((q) => q.entityId)).toContain(audioId);
    expect(audioOps[0]!.operationType).toBe('delete');
    expect(new Set(ops.map((q) => q.entityType)).has('trip')).toBe(true);
  });

  it('🔴 여행 복원도 소리 op를 만든다 — 없으면 서버 tombstone이 다음 pull에서 되지운다', async () => {
    const { tripId, audioId } = await seed();
    const children = await softDeleteTripLocalFirst(tripId);
    await db().syncQueue.clear();
    await restoreTripLocalFirst(tripId, children);
    const audioOps = (await db().syncQueue.toArray()).filter((q) => q.entityType === 'audio');
    expect(audioOps.map((q) => q.entityId)).toContain(audioId);
    expect(audioOps[0]!.operationType).toBe('update');
  });

  it('🔴 순간 cascade도 소리 op를 만든다(여행과 같은 규율 — 형제 위치를 함께 본다)', async () => {
    const { momentId, audioId } = await seed();
    await db().syncQueue.clear();
    await softDeleteMomentLocalFirst(momentId);
    const audioOps = (await db().syncQueue.toArray()).filter((q) => q.entityType === 'audio');
    expect(audioOps.map((q) => q.entityId)).toContain(audioId);
  });
});

describe('② 휴지통 — 개별로 지운 소리에 손이 닿는다', () => {
  it('🔴 혼자 지워진 소리가 휴지통에 보인다(안 보이면 복구 경로가 없다 — F5 재발)', async () => {
    const { audioId } = await seed();
    await softDeleteAudio(audioId);
    const rows = await listTrashedChildren();
    expect(rows.map((r) => r.id)).toContain(audioId);
    expect(rows.find((r) => r.id === audioId)!.domain).toBe('audio');
  });

  it('부모 여행이 함께 지워졌으면 **안** 보인다(여행 휴지통이 이미 보여준다)', async () => {
    const { tripId, audioId } = await seed();
    await softDeleteTripLocalFirst(tripId);
    expect((await listTrashedChildren()).map((r) => r.id)).not.toContain(audioId);
  });

  it('휴지통 줄이 사람 말로 읽힌다 — 날짜·길이(사진과 같은 어휘)', async () => {
    const { audioId } = await seed();
    await softDeleteAudio(audioId);
    const row = (await listTrashedChildren()).find((r) => r.id === audioId)!;
    expect(row.label).toMatch(/\d{4}/); // 연도
    expect(row.label).toContain('녹음');
    expect(row.label).toContain('0:12'); // 화면 칩과 같은 길이 표기
  });

  it('휴지통에서 되살리면 활성으로 돌아온다', async () => {
    const { audioId } = await seed();
    await softDeleteAudio(audioId);
    await restoreTrashedChild('audio', audioId);
    expect((await audioRow(audioId))!.deletedAt).toBeNull();
  });

  it('순간을 휴지통에서 되살리면 딸린 소리도 함께 돌아온다', async () => {
    const { momentId, audioId } = await seed();
    await softDeleteMomentLocalFirst(momentId);
    await restoreTrashedChild('moment', momentId);
    expect((await audioRow(audioId))!.deletedAt).toBeNull();
  });

  it('🔴 도메인 목록·이름표에 소리가 든다 — 형제를 빠뜨리면 화면에서 사라진다', () => {
    expect(CHILD_DOMAINS).toContain('audio');
    expect(CHILD_LABEL.audio).toBe('소리');
  });
});

describe('③ 영구삭제 — 바이트가 실제로 사라진다', () => {
  it('🔴 여행을 영구삭제하면 소리 행이 남지 않는다(예전엔 영원히 고아로 남았다)', async () => {
    const { tripId, audioId } = await seed();
    await softDeleteTripLocalFirst(tripId);
    await db().syncQueue.clear(); // 사전조건(대기 op 없음)을 만든다
    await purgeTripPermanently(tripId);
    expect(await audioRow(audioId)).toBeUndefined();
  });

  it('소리 하나만 영구삭제해도 행이 사라진다', async () => {
    const { audioId } = await seed();
    await softDeleteAudio(audioId);
    await db().syncQueue.clear(); // 사전조건(대기 op 없음) — 형제와 **같은** 조건이다
    await purgeChildPermanently('audio', audioId);
    expect(await audioRow(audioId)).toBeUndefined();
  });

  it('🔴 서버에 못 보낸 변경이 있으면 영구삭제를 거부한다 — 사진·비용과 같은 사전조건', async () => {
    const { audioId } = await seed();
    await softDeleteAudio(audioId); // 삭제 op가 큐에 남는다
    await expect(purgeChildPermanently('audio', audioId)).rejects.toThrow(/서버에 반영되지 않은/);
  });

  it('삭제되지 않은 소리는 영구삭제를 **거부**한다(형제와 같은 사전조건)', async () => {
    const { audioId } = await seed();
    await expect(purgeChildPermanently('audio', audioId)).rejects.toThrow(/삭제되지 않은/);
  });

  it('🔴 표식과 전파 op를 남긴다 — 다른 기기에서도 사라져야 한다(예전엔 둘 다 없었다)', async () => {
    const { audioId } = await seed();
    await softDeleteAudio(audioId);
    await db().syncQueue.clear();
    await purgeChildPermanently('audio', audioId);
    // 표식: pull이 이 id를 건너뛴다(서버 tombstone을 다시 받아 휴지통에 되살아나지 않게).
    expect((await db().purgedIds.get(audioId))?.entityType).toBe('audio');
    // 전파: 없으면 이 기기에서만 지워지고 서버·R2엔 영영 남는다(M-0023).
    const ops = (await db().syncQueue.toArray()).filter((q) => q.entityId === audioId);
    expect(ops.map((q) => q.entityType)).toContain('purge:audio');
  });
});

describe('④ 저장 용량 — 앱이 아는 것을 화면에 말한다 (§12)', () => {
  it('🔴 소리 바이트가 집계된다(예전엔 어느 줄에도 안 들어가 합계가 작게 나왔다)', async () => {
    await seed(4096);
    const u = await computeStorageUsage();
    expect(u.audioBytes).toBe(4096);
    expect(u.audioCount).toBe(1);
  });

  it('소리 바이트를 텍스트로 잘못 세지 않는다(blob은 JSON에서 빠진다)', async () => {
    const big = await (async () => {
      await seed(200_000);
      return computeStorageUsage();
    })();
    expect(big.audioBytes).toBe(200_000);
    expect(big.textBytes).toBeLessThan(200_000); // blob이 텍스트에 섞였다면 여기서 터진다
  });

  it('소리가 없으면 0이다(없는 것을 지어내지 않는다)', async () => {
    await createTripLocalFirst({ title: '소리 없는 여행' });
    const u = await computeStorageUsage();
    expect(u.audioBytes).toBe(0);
    expect(u.audioCount).toBe(0);
  });

  it('tombstone된 소리도 센다 — 지웠어도 바이트는 아직 기기에 있다(정직성 §4)', async () => {
    const { audioId } = await seed(1000);
    await softDeleteAudio(audioId);
    expect((await computeStorageUsage()).audioBytes).toBe(1000);
  });
});

describe('⑤ 무결성 — 안 보는 것을 「0건」이라 말하지 않는다 (§8)', () => {
  it('🔴 부모 없는 소리를 잡는다(예전엔 이 상태가 있어도 침묵했다)', async () => {
    const { audioId } = await seed();
    await db().localMoments.clear(); // 부모 순간이 사라진 상태
    const codes = checkIntegrity(await loadIntegritySnapshot()).findings.map((f) => f.code);
    expect(codes).toContain('ORPHAN_PARENT');
    expect(audioId).toBeTruthy();
  });

  it('🔴 지운 순간에 살아남은 소리를 잡는다(cascade가 새는 자리)', async () => {
    const { momentId } = await seed();
    const d = db();
    const m = (await d.localMoments.get(momentId))!;
    // 옛 결함이 만들던 상태를 그대로 재현: 순간은 tombstone인데 소리만 활성이다.
    await d.localMoments.put({ ...m, deletedAt: new Date().toISOString() });
    const codes = checkIntegrity(await loadIntegritySnapshot()).findings.map((f) => f.code);
    expect(codes).toContain('ALIVE_UNDER_DELETED');
  });

  it('소리의 시각 표기도 본다(recordedAt이 옛 표기면 말한다)', async () => {
    const { audioId } = await seed();
    const d = db();
    const a = (await d.localAudio.get(audioId))!;
    await d.localAudio.put({ ...a, recordedAt: '2026-07-26T17:29:48.34+00:00' });
    const codes = checkIntegrity(await loadIntegritySnapshot()).findings.map((f) => f.code);
    expect(codes).toContain('BAD_TIME_FORMAT');
  });

  it('앞뒤가 맞으면 **침묵한다** — 겁주는 것은 거짓 경보만큼 나쁘다', async () => {
    await seed();
    const codes = checkIntegrity(await loadIntegritySnapshot()).findings.map((f) => f.code);
    expect(codes).not.toContain('ORPHAN_PARENT');
    expect(codes).not.toContain('ALIVE_UNDER_DELETED');
    expect(codes).not.toContain('BAD_TIME_FORMAT');
  });

  it('점검 대상 수에 소리가 포함된다(안 세면 안 본 것이다)', async () => {
    await seed();
    const before = checkIntegrity({ ...(await loadIntegritySnapshot()), audio: [] }).checked;
    const after = checkIntegrity(await loadIntegritySnapshot()).checked;
    expect(after).toBe(before + 1);
  });
});

// ⚠️ 2026-07-27에 **추가된 무리**. 위 ①이 서비스 계층은 잠갔는데, 화면이 그 서비스를
// **반쪽으로 부르고 있었다**: `const { deletedMediaIds } = await softDelete…` 로 사진만
// 꺼내 넘겼고, 선택적 매개변수의 기본값 `[]`가 나머지를 **조용히 삼켰다**(M-0007의 재발).
// 그래서 서비스 유닛은 전부 통과하는데 **실제 실행취소는 비용·소리를 안 되살렸다.**
//
// 교훈: 계약을 타입으로 잠갔으면 **호출부도 그 타입을 통과하게** 만들어야 한다. 여기서는
// `MomentChildren` 묶음이 그 일을 한다 — 삭제가 돌려주는 것과 복원이 받는 것이 같은 타입이라
// 손으로 고를 기회 자체가 없다. 아래 검사는 그 계약이 살아 있는지를 **행으로** 확인한다.
describe('⑥ 실행취소는 **딸린 것 전부**를 데려온다 (M-0007 재발 방지)', () => {
  it('🔴 순간 삭제→복원이 사진·비용·소리를 **한 번에** 되살린다', async () => {
    const { tripId, momentId, audioId } = await seed();
    const d = db();
    const now = new Date().toISOString();
    const expenseId = crypto.randomUUID();
    const mediaId = crypto.randomUUID();
    await d.localExpenses.put({
      id: expenseId, tripId, momentId, originalAmount: 1000, originalCurrency: 'KRW',
      note: '', occurredAt: now, createdAt: now, updatedAt: now, deletedAt: null, version: 1,
    } as never);
    await d.localMedia.put({
      id: mediaId, tripId, momentId, mime: 'image/webp', width: 4, height: 4,
      originalBlob: new Blob(['o']), displayBlob: new Blob(['d']), thumbBlob: new Blob(['t']),
      takenAt: now, createdAt: now, updatedAt: now, deletedAt: null, version: 1,
    } as never);

    const children = await softDeleteMomentLocalFirst(momentId);
    // 삭제는 셋 다 담아야 한다 — 여기서 빠지면 복원은 시작도 못 한다.
    expect(children.mediaIds).toEqual([mediaId]);
    expect(children.expenseIds).toEqual([expenseId]);
    expect(children.audioIds).toEqual([audioId]);

    await restoreMomentLocalFirst(momentId, children);
    expect((await d.localMedia.get(mediaId))!.deletedAt).toBeNull();
    expect((await d.localExpenses.get(expenseId))!.deletedAt).toBeNull(); // ← 옛 결함이 남기던 자리
    expect((await d.localAudio.get(audioId))!.deletedAt).toBeNull(); // ← 그리고 여기
  });
});
