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

/** 여행의 활성 순간 목록(tombstone 제외 — deletedAt은 filter, M-0005). */
export async function listMoments(tripId: string): Promise<LocalMoment[]> {
  const d = db();
  const rows = await d.localMoments.where('tripId').equals(tripId).toArray();
  return rows.filter((m) => m.deletedAt === null);
}
