import { describe, expect, it } from 'vitest';
import { backupBecause, backupHeadline } from '../../src/ui/panels/diagnostics';

describe('백업·복원 판정 문장', () => {
  it('최근 백업은 있지만 파일 왕복을 안 했으면 그 빈칸을 정확히 말한다', () => {
    const input: Parameters<typeof backupHeadline>[0] = { cloud: true, stale: false, roundTrip: null };
    expect(backupHeadline(input)).toContain('되읽어');
    expect(backupBecause(input)).toContain('파일이 있다는 것과 실제로 다시 읽힌다는 것은 다릅니다');
  });

  it('왕복 실패를 백업 파일 부재로 잘못 말하지 않는다', () => {
    const input = { cloud: true, stale: false, roundTrip: 'fail' as const };
    expect(backupHeadline(input)).toContain('복원 왕복에 실패');
    expect(backupBecause({ ...input, roundTripError: '해시 불일치' })).toBe('해시 불일치');
  });

  it('클라우드도 백업도 없는 데이터 유실 위험을 가장 먼저 말한다', () => {
    expect(backupHeadline({ cloud: false, stale: true, roundTrip: 'fail' })).toContain('유일한 사본');
  });

  it('두 층을 모두 통과했을 때만 완료형으로 말한다', () => {
    expect(backupHeadline({ cloud: true, stale: false, roundTrip: 'pass' })).toContain('모두 통과');
  });
});
