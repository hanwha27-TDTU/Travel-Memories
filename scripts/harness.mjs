// harness.mjs — 단일 검사 문(docs/TEST_PLAN.md). Required 게이트를 한 곳에서 실행.
// Phase 0B: typecheck + secret-leak + domain-registry 정합. 이후 Phase에서 게이트 추가.
import { execSync } from 'node:child_process';

const gates = [
  { name: 'typecheck', cmd: 'npm run -s typecheck' },
  { name: 'check-secret-leak', cmd: 'node scripts/check-secret-leak.mjs' },
  { name: 'check-domain-wiring', cmd: 'node scripts/check-domain-wiring.mjs' },
  { name: 'check-csp', cmd: 'node scripts/check-csp.mjs' },
  { name: 'check-base-consistency', cmd: 'node scripts/check-base-consistency.mjs' },
  { name: 'check-env-wiring', cmd: 'node scripts/check-env-wiring.mjs' },
  { name: 'check-domain-symmetry', cmd: 'node scripts/check-domain-symmetry.mjs' },
  { name: 'check-verdict-symmetry', cmd: 'node scripts/check-verdict-symmetry.mjs' },
  { name: 'check-skill-routing', cmd: 'node scripts/check-skill-routing.mjs' },
  { name: 'check-self-eval', cmd: 'node scripts/check-self-eval.mjs' },
  { name: 'check-schema-parity', cmd: 'node scripts/check-schema-parity.mjs' },
  { name: 'check-migration-grants', cmd: 'node scripts/check-migration-grants.mjs' },
  { name: 'check-report-fields', cmd: 'node scripts/check-report-fields.mjs' },
  { name: 'check-backup-coverage', cmd: 'node scripts/check-backup-coverage.mjs' },
  { name: 'check-blueprint', cmd: 'node scripts/check-blueprint.mjs' },
  { name: 'check-registry-gen', cmd: 'node scripts/check-registry-gen.mjs' },
  { name: 'check-platform-map', cmd: 'node scripts/check-platform-map.mjs' },
  { name: 'check-doc-counts', cmd: 'node scripts/check-doc-counts.mjs' },
  { name: 'check-timezone', cmd: 'node scripts/check-timezone.mjs' },
  { name: 'unit-tests', cmd: 'npm run -s test' },
];

let failed = 0;
for (const g of gates) {
  process.stdout.write(`▶ ${g.name} ... `);
  try {
    execSync(g.cmd, { stdio: 'pipe' });
    console.log('PASS');
  } catch (e) {
    console.log('FAIL');
    if (e.stdout) process.stderr.write(e.stdout.toString());
    if (e.stderr) process.stderr.write(e.stderr.toString());
    failed++;
  }
}

if (failed > 0) {
  console.error(`\nharness: ${failed} gate(s) FAILED`);
  process.exit(1);
}
console.log('\nharness: 모든 Required 게이트 통과');
