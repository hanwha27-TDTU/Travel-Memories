// tests/unit/timeline.test.ts — 타임라인 그룹핑 순수함수 직접 검증(미러 금지).
import { describe, it, expect } from 'vitest';
import { groupMomentsByDay } from '../../src/domain/moment/timeline';
import type { LocalMoment } from '../../src/offline/db';

function m(partial: Partial<LocalMoment>): LocalMoment {
  return {
    id: partial.id ?? crypto.randomUUID(),
    tripId: 't1',
    occurredAt: partial.occurredAt ?? '2026-07-10T09:00:00.000Z',
    title: partial.title ?? '기록',
    note: '',
    emotion: '',
    placeName: '',
    version: 1,
    createdAt: partial.createdAt ?? partial.occurredAt ?? '2026-07-10T09:00:00.000Z',
    updatedAt: '2026-07-10T09:00:00.000Z',
    deletedAt: partial.deletedAt ?? null,
  };
}

describe('groupMomentsByDay', () => {
  it('날짜별로 묶고 날짜 오름차순으로 정렬한다', () => {
    const groups = groupMomentsByDay([
      m({ occurredAt: '2026-07-11T08:00:00.000Z', title: 'B' }),
      m({ occurredAt: '2026-07-10T18:00:00.000Z', title: 'A' }),
    ]);
    expect(groups.map((g) => g.date)).toEqual(['2026-07-11', '2026-07-10'].sort());
    expect(groups[0]!.date).toBe('2026-07-10');
  });

  it('같은 날은 발생 시각 오름차순으로 정렬한다', () => {
    const [g] = groupMomentsByDay([
      m({ occurredAt: '2026-07-10T18:00:00.000Z', title: '저녁' }),
      m({ occurredAt: '2026-07-10T09:00:00.000Z', title: '아침' }),
    ]);
    expect(g!.items.map((x) => x.title)).toEqual(['아침', '저녁']);
  });

  it('tombstone(deletedAt≠null)는 제외한다', () => {
    const groups = groupMomentsByDay([
      m({ occurredAt: '2026-07-10T09:00:00.000Z', title: '살아있음' }),
      m({ occurredAt: '2026-07-10T10:00:00.000Z', title: '삭제됨', deletedAt: '2026-07-12T00:00:00.000Z' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items).toHaveLength(1);
    expect(groups[0]!.items[0]!.title).toBe('살아있음');
  });

  it('여행 시작일이 있으면 Day 번호를 붙인다', () => {
    const groups = groupMomentsByDay(
      [
        m({ occurredAt: '2026-07-10T09:00:00.000Z' }),
        m({ occurredAt: '2026-07-12T09:00:00.000Z' }),
      ],
      '2026-07-10',
    );
    expect(groups.find((g) => g.date === '2026-07-10')!.dayNumber).toBe(1);
    expect(groups.find((g) => g.date === '2026-07-12')!.dayNumber).toBe(3);
  });

  it('시작일이 없으면 dayNumber는 null', () => {
    const [g] = groupMomentsByDay([m({ occurredAt: '2026-07-10T09:00:00.000Z' })]);
    expect(g!.dayNumber).toBeNull();
  });
});
