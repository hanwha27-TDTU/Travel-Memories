// check-domain-wiring.mjs — DOMAIN_REGISTRY 대칭성 게이트 스텁 (docs/DATA_MODEL.md)
// Phase 0B: registry가 기대 엔티티 집합과 정확히 일치하는지 검사(누락/추가 = 실패).
// 이후 Phase에서 엔티티×생명주기노드 매트릭스로 확장한다.
import { readFileSync } from 'node:fs';

const EXPECTED = [
  'trips', 'trip_days', 'moments', 'places', 'media_assets', 'expenses',
  'companions', 'reflections', 'tags', 'profiles', 'trip_companions',
  'moment_tags', 'client_operations', 'user_devices', 'sync_changes',
  'sync_conflicts', 'deletion_jobs', 'ai_artifacts',
];

const src = readFileSync('src/domain/registry.ts', 'utf8');
const found = [...src.matchAll(/table:\s*'([a-z_]+)'/g)].map((m) => m[1]);

const missing = EXPECTED.filter((t) => !found.includes(t));
const extra = found.filter((t) => !EXPECTED.includes(t));

if (missing.length || extra.length) {
  if (missing.length) console.error('  ✗ registry 누락(대칭 위반):', missing.join(', '));
  if (extra.length) console.error('  ✗ registry 미등록 추가:', extra.join(', '));
  console.error('check-domain-wiring: DOMAIN_REGISTRY가 기대 집합과 불일치.');
  process.exit(1);
}
console.log(`check-domain-wiring: OK (${found.length}개 도메인 정합)`);
