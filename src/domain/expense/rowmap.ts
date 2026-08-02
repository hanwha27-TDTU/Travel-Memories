// domain/expense/rowmap.ts — Expense의 직렬화 경계 (docs/DATA_MODEL.md 경계 규칙)
// 메모리는 camelCase, DB 행은 snake_case. 두 표기는 이 파일의 함수 안에서만 만난다.
// check-schema-parity 게이트가 ExpenseRow 필드 ⊆ journey.expenses 컬럼을 강제한다.

import { isoInstant, isoInstantOrNull, type WithInstants } from '../time';
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
  base_version?: number | null;
  base_canonical_version?: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  client_operation_id: string | null;
  /** 마지막으로 이 행을 올린 기기(`라벨#짧은id`) — 진단의 "기기별 현황"이 읽는다. 값은 인자로 받는다. */
  updated_by_device?: string | null;
}

export function toExpenseRow(e: LocalExpense, userId: string, device?: string): ExpenseRow {
  return {
    id: e.id,
    user_id: userId,
    updated_by_device: device ?? null,
    moment_id: e.momentId,
    trip_id: e.tripId,
    original_amount: e.originalAmount,
    original_currency: e.originalCurrency,
    category: e.category,
    note: e.note,
    version: e.version,
    base_version: e.baseVersion ?? Math.max(0, e.version - 1),
    base_canonical_version: e.baseCanonicalVersion ?? 'legacy',
    created_at: e.createdAt,
    updated_at: e.updatedAt,
    deleted_at: e.deletedAt,
    client_operation_id: e.clientOperationId ?? null,
  };
}

/** 서버 행 → 로컬 행. 시각은 반드시 `isoInstant()`를 통과한다(M-0034 — `domain/time.ts` 참조). */
export function fromExpenseRow(r: ExpenseRow): WithInstants<LocalExpense> {
  return {
    id: r.id,
    momentId: r.moment_id,
    tripId: r.trip_id,
    originalAmount: r.original_amount,
    originalCurrency: r.original_currency,
    category: r.category,
    note: r.note,
    version: r.version,
    baseVersion: r.version,
    baseCanonicalVersion: r.base_canonical_version ?? 'legacy',
    createdAt: isoInstant(r.created_at),
    updatedAt: isoInstant(r.updated_at),
    deletedAt: isoInstantOrNull(r.deleted_at),
    ...(r.client_operation_id ? { clientOperationId: r.client_operation_id } : {}),
  };
}
