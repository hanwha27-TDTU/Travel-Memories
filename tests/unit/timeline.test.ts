// tests/unit/timeline.test.ts — 타임라인 그룹핑 순수함수 직접 검증(미러 금지).
//
// 시간대 안전(결함군 M-utc-slice): 순간이 속한 "그 날"은 **사용자의 로컬 달력 날짜**다.
// 그래서 픽스처를 UTC 문자열로 박지 않고 `at()`으로 **로컬 시각**에서 만든다 —
// 이러면 UTC·KST 어디서 돌려도 기대값이 흔들리지 않는다(옛 테스트는 UTC 전제라 KST에서 깨졌다).
import { describe, it, expect } from 'vitest';
import { groupMomentsByDay } from '../../src/domain/moment/timeline';
import { localDate } from '../../src/domain/time';
import type { LocalMoment } from '../../src/offline/db';

/** 로컬 달력 시각 → ISO. 어느 시간대에서 돌려도 그 날짜(y-mo-d)에 속한다. */
function at(y: number, mo: number, d: number, h: number, mi = 0): string {
  return new Date(y, mo - 1, d, h, mi).toISOString();
}

function m(partial: Partial<LocalMoment>): LocalMoment {
  const occurredAt = partial.occurredAt ?? at(2026, 7, 10, 9);
  return {
    id: partial.id ?? crypto.randomUUID(),
    tripId: 't1',
    occurredAt,
    title: partial.title ?? '기록',
    note: '',
    emotion: '',
    placeName: '',
    version: 1,
    createdAt: partial.createdAt ?? occurredAt,
    updatedAt: occurredAt,
    deletedAt: partial.deletedAt ?? null,
  };
}

describe('groupMomentsByDay', () => {
  it('날짜별로 묶고 날짜 오름차순으로 정렬한다', () => {
    const groups = groupMomentsByDay([
      m({ occurredAt: at(2026, 7, 11, 8), title: 'B' }),
      m({ occurredAt: at(2026, 7, 10, 18), title: 'A' }),
    ]);
    expect(groups.map((g) => g.date)).toEqual(['2026-07-10', '2026-07-11']);
    expect(groups[0]!.date).toBe('2026-07-10');
  });

  it('같은 날은 발생 시각 오름차순으로 정렬한다', () => {
    const [g] = groupMomentsByDay([
      m({ occurredAt: at(2026, 7, 10, 18), title: '저녁' }),
      m({ occurredAt: at(2026, 7, 10, 9), title: '아침' }),
    ]);
    expect(g!.items.map((x) => x.title)).toEqual(['아침', '저녁']);
  });

  it('tombstone(deletedAt≠null)는 제외한다', () => {
    const groups = groupMomentsByDay([
      m({ occurredAt: at(2026, 7, 10, 9), title: '살아있음' }),
      m({ occurredAt: at(2026, 7, 10, 10), title: '삭제됨', deletedAt: at(2026, 7, 12, 0) }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items).toHaveLength(1);
    expect(groups[0]!.items[0]!.title).toBe('살아있음');
  });

  it('여행 시작일이 있으면 Day 번호를 붙인다', () => {
    const groups = groupMomentsByDay(
      [m({ occurredAt: at(2026, 7, 10, 9) }), m({ occurredAt: at(2026, 7, 12, 9) })],
      '2026-07-10',
    );
    expect(groups.find((g) => g.date === '2026-07-10')!.dayNumber).toBe(1);
    expect(groups.find((g) => g.date === '2026-07-12')!.dayNumber).toBe(3);
  });

  it('시작일이 없으면 dayNumber는 null', () => {
    const [g] = groupMomentsByDay([m({ occurredAt: at(2026, 7, 10, 9) })]);
    expect(g!.dayNumber).toBeNull();
  });

  // ── 회귀 방지(결함군 M-utc-slice) ──
  // 증상: 한국(UTC+9) 새벽 06:48 기록이 타임라인에서 **전날** 그룹에 묶였다.
  // 원인: dayKey가 occurredAt.slice(0,10)으로 UTC 날짜를 뽑았는데 시각 표시·입력·환율은 로컬이었다.
  // 주의: UTC 환경에서는 두 방식이 같아 이 테스트만으로는 못 잡는다 → check-local-date 게이트가 본 방어선.
  it('그룹 날짜 = 사용자의 로컬 달력 날짜(UTC 절단 금지)', () => {
    for (const h of [0, 1, 6, 12, 18, 23]) {
      const iso = at(2026, 7, 16, h, 48);
      const [g] = groupMomentsByDay([m({ occurredAt: iso })]);
      expect(g!.date).toBe(localDate(iso));
      expect(g!.date).toBe('2026-07-16'); // 만든 그 날짜 그대로
    }
  });

  it('로컬 새벽 기록이 전날로 밀리지 않는다(사용자 신고 사례)', () => {
    const dawn = at(2026, 7, 16, 6, 48); // 사용자 사례: 7/16 오전 6:48
    const [g] = groupMomentsByDay([m({ occurredAt: dawn })]);
    expect(g!.date).toBe('2026-07-16');
  });
});
