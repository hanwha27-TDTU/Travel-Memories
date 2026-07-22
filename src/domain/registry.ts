// domain/registry.ts — DOMAIN_REGISTRY (대칭성 SSOT · docs/DATA_MODEL.md)
// 모든 사용자 도메인은 형제다. 신규 엔티티는 여기에 등록하고 모든 생명주기 노드를
// 배선하거나 명시적으로 제외(⛔)해야 한다. 침묵 공백은 대칭 위반(❌).
// Phase 0B에서는 목록만 선언하고, 노드별 배선/게이트는 이후 Phase에서 채운다.

export type DataClass = 'user' | 'ledger' | 'join' | 'profile' | 'sync-control';

export interface DomainSpec {
  readonly key: string;
  readonly table: string;
  readonly dataClass: DataClass;
  /** ⛔ 명시적 제외 사유(비어 있으면 완전 배선 대상). */
  readonly excludeReason?: string;
}

export const DOMAIN_REGISTRY = [
  { key: 'trip', table: 'trips', dataClass: 'user' },
  { key: 'tripDay', table: 'trip_days', dataClass: 'user' },
  { key: 'moment', table: 'moments', dataClass: 'user' },
  { key: 'place', table: 'places', dataClass: 'user' },
  { key: 'media', table: 'media_assets', dataClass: 'user' },
  { key: 'expense', table: 'expenses', dataClass: 'user' },
  { key: 'companion', table: 'companions', dataClass: 'user' },
  { key: 'reflection', table: 'reflections', dataClass: 'user' },
  { key: 'tag', table: 'tags', dataClass: 'user' },
  { key: 'profile', table: 'profiles', dataClass: 'profile', excludeReason: '사용자 1:1 프로필, 도메인 아님' },
  { key: 'tripCompanion', table: 'trip_companions', dataClass: 'join', excludeReason: '조인 테이블 — 부모와 함께 동기화' },
  { key: 'momentTag', table: 'moment_tags', dataClass: 'join', excludeReason: '조인 테이블 — 부모와 함께 동기화' },
  { key: 'clientOperation', table: 'client_operations', dataClass: 'ledger', excludeReason: '멱등성 원장' },
  { key: 'userDevice', table: 'user_devices', dataClass: 'sync-control', excludeReason: '동기화 제어' },
  { key: 'syncChange', table: 'sync_changes', dataClass: 'sync-control', excludeReason: '변경 커서' },
  { key: 'syncConflict', table: 'sync_conflicts', dataClass: 'sync-control', excludeReason: '충돌 기록' },
  { key: 'deletionJob', table: 'deletion_jobs', dataClass: 'sync-control', excludeReason: '삭제 상태머신' },
  { key: 'aiArtifact', table: 'ai_artifacts', dataClass: 'ledger', excludeReason: 'AI 출처 — Phase 7' },
] as const satisfies readonly DomainSpec[];

/** 완전 배선 대상(사용자 도메인) 키 목록. */
export const USER_DOMAINS = (DOMAIN_REGISTRY as readonly DomainSpec[])
  .filter((d) => !d.excludeReason)
  .map((d) => d.key);
