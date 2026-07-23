// sync/merge.ts — 동기화 결정의 순수 함수 (docs/SYNC_PROTOCOL.md 불변식).
// 네트워크·DB 의존이 없어 직접 단위테스트로 잠근다(LESSONS §6: 미러 아닌 운영함수 테스트).

import type { SyncMeta } from '../offline/db';

/**
 * 서버 행을 로컬에 반영할지 결정. LWW(최신 updatedAt 우선) + tombstone 우선.
 * tombstone(삭제)도 하나의 수정이므로 updatedAt이 최신이면 활성 행을 이긴다(불변식 2).
 * SyncMeta만 참조하므로 모든 동기화 엔티티(Trip·Moment…)에 공통 적용된다.
 */
export function mergeDecision(
  local: SyncMeta | undefined,
  server: SyncMeta,
): 'take-server' | 'keep-local' {
  if (!local) return 'take-server';
  if (server.updatedAt > local.updatedAt) return 'take-server';
  if (server.updatedAt < local.updatedAt) return 'keep-local';
  // 동일 시각 tiebreak: version 큰 쪽 → 그다음 tombstone이 활성보다 우선
  if (server.version !== local.version) return server.version > local.version ? 'take-server' : 'keep-local';
  if (server.deletedAt && !local.deletedAt) return 'take-server';
  return 'keep-local';
}

/**
 * 빈-클라우드 가드(불변식 4): 서버가 0행인데 로컬에 활성 데이터가 있으면 이상 상황.
 * RLS 오설정·잘못된 프로젝트일 수 있으므로 로컬을 절대 덮어쓰지 않는다.
 */
export function isEmptyCloudAnomaly(serverRowCount: number, localActiveCount: number): boolean {
  return serverRowCount === 0 && localActiveCount > 0;
}

/**
 * 오류 분류: 재시도 가능(네트워크·일시) vs 영구(검증·권한).
 * status undefined = 네트워크 미도달 → 재시도. 401/403 = 인증/권한 → 영구(사용자 개입).
 */
export function classifyError(status: number | undefined): 'retryable' | 'permanent' {
  if (status === undefined) return 'retryable';
  if (status === 429 || status >= 500) return 'retryable';
  if (status === 401 || status === 403) return 'permanent';
  if (status >= 400) return 'permanent';
  return 'retryable';
}
