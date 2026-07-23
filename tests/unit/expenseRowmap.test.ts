// expense rowmap 경계 왕복 테스트 — 운영 함수 직접 테스트(미러 금지, LESSONS §6).
import { describe, it, expect } from 'vitest';
import { toExpenseRow, fromExpenseRow } from '../../src/domain/expense/rowmap';
import type { LocalExpense } from '../../src/offline/db';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const expense: LocalExpense = {
  id: '44444444-4444-4444-8444-444444444444',
  momentId: '22222222-2222-4222-8222-222222222222',
  tripId: '11111111-1111-4111-8111-111111111111',
  originalAmount: 15000,
  originalCurrency: 'KRW',
  category: '식비',
  note: '흑돼지',
  version: 2,
  createdAt: '2026-07-22T10:00:00.000Z',
  updatedAt: '2026-07-22T11:30:00.000Z',
  deletedAt: null,
  clientOperationId: '55555555-5555-4555-8555-555555555555',
};

describe('expense rowmap 경계', () => {
  it('toExpenseRow → fromExpenseRow 왕복이 손실 없이 동등하다', () => {
    expect(fromExpenseRow(toExpenseRow(expense, USER))).toEqual(expense);
  });

  it('snake_case 행을 만들고 user_id를 주입한다', () => {
    const row = toExpenseRow(expense, USER);
    expect(row.user_id).toBe(USER);
    expect(row.moment_id).toBe(expense.momentId);
    expect(row.trip_id).toBe(expense.tripId);
    expect(row.original_amount).toBe(15000);
    expect(row.original_currency).toBe('KRW');
    expect(row.client_operation_id).toBe(expense.clientOperationId);
  });

  it('tombstone(삭제) 행도 왕복 보존된다', () => {
    const del: LocalExpense = { ...expense, deletedAt: '2026-07-22T12:00:00.000Z', version: 3 };
    const back = fromExpenseRow(toExpenseRow(del, USER));
    expect(back.deletedAt).toBe('2026-07-22T12:00:00.000Z');
    expect(back.version).toBe(3);
  });

  it('clientOperationId 없으면 행에서 null, 복원 시 키 없음', () => {
    const { clientOperationId: _drop, ...noCoi } = expense;
    const row = toExpenseRow(noCoi as LocalExpense, USER);
    expect(row.client_operation_id).toBe(null);
    expect('clientOperationId' in fromExpenseRow(row)).toBe(false);
  });
});
