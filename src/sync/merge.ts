// sync/merge.ts — 동기화 결정의 순수 함수 (docs/SYNC_PROTOCOL.md 불변식).
// 네트워크·DB 의존이 없어 직접 단위테스트로 잠근다(LESSONS §6: 미러 아닌 운영함수 테스트).

import { compareInstants } from '../domain/time';
import type { SyncMeta } from '../offline/db';

/**
 * 서버 행을 로컬에 반영할지 결정. **version 기반 tombstone 우위 + LWW**(SYNC_PROTOCOL 불변식 2).
 *
 * 좀비데이터 절대 방지의 핵심 규칙:
 *  - 삭제(tombstone)는 "강한 의도"다. 활성 사본이 tombstone을 이기려면 **오직 진짜 복원**
 *    (version이 tombstone보다 더 큼)이어야 한다. **벽시계(updatedAt)로는 절대 부활시키지 않는다** —
 *    기기 간 시계 스큐로 오래된 활성 사본의 시각이 우연히 앞서면 삭제가 되살아나던(좀비) 근본 원인.
 *  - 삭제상태가 다르면 version으로만 판정하고, version 동률이면 **삭제가 이긴다**(안전 편향).
 *    → 오래된 백업 복원·지연 pull이 삭제한 데이터를 되살리지 못한다.
 *  - 삭제상태가 같으면(둘 다 활성 또는 둘 다 tombstone) 평범한 LWW(updatedAt→version).
 *
 * SyncMeta만 참조하므로 모든 동기화 엔티티(Trip·Moment·Media·Expense…)에 공통 적용된다.
 */
export function mergeDecision(
  local: SyncMeta | undefined,
  server: SyncMeta,
): 'take-server' | 'keep-local' {
  if (!local) return 'take-server';

  const localDeleted = local.deletedAt != null;
  const serverDeleted = server.deletedAt != null;

  // ── 삭제상태가 다른 전이(활성 ↔ tombstone): version으로만 판정(시계 무시) ──
  if (localDeleted !== serverDeleted) {
    if (server.version > local.version) return 'take-server'; // 진짜 복원/진짜 삭제(더 높은 세대)만 수용
    if (server.version < local.version) return 'keep-local';
    return serverDeleted ? 'take-server' : 'keep-local'; // 동률 → 삭제가 이긴다(부활 금지)
  }

  // ── 삭제상태가 같으면 평범한 LWW(updatedAt 우선 → version → 안정) ──
  //
  // ⚠️ **시각은 문자열이 아니라 순간으로 비교한다**(M-0034, 2026-07-27). 같은 순간이 두 표기로
  // 저장될 수 있었다 — 서버(PostgREST) `…48.34+00:00` vs 로컬(JS) `…48.340Z`. 문자열 대소로 재면
  // 같은 순간인데 한쪽이 크게 나오고, **동률일 때만 도는 version 판정을 건너뛴다**(더 높은 세대의
  // 서버 행이 조용히 무시된다). 표기는 `isoInstant()`가 경계에서 정규화하지만, 비교 자체도
  // 표기에 의존하지 않게 둔다 — 방어선은 하나면 뚫린다.
  //
  // 파싱 불가는 `null` → 시각 판정을 건너뛰고 version으로 간다(모르는 값으로 승부를 내지 않는다).
  const byTime = compareInstants(server.updatedAt, local.updatedAt);
  if (byTime !== null && byTime > 0) return 'take-server';
  if (byTime !== null && byTime < 0) return 'keep-local';
  if (server.version !== local.version) return server.version > local.version ? 'take-server' : 'keep-local';
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
