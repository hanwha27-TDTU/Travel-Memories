// domain/syncProgress.ts — 동기화 진행률의 단일 계약.
//
// 퍼센트는 시간 추정이 아니다. 병렬 실행계획에서 완료가 관찰된 도메인 단위만 센다.
// canonical 확인·파일 대조처럼 분모를 알 수 없는 안전 단계에는 숫자를 붙이지 않는다.

export type SyncProgressPhase = 'preparing' | 'pushing' | 'finalizing' | 'pulling';

export interface SyncProgress {
  phase: SyncProgressPhase;
  /** 전체 관찰 가능 도메인 단계에서 끝난 수. 일반 동기화는 push 6 + pull 6 = 12다. */
  completed: number;
  total: number;
  /** 현재 병렬 묶음에서 끝난 수. */
  phaseCompleted: number;
  phaseTotal: number;
}

export function syncProgressPercent(progress: SyncProgress | null): number | null {
  if (!progress || progress.phase === 'preparing' || progress.total <= 0) return null;
  return Math.round((Math.min(progress.completed, progress.total) / progress.total) * 100);
}

export function syncProgressLabel(progress: SyncProgress | null): string {
  if (!progress || progress.phase === 'preparing') return '동기화 준비·안전 확인 중';
  if (progress.phase === 'pushing') return `보내는 중 ${progress.phaseCompleted}/${progress.phaseTotal} 분야`;
  if (progress.phase === 'pulling') return `받는 중 ${progress.phaseCompleted}/${progress.phaseTotal} 분야`;
  return '서버 반영·대조 확인 중';
}
