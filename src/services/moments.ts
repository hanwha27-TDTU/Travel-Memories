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
  note?: string;
  occurredAt?: string;
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
  note?: string;
  occurredAt?: string;
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
    ...(patch.note !== undefined ? { note: patch.note.trim() } : {}),
    ...(patch.occurredAt !== undefined ? { occurredAt: patch.occurredAt } : {}),
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
 * 순간 삭제 — 하드 삭제 금지(§0): deletedAt tombstone. version+1로 LWW에서 이기게 하고,
 * 이 순간에 달린 활성 사진도 같은 트랜잭션에서 함께 tombstone한다(고아 사진이 통계를
 * 속이지 않도록). 되살리기(undo)가 정확히 이 사진들만 복원하도록 그 id 목록을 반환한다.
 * 미디어는 로컬 전용이라 sync 큐 op를 만들지 않는다(처리 주체가 없어 대기열에 영구 잔류함).
 */
export async function softDeleteMomentLocalFirst(
  id: string,
): Promise<{ deletedMediaIds: string[]; deletedExpenseIds: string[] }> {
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
  const deletedMediaIds = media.map((m) => m.id);
  const deletedExpenseIds = expenses.map((e) => e.id);

  await d.transaction('rw', d.localMoments, d.localMedia, d.localExpenses, d.syncQueue, async () => {
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
    await d.syncQueue.add(op);
  });

  const back = await d.localMoments.get(id);
  if (!back || back.deletedAt === null) {
    throw new Error('내구성 커밋 확인 실패: 삭제 read-back 불일치');
  }
  return { deletedMediaIds, deletedExpenseIds };
}

/**
 * 순간 되살리기(실행취소) — deletedAt=null 복원. 되살리기 자체가 새 변경이므로 version+1·
 * updatedAt=now로 삭제를 이긴다(다른 기기가 이미 삭제를 본 경우에도 LWW로 복원이 승리).
 * 삭제 시 함께 tombstone된 사진(mediaIds)도 같은 트랜잭션에서 복원한다.
 */
export async function restoreMomentLocalFirst(
  id: string,
  mediaIds: string[],
  expenseIds: string[] = [],
): Promise<LocalMoment> {
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

  await d.transaction('rw', d.localMoments, d.localMedia, d.localExpenses, d.syncQueue, async () => {
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
