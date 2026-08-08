// domain/syncReleaseVerdict.ts — 배포 계약과 실행 정체를 사용자 문장으로 옮기는 순수 판정.

import { SYNC_RELEASE_CONTRACT } from '../app/syncReleaseContract.gen';
import type { SyncPhase } from '../services/autoSync';

export type SyncReleaseLevel = 'ok' | 'todo' | 'problem' | 'unknown';

export interface SyncReleaseMetricView {
  label: string;
  actual: string;
  expected: string;
  level: SyncReleaseLevel;
  meaning?: string;
}

export interface SyncReleaseObservation {
  edge: {
    version: number | null;
    ops: string[] | null;
    sourceSha256: string | null;
    serverTime: string | null;
    secretsOk: boolean | null;
    error: string | null;
  };
  runtime: {
    phase: SyncPhase;
    progressLabel: string | null;
    startedAt: string | null;
    progressAt: string | null;
  };
  nowIso: string;
}

function shortHash(hash: string | null): string {
  return hash ? hash.slice(0, 12) : '알 수 없음';
}

function ageMs(nowIso: string, thenIso: string | null): number | null {
  if (!thenIso) return null;
  const now = Date.parse(nowIso);
  const then = Date.parse(thenIso);
  return Number.isFinite(now) && Number.isFinite(then) ? Math.max(0, now - then) : null;
}

function duration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1_000))}초`;
  return `${Math.floor(ms / 60_000)}분`;
}

export function syncReleaseMetrics(observation: SyncReleaseObservation): SyncReleaseMetricView[] {
  const expected = SYNC_RELEASE_CONTRACT.mediaSign;
  const edgeUnknown = observation.edge.error !== null;
  const missingOps = observation.edge.ops === null
    ? null
    : expected.requiredOps.filter((op) => !observation.edge.ops?.includes(op));
  const stalledFor = observation.runtime.phase === 'running'
    ? ageMs(observation.nowIso, observation.runtime.progressAt ?? observation.runtime.startedAt)
    : null;

  return [
    {
      label: 'Edge 함수 규약',
      actual: edgeUnknown ? `확인 실패 — ${observation.edge.error}` : observation.edge.version === null ? '판을 밝히지 않음' : `v${observation.edge.version}`,
      expected: `v${expected.protocolVersion} 이상`,
      level: edgeUnknown || observation.edge.version === null
        ? 'unknown'
        : observation.edge.version >= expected.protocolVersion ? 'ok' : 'problem',
      ...(observation.edge.version !== null && observation.edge.version < expected.protocolVersion
        ? { meaning: '앱보다 낡은 Edge Function입니다. 함수를 먼저 배포하고 운영 대조를 통과시킨 뒤 앱을 배포해야 합니다.' }
        : {}),
    },
    {
      label: 'Edge 필수 연산',
      actual: edgeUnknown || observation.edge.ops === null
        ? '확인 불가'
        : missingOps?.length ? `빠짐 ${missingOps.join(', ')}` : `${observation.edge.ops.length}개 지원`,
      expected: `${expected.requiredOps.length}개 모두 지원`,
      level: edgeUnknown || observation.edge.ops === null ? 'unknown' : missingOps?.length ? 'problem' : 'ok',
      ...(missingOps?.length
        ? { meaning: '소스 일부만 배포됐거나 함수와 앱의 계약이 갈라졌습니다. 빠진 연산이 있는 상태로 동기화하면 안 됩니다.' }
        : {}),
    },
    {
      label: 'Edge 배포 소스',
      actual: shortHash(observation.edge.sourceSha256),
      expected: shortHash(expected.sourceSha256),
      level: edgeUnknown || observation.edge.sourceSha256 === null
        ? 'unknown'
        : observation.edge.sourceSha256 === expected.sourceSha256 ? 'ok' : 'todo',
      ...(observation.edge.sourceSha256 !== null && observation.edge.sourceSha256 !== expected.sourceSha256
        ? { meaning: '앱과 Edge Function의 소스 판이 다릅니다. 새로고침 뒤에도 같으면 Edge 선배포 또는 Pages 배포가 누락됐는지 확인하세요.' }
        : {}),
    },
    {
      label: 'Edge 시크릿',
      actual: observation.edge.secretsOk === null ? '확인 불가' : observation.edge.secretsOk ? '필수 값 있음' : '빠진 값 있음',
      expected: '필수 값 있음',
      level: edgeUnknown || observation.edge.secretsOk === null ? 'unknown' : observation.edge.secretsOk ? 'ok' : 'problem',
      ...(observation.edge.secretsOk === false
        ? { meaning: '배포는 됐지만 R2 연결 시크릿이 빠졌습니다. 사진 동기화 전에 Supabase Edge Function Secrets를 복구해야 합니다.' }
        : {}),
    },
    {
      label: '동기화 단계 전진',
      actual: observation.runtime.phase !== 'running'
        ? '지금 실행 중 아님'
        : stalledFor === null
          ? '실행 중 · 마지막 전진 시각 알 수 없음'
          : `${observation.runtime.progressLabel ?? '준비 중'} · ${duration(stalledFor)} 전 전진`,
      expected: `실행 중이면 ${duration(SYNC_RELEASE_CONTRACT.runtime.stallAfterMs)} 안에 다음 단계`,
      level: observation.runtime.phase !== 'running'
        ? 'ok'
        : stalledFor === null
          ? 'unknown'
          : stalledFor >= SYNC_RELEASE_CONTRACT.runtime.stallAfterMs ? 'problem' : 'ok',
      ...(stalledFor !== null && stalledFor >= SYNC_RELEASE_CONTRACT.runtime.stallAfterMs
        ? { meaning: '같은 단계가 너무 오래 전진하지 않았습니다. 로컬 기록은 원자 적용 전이라 보존됩니다. 페이지를 새로고침한 뒤 [지금 동기화]로 다시 시도하세요.' }
        : {}),
    },
  ];
}

export function syncReleaseHeadline(metrics: readonly SyncReleaseMetricView[]): string {
  if (metrics.some((metric) => metric.level === 'problem')) return '동기화 출고 계약이나 실행 진행에 문제가 있어요';
  if (metrics.some((metric) => metric.level === 'todo')) return '앱과 Edge Function의 배포 판을 맞춰야 해요';
  if (metrics.some((metric) => metric.level === 'unknown')) return '동기화 출고 상태를 모두 확인하지 못했어요';
  return '동기화 출고 계약과 실행 진행이 정상입니다';
}
