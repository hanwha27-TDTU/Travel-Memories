import { describe, expect, it } from 'vitest';
import { SYNC_RELEASE_CONTRACT } from '../../src/app/syncReleaseContract.gen';
import {
  syncReleaseHeadline,
  syncReleaseMetrics,
  type SyncReleaseObservation,
} from '../../src/domain/syncReleaseVerdict';

const now = '2026-08-08T09:00:00.000Z';

function observation(overrides: Partial<SyncReleaseObservation> = {}): SyncReleaseObservation {
  return {
    edge: {
      version: SYNC_RELEASE_CONTRACT.mediaSign.protocolVersion,
      ops: [...SYNC_RELEASE_CONTRACT.mediaSign.requiredOps],
      sourceSha256: SYNC_RELEASE_CONTRACT.mediaSign.sourceSha256,
      serverTime: now,
      secretsOk: true,
      error: null,
      ...overrides.edge,
    },
    runtime: {
      phase: 'idle',
      progressLabel: null,
      startedAt: null,
      progressAt: null,
      ...overrides.runtime,
    },
    nowIso: overrides.nowIso ?? now,
  };
}

describe('동기화 출고 계약', () => {
  it('정본과 같은 운영 함수는 모두 ok다', () => {
    const metrics = syncReleaseMetrics(observation());
    expect(metrics.every((metric) => metric.level === 'ok')).toBe(true);
    expect(syncReleaseHeadline(metrics)).toContain('정상');
  });

  it('필수 연산 하나가 빠지면 problem이고 이름을 말한다', () => {
    const metrics = syncReleaseMetrics(observation({
      edge: {
        version: 6,
        ops: ['probe'],
        sourceSha256: SYNC_RELEASE_CONTRACT.mediaSign.sourceSha256,
        serverTime: now,
        secretsOk: true,
        error: null,
      },
    }));
    const metric = metrics.find((item) => item.label === 'Edge 필수 연산');
    expect(metric?.level).toBe('problem');
    expect(metric?.actual).toContain('get');
  });

  it('프로토콜은 맞아도 소스가 다르면 배포 드리프트 todo다', () => {
    const metric = syncReleaseMetrics(observation({
      edge: {
        version: 6,
        ops: [...SYNC_RELEASE_CONTRACT.mediaSign.requiredOps],
        sourceSha256: '0'.repeat(64),
        serverTime: now,
        secretsOk: true,
        error: null,
      },
    })).find((item) => item.label === 'Edge 배포 소스');
    expect(metric?.level).toBe('todo');
    expect(metric?.meaning).toContain('배포');
  });
});

describe('실행 정체 판정', () => {
  it('3분 동안 큰 사진을 받는 정상 경로는 멈춤으로 오진하지 않는다', () => {
    const metric = syncReleaseMetrics(observation({
      runtime: {
        phase: 'running',
        progressLabel: '사진 받는 중 80/90',
        startedAt: '2026-08-08T08:55:00.000Z',
        progressAt: '2026-08-08T08:57:00.000Z',
      },
    })).find((item) => item.label === '동기화 단계 전진');
    expect(metric?.level).toBe('ok');
    expect(metric?.actual).toContain('3분');
  });

  it('5분 동안 한 단계도 전진하지 않으면 problem이다', () => {
    const metric = syncReleaseMetrics(observation({
      runtime: {
        phase: 'running',
        progressLabel: '동기화 준비·안전 확인 중',
        startedAt: '2026-08-08T08:55:00.000Z',
        progressAt: '2026-08-08T08:55:00.000Z',
      },
    })).find((item) => item.label === '동기화 단계 전진');
    expect(metric?.level).toBe('problem');
    expect(metric?.meaning).toContain('새로고침');
  });

  it('실행 중인데 시각이 없으면 정상으로 반올림하지 않는다', () => {
    const metric = syncReleaseMetrics(observation({
      runtime: { phase: 'running', progressLabel: null, startedAt: null, progressAt: null },
    })).find((item) => item.label === '동기화 단계 전진');
    expect(metric?.level).toBe('unknown');
  });
});
