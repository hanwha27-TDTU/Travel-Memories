// rowmap 경계 왕복 테스트 — 운영 함수를 직접 테스트(미러 금지, LESSONS §6).
// camelCase↔snake_case 키 불일치(M류 0-지표 버그)를 왕복 동등성으로 잠근다.
import { describe, it, expect } from 'vitest';
import { toRow, fromRow } from '../../src/domain/trip/rowmap';
import type { LocalTrip } from '../../src/offline/db';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const trip: LocalTrip = {
  id: '11111111-1111-4111-8111-111111111111',
  title: '제주도 여름 여행',
  startDate: '2026-08-01',
  endDate: '2026-08-05',
  status: 'planned',
  timeZone: 'Asia/Ho_Chi_Minh', // 여행지 시간대도 왕복해야 한다(M-0049)
  version: 3,
  createdAt: '2026-07-22T10:00:00.000Z',
  updatedAt: '2026-07-22T11:30:00.000Z',
  deletedAt: null,
  clientOperationId: '22222222-2222-4222-8222-222222222222',
};

describe('trip rowmap 경계', () => {
  it('toRow → fromRow 왕복이 손실 없이 동등하다', () => {
    expect(fromRow(toRow(trip, USER))).toEqual(trip);
  });

  it('toRow는 snake_case 행을 만들고 user_id를 주입한다', () => {
    const row = toRow(trip, USER);
    expect(row.user_id).toBe(USER);
    expect(row.start_date).toBe('2026-08-01');
    expect(row.client_operation_id).toBe(trip.clientOperationId);
    // camelCase 키가 행에 존재하면 경계 위반
    expect('startDate' in row).toBe(false);
    expect('updatedAt' in row).toBe(false);
  });

  it('tombstone(deleted_at)이 왕복에서 보존된다 — 삭제 부활 방지의 전제', () => {
    const dead: LocalTrip = { ...trip, deletedAt: '2026-07-22T12:00:00.000Z' };
    expect(fromRow(toRow(dead, USER)).deletedAt).toBe('2026-07-22T12:00:00.000Z');
  });

  it('빈 날짜는 null로 저장되고 빈 문자열로 복원된다(0-지표 아님)', () => {
    const noDates: LocalTrip = { ...trip, startDate: '', endDate: '' };
    const row = toRow(noDates, USER);
    expect(row.start_date).toBeNull();
    expect(fromRow(row).startDate).toBe('');
  });
});
