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
