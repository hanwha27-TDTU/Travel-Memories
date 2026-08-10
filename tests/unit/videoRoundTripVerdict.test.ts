import { describe, expect, it } from 'vitest';
import {
  VIDEO_ROUND_TRIP_STEPS,
  sameVideoRoundTripGeneration,
  videoRoundTripR2PairAbsent,
  videoRoundTripView,
  type VideoRoundTripRun,
} from '../../src/domain/videoRoundTripVerdict';

const run = (state: 'pass' | 'fail' | 'skipped', leftovers: string[] = []): VideoRoundTripRun => ({
  at: '2026-08-10T00:00:00.000Z',
  canonicalVersion: 'generation-a',
  leftoverIds: leftovers,
  steps: VIDEO_ROUND_TRIP_STEPS.map((step) => ({ step, state, ms: state === 'skipped' ? null : 1, error: state === 'fail' ? '주입 실패' : null, note: null })),
});

describe('영상 서버 왕복 판정', () => {
  it('미실행을 정상으로 반올림하지 않는다', () => expect(videoRoundTripView(null).level).toBe('unknown'));
  it('10단계와 잔재 0건일 때만 정상이다', () => expect(videoRoundTripView(run('pass')).level).toBe('ok'));
  it('단계 실패 또는 exact 잔재가 있으면 문제다', () => {
    expect(videoRoundTripView(run('fail')).level).toBe('problem');
    expect(videoRoundTripView(run('pass', ['fixture-id'])).level).toBe('problem');
  });
  it('안 잰 단계는 실패와 구분해 확인 불가로 둔다', () => expect(videoRoundTripView(run('skipped')).level).toBe('unknown'));
  it('저장 세대가 비거나 달라지면 이전 fixture 정리를 재개하지 않는다', () => {
    expect(sameVideoRoundTripGeneration('', 'generation-b')).toBe(false);
    expect(sameVideoRoundTripGeneration('generation-a', 'generation-b')).toBe(false);
    expect(sameVideoRoundTripGeneration('generation-a', 'generation-a')).toBe(true);
  });
  it('R2 영상 본체와 포스터가 모두 404일 때만 exact cleanup이다', () => {
    expect(videoRoundTripR2PairAbsent(404, 404)).toBe(true);
    expect(videoRoundTripR2PairAbsent(404, 200)).toBe(false);
    expect(videoRoundTripR2PairAbsent(undefined, 404)).toBe(false);
  });
});
