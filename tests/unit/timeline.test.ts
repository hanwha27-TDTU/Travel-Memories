// tests/unit/timeline.test.ts — 타임라인 그룹핑 순수함수 직접 검증(미러 금지).
//
// 시간대 안전(결함군 M-utc-slice): 순간이 속한 "그 날"은 **사용자의 로컬 달력 날짜**다.
// 그래서 픽스처를 UTC 문자열로 박지 않고 `at()`으로 **로컬 시각**에서 만든다 —
// 이러면 UTC·KST 어디서 돌려도 기대값이 흔들리지 않는다(옛 테스트는 UTC 전제라 KST에서 깨졌다).
import { describe, it, expect } from 'vitest';
import { groupMomentsByDay } from '../../src/domain/moment/timeline';
import { localDate, deviceZone, type TripClock } from '../../src/domain/time';
import type { LocalMoment } from '../../src/offline/db';

/**
 * **기기 시간대 시계** — 옛 회귀 검사들이 그대로 유효하게 하는 자다.
 *
 * 이 파일의 기존 검사들은 「UTC로 자르지 않는다」를 잠그는 것이고, 그 계약은 지금도 산다.
 * 다만 이제 기준이 **여행 시간대**이므로, 옛 기대값을 유지하려면 시계를 기기로 놓아야 한다.
 * 아래 「여행 시간대」 블록이 *새* 계약을 따로 잠근다(§11 ② — 케이스를 지우지 않고 나눈다).
 */
const DEVICE: TripClock = { zone: deviceZone(), homeZone: deviceZone() };

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
    const groups = groupMomentsByDay(
      [m({ occurredAt: at(2026, 7, 11, 8), title: 'B' }), m({ occurredAt: at(2026, 7, 10, 18), title: 'A' })],
      DEVICE,
    );
    expect(groups.map((g) => g.date)).toEqual(['2026-07-10', '2026-07-11']);
    expect(groups[0]!.date).toBe('2026-07-10');
  });

  it('같은 날은 발생 시각 오름차순으로 정렬한다', () => {
    const [g] = groupMomentsByDay(
      [m({ occurredAt: at(2026, 7, 10, 18), title: '저녁' }), m({ occurredAt: at(2026, 7, 10, 9), title: '아침' })],
      DEVICE,
    );
    expect(g!.items.map((x) => x.title)).toEqual(['아침', '저녁']);
  });

  it('tombstone(deletedAt≠null)는 제외한다', () => {
    const groups = groupMomentsByDay(
      [
        m({ occurredAt: at(2026, 7, 10, 9), title: '살아있음' }),
        m({ occurredAt: at(2026, 7, 10, 10), title: '삭제됨', deletedAt: at(2026, 7, 12, 0) }),
      ],
      DEVICE,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items).toHaveLength(1);
    expect(groups[0]!.items[0]!.title).toBe('살아있음');
  });

  it('여행 시작일이 있으면 Day 번호를 붙인다', () => {
    const groups = groupMomentsByDay(
      [m({ occurredAt: at(2026, 7, 10, 9) }), m({ occurredAt: at(2026, 7, 12, 9) })],
      DEVICE,
      '2026-07-10',
    );
    expect(groups.find((g) => g.date === '2026-07-10')!.dayNumber).toBe(1);
    expect(groups.find((g) => g.date === '2026-07-12')!.dayNumber).toBe(3);
  });

  it('시작일이 없으면 dayNumber는 null', () => {
    const [g] = groupMomentsByDay([m({ occurredAt: at(2026, 7, 10, 9) })], DEVICE);
    expect(g!.dayNumber).toBeNull();
  });

  // ── 회귀 방지(결함군 M-utc-slice) ──
  // 증상: 한국(UTC+9) 새벽 06:48 기록이 타임라인에서 **전날** 그룹에 묶였다.
  // 원인: dayKey가 occurredAt.slice(0,10)으로 UTC 날짜를 뽑았는데 시각 표시·입력·환율은 로컬이었다.
  // 주의: UTC 환경에서는 두 방식이 같아 이 테스트만으로는 못 잡는다 → check-local-date 게이트가 본 방어선.
  it('그룹 날짜 = 사용자의 로컬 달력 날짜(UTC 절단 금지)', () => {
    for (const h of [0, 1, 6, 12, 18, 23]) {
      const iso = at(2026, 7, 16, h, 48);
      const [g] = groupMomentsByDay([m({ occurredAt: iso })], DEVICE);
      expect(g!.date).toBe(localDate(iso));
      expect(g!.date).toBe('2026-07-16'); // 만든 그 날짜 그대로
    }
  });

  it('로컬 새벽 기록이 전날로 밀리지 않는다(사용자 신고 사례)', () => {
    const dawn = at(2026, 7, 16, 6, 48); // 사용자 사례: 7/16 오전 6:48
    const [g] = groupMomentsByDay([m({ occurredAt: dawn })], DEVICE);
    expect(g!.date).toBe('2026-07-16');
  });

  // ── 새 계약(M-0049 후반): Day 묶기는 **여행 시간대**로 잰다 ──
  //
  // 왜 여기가 가장 무거운가: 시각이 두 시간 틀리면 「저녁쯤」으로 뭉개져 읽히지만, **날짜가
  // 밀리면 없던 Day가 생긴다.** 하루가 두 조각으로 갈리고 Day 번호가 전부 한 칸씩 움직인다.
  describe('여행 시간대 기준(그 자리의 시계)', () => {
    const VIETNAM: TripClock = { zone: 'Asia/Ho_Chi_Minh', homeZone: 'Asia/Seoul' };

    it('베트남 23:30(UTC+7)은 한국에서 열어도 그 날에 남는다', () => {
      // 절대시각 2026-07-16T16:30Z = 베트남 23:30 = 한국 01:30(7/17).
      // 기기(한국) 기준이면 7/17로 밀린다 — 그게 사용자가 본 결함이다.
      const [g] = groupMomentsByDay([m({ occurredAt: '2026-07-16T16:30:00.000Z' })], VIETNAM);
      expect(g!.date).toBe('2026-07-16');
    });

    it('순간에 적힌 오프셋이 여행 시간대를 이긴다(EXIF OffsetTimeOriginal · 사용자 예외)', () => {
      // 같은 절대시각을 +540(한국)으로 적어 두면 7/17 01:30 — 그 순간만 다른 날이 된다.
      // 여행 중 국경을 넘은 경우가 정확히 이 형태다.
      const one = m({ occurredAt: '2026-07-16T16:30:00.000Z' });
      const [g] = groupMomentsByDay([{ ...one, tzOffsetMin: 540 }], VIETNAM);
      expect(g!.date).toBe('2026-07-17');
    });

    it('Day 번호도 여행 시간대로 센다', () => {
      const groups = groupMomentsByDay(
        [m({ occurredAt: '2026-07-16T16:30:00.000Z' })],
        VIETNAM,
        '2026-07-16',
      );
      expect(groups[0]!.dayNumber).toBe(1); // 기기(한국) 기준이면 2가 된다
    });

    it('시간대 미지정이면 기기 시간대로 묶는다(값을 지어내지 않되 화면을 비우지도 않는다)', () => {
      const iso = at(2026, 7, 16, 6, 48);
      const [g] = groupMomentsByDay([m({ occurredAt: iso })], { zone: '', homeZone: 'Asia/Seoul' });
      expect(g!.date).toBe(localDate(iso));
    });
  });
});
