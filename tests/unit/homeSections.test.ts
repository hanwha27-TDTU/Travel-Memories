// 홈 상태별 보기 — 칩·구획·접기의 순수 로직 검사.
//
// 문장까지 재는 이유: §10 ③ — 자료구조가 옳아도 사용자에게 가는 문장이 틀릴 수 있다.
// 「완료 7개 모두 보기」의 숫자가 **접힌 개수**가 아니라 **전체 개수**여야 한다는 것이
// 정확히 그 부류다(접힌 4를 적으면 사용자는 4개만 더 있는 줄 안다).
import { describe, expect, it } from 'vitest';
import {
  RECENT_LIMIT,
  STATUS_LABEL,
  STATUS_ORDER,
  homeSections,
  statusChips,
  summaryPool,
  type StatusTrip,
  type TripStatus,
} from '../../src/domain/trip/homeSections';

const T = (status: TripStatus, startDate: string | null = null): StatusTrip => ({ status, startDate });

/** 사용자 실측 데이터(2026-08-06 스크린샷): 완료 7 · 진행 중 2 · 계획 중 0 · 보관 0. */
const REAL = [
  T('completed', '2026-08-01'),
  T('completed', '2026-07-31'),
  T('completed', '2026-07-29'),
  T('completed', '2026-07-20'),
  T('completed', '2026-07-16'),
  T('completed', '2013-07-28'),
  T('completed', '2013-02-14'),
  T('active', '2023-09-23'),
  T('active', null),
];

describe('STATUS_ORDER / STATUS_LABEL', () => {
  it('사용자가 부른 순서 그대로다 — 계획 중 → 진행 중 → 완료 → 보관 중', () => {
    expect(STATUS_ORDER).toEqual(['planned', 'active', 'completed', 'archived']);
    expect(STATUS_ORDER.map((s) => STATUS_LABEL[s])).toEqual(['계획 중', '진행 중', '완료', '보관 중']);
  });
});

describe('statusChips', () => {
  it('0건인 상태는 칩을 만들지 않는다(§8 — 빈 칸은 새 소음)', () => {
    const chips = statusChips(REAL);
    expect(chips.map((c) => c.status)).toEqual(['active', 'completed']);
    expect(chips.map((c) => c.count)).toEqual([2, 7]);
  });

  it('보관 여행이 생기면 칩이 저절로 따라온다(데이터에서 파생)', () => {
    const chips = statusChips([...REAL, T('archived', '2020-01-01'), T('planned', '2027-01-01')]);
    expect(chips.map((c) => c.status)).toEqual(['planned', 'active', 'completed', 'archived']);
    expect(chips.map((c) => c.label)).toEqual(['계획 중', '진행 중', '완료', '보관 중']);
  });

  it('칩 순서는 입력 순서가 아니라 생명주기 순서다', () => {
    // 일부러 거꾸로 넣는다 — 이미 정렬된 자료를 재면 정렬 코드가 없어도 초록이다(§4).
    const chips = statusChips([T('archived'), T('completed'), T('active'), T('planned')]);
    expect(chips.map((c) => c.status)).toEqual(['planned', 'active', 'completed', 'archived']);
  });

  it('여행이 없으면 칩도 없다(줄 자체가 침묵)', () => {
    expect(statusChips([])).toEqual([]);
  });
});

describe('summaryPool', () => {
  it('보관은 첫 화면 대상에서 빠진다', () => {
    const pool = summaryPool([...REAL, T('archived', '2020-01-01')]);
    expect(pool).toHaveLength(REAL.length);
    expect(pool.some((t) => t.status === 'archived')).toBe(false);
  });
});

describe('homeSections', () => {
  it('실측 데이터: 진행 중 2건은 전부, 완료 7건은 3건만 + 나머지 4건은 접힌다', () => {
    const sections = homeSections(REAL);
    expect(sections.map((s) => s.status)).toEqual(['active', 'completed']);

    const active = sections[0]!;
    expect(active.trips).toHaveLength(2);
    expect(active.hiddenCount).toBe(0);
    expect(active.moreLabel).toBeNull(); // 접힌 게 없으면 버튼 문장도 없다

    const done = sections[1]!;
    expect(done.total).toBe(7);
    expect(done.trips).toHaveLength(RECENT_LIMIT);
    expect(done.hiddenCount).toBe(4);
    // 🔴 접힌 4가 아니라 **전체 7**을 적는다 — 4라고 쓰면 사용자는 4개만 더 있는 줄 안다.
    expect(done.moreLabel).toBe('완료 7개 모두 보기');
  });

  it('첫 화면 카드 수가 실제로 줄어든다 — 9장 → 5장(이 변경의 목적)', () => {
    const shown = homeSections(REAL).reduce((n, s) => n + s.trips.length, 0);
    expect(REAL).toHaveLength(9);
    expect(shown).toBe(5);
  });

  it('구획 안은 최신순이고, 날짜 미정은 뒤로 간다(공용 정렬 함수를 통과)', () => {
    // 입력을 일부러 오래된 것부터 넣는다(§4 — 정렬 픽스처는 기대와 반대로 만든다).
    const sections = homeSections([
      T('completed', '2013-02-14'),
      T('completed', null),
      T('completed', '2026-08-01'),
    ]);
    expect(sections[0]!.trips.map((t) => t.startDate)).toEqual(['2026-08-01', '2013-02-14', null]);
  });

  it('완료가 딱 3건이면 접지 않는다(경계값)', () => {
    const s = homeSections([T('completed', '2026-03-01'), T('completed', '2026-02-01'), T('completed', '2026-01-01')])[0]!;
    expect(s.trips).toHaveLength(3);
    expect(s.hiddenCount).toBe(0);
    expect(s.moreLabel).toBeNull();
  });

  it('완료가 4건이면 1건이 접힌다(경계값 바로 위)', () => {
    const s = homeSections([
      T('completed', '2026-04-01'),
      T('completed', '2026-03-01'),
      T('completed', '2026-02-01'),
      T('completed', '2026-01-01'),
    ])[0]!;
    expect(s.hiddenCount).toBe(1);
    expect(s.moreLabel).toBe('완료 4개 모두 보기');
  });

  it('진행 중은 아무리 많아도 접지 않는다 — 그게 홈을 여는 이유다', () => {
    const many = Array.from({ length: 9 }, (_, i) => T('active', `2026-0${i + 1}-01`));
    const s = homeSections(many)[0]!;
    expect(s.trips).toHaveLength(9);
    expect(s.hiddenCount).toBe(0);
  });

  it('계획 중도 접지 않는다(진행 중과 같은 대우 — §7 형제 대칭)', () => {
    const many = Array.from({ length: 6 }, (_, i) => T('planned', `2027-0${i + 1}-01`));
    const s = homeSections(many)[0]!;
    expect(s.trips).toHaveLength(6);
    expect(s.hiddenCount).toBe(0);
  });

  it('보관은 구획을 갖지 않는다(첫 화면에서 침묵 — 칩이 그 문을 연다)', () => {
    const sections = homeSections([T('archived', '2020-01-01'), T('archived', '2019-01-01')]);
    expect(sections).toEqual([]);
  });

  it('빈 상태는 구획을 만들지 않는다 — 세 구획이 늘 서 있지 않는다', () => {
    const sections = homeSections([T('active', '2026-01-01')]);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.status).toBe('active');
  });

  it('구획 순서는 생명주기 순서다(칩과 같은 순서 — §7)', () => {
    const sections = homeSections([T('completed', '2020-01-01'), T('planned', '2027-01-01'), T('active', '2026-01-01')]);
    expect(sections.map((s) => s.status)).toEqual(['planned', 'active', 'completed']);
  });
});
