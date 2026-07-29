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

// ─────────────────────────────────────────────────────────────────────────────
// 빠른 차선 (`--fast` · `npm run gates`) — 2026-07-29, 실측 후 신설
// ─────────────────────────────────────────────────────────────────────────────
// 33개를 다 돌면 **91초**인데, 재보니 그중 28개(정적)는 다 합쳐 **1.8초**였다.
// 나머지가 89초를 먹는다: verify-editor-live 54s · check-timezone 15.5s ·
// verify-diagnostics-live 8s · unit-tests 7.5s.
//
// 그래서 편집 루프용 차선을 둔다 — `slow: true`를 뺀 나머지(정적 + typecheck ≈ 6초).
// typecheck는 뺄 수 없다: 타입이 깨지면 나머지 초록이 아무 뜻도 없다.
//
// 🔴 **이 차선의 유일한 계약**: 무엇을 **안 쟀는지** 반드시 말한다. 오늘(M-0047) 커버리지
// 게이트가 SKIP된 층을 「덮음」이라 말해 Required의 초록이 선택 게이트의 침묵을 덮었다.
// 같은 실수를 속도 개선으로 다시 저지르지 않는다 — 빠른 차선의 판정문은 **「통과」가 아니라
// 「일부만 쟀다」**이다(§2-G · §8).
const FAST = process.argv.includes('--fast');

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
  // 아래 둘은 형제다: 하나는 「이 코드는 누가 읽고 고치나(문서)」를, 다른 하나는
  // 「이 화면은 누가 눈으로 보나(라이브)」를 묻는다. 둘 다 *덮였음의 보증*이 아니라
  // **안 덮인 것이 조용히 생기는 것의 차단**이다(CLAUDE.md §13).
  { name: 'check-live-coverage', cmd: 'node scripts/check-live-coverage.mjs' },
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
  // 두 AI가 **다른 계약을 읽고 있지 않은지**. 2026-07-29에 실제로 네 군데가 갈라져 있었고,
  // 그중 「완료의 정의」는 서로를 포함하지 않았다 — Codex는 화면을 안 보고, Claude는 배포
  // 확인 없이 「완료」라 할 수 있었다(M-0046이 그 형태). 정본은 docs/CONSTITUTION.md 하나다.
  { name: 'check-adapter-parity', cmd: 'node scripts/check-adapter-parity.mjs' },
  { name: 'check-platform-map', cmd: 'node scripts/check-platform-map.mjs' },
  { name: 'check-lazy-screens', cmd: 'node scripts/check-lazy-screens.mjs' },
  { name: 'check-font-subsets', cmd: 'node scripts/check-font-subsets.mjs' },
  { name: 'check-fn-size', cmd: 'node scripts/check-fn-size.mjs' },
  { name: 'check-sw', cmd: 'node scripts/check-sw.mjs' },
  { name: 'check-hand-counts', cmd: 'node scripts/check-hand-counts.mjs' },
  { name: 'check-doc-counts', cmd: 'node scripts/check-doc-counts.mjs' },
  { slow: true, name: 'check-timezone', cmd: 'node scripts/check-timezone.mjs' },
  { name: 'check-instant-normalization', cmd: 'node scripts/check-instant-normalization.mjs' },
  { name: 'check-exif-strip-on-share', cmd: 'node scripts/check-exif-strip-on-share.mjs' },
  { slow: true, name: 'unit-tests', cmd: 'npm run -s test' },
  // 런타임 층 — 실제 Chromium이 `dist`를 열어 **화면에 나가는 것**을 잰다.
  // 전제(playwright + 최신 dist)가 없으면 SKIP, 돌았는데 위반이면 FAIL(위 계약 참조).
  //
  // 둘로 나뉜 이유: 재는 대상이 다르다. 편집기는 **상호작용**(슬라이더·브러시·픽셀 read-back)을,
  // 진단은 **전달**(사용자에게 가는 문장·자리·버튼)을 잰다. 후자는 2026-07-28 M-0046 때
  // **아예 없던 층**이다 — 게이트 31종·유닛 686건이 전부 초록인 채로 거짓 안내가 배포됐고,
  // 30분 뒤 사용자 실기기 스크린샷이 잡았다(§10 ③).
  { slow: true, name: 'verify-editor-live', cmd: 'node scripts/verify-editor-live.mjs', optional: true },
  { slow: true, name: 'verify-diagnostics-live', cmd: 'node scripts/verify-diagnostics-live.mjs', optional: true },
];

/**
 * 전제 미충족을 뜻하는 종료코드. 라이브 게이트들이 이 값으로 자기 전제를 알린다.
 *
 * 🔴 **이 값은 `optional`일 때만 SKIP이다.** 아래 분기의 `g.optional &&`가 그 경계이고,
 * 그건 실수가 아니라 계약이다 — 정적 게이트 15종은 **셀프테스트가 공허할 때** 같은 `2`를
 * 낸다(저장소 관용구). Required이므로 지금은 올바르게 **FAIL**로 잡힌다.
 *
 * > 그러나 **게이트 하나를 `optional`로 바꾸는 순간, 그 게이트의 「나는 공허하다」는 비명이
 * > 조용한 SKIP이 된다.** 같은 숫자가 두 가지를 뜻하기 때문이다(2026-07-28 점검에서 확인).
 * > 그래서 규칙: **정적 게이트를 optional로 승격할 때는 그 게이트의 셀프테스트 실패 코드를
 * > 먼저 `1`로 바꾼다.** 전제 미충족과 공허함은 정반대의 사건이다.
 */
const EXIT_PRECONDITION = 2;

let failed = 0;
const skipped = [];
const notMeasured = [];
for (const g of gates) {
  if (FAST && g.slow) {
    notMeasured.push(g.name);
    continue;
  }
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
if (FAST) {
  // 「통과」라고 쓰지 않는다 — 이 실행은 무거운 층을 **아예 안 돌렸다.**
  console.log(`\nharness(빠른 차선): 재본 ${gates.length - notMeasured.length}개 통과 · **${notMeasured.length}개는 아예 안 쟀습니다**`);
  console.log(`  · 안 잰 것: ${notMeasured.join(', ')}`);
  console.log('  → 커밋 전에는 반드시 전체를 돌리세요: npm run build && npm run harness');
} else if (skipped.length > 0) {
  console.log(`\nharness: Required 게이트 통과 · 선택 ${skipped.length}개 **건너뜀**`);
  for (const s of skipped) console.log(`  · ${s.name} — 재지 못했습니다: ${s.why}`);
  console.log('  → 이 실행은 위 층을 확인하지 않았습니다. 갖추고 돌리려면: npm run build && npm run live');
} else {
  console.log('\nharness: 모든 게이트 통과(선택 게이트 포함 — 건너뛴 것 없음)');
}
