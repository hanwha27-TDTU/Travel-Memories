import { describe, expect, it } from 'vitest';
import {
  defaultTimelineOrder,
  orderToggleLabel,
  timelineOrder,
} from '../../src/domain/moment/timelineOrder';
import type { TripStatus } from '../../src/domain/trip/homeSections';

const ALL: TripStatus[] = ['planned', 'active', 'completed', 'archived'];

describe('defaultTimelineOrder — 기록 중과 회고 중은 정반대를 원한다', () => {
  it('🔴 진행 중이면 최신 먼저 — 오늘 쓴 것이 손 닿는 곳에 있어야 한다', () => {
    expect(defaultTimelineOrder('active')).toBe('newest');
  });

  it('🔴 그 밖에는 Day 1 먼저 — 여행은 앞에서 뒤로 읽히는 이야기다', () => {
    for (const s of ALL.filter((x) => x !== 'active')) {
      expect(defaultTimelineOrder(s)).toBe('oldest');
    }
  });

  it('모든 상태가 답을 갖는다(빠진 갈래가 없다)', () => {
    for (const s of ALL) expect(['oldest', 'newest']).toContain(defaultTimelineOrder(s));
  });
});

describe('timelineOrder — 사용자 선택이 언제나 이긴다', () => {
  it('🔴 고른 값이 있으면 상태 기본값을 덮는다(추측이 사실을 덮지 않는다)', () => {
    expect(timelineOrder('active', 'oldest')).toBe('oldest');
    expect(timelineOrder('completed', 'newest')).toBe('newest');
  });

  it('🔴 「아직 안 골랐다」와 「기본값과 같은 값을 골랐다」는 다른 상태다', () => {
    // null이면 상태를 따라간다 — 나중에 상태가 바뀌면 함께 바뀐다.
    expect(timelineOrder('active', null)).toBe('newest');
    expect(timelineOrder('completed', null)).toBe('oldest');
    // 값을 골랐으면 상태가 바뀌어도 그대로다.
    expect(timelineOrder('active', 'oldest')).toBe('oldest');
    expect(timelineOrder('completed', 'oldest')).toBe('oldest');
  });
});

describe('orderToggleLabel — 버튼은 「누르면 무엇이 되는가」를 말한다', () => {
  it('🔴 라벨이 현재 상태가 아니라 **다음 상태**를 가리킨다', () => {
    expect(orderToggleLabel('newest').label).toContain('처음부터');
    expect(orderToggleLabel('oldest').label).toContain('최신부터');
  });

  it('🔴 라벨과 실제 동작이 어긋날 수 없다 — 한 함수가 둘 다 만든다', () => {
    for (const cur of ['oldest', 'newest'] as const) {
      const t = orderToggleLabel(cur);
      expect(t.next).not.toBe(cur);
      expect(orderToggleLabel(t.next).next).toBe(cur); // 두 번 누르면 제자리
    }
  });

  it('화면읽기 라벨이 비어 있지 않다', () => {
    for (const cur of ['oldest', 'newest'] as const) {
      expect(orderToggleLabel(cur).ariaLabel.length).toBeGreaterThan(0);
    }
  });
});
