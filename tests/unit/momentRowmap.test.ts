// tests/unit/momentRowmap.test.ts — Moment 직렬화 경계 왕복 검증.
import { describe, it, expect } from 'vitest';
import { toMomentRow, fromMomentRow } from '../../src/domain/moment/rowmap';
import type { LocalMoment } from '../../src/offline/db';

const base: LocalMoment = {
  id: 'm1',
  tripId: 't1',
  occurredAt: '2026-07-10T09:20:00.000Z',
  title: '협재 노을',
  note: '',
  emotion: '🥹',
  placeName: '협재 해변',
  version: 3,
  createdAt: '2026-07-10T09:20:00.000Z',
  updatedAt: '2026-07-10T09:25:00.000Z',
  deletedAt: null,
  clientOperationId: 'op-1',
};

describe('moment rowmap 경계', () => {
  it('toMomentRow는 snake_case + user_id를 붙인다', () => {
    const row = toMomentRow(base, 'user-9');
    expect(row.user_id).toBe('user-9');
    expect(row.trip_id).toBe('t1');
    expect(row.place_name).toBe('협재 해변');
    expect(row.occurred_at).toBe('2026-07-10T09:20:00.000Z');
  });

  it('fromMomentRow ∘ toMomentRow = 항등(핵심 필드)', () => {
    const round = fromMomentRow(toMomentRow(base, 'user-9'));
    expect(round).toEqual(base);
  });

  it('빈 occurredAt은 null로, 되읽으면 다시 빈 문자열', () => {
    const row = toMomentRow({ ...base, occurredAt: '' }, 'u');
    expect(row.occurred_at).toBeNull();
    expect(fromMomentRow(row).occurredAt).toBe('');
  });
});
