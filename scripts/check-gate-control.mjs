#!/usr/bin/env node
// check-gate-control — **게이트에 대조군이 있는가, 그리고 그 대조군이 살아 있는가.**
//
// 🔴 왜(사용자 제안 2026-08-12): 헌법 §4는 *"알려진 실패를 주입해 RED로 잡히는지 확인한
//    뒤에만 게이트를 신뢰한다"*고 **조항으로만** 있었다. 지키는지 아무도 안 봤다.
//    실측: 하네스 게이트 62개 중 셀프테스트를 가진 것은 **12개뿐이었다.**
//
// 그리고 그 값은 오늘 바로 치렀다 — `check-edge-cors`를 만들자마자 **오탐 두 건**을 냈다
// (내가 규칙을 설명하려 적은 주석 속 `req.json()` · `media-sign`의 이름 붙인 핸들러).
// 「잡으면 안 되는 것」을 셀프테스트에 넣고서야 잡혔다. 오탐은 「빡빡한 게이트」가 아니라
// **틀린 게이트**이고, 사람이 무시하기 시작하면 그 게이트는 죽는다(§11 ③).
//
// 무엇을 판정하나:
//  A) 셀프테스트를 가진 게이트 수가 **줄지 않는가**(래칫 — 한 방향).
//  B) 있다고 한 셀프테스트가 **실제로 통과**하는가 — 돌려 본다. 검사하는 것도 결함을 갖는다(§11).
//  C) 대상 게이트를 하나도 못 찾으면 **통과가 아니라 exit 2**(§4 — 모집단 0에서 공허하게
//     초록을 내지 않는다. 이 저장소의 최빈 실패다).
//
// 🔴 정직한 한계 — 이 게이트가 **못 보는 것**:
//    「대조군이 *적절한가*」는 판단이지 계산이 아니다. 사례가 몇 개인지는 셀 수 있어도
//    **그 사례가 진짜 위험을 재는지**는 사람만 안다. 실제로 §11 ②가 그 사고를 적어 뒀다 —
//    *"셀프테스트가 옛 전제를 정상 케이스로 못박아 두고 있었다."*
//    그러므로 이 게이트가 보증하는 것은 「대조군이 좋다」가 아니라
//    **「대조군 없는 게이트가 조용히 늘어나는 것의 차단」**이다.
//
// 가정하는 세계(§18-G): 없음 — 작업트리의 파일만 읽고 node로 스크립트를 돌린다.
// 종료코드: 0 통과 · 1 위반 · 2 전제 미충족(모집단 0 · 셀프테스트 실패).

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const HARNESS = 'scripts/harness.mjs';

/**
 * 🔴 래칫 기준선 — **오직 올리기만 한다.**
 * 게이트에 셀프테스트를 하나 붙일 때마다 이 숫자를 함께 올린다. 내리는 커밋은 없다.
 */
export const CONTROL_BASELINE = 12;

/** 하네스에 등록된 게이트 중 `node scripts/*.mjs`로 도는 것의 스크립트 경로를 뽑는다. */
export function gateScripts(harnessSrc) {
  const out = [];
  for (const m of harnessSrc.matchAll(/\{\s*name:\s*'([^']+)'\s*,\s*cmd:\s*'([^']+)'/g)) {
    const [, name, cmd] = m;
    const s = /node\s+(scripts\/[\w.-]+\.mjs)/.exec(cmd);
    if (s) out.push({ name, script: s[1] });
  }
  return out;
}

/** 이 스크립트가 `--selftest`를 **인자로 받아 처리**하는가(주석에 적힌 말이 아니라 코드). */
export function declaresSelftest(src) {
  return /process\.argv\.includes\(\s*['"]--selftest['"]\s*\)/.test(src);
}

function selfTest() {
  const harness = `
    { name: 'check-a', cmd: 'node scripts/check-a.mjs' },
    { name: 'unit-tests', cmd: 'npx vitest run' },
    { name: 'check-b', cmd: 'node scripts/check-b.mjs --strict' },
  `;
  const cases = [
    ['node로 도는 게이트만 뽑는다', () => gateScripts(harness).length === 2],
    ['인자가 붙어도 스크립트를 찾는다', () => gateScripts(harness)[1].script === 'scripts/check-b.mjs'],
    ['npx로 도는 것은 대상이 아니다(오탐 금지)', () => !gateScripts(harness).some((g) => g.name === 'unit-tests')],
    [
      '실제로 --selftest를 처리하면 참',
      () => declaresSelftest(`if (process.argv.includes('--selftest')) { process.exit(0); }`),
    ],
    [
      '🔴 주석에만 적힌 --selftest는 거짓(말이 아니라 코드를 본다)',
      () => !declaresSelftest(`// 사용: node x.mjs --selftest 로 자체검사`),
    ],
    ['처리 코드가 아예 없으면 거짓', () => !declaresSelftest(`console.log('hi');`)],
  ];
  const failed = cases.filter(([, fn]) => !fn());
  if (failed.length) {
    console.error('check-gate-control: 셀프테스트 실패 — 게이트가 공허하다(§4).');
    for (const [name] of failed) console.error(`  ✗ ${name}`);
    process.exit(2);
  }
}

selfTest();
if (process.argv.includes('--selftest')) {
  console.log('check-gate-control: 셀프테스트 통과 (잡아야 할 것 3 · 잡으면 안 되는 것 3)');
  process.exit(0);
}

if (!existsSync(HARNESS)) {
  console.error(`check-gate-control: ${HARNESS}가 없습니다 — 잴 대상을 확보하지 못했습니다.`);
  process.exit(2);
}

const gates = gateScripts(readFileSync(HARNESS, 'utf8')).filter((g) => existsSync(g.script));

// 🔴 대상 0에서 공허하게 통과하지 않는다 — 목록 확보를 **먼저 판정**한다(§4).
if (gates.length === 0) {
  console.error('check-gate-control: 게이트를 하나도 못 찾았습니다 — 재지 못했습니다.');
  process.exit(2);
}

const withControl = [];
const without = [];
for (const g of gates) {
  (declaresSelftest(readFileSync(g.script, 'utf8')) ? withControl : without).push(g);
}

// B) 있다고 한 대조군이 **실제로 도는가.** 산문을 믿지 않는다 — 돌려 본다(§18-A: 결론을 직접 묻는다).
const broken = [];
for (const g of withControl) {
  try {
    execFileSync('node', [g.script, '--selftest'], { stdio: 'pipe' });
  } catch (e) {
    broken.push(`${g.name} (exit ${e.status ?? '?'})`);
  }
}
if (broken.length) {
  console.error('check-gate-control: 대조군이 있다고 했는데 **통과하지 못합니다** — 검사하는 것도 결함을 갖는다(§11).');
  for (const b of broken) console.error(`  ✗ ${b}`);
  process.exit(2); // 판정이 아니라 전제가 무너진 것이다
}

// A) 래칫 — 한 방향.
if (withControl.length < CONTROL_BASELINE) {
  console.error(
    `check-gate-control: 대조군을 가진 게이트가 ${withControl.length}개로 **줄었습니다**(기준선 ${CONTROL_BASELINE}).`,
  );
  console.error('  → 게이트에서 셀프테스트를 빼지 마세요. 대조군 없는 게이트는 공허할 수 있습니다(§4).');
  process.exit(1);
}

console.log(
  `check-gate-control: 게이트 ${gates.length}개 중 대조군 보유 ${withControl.length}개 — 전부 자체검사 통과(기준선 ${CONTROL_BASELINE}).`,
);
console.log(
  `    ↳ 정직한 한계: **대조군의 유무와 생존**만 봅니다 — 그 사례가 진짜 위험을 재는지는 못 봅니다(§11 ②).`,
);
console.log(
  `    ↳ 그리고 **과소평가합니다**: \`--selftest\` 플래그로 노출하지 않고 본문에서 주입하는 게이트가 있습니다` +
    `(check-schema-parity가 그 형태 — 가짜 컬럼을 먹여 RED를 확인한다). 그런 대조군은 여기서 안 세집니다.`,
);
console.log(`    ↳ 아직 대조군이 없는 게이트 ${without.length}개: ${without.map((g) => g.name).join(', ')}`);
