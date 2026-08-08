import { describe, expect, it } from 'vitest';
import { syncProgressLabel, syncProgressPercent } from '../../src/domain/syncProgress';

describe('sync progress contract', () => {
  it('does not invent a percentage while preparation has no measurable denominator', () => {
    const progress = { phase: 'preparing' as const, completed: 0, total: 13, phaseCompleted: 0, phaseTotal: 0 };
    expect(syncProgressPercent(progress)).toBeNull();
    expect(syncProgressLabel(progress)).toContain('준비');
  });

  it('uses settled domain stages instead of elapsed time', () => {
    const progress = { phase: 'pushing' as const, completed: 3, total: 13, phaseCompleted: 3, phaseTotal: 6 };
    expect(syncProgressPercent(progress)).toBe(23);
    expect(syncProgressLabel(progress)).toContain('3/6');
  });

  it('shows real canonical photo counts instead of hiding the whole download as preparation', () => {
    const progress = { phase: 'canonical-media' as const, completed: 56, total: 92, phaseCompleted: 56, phaseTotal: 90 };
    expect(syncProgressPercent(progress)).toBe(61);
    expect(syncProgressLabel(progress)).toBe('사진 받는 중 56/90');
  });

  it('names the atomic apply and read-back boundaries separately', () => {
    expect(syncProgressLabel({
      phase: 'canonical-applying', completed: 90, total: 92, phaseCompleted: 0, phaseTotal: 1,
    })).toContain('반영 중');
    expect(syncProgressLabel({
      phase: 'canonical-verifying', completed: 91, total: 92, phaseCompleted: 0, phaseTotal: 1,
    })).toContain('다시 확인 중');
  });
});
