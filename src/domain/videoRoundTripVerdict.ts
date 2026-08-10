export const VIDEO_ROUND_TRIP_STEPS = [
  'prepare', 'localCommit', 'serverPush', 'serverRead', 'r2Read',
  'devicePull', 'tombstone', 'restore', 'purge', 'cleanup',
] as const;

export type VideoRoundTripStep = typeof VIDEO_ROUND_TRIP_STEPS[number];
export type VideoRoundTripState = 'pass' | 'fail' | 'skipped';

export interface VideoRoundTripStepResult {
  step: VideoRoundTripStep;
  state: VideoRoundTripState;
  ms: number | null;
  error: string | null;
  note: string | null;
}

export interface VideoRoundTripRun {
  at: string;
  steps: VideoRoundTripStepResult[];
  leftoverIds: string[];
  canonicalVersion: string | null;
}

/** 비어 있거나 달라진 세대에서는 진단 fixture 정리 쓰기를 재개하지 않는다. */
export function sameVideoRoundTripGeneration(saved: string | null | undefined, current: string | null | undefined): boolean {
  return typeof saved === 'string' && saved.length > 0 && saved === current;
}

/** 영상 본체와 포스터가 모두 404일 때만 exact R2 cleanup으로 판정한다. */
export function videoRoundTripR2PairAbsent(bodyStatus: number | undefined, posterStatus: number | undefined): boolean {
  return bodyStatus === 404 && posterStatus === 404;
}

export const VIDEO_ROUND_TRIP_LABEL: Record<VideoRoundTripStep, string> = {
  prepare: '합성 영상·포스터 준비',
  localCommit: '시험 가족 원자 저장',
  serverPush: '운영 동기화로 서버 전송',
  serverRead: 'DB 행·메타·operation 되읽기',
  r2Read: 'R2 영상·포스터 해시·재생 확인',
  devicePull: '로컬 사본 제거 후 다른 기기식 복원',
  tombstone: '휴지통 tombstone·바이트 보존',
  restore: '복원·메타·바이트 재확인',
  purge: '영구삭제·원장·R2 부재 확인',
  cleanup: '시험 여행·원장·큐 exact 정리',
};

export function videoRoundTripView(run: VideoRoundTripRun | null): {
  level: 'ok' | 'todo' | 'problem' | 'unknown'; headline: string; actual: string; expected: string;
} {
  if (!run) return { level: 'unknown', headline: '영상 서버 왕복을 아직 실행하지 않았어요', actual: '미실행', expected: '최근 실제 시험 10단계 통과' };
  const failed = run.steps.filter((s) => s.state === 'fail');
  const skipped = run.steps.filter((s) => s.state === 'skipped');
  if (failed.length || run.leftoverIds.length) {
    return {
      level: 'problem',
      headline: run.leftoverIds.length ? '영상 왕복 시험 잔재를 치우지 못했어요' : '영상 서버 왕복이 중간에서 실패했어요',
      actual: `실패 ${failed.length} · 안 잰 단계 ${skipped.length} · 잔재 ${run.leftoverIds.length}`,
      expected: '실패 0 · 안 잰 단계 0 · 잔재 0',
    };
  }
  if (skipped.length) return { level: 'unknown', headline: '영상 서버 왕복을 끝까지 재지 못했어요', actual: `안 잰 단계 ${skipped.length}`, expected: '안 잰 단계 0' };
  return { level: 'ok', headline: '영상·포스터가 서버를 정확히 왕복했어요', actual: '10/10 통과 · 잔재 0', expected: '10/10 통과 · 잔재 0' };
}
