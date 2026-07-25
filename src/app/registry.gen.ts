// GENERATED — 손으로 편집하지 마세요. 재생성: node scripts/gen-registry.mjs
// SSOT: scripts/harness.mjs · .claude/{agents,skills}/ · src/ui/screens/ · supabase/migrations/ · src/app/{changelog,researchLog}.ts
// check-registry-gen 게이트가 이 파일이 SSOT와 일치하는지(커밋본==재생성본) 검사합니다.

export const REGISTRY = {
  /** npm run harness가 도는 Required 게이트 이름(정본: scripts/harness.mjs). */
  gates: [
  'typecheck',
  'check-secret-leak',
  'check-domain-wiring',
  'check-csp',
  'check-base-consistency',
  'check-env-wiring',
  'check-schema-parity',
  'check-backup-coverage',
  'check-blueprint',
  'check-registry-gen',
  'check-doc-counts',
  'check-timezone',
  'unit-tests',
  ] as const,
  gateCount: 13,
  agentCount: 28,
  skillCount: 8,
  screenCount: 10,
  migrationCount: 10,
  changelogCount: 64,
  researchCount: 45,
} as const;
