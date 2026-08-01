// services/moments.ts — 순간(Moment) 로컬우선 저장 (여행과 동일 규율).
// "저장 완료" = 내구성 로컬 커밋: Dexie 트랜잭션으로 entity+operation 원자 커밋 후
// 같은 키를 되읽어(read-back) 확인한 뒤에만 완료. 서버 push는 후속(대기열에 적재).

import { db, type LocalMoment, type SyncQueueItem } from '../offline/db';

function uuid(): string {
  return crypto.randomUUID();
}

export interface CreateMomentInput {
  tripId: string;
  title: string;
  emotion?: string;
  placeName?: string;
  placeLat?: number | null;
  placeLng?: number | null;
  /** 장소 라이브러리 링크(선택 · 0023). 없는 것이 정상 — 자유 입력 장소는 링크가 없다. */
  placeId?: string | null;
  note?: string;
  occurredAt?: string;
  /**
   * 🔴 이 순간의 **시간대 오프셋 예외**(분). 사진 EXIF `OffsetTimeOriginal`이 알려줬을 때만 채운다
   * (환승·국경으로 여행 시간대와 다를 수 있는 경우 — M-1). 없으면 여행 시간대로 파생한다.
   * 그동안 이 필드는 저장·동기화·백업·표시까지 배선돼 있었는데 **값을 넣는 곳이 없어 죽어 있었다**.
   */
  tzOffsetMin?: number | null;
}

/** 순간 생성 — 내구성 로컬 커밋 + 정확한 read-back. */
export async function createMomentLocalFirst(input: CreateMomentInput): Promise<LocalMoment> {
  const title = input.title.trim();
  if (!title) throw new Error('기록 내용이 비어 있습니다.');
  if (!input.tripId) throw new Error('여행 정보가 없습니다.');

  const now = new Date().toISOString();
  const moment: LocalMoment = {
    id: uuid(),
    tripId: input.tripId,
    occurredAt: input.occurredAt ?? now,
    title,
    note: input.note?.trim() ?? '',
    emotion: input.emotion ?? '',
    placeName: input.placeName?.trim() ?? '',
    placeLat: input.placeLat ?? null,
    placeLng: input.placeLng ?? null,
    placeId: input.placeId ?? null,
    tzOffsetMin: input.tzOffsetMin ?? null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    clientOperationId: uuid(),
  };
  const op: SyncQueueItem = {
    operationId: moment.clientOperationId!,
    entityType: 'moment',
    entityId: moment.id,
    operationType: 'insert',
    state: 'local_only',
    attempts: 0,
    createdAt: now,
  };

  const d = db();
  await d.transaction('rw', d.localMoments, d.syncQueue, async () => {
    await d.localMoments.add(moment);
    await d.syncQueue.add(op);
  });

  const [readMoment, readOp] = await Promise.all([
    d.localMoments.get(moment.id),
    d.syncQueue.get(op.operationId),
  ]);
  if (!readMoment || readMoment.title !== moment.title || !readOp) {
    throw new Error('내구성 커밋 확인 실패: read-back 불일치 — 저장을 완료로 표시하지 않음');
  }
  return readMoment;
}

export interface UpdateMomentPatch {
  title?: string;
  emotion?: string;
  placeName?: string;
  placeLat?: number | null;
  placeLng?: number | null;
  /** 장소 라이브러리 링크(선택 · 0023). 없는 것이 정상 — 자유 입력 장소는 링크가 없다. */
  placeId?: string | null;
  note?: string;
  occurredAt?: string;
  /** 시간대 오프셋 예외(분) — 사용자가 발생 시각을 고치거나 사진 오프셋이 바뀔 때(M-1). */
  tzOffsetMin?: number | null;
}

/**
 * 순간 수정 — 생성과 동일 규율: version+1, updatedAt 갱신(LWW 기준), 대기열(update),
 * 정확한 read-back. 서버 push는 기존 순간 파이프라인이 처리(op 타입 무관 멱등 upsert).
 */
export async function updateMomentLocalFirst(id: string, patch: UpdateMomentPatch): Promise<LocalMoment> {
  const d = db();
  const cur = await d.localMoments.get(id);
  if (!cur || cur.deletedAt !== null) throw new Error('순간을 찾을 수 없습니다.');

  const now = new Date().toISOString();
  const opId = uuid();
  const next: LocalMoment = {
    ...cur,
    ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
    ...(patch.emotion !== undefined ? { emotion: patch.emotion } : {}),
    ...(patch.placeName !== undefined ? { placeName: patch.placeName.trim() } : {}),
    ...(patch.placeLat !== undefined ? { placeLat: patch.placeLat } : {}),
    ...(patch.placeLng !== undefined ? { placeLng: patch.placeLng } : {}),
    ...(patch.placeId !== undefined ? { placeId: patch.placeId } : {}),
    ...(patch.note !== undefined ? { note: patch.note.trim() } : {}),
    ...(patch.occurredAt !== undefined ? { occurredAt: patch.occurredAt } : {}),
    ...(patch.tzOffsetMin !== undefined ? { tzOffsetMin: patch.tzOffsetMin } : {}),
    version: cur.version + 1,
    updatedAt: now,
    baseVersion: cur.version,
    clientOperationId: opId,
  };
  if (!next.title) throw new Error('기록 내용이 비어 있습니다.');

  const op: SyncQueueItem = {
    operationId: opId,
    entityType: 'moment',
    entityId: id,
    operationType: 'update',
    state: 'local_only',
    attempts: 0,
    createdAt: now,
  };

  await d.transaction('rw', d.localMoments, d.syncQueue, async () => {
    await d.localMoments.put(next);
    await d.syncQueue.add(op);
  });

  const readMoment = await d.localMoments.get(id);
  if (!readMoment || readMoment.version !== next.version) {
    throw new Error('내구성 커밋 확인 실패: read-back 불일치');
  }
  return readMoment;
}

/**
 * 순간과 함께 tombstone된 자식 id 묶음. **복원은 이 묶음을 통째로 받는다.**
 *
 * ⚠️ 결함 이력(2026-07-27, M-0007의 **재발**): 예전 시그니처는
 * `restoreMomentLocalFirst(id, mediaIds, expenseIds = [], audioIds = [])`였고, 화면이
 * `const { deletedMediaIds } = await softDelete…` 로 **사진만 꺼내 넘겼다.** 선택적
 * 매개변수의 기본값이 그 누락을 **조용히 삼켜** 컴파일도 통과했다 — 타임라인에서 순간을
 * 지우고 실행취소하면 사진만 돌아오고 **비용·소리는 영영 tombstone으로 남았다**(순간이
 * 활성으로 돌아오므로 휴지통에도 안 보여 복구 경로가 사라진다).
 *
 * M-0007에서 여행 쪽은 `TripChildren` 묶음 타입으로 이 부류를 컴파일 오류화했는데
 * **순간 쪽만 옛 모양으로 남아 있었다** — 형제 비대칭(§7). 같은 처방을 여기에도 적용한다:
 * 삭제가 돌려주는 것과 복원이 받는 것이 **같은 타입**이라 그대로 넘기면 되고, 자식 종류가
 * 늘면 컴파일러가 모든 호출부를 데려온다.
 */
export interface MomentChildren {
  mediaIds: string[];
  expenseIds: string[];
  audioIds: string[];
}

/**
 * 순간 삭제 — 하드 삭제 금지(§0): deletedAt tombstone. version+1로 LWW에서 이기게 하고,
 * 이 순간에 달린 활성 **사진·비용·소리**도 같은 트랜잭션에서 함께 tombstone한다(고아가
 * 통계를 속이지 않도록). 되살리기(undo)가 정확히 그것들만 복원하도록 id 목록을 반환한다.
 *
 * ⚠️ 화석 주석 정정(2026-07-27): 예전 이 자리엔 "미디어는 로컬 전용이라 sync 큐 op를 만들지
 * 않는다"가 적혀 있었다. 사진 동기화가 생기면서 **아래 코드는 op를 만드는데 주석만 옛
 * 전제를 붙들고** 있었다 — M-0006과 같은 부류다. 지금 op를 만들지 않는 것은 소리뿐이고,
 * 그 이유는 그 자리(아래 루프)에 적혀 있다.
 */
export async function softDeleteMomentLocalFirst(id: string): Promise<MomentChildren> {
  const d = db();
  const cur = await d.localMoments.get(id);
  if (!cur || cur.deletedAt !== null) throw new Error('순간을 찾을 수 없습니다.');

  const now = new Date().toISOString();
  const opId = uuid();
  const tombstoned: LocalMoment = {
    ...cur,
    deletedAt: now,
    version: cur.version + 1,
    updatedAt: now,
    baseVersion: cur.version,
    clientOperationId: opId,
  };
  const op: SyncQueueItem = {
    operationId: opId,
    entityType: 'moment',
    entityId: id,
    operationType: 'delete',
    state: 'local_only',
    attempts: 0,
    createdAt: now,
  };

  const media = (await d.localMedia.where('momentId').equals(id).toArray()).filter((m) => m.deletedAt === null);
  const expenses = (await d.localExpenses.where('momentId').equals(id).toArray()).filter((e) => e.deletedAt === null);
  // 오디오도 **형제다** — 순간이 사라지면 함께 사라져야 한다(§7 대칭이 기본값).
  const audio = (await d.localAudio.where('momentId').equals(id).toArray()).filter((a) => a.deletedAt === null);
  const mediaIds = media.map((m) => m.id);
  const expenseIds = expenses.map((e) => e.id);
  const audioIds = audio.map((a) => a.id);

  await d.transaction('rw', d.localMoments, d.localMedia, d.localExpenses, d.localAudio, d.syncQueue, async () => {
    await d.localMoments.put(tombstoned);
    for (const m of media) {
      // 사진도 동기화 대상 — cascade tombstone을 큐 op로 전파.
      const mOpId = uuid();
      await d.localMedia.put({ ...m, deletedAt: now, version: m.version + 1, updatedAt: now, baseVersion: m.version, clientOperationId: mOpId });
      await d.syncQueue.add({ operationId: mOpId, entityType: 'media', entityId: m.id, operationType: 'delete', state: 'local_only', attempts: 0, createdAt: now });
    }
    for (const e of expenses) {
      // 비용은 동기화 대상 — cascade tombstone도 큐 op로 전파(안 하면 서버에 삭제가 안 감).
      const eOpId = uuid();
      await d.localExpenses.put({ ...e, deletedAt: now, version: e.version + 1, updatedAt: now, baseVersion: e.version, clientOperationId: eOpId });
      await d.syncQueue.add({ operationId: eOpId, entityType: 'expense', entityId: e.id, operationType: 'delete', state: 'local_only', attempts: 0, createdAt: now });
    }
    for (const a of audio) {
      // 오디오도 **서버로 간다**(2026-07-27~). cascade tombstone을 큐 op로 전파하지 않으면
      // 순간을 지워도 서버의 소리 행이 활성으로 남고 R2 객체까지 잔류한다 — M-0006이 사진·
      // 비용에서 정확히 그랬다. 형제가 지키는 것을 새것도 지킨다.
      const aOpId = uuid();
      await d.localAudio.put({ ...a, deletedAt: now, version: a.version + 1, updatedAt: now, baseVersion: a.version, clientOperationId: aOpId });
      await d.syncQueue.add({ operationId: aOpId, entityType: 'audio', entityId: a.id, operationType: 'delete', state: 'local_only', attempts: 0, createdAt: now });
    }
    await d.syncQueue.add(op);
  });

  const back = await d.localMoments.get(id);
  if (!back || back.deletedAt === null) {
    throw new Error('내구성 커밋 확인 실패: 삭제 read-back 불일치');
  }
  return { mediaIds, expenseIds, audioIds };
}

/**
 * 순간 되살리기(실행취소) — deletedAt=null 복원. 되살리기 자체가 새 변경이므로 version+1·
 * updatedAt=now로 삭제를 이긴다(다른 기기가 이미 삭제를 본 경우에도 LWW로 복원이 승리).
 * 삭제 시 함께 tombstone된 사진(mediaIds)도 같은 트랜잭션에서 복원한다.
 */
export async function restoreMomentLocalFirst(id: string, children: MomentChildren): Promise<LocalMoment> {
  const { mediaIds, expenseIds, audioIds } = children;
  const d = db();
  const cur = await d.localMoments.get(id);
  if (!cur) throw new Error('순간을 찾을 수 없습니다.');

  const now = new Date().toISOString();
  const opId = uuid();
  const restored: LocalMoment = {
    ...cur,
    deletedAt: null,
    version: cur.version + 1,
    updatedAt: now,
    baseVersion: cur.version,
    clientOperationId: opId,
  };
  const op: SyncQueueItem = {
    operationId: opId,
    entityType: 'moment',
    entityId: id,
    operationType: 'update',
    state: 'local_only',
    attempts: 0,
    createdAt: now,
  };

  await d.transaction('rw', d.localMoments, d.localMedia, d.localExpenses, d.localAudio, d.syncQueue, async () => {
    await d.localMoments.put(restored);
    for (const mid of mediaIds) {
      const m = await d.localMedia.get(mid);
      if (m) {
        const mOpId = uuid();
        await d.localMedia.put({ ...m, deletedAt: null, version: m.version + 1, updatedAt: now, baseVersion: m.version, clientOperationId: mOpId });
        await d.syncQueue.add({ operationId: mOpId, entityType: 'media', entityId: m.id, operationType: 'update', state: 'local_only', attempts: 0, createdAt: now });
      }
    }
    for (const eid of expenseIds) {
      const e = await d.localExpenses.get(eid);
      if (e) {
        // 비용 복원도 큐 op로 전파(update — deletedAt=null·version+1로 삭제를 이긴다).
        const eOpId = uuid();
        await d.localExpenses.put({ ...e, deletedAt: null, version: e.version + 1, updatedAt: now, baseVersion: e.version, clientOperationId: eOpId });
        await d.syncQueue.add({ operationId: eOpId, entityType: 'expense', entityId: e.id, operationType: 'update', state: 'local_only', attempts: 0, createdAt: now });
      }
    }
    for (const aid of audioIds) {
      const a = await d.localAudio.get(aid);
      // 삭제와 **같은 자리에서 되살린다** — 되살릴 수 없는 삭제는 이 앱의 계약 위반이다.
      // 복원도 큐 op로 전파한다(update — deletedAt=null·version+1로 삭제를 이긴다).
      if (a) {
        const aOpId = uuid();
        await d.localAudio.put({ ...a, deletedAt: null, version: a.version + 1, updatedAt: now, baseVersion: a.version, clientOperationId: aOpId });
        await d.syncQueue.add({ operationId: aOpId, entityType: 'audio', entityId: a.id, operationType: 'update', state: 'local_only', attempts: 0, createdAt: now });
      }
    }
    await d.syncQueue.add(op);
  });

  const back = await d.localMoments.get(id);
  if (!back || back.deletedAt !== null) {
    throw new Error('내구성 커밋 확인 실패: 되살리기 read-back 불일치');
  }
  return back;
}

/** 여행의 활성 순간 목록(tombstone 제외 — deletedAt은 filter, M-0005). */
export async function listMoments(tripId: string): Promise<LocalMoment[]> {
  const d = db();
  const rows = await d.localMoments.where('tripId').equals(tripId).toArray();
  return rows.filter((m) => m.deletedAt === null);
}
