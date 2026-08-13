// tests/unit/momentRowmap.test.ts — Moment 직렬화 경계 왕복 검증.
import { describe, it, expect } from 'vitest';
import { toMomentRow, fromMomentRow } from '../../src/domain/moment/rowmap';
import type { LocalMoment } from '../../src/offline/db';

const base: LocalMoment = {
  id: 'm1',
  tripId: 't1',
  occurredAt: '2026-07-10T09:20:00.000Z',
  tzOffsetMin: 420, // 순간별 시간대 예외도 왕복해야 한다(M-0049)
  title: '협재 노을',
  note: '',
  emotion: '🥹',
  companionNames: '아버지, 어머니',
  placeName: '협재 해변',
  placeLat: 33.3937,
  placeLng: 126.2396,
  // 장소 라이브러리 링크(0023) — **왕복해야 한다.** 빠지면 다른 기기에서 링크만 사라진다.
  placeId: 'pl-1',
  version: 3,
  baseVersion: 3,
  baseCanonicalVersion: 'legacy',
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
    expect(row.place_lat).toBe(33.3937);
    expect(row.place_lng).toBe(126.2396);
    expect(row.place_id).toBe('pl-1');
    expect(row.companion_names).toBe('아버지, 어머니');
    expect(row.occurred_at).toBe('2026-07-10T09:20:00.000Z');
    expect(row.base_version).toBe(3);
    expect(row.base_canonical_version).toBe('legacy');
  });

  it('fromMomentRow ∘ toMomentRow = 항등(핵심 필드)', () => {
    const round = fromMomentRow(toMomentRow(base, 'user-9'));
    expect(round).toEqual(base);
  });

  it('링크가 없는 순간(자유 입력)도 왕복한다 — null이 정상이다', () => {
    const round = fromMomentRow(toMomentRow({ ...base, placeId: null }, 'u'));
    expect(round.placeId).toBeNull();
  });

  it('옛 서버 행에 동행인 열이 없어도 빈 값으로 읽는다', () => {
    const row = toMomentRow(base, 'u');
    delete row.companion_names;
    expect(fromMomentRow(row).companionNames).toBe('');
  });

  it('빈 occurredAt은 null로, 되읽으면 다시 빈 문자열', () => {
    const row = toMomentRow({ ...base, occurredAt: '' }, 'u');
    expect(row.occurred_at).toBeNull();
    expect(fromMomentRow(row).occurredAt).toBe('');
  });
});
