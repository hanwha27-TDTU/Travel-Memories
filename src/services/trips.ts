// services/trips.ts — 여행 로컬우선 저장 (docs/SYNC_PROTOCOL.md thin slice)
// "저장 완료" = 내구성 로컬 커밋: Dexie 트랜잭션으로 entity+operation을 원자적으로
// 쓰고, 같은 키를 즉시 되읽어(read-back) 일치를 확인한 뒤에만 완료를 반환한다.
// 서버 push는 인증(Google OAuth, Phase 1 후속)이 붙기 전까지 대기열에만 쌓인다 —
// sync_queue가 그 대기열이며, 유실되지 않는다.

import { db, type LocalTrip, type SyncQueueItem } from '../offline/db';

function uuid(): string {
  return crypto.randomUUID();
}

export interface CreateTripInput {
  title: string;
  startDate?: string;
  endDate?: string;
}

/**
 * 여행 생성 — 내구성 로컬 커밋 + 정확한 read-back.
 * 반환된 시점 = SYNC_PROTOCOL의 "내구성 로컬 커밋 이후"(앱 원인 유실 0 범위 시작점).
 */
export async function createTripLocalFirst(input: CreateTripInput): Promise<LocalTrip> {
  const title = input.title.trim();
  if (!title) throw new Error('제목이 비어 있습니다.');

  const now = new Date().toISOString();
  const trip: LocalTrip = {
    id: uuid(),
    title,
    startDate: input.startDate ?? '',
    endDate: input.endDate ?? '',
    status: 'planned',
    version: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    clientOperationId: uuid(),
  };
  const op: SyncQueueItem = {
    operationId: trip.clientOperationId!,
    entityType: 'trip',
    entityId: trip.id,
    operationType: 'insert',
    state: 'local_only',
    attempts: 0,
    createdAt: now,
  };

  const d = db();
  // entity + operation 원자적 커밋 — 하나만 남는 상태를 만들지 않는다.
  await d.transaction('rw', d.localTrips, d.syncQueue, async () => {
    await d.localTrips.add(trip);
    await d.syncQueue.add(op);
  });

  // 정확한 read-back: 트랜잭션 성공 반환을 믿지 않고 같은 키를 되읽어 확인(불변식 5).
  const [readTrip, readOp] = await Promise.all([
    d.localTrips.get(trip.id),
    d.syncQueue.get(op.operationId),
  ]);
  if (!readTrip || readTrip.title !== trip.title || !readOp) {
    throw new Error('내구성 커밋 확인 실패: read-back 불일치 — 저장을 완료로 표시하지 않음');
  }
  return readTrip;
}

/** 단일 여행 조회(활성만; tombstone/없음은 null). */
export async function getTrip(id: string): Promise<LocalTrip | null> {
  const t = await db().localTrips.get(id);
  return t && t.deletedAt === null ? t : null;
}

export interface UpdateTripPatch {
  title?: string;
  startDate?: string;
  endDate?: string;
  status?: LocalTrip['status'];
}

/**
 * 여행 수정 — 내구성 로컬 커밋 + 정확한 read-back + 동기화 대기열(update).
 * version을 올리고 updatedAt을 갱신한다(LWW 기준). 서버 push는 기존 파이프라인이 처리.
 */
export async function updateTripLocalFirst(id: string, patch: UpdateTripPatch): Promise<LocalTrip> {
  const d = db();
  const cur = await d.localTrips.get(id);
  if (!cur || cur.deletedAt !== null) throw new Error('여행을 찾을 수 없습니다.');

  const now = new Date().toISOString();
  const opId = uuid();
  const next: LocalTrip = {
    ...cur,
    ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
    ...(patch.startDate !== undefined ? { startDate: patch.startDate } : {}),
    ...(patch.endDate !== undefined ? { endDate: patch.endDate } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    version: cur.version + 1,
    updatedAt: now,
    baseVersion: cur.version,
    clientOperationId: opId,
  };
  if (!next.title) throw new Error('제목이 비어 있습니다.');

  const op: SyncQueueItem = {
    operationId: opId,
    entityType: 'trip',
    entityId: id,
    operationType: 'update',
    state: 'local_only',
    attempts: 0,
    createdAt: now,
  };

  await d.transaction('rw', d.localTrips, d.syncQueue, async () => {
    await d.localTrips.put(next);
    await d.syncQueue.add(op);
  });

  const readTrip = await d.localTrips.get(id);
  if (!readTrip || readTrip.version !== next.version) {
    throw new Error('내구성 커밋 확인 실패: read-back 불일치');
  }
  return readTrip;
}

/**
 * 여행 삭제 — 하드 삭제 금지(§0): deletedAt tombstone. 순간(Moment)·사진(Media)까지
 * 같은 트랜잭션에서 cascade tombstone하여 고아 데이터가 남지 않게 한다. 순간은 서버로
 * 동기화되므로 각각 sync 큐 op(delete)를 만들고, 미디어는 로컬 전용이라 op를 만들지
 * 않는다(처리 주체 부재 → 대기열 영구 잔류 방지). 되살리기가 정확히 이 자식들만 복원하도록
 * id 목록을 반환한다. 되살리기·삭제 모두 version+1로 LWW에서 최신이 이긴다.
 */
export async function softDeleteTripLocalFirst(
  id: string,
): Promise<{ momentIds: string[]; mediaIds: string[]; expenseIds: string[] }> {
  const d = db();
  const cur = await d.localTrips.get(id);
  if (!cur || cur.deletedAt !== null) throw new Error('여행을 찾을 수 없습니다.');

  const now = new Date().toISOString();
  const tripOpId = uuid();
  const tombstonedTrip: LocalTrip = {
    ...cur,
    deletedAt: now,
    version: cur.version + 1,
    updatedAt: now,
    baseVersion: cur.version,
    clientOperationId: tripOpId,
  };

  const moments = (await d.localMoments.where('tripId').equals(id).toArray()).filter(
    (m) => m.deletedAt === null,
  );
  const media = (await d.localMedia.where('tripId').equals(id).toArray()).filter(
    (m) => m.deletedAt === null,
  );
  const expenses = (await d.localExpenses.where('tripId').equals(id).toArray()).filter(
    (e) => e.deletedAt === null,
  );
  const momentIds = moments.map((m) => m.id);
  const mediaIds = media.map((m) => m.id);
  const expenseIds = expenses.map((e) => e.id);

  const ops: SyncQueueItem[] = [
    { operationId: tripOpId, entityType: 'trip', entityId: id, operationType: 'delete', state: 'local_only', attempts: 0, createdAt: now },
    ...moments.map((m) => ({
      operationId: uuid(),
      entityType: 'moment',
      entityId: m.id,
      operationType: 'delete' as const,
      state: 'local_only',
      attempts: 0,
      createdAt: now,
    })),
  ];

  await d.transaction('rw', d.localTrips, d.localMoments, d.localMedia, d.localExpenses, d.syncQueue, async () => {
    await d.localTrips.put(tombstonedTrip);
    for (const m of moments) await d.localMoments.put({ ...m, deletedAt: now, version: m.version + 1, updatedAt: now });
    for (const m of media) await d.localMedia.put({ ...m, deletedAt: now, version: m.version + 1, updatedAt: now });
    for (const e of expenses) await d.localExpenses.put({ ...e, deletedAt: now, version: e.version + 1, updatedAt: now });
    for (const op of ops) await d.syncQueue.add(op);
  });

  const back = await d.localTrips.get(id);
  if (!back || back.deletedAt === null) throw new Error('내구성 커밋 확인 실패: 여행 삭제 read-back 불일치');
  return { momentIds, mediaIds, expenseIds };
}

/** 여행 되살리기(실행취소) — 여행 + 삭제 시 함께 tombstone된 순간·사진·비용을 복원. version+1로 LWW 승리. */
export async function restoreTripLocalFirst(
  id: string,
  momentIds: string[],
  mediaIds: string[],
  expenseIds: string[] = [],
): Promise<LocalTrip> {
  const d = db();
  const cur = await d.localTrips.get(id);
  if (!cur) throw new Error('여행을 찾을 수 없습니다.');

  const now = new Date().toISOString();
  const tripOpId = uuid();
  const restored: LocalTrip = {
    ...cur,
    deletedAt: null,
    version: cur.version + 1,
    updatedAt: now,
    baseVersion: cur.version,
    clientOperationId: tripOpId,
  };
  const ops: SyncQueueItem[] = [
    { operationId: tripOpId, entityType: 'trip', entityId: id, operationType: 'update', state: 'local_only', attempts: 0, createdAt: now },
    ...momentIds.map((mid) => ({
      operationId: uuid(),
      entityType: 'moment',
      entityId: mid,
      operationType: 'update' as const,
      state: 'local_only',
      attempts: 0,
      createdAt: now,
    })),
  ];

  await d.transaction('rw', d.localTrips, d.localMoments, d.localMedia, d.localExpenses, d.syncQueue, async () => {
    await d.localTrips.put(restored);
    for (const mid of momentIds) {
      const m = await d.localMoments.get(mid);
      if (m) await d.localMoments.put({ ...m, deletedAt: null, version: m.version + 1, updatedAt: now });
    }
    for (const mid of mediaIds) {
      const m = await d.localMedia.get(mid);
      if (m) await d.localMedia.put({ ...m, deletedAt: null, version: m.version + 1, updatedAt: now });
    }
    for (const eid of expenseIds) {
      const e = await d.localExpenses.get(eid);
      if (e) await d.localExpenses.put({ ...e, deletedAt: null, version: e.version + 1, updatedAt: now });
    }
    for (const op of ops) await d.syncQueue.add(op);
  });

  const back = await d.localTrips.get(id);
  if (!back || back.deletedAt !== null) throw new Error('내구성 커밋 확인 실패: 여행 되살리기 read-back 불일치');
  return back;
}

/** 휴지통 — 삭제(tombstone)된 여행 목록. 최근 삭제 먼저. */
export async function listDeletedTrips(): Promise<LocalTrip[]> {
  const d = db();
  const all = await d.localTrips.orderBy('updatedAt').reverse().toArray();
  return all.filter((t) => t.deletedAt !== null);
}

/**
 * 휴지통에서 여행 복원 — 여행 + 그 여행의 현재 tombstone된 순간·사진을 함께 되살린다.
 * (삭제 시 어떤 자식이 함께 지워졌는지는 영속하지 않으므로, 복구 우선 원칙(§5)에 따라
 * 그 여행에 딸린 삭제된 자식을 모두 되살린다.) version+1로 LWW 승리.
 */
export async function restoreTripFromTrash(id: string): Promise<LocalTrip> {
  const d = db();
  const moments = (await d.localMoments.where('tripId').equals(id).toArray()).filter((m) => m.deletedAt !== null);
  const media = (await d.localMedia.where('tripId').equals(id).toArray()).filter((m) => m.deletedAt !== null);
  const expenses = (await d.localExpenses.where('tripId').equals(id).toArray()).filter((e) => e.deletedAt !== null);
  return restoreTripLocalFirst(id, moments.map((m) => m.id), media.map((m) => m.id), expenses.map((e) => e.id));
}

/**
 * 영구 삭제 — 휴지통에서 이 기기의 저장공간을 실제로 비운다(여행 + 순간 + 사진 로컬 하드 삭제).
 * 되돌릴 수 없다. 삭제된(tombstone) 행에만 적용한다(활성 여행은 먼저 tombstone돼야 함).
 * 주의(정직): 다른 기기와 동기화를 쓰면, 서버에 아직 남은 행이 다음 pull에서 되살아날 수 있다.
 * 진짜 영구 삭제(서버 포함)는 동기화 실연동 후속에서 tombstone 전파로 다룬다.
 */
export async function purgeTripPermanently(id: string): Promise<void> {
  const d = db();
  const cur = await d.localTrips.get(id);
  if (!cur) return;
  if (cur.deletedAt === null) throw new Error('삭제되지 않은 여행은 영구 삭제할 수 없습니다.');

  const moments = await d.localMoments.where('tripId').equals(id).toArray();
  const media = await d.localMedia.where('tripId').equals(id).toArray();
  const expenses = await d.localExpenses.where('tripId').equals(id).toArray();
  await d.transaction('rw', d.localTrips, d.localMoments, d.localMedia, d.localExpenses, async () => {
    if (media.length) await d.localMedia.bulkDelete(media.map((m) => m.id));
    if (expenses.length) await d.localExpenses.bulkDelete(expenses.map((e) => e.id));
    if (moments.length) await d.localMoments.bulkDelete(moments.map((m) => m.id));
    await d.localTrips.delete(id);
  });

  const back = await d.localTrips.get(id);
  if (back) throw new Error('영구 삭제 확인 실패: 행이 남아 있음');
}

/** 홈 목록 (tombstone·보관 제외 — deletedAt/status는 filter, M-0005). */
export async function listTrips(): Promise<LocalTrip[]> {
  const d = db();
  const all = await d.localTrips.orderBy('updatedAt').reverse().toArray();
  return all.filter((t) => t.deletedAt === null && t.status !== 'archived');
}

/** 보관함 목록 (보관 상태만, tombstone 제외). */
export async function listArchivedTrips(): Promise<LocalTrip[]> {
  const d = db();
  const all = await d.localTrips.orderBy('updatedAt').reverse().toArray();
  return all.filter((t) => t.deletedAt === null && t.status === 'archived');
}

/** 동기화 대기 중인 작업 수 (UI 상태 표시용 — false/null 과적재 금지, 숫자로 반환). */
export async function pendingSyncCount(): Promise<number> {
  const d = db();
  return d.syncQueue.where('state').equals('local_only').count();
}
