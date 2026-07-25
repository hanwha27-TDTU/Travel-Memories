// services/expenses.ts — 비용(Expense) 로컬우선 저장. 원금액은 양수·불변(H-04).
// 서버 동기화: 생성/수정/삭제마다 sync 큐에 'expense' op를 쌓아 push/pull(services/sync.ts)한다.
// 순간 삭제 cascade가 비용을 tombstone할 때도 그 큐 op를 함께 넣어 전파한다(moments.ts).
// 백업/복원에도 포함되어 기기 간 이전·유실 방지(§1).

import { db, type LocalExpense, type SyncQueueItem } from '../offline/db';

function uuid(): string {
  return crypto.randomUUID();
}

/** 'expense' 동기화 op 하나. moments와 동일 형태. */
function expenseOp(
  operationId: string,
  entityId: string,
  operationType: SyncQueueItem['operationType'],
  createdAt: string,
): SyncQueueItem {
  return { operationId, entityType: 'expense', entityId, operationType, state: 'local_only', attempts: 0, createdAt };
}

export interface CreateExpenseInput {
  momentId: string;
  tripId: string;
  originalAmount: number;
  originalCurrency: string;
  category?: string;
  note?: string;
}

/** 비용 생성 — 내구성 로컬 커밋 + read-back. 원금액은 양수만 허용(제약). */
export async function createExpenseLocalFirst(input: CreateExpenseInput): Promise<LocalExpense> {
  if (!input.momentId || !input.tripId) throw new Error('순간 정보가 없습니다.');
  if (!(input.originalAmount > 0)) throw new Error('금액은 0보다 커야 합니다.');
  if (!input.originalCurrency) throw new Error('통화가 없습니다.');

  const now = new Date().toISOString();
  const opId = uuid();
  const expense: LocalExpense = {
    id: uuid(),
    momentId: input.momentId,
    tripId: input.tripId,
    originalAmount: input.originalAmount,
    originalCurrency: input.originalCurrency,
    category: input.category?.trim() ?? '',
    note: input.note?.trim() ?? '',
    version: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    clientOperationId: opId,
  };
  const d = db();
  await d.transaction('rw', d.localExpenses, d.syncQueue, async () => {
    await d.localExpenses.add(expense);
    await d.syncQueue.add(expenseOp(opId, expense.id, 'insert', now));
  });
  const back = await d.localExpenses.get(expense.id);
  if (!back || back.originalAmount !== expense.originalAmount) {
    throw new Error('내구성 커밋 확인 실패: 비용 read-back 불일치');
  }
  return back;
}

export interface UpdateExpensePatch {
  originalAmount?: number;
  originalCurrency?: string;
  category?: string;
  note?: string;
}

/** 비용 수정 — version+1·updatedAt 갱신(LWW). 금액은 양수 유지. */
export async function updateExpenseLocalFirst(id: string, patch: UpdateExpensePatch): Promise<LocalExpense> {
  const d = db();
  const cur = await d.localExpenses.get(id);
  if (!cur || cur.deletedAt !== null) throw new Error('비용을 찾을 수 없습니다.');
  if (patch.originalAmount !== undefined && !(patch.originalAmount > 0)) {
    throw new Error('금액은 0보다 커야 합니다.');
  }
  const now = new Date().toISOString();
  const opId = uuid();
  const next: LocalExpense = {
    ...cur,
    ...(patch.originalAmount !== undefined ? { originalAmount: patch.originalAmount } : {}),
    ...(patch.originalCurrency !== undefined ? { originalCurrency: patch.originalCurrency } : {}),
    ...(patch.category !== undefined ? { category: patch.category.trim() } : {}),
    ...(patch.note !== undefined ? { note: patch.note.trim() } : {}),
    version: cur.version + 1,
    updatedAt: now,
    baseVersion: cur.version,
    clientOperationId: opId,
  };
  await d.transaction('rw', d.localExpenses, d.syncQueue, async () => {
    await d.localExpenses.put(next);
    await d.syncQueue.add(expenseOp(opId, id, 'update', now));
  });
  const back = await d.localExpenses.get(id);
  if (!back || back.version !== next.version) throw new Error('내구성 커밋 확인 실패: 비용 수정 read-back 불일치');
  return back;
}

/** 비용 삭제 — tombstone(§0). 삭제도 동기화되도록 큐 op를 넣는다. */
export async function softDeleteExpenseLocalFirst(id: string): Promise<void> {
  const d = db();
  const cur = await d.localExpenses.get(id);
  if (!cur || cur.deletedAt !== null) throw new Error('비용을 찾을 수 없습니다.');
  const now = new Date().toISOString();
  const opId = uuid();
  await d.transaction('rw', d.localExpenses, d.syncQueue, async () => {
    await d.localExpenses.put({
      ...cur,
      deletedAt: now,
      version: cur.version + 1,
      updatedAt: now,
      baseVersion: cur.version,
      clientOperationId: opId,
    });
    await d.syncQueue.add(expenseOp(opId, id, 'delete', now));
  });
  const back = await d.localExpenses.get(id);
  if (!back || back.deletedAt === null) throw new Error('내구성 커밋 확인 실패: 비용 삭제 read-back 불일치');
}

/**
 * 비용 되살리기(실행취소) — 삭제와 **대칭**. version+1로 LWW에서 최신이 이긴다.
 *
 * 2026-07-25 감사 F4: trips·moments·media에는 restore가 있는데 비용만 없어, 개별 비용 삭제는
 * 되돌릴 수 없었다. 도메인 간 생명주기 대칭이 깨져 있던 자리다.
 */
export async function restoreExpenseLocalFirst(id: string): Promise<void> {
  const d = db();
  const cur = await d.localExpenses.get(id);
  if (!cur) throw new Error('비용을 찾을 수 없습니다.');
  const now = new Date().toISOString();
  const opId = uuid();
  await d.transaction('rw', d.localExpenses, d.syncQueue, async () => {
    await d.localExpenses.put({
      ...cur,
      deletedAt: null,
      version: cur.version + 1,
      updatedAt: now,
      baseVersion: cur.version,
      clientOperationId: opId,
    });
    await d.syncQueue.add(expenseOp(opId, id, 'update', now));
  });
  const back = await d.localExpenses.get(id);
  if (!back || back.deletedAt !== null) throw new Error('내구성 커밋 확인 실패: 비용 복원 read-back 불일치');
}

/** 여행의 활성 비용(통계·합계용). tombstone 제외. */
export async function listExpensesByTrip(tripId: string): Promise<LocalExpense[]> {
  const rows = await db().localExpenses.where('tripId').equals(tripId).toArray();
  return rows.filter((e) => e.deletedAt === null);
}

/** 순간의 활성 비용. tombstone 제외. */
export async function listExpensesByMoment(momentId: string): Promise<LocalExpense[]> {
  const rows = await db().localExpenses.where('momentId').equals(momentId).toArray();
  return rows.filter((e) => e.deletedAt === null);
}
