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
});
