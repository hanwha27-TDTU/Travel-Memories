// harness.mjs — 단일 검사 문(docs/TEST_PLAN.md). 게이트를 한 곳에서 실행.
// Phase 0B: typecheck + secret-leak + domain-registry 정합. 이후 Phase에서 게이트 추가.
//
// ── 선택(optional) 게이트의 계약 (2026-07-27 건강진단에서 신설) ──────────────────
//
// **`optional`은 "실패해도 된다"가 아니다. "전제가 없으면 재지 못한다"이다.**
//
//   · exit 2 = 전제 미충족(브라우저 없음·dist 없음·dist가 소스보다 낡음) → **SKIP**
//   · exit 1 = 검사가 실제로 돌았고 위반을 찾음                          → **FAIL**(Required와 동일)
//   · exit 0 = 통과
//
// 왜 이 구분이 필요했나: `verify-editor-live`(라이브 렌더)는 **이 앱에서 유일하게 도는
// 런타임 검출층**인데 harness에도 CI에도 없어서, 전역 playwright를 가진 사람이 기억해서
// 손으로 돌려야만 돌았다. 그런데 harness는 끝날 때 **"모든 Required 게이트 통과"**라고
// 말했다 — 런타임 층을 한 번도 재지 않고 하는 말이었다(§4 정직한 완료 위반). 그리고
// 직전 세션의 M-0037이 바로 그 검사에서 났다. **안 도는 검사가 최근 결함의 발생지였다.**
//
// 그래서 규칙 둘:
//   ① SKIP을 PASS로 반올림하지 않는다. 건너뛴 이유를 화면에 적고, 마지막 줄에서
//      "이번 실행은 그 층을 재지 않았다"고 말한다(§8 — 모르는 것은 '확인 불가').
//   ② CI에서는 전제를 **갖춰서** 돌린다(`.github/workflows/ci.yml`의 live-render job).
//      전제를 갖출 수 있는 곳에서까지 건너뛰면 ①은 그냥 변명이 된다.
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
  { name: 'check-no-synthetic-italic', cmd: 'node scripts/check-no-synthetic-italic.mjs' },
  { name: 'check-edge-fn-ops', cmd: 'node scripts/check-edge-fn-ops.mjs' },
  { name: 'check-node-version', cmd: 'node scripts/check-node-version.mjs' },
  { name: 'check-backup-coverage', cmd: 'node scripts/check-backup-coverage.mjs' },
  { name: 'check-blueprint', cmd: 'node scripts/check-blueprint.mjs' },
  { name: 'check-registry-gen', cmd: 'node scripts/check-registry-gen.mjs' },
  { name: 'check-platform-map', cmd: 'node scripts/check-platform-map.mjs' },
  { name: 'check-lazy-screens', cmd: 'node scripts/check-lazy-screens.mjs' },
  { name: 'check-font-subsets', cmd: 'node scripts/check-font-subsets.mjs' },
  { name: 'check-fn-size', cmd: 'node scripts/check-fn-size.mjs' },
  { name: 'check-sw', cmd: 'node scripts/check-sw.mjs' },
  { name: 'check-hand-counts', cmd: 'node scripts/check-hand-counts.mjs' },
  { name: 'check-doc-counts', cmd: 'node scripts/check-doc-counts.mjs' },
  { name: 'check-timezone', cmd: 'node scripts/check-timezone.mjs' },
  { name: 'check-instant-normalization', cmd: 'node scripts/check-instant-normalization.mjs' },
  { name: 'check-exif-strip-on-share', cmd: 'node scripts/check-exif-strip-on-share.mjs' },
  { name: 'unit-tests', cmd: 'npm run -s test' },
  // 유일한 런타임 층 — 실제 Chromium이 `dist`를 열어 화면·서비스워커·폰트를 잰다.
  // 전제(playwright + 최신 dist)가 없으면 SKIP, 돌았는데 위반이면 FAIL(위 계약 참조).
  { name: 'verify-editor-live', cmd: 'node scripts/verify-editor-live.mjs', optional: true },
];

/** 전제 미충족을 뜻하는 종료코드. `verify-editor-live`가 이 값으로 자기 전제를 알린다. */
const EXIT_PRECONDITION = 2;

let failed = 0;
const skipped = [];
for (const g of gates) {
  process.stdout.write(`▶ ${g.name} ... `);
  try {
    execSync(g.cmd, { stdio: 'pipe' });
    console.log('PASS');
  } catch (e) {
    const out = `${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}`;
    if (g.optional && e.status === EXIT_PRECONDITION) {
      // 전제가 없어 **재지 못했다**. 통과가 아니다 — 이유를 그대로 보여준다.
      console.log('SKIP');
      const why = out.trim().split('\n')[0] || '(이유를 알리지 않음)';
      console.log(`    ↳ ${why}`);
      skipped.push({ name: g.name, why });
      continue;
    }
    console.log('FAIL');
    if (out) process.stderr.write(out);
    failed++;
  }
}

if (failed > 0) {
  console.error(`\nharness: ${failed} gate(s) FAILED`);
  process.exit(1);
}

// 마지막 줄이 이 실행의 **판정문**이다. 건너뛴 것이 있는데 "모두 통과"라고 쓰면 거짓말이 된다.
if (skipped.length > 0) {
  console.log(`\nharness: Required 게이트 통과 · 선택 ${skipped.length}개 **건너뜀**`);
  for (const s of skipped) console.log(`  · ${s.name} — 재지 못했습니다: ${s.why}`);
  console.log('  → 이 실행은 위 층을 확인하지 않았습니다. 갖추고 돌리려면: npm run build && npm run live');
} else {
  console.log('\nharness: 모든 게이트 통과(선택 게이트 포함 — 건너뛴 것 없음)');
}
