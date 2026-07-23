// services/expenses.ts — 비용(Expense) 로컬우선 저장. 원금액은 양수·불변(H-04).
// 미디어와 동일하게 로컬 전용(sync 큐 op 없음) — 서버 동기화 push/pull은 후속.
// 백업/복원에는 포함되어 기기 간 이전·유실 방지(§1).

import { db, type LocalExpense } from '../offline/db';

function uuid(): string {
  return crypto.randomUUID();
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
  };
  const d = db();
  await d.localExpenses.add(expense);
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
  const next: LocalExpense = {
    ...cur,
    ...(patch.originalAmount !== undefined ? { originalAmount: patch.originalAmount } : {}),
    ...(patch.originalCurrency !== undefined ? { originalCurrency: patch.originalCurrency } : {}),
    ...(patch.category !== undefined ? { category: patch.category.trim() } : {}),
    ...(patch.note !== undefined ? { note: patch.note.trim() } : {}),
    version: cur.version + 1,
    updatedAt: now,
    baseVersion: cur.version,
  };
  await d.localExpenses.put(next);
  const back = await d.localExpenses.get(id);
  if (!back || back.version !== next.version) throw new Error('내구성 커밋 확인 실패: 비용 수정 read-back 불일치');
  return back;
}

/** 비용 삭제 — tombstone(§0). */
export async function softDeleteExpenseLocalFirst(id: string): Promise<void> {
  const d = db();
  const cur = await d.localExpenses.get(id);
  if (!cur || cur.deletedAt !== null) throw new Error('비용을 찾을 수 없습니다.');
  const now = new Date().toISOString();
  await d.localExpenses.put({ ...cur, deletedAt: now, version: cur.version + 1, updatedAt: now });
  const back = await d.localExpenses.get(id);
  if (!back || back.deletedAt === null) throw new Error('내구성 커밋 확인 실패: 비용 삭제 read-back 불일치');
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
