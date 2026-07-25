// domain/expense/rowmap.ts — Expense의 직렬화 경계 (docs/DATA_MODEL.md 경계 규칙)
// 메모리는 camelCase, DB 행은 snake_case. 두 표기는 이 파일의 함수 안에서만 만난다.
// check-schema-parity 게이트가 ExpenseRow 필드 ⊆ journey.expenses 컬럼을 강제한다.

import type { LocalExpense } from '../../offline/db';

/** Supabase journey.expenses 행 (snake_case — 이 파일 밖에서 사용 금지). */
export interface ExpenseRow {
  id: string;
  user_id: string;
  moment_id: string;
  trip_id: string;
  original_amount: number;
  original_currency: string;
  category: string;
  note: string;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  client_operation_id: string | null;
  /**
   * 영구삭제 표식(ADR-0027) — 어느 기기에서 휴지통을 비운 시각.
   *
   * **선택 필드다.** toRow()는 이 키를 절대 담지 않는다 — 담으면 평범한 upsert가 다른 기기의
   * 영구삭제를 `null`로 덮어써 지운 것이 되살아난다. 읽기 전용으로만 쓴다(pull이 본다).
   */
  purged_at?: string | null;
}

export function toExpenseRow(e: LocalExpense, userId: string): ExpenseRow {
  return {
    id: e.id,
    user_id: userId,
    moment_id: e.momentId,
    trip_id: e.tripId,
    original_amount: e.originalAmount,
    original_currency: e.originalCurrency,
    category: e.category,
    note: e.note,
    version: e.version,
    created_at: e.createdAt,
    updated_at: e.updatedAt,
    deleted_at: e.deletedAt,
    client_operation_id: e.clientOperationId ?? null,
  };
}

export function fromExpenseRow(r: ExpenseRow): LocalExpense {
  return {
    id: r.id,
    momentId: r.moment_id,
    tripId: r.trip_id,
    originalAmount: r.original_amount,
    originalCurrency: r.original_currency,
    category: r.category,
    note: r.note,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
    ...(r.client_operation_id ? { clientOperationId: r.client_operation_id } : {}),
  };
}
