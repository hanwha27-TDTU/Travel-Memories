// domain/syncProgress.ts — 동기화 진행률의 단일 계약.
//
// 퍼센트는 시간 추정이 아니다. 완료가 실제로 관찰된 도메인·파일·커밋 단계만 센다.
// canonical 목록을 읽은 뒤에는 사진·소리 개수를 아니까, 파일 하나를 온전히 내려받아
// 썸네일까지 만든 시점에만 한 칸 전진한다. 준비처럼 분모를 모를 때만 숫자를 숨긴다.

export type SyncProgressPhase =
  | 'preparing'
  | 'canonical-media'
  | 'canonical-audio'
  | 'canonical-applying'
  | 'canonical-verifying'
  | 'pushing'
  | 'finalizing'
  | 'pulling';

export interface SyncProgress {
  phase: SyncProgressPhase;
  /** 전체 관찰 가능 단계에서 끝난 수. 일반 동기화는 push 6 + pull 6 + 마무리 1이다. */
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
  if (progress.phase === 'canonical-media') return `사진 받는 중 ${progress.phaseCompleted}/${progress.phaseTotal}`;
  if (progress.phase === 'canonical-audio') return `소리 받는 중 ${progress.phaseCompleted}/${progress.phaseTotal}`;
  if (progress.phase === 'canonical-applying') return '받은 기록을 이 기기에 반영 중';
  if (progress.phase === 'canonical-verifying') return '받은 기록을 다시 확인 중';
  if (progress.phase === 'pushing') return `보내는 중 ${progress.phaseCompleted}/${progress.phaseTotal} 분야`;
  if (progress.phase === 'pulling') return `받는 중 ${progress.phaseCompleted}/${progress.phaseTotal} 분야`;
  return '서버 반영·대조 확인 중';
}
