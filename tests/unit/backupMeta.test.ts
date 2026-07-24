// backupMeta 경계 — 신선도 계산(순수). now를 주입해 결정적으로 검증.
import { describe, it, expect } from 'vitest';
import { backupAgeDays, backupFreshness, STALE_DAYS } from '../../src/services/backupMeta';

const DAY = 86_400_000;
const NOW = Date.parse('2026-07-24T12:00:00.000Z');

describe('backupMeta 신선도', () => {
  it('age 계산: 없음/오늘/N일 전', () => {
    expect(backupAgeDays(null, NOW)).toBe(null);
    expect(backupAgeDays(new Date(NOW).toISOString(), NOW)).toBe(0);
    expect(backupAgeDays(new Date(NOW - 3 * DAY).toISOString(), NOW)).toBe(3);
    expect(backupAgeDays('쓰레기', NOW)).toBe(null);
  });

  it('freshness 문구·플래그', () => {
    expect(backupFreshness(null, NOW)).toMatchObject({ never: true, stale: true });
    expect(backupFreshness(new Date(NOW).toISOString(), NOW)).toMatchObject({ never: false, stale: false, text: '마지막 백업: 오늘' });
    expect(backupFreshness(new Date(NOW - DAY).toISOString(), NOW).text).toBe('마지막 백업: 어제');
    expect(backupFreshness(new Date(NOW - (STALE_DAYS - 1) * DAY).toISOString(), NOW).stale).toBe(false);
    expect(backupFreshness(new Date(NOW - STALE_DAYS * DAY).toISOString(), NOW).stale).toBe(true);
  });
});
