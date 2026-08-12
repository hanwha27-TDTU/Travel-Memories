#!/usr/bin/env node
// check-gate-control — **게이트에 대조군이 있는가, 그리고 그 대조군이 살아 있는가.**
//
// 🔴 왜(사용자 제안 2026-08-12): 헌법 §4는 *"알려진 실패를 주입해 RED로 잡히는지 확인한
//    뒤에만 게이트를 신뢰한다"*고 **조항으로만** 있었다. 지키는지 아무도 안 봤다.
//    실측: 하네스 게이트 62개 중 대조군을 가진 것은 **22개**, 그중 밖에서 돌려 볼 수 있는
//    것은 **12개**뿐이었다(첫 판은 후자만 세면서 전자인 척했다 — 아래 두 기준선 주석 참조).
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
 * 🔴 래칫 기준선 **둘** — 오직 올리기만 한다. 내리는 커밋은 없다.
 *
 * 왜 둘인가(2026-08-12 이 게이트를 만든 다음 판에 발견): 첫 판은 `--selftest` **플래그**만
 * 셌는데, 세어 보니 **대조군을 갖고도 플래그를 안 단 게이트가 14개**였다. 즉 이 게이트는
 * 「대조군 보유」가 아니라 「독립 실행 가능」을 재면서 전자인 척하고 있었다 —
 * **자기가 무엇을 재는지 틀리게 말한 것**이고, 그건 §8이 금하는 반올림이다.
 *
 * 그래서 축을 둘로 가른다:
 *  · `HAS_CONTROL` — 대조군이 **있는가**(`selfTest` 함수의 존재). 이게 §4가 요구하는 것이다.
 *  · `RUNNABLE`    — 그 대조군을 **밖에서 돌려 볼 수 있는가**(`--selftest` 플래그).
 *                    이게 있어야 이 게이트가 「살아 있는지」까지 확인할 수 있다.
 */
export const HAS_CONTROL_BASELINE = 63;
export const RUNNABLE_BASELINE = 15;
/**
 * 🔴 세 번째 축(2026-08-12 · M-0152) — **대조군이 실패를 「판정」으로 알리는가.**
 *
 * 63개 전부 대조군을 갖고 있다. 남은 문제는 **알리는 방식**이다: 23개가 `throw`로 죽어
 * 스택과 함께 `exit 1`이 되고, 하네스는 그것을 「위반을 찾았다」로 적는다. 자체검사 실패는
 * 위반이 아니라 **「이 게이트를 믿을 수 없다」**이므로 `exit 2`가 맞다(§18-G).
 *
 * 한 방향 래칫이다. 23개를 한 번에 바꾸지 않는다 — 급하게 손대면 이번에 피한 §11 ②를 밟는다.
 */
export const CLEAN_EXIT_BASELINE = 40;

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

/**
 * 주석을 지운다. 🔴 **이 게이트가 첫 판에 여기서 뚫렸다** — 호출을 `// selfTest();`로 주석
 * 처리해도 대조군이 살아 있다고 셌다. 오늘 `check-edge-cors`에서 똑같이 당한 자리를
 * 그대로 반복한 것이다(§7 — 한 곳에서 옳은 것은 형제 전부에서 옳다).
 */
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 이 스크립트가 `--selftest`를 **인자로 받아 처리**하는가(주석에 적힌 말이 아니라 코드). */
export function declaresSelftest(src) {
  return /process\.argv\.includes\(\s*['"]--selftest['"]\s*\)/.test(stripComments(src));
}

/**
 * 대조군을 **갖고 있는가** — 플래그와 무관하다.
 *
 * `selfTest` 함수가 정의돼 **있고 실제로 불리는가**를 본다. 정의만 하고 안 부르면
 * 그건 대조군이 아니라 **죽은 코드**이고, 그 게이트는 여전히 공허하다.
 * 인자를 받는 형태(`selfTest(server)`)도 센다 — 살아 있는 실제 자료를 먹이는 대조군이다.
 */
export function hasControl(src) {
  const code = stripComments(src);
  return hasSelfTestFunction(code) || hasInlineSelfCheck(code);
}

/** ① 이름 붙인 형태 — `function selfTest()`를 정의하고 **실제로 부른다**. */
function hasSelfTestFunction(code) {
  if (!/function\s+selfTest\s*\(/.test(code)) return false;
  return /(^|[^\w.])selfTest\s*\([^)]*\)\s*;/m.test(code.replace(/function\s+selfTest\s*\([^)]*\)/g, ''));
}

/**
 * ② 블록 형태 — 이름 없는 `{ … }` 안에서 사례를 돌리고 **실패하면 `exit(2)`로 나간다.**
 *
 * 🔴 이 갈래를 놓쳐서 이 게이트는 **대조군 41개를 「없음」으로 셌다**(2026-08-12 · M-0151).
 *    `check-ui-color-token`은 양성·음성 6사례를 갖고도 「없음」이었다. 검출기가 **한 가지
 *    모양만 알면**, 다른 모양으로 쓴 형제는 전부 결함으로 보인다(§7의 반대 방향 사고).
 *
 * 판정 근거는 이 저장소의 **종료코드 계약**이다: 자체검사 실패는 위반(1)이 아니라
 * **전제 미충족(2)**이다. 그래서 「자체검사가 실패했다고 말하며 exit 2로 나가는 길이
 * 코드에 있는가」를 본다.
 */
function hasInlineSelfCheck(code) {
  return declaresSelfCheckExit(code) || throwsOnSelfCheck(code);
}

/** 자체검사 실패를 **판정으로** 알린다 — 사유를 적고 `exit 2`(전제 미충족)로 나간다. */
export function declaresSelfCheckExit(code) {
  return /(셀프테스트|자체검사|SELF-TEST)/.test(code) && /process\.exit\(\s*2\s*\)/.test(code);
}

/**
 * 자체검사 실패를 **던져서** 알린다 — `throw new Error('SELF-TEST 실패: …')`.
 *
 * 🔴 대조군은 **있지만 알리는 방식이 §18-G에 어긋난다**: 던지면 스택과 함께 `exit 1`이 되고,
 *    하네스는 그것을 **「위반을 찾았다」**로 적는다. 그런데 자체검사 실패는 위반이 아니라
 *    **「이 게이트를 믿을 수 없다」**이다. 그래서 이 형태는 세되 **따로** 센다.
 */
export function throwsOnSelfCheck(code) {
  return /throw\s+new\s+Error\(\s*['"`]SELF-TEST/.test(code);
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
    [
      '대조군: 정의하고 부르면 참',
      () => hasControl(`function selfTest() { }\nselfTest();`),
    ],
    [
      '대조군: 인자를 받는 형태도 참(살아 있는 자료를 먹이는 대조군)',
      () => hasControl(`function selfTest(a) { }\nselfTest(server);`),
    ],
    [
      '🔴 대조군: 정의만 하고 안 부르면 거짓 — 죽은 대조군은 대조군이 아니다',
      () => !hasControl(`function selfTest() { }\nconsole.log('끝');`),
    ],
    ['대조군: 아예 없으면 거짓', () => !hasControl(`console.log('hi');`)],
    [
      '🔴 대조군: **블록 형태**도 참 — 이름을 안 붙였다고 없는 게 아니다(M-0151)',
      () =>
        hasControl(
          `{ const bad = cases.filter(f); if (bad.length) { console.error('x: 셀프테스트 실패'); process.exit(2); } }`,
        ),
    ],
    [
      '블록 형태: exit(2) 없이 말만 하면 거짓(나가지 않으면 판정이 아니다)',
      () => !hasControl(`console.error('셀프테스트 실패했지만 계속 간다');`),
    ],
    [
      '블록 형태: exit(2)만 있고 자체검사가 아니면 거짓(전제 미충족은 대조군이 아니다)',
      () => !hasControl(`if (!existsSync(X)) { console.error('대상 없음'); process.exit(2); }`),
    ],
    [
      '🔴 대조군: 호출이 **주석 처리**돼 있으면 거짓 — 첫 판이 여기서 뚫렸다',
      () => !hasControl(`function selfTest() { }\n// selfTest();`),
    ],
    [
      '🔴 플래그도 주석이면 거짓 — 같은 함정을 형제에도 건다(§7)',
      () => !declaresSelftest(`// if (process.argv.includes('--selftest')) {}`),
    ],
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
  console.log('check-gate-control: 셀프테스트 통과 (잡아야 할 것 6 · 잡으면 안 되는 것 9)');
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
const runnable = [];
const cleanExit = [];
const dies = [];
const without = [];
for (const g of gates) {
  const code = stripComments(readFileSync(g.script, 'utf8'));
  if (hasControl(code)) withControl.push(g);
  else without.push(g);
  if (declaresSelftest(code)) runnable.push(g);
  if (declaresSelfCheckExit(code)) cleanExit.push(g);
  else if (throwsOnSelfCheck(code)) dies.push(g);
}

// B) 있다고 한 대조군이 **실제로 도는가.** 산문을 믿지 않는다 — 돌려 본다(§18-A: 결론을 직접 묻는다).
const broken = [];
for (const g of runnable) {
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

// A) 래칫 — 두 축 모두 한 방향.
const fell = [];
if (withControl.length < HAS_CONTROL_BASELINE) {
  fell.push(`대조군 보유 ${withControl.length}개 < 기준선 ${HAS_CONTROL_BASELINE}`);
}
if (runnable.length < RUNNABLE_BASELINE) {
  fell.push(`독립 실행 가능 ${runnable.length}개 < 기준선 ${RUNNABLE_BASELINE}`);
}
if (cleanExit.length < CLEAN_EXIT_BASELINE) {
  fell.push(`실패를 판정으로 알리는 게이트 ${cleanExit.length}개 < 기준선 ${CLEAN_EXIT_BASELINE}`);
}
if (fell.length) {
  console.error('check-gate-control: 대조군이 **줄었습니다**.');
  for (const f of fell) console.error(`  ✗ ${f}`);
  console.error('  → 게이트에서 셀프테스트를 빼지 마세요. 대조군 없는 게이트는 공허할 수 있습니다(§4).');
  process.exit(1);
}

console.log(
  `check-gate-control: 게이트 ${gates.length}개 중 **대조군 보유 ${withControl.length}개**(기준선 ${HAS_CONTROL_BASELINE}) · ` +
    `그중 **독립 실행 가능 ${runnable.length}개**(기준선 ${RUNNABLE_BASELINE}) · **실패를 판정으로 알리는 것 ${cleanExit.length}개**(기준선 ${CLEAN_EXIT_BASELINE}) — 돌려 본 것은 전부 통과.`,
);
console.log(
  `    ↳ 정직한 한계: **대조군의 유무와 생존**만 봅니다 — 그 사례가 진짜 위험을 재는지는 못 봅니다(§11 ②).`,
);
console.log(
  `    ↳ 🔴 **돌려 본 것은 ${runnable.length}개뿐입니다.** 나머지 ${withControl.length - runnable.length}개는 ` +
    `대조군이 있다고 **읽었을 뿐** 살아 있는지 재지 못했습니다 — 플래그를 달면 그때 재집니다.`,
);
console.log(
  `    ↳ 🔴 자체검사 실패를 **던져서 죽는** 게이트 ${dies.length}개 — 스택과 함께 exit 1이 되어 ` +
    `하네스가 「위반을 찾았다」로 적습니다. 자체검사 실패는 위반이 아니라 「이 게이트를 믿을 수 없다」입니다(§18-G).` +
    (dies.length ? `\n       ${dies.map((g) => g.name).join(', ')}` : ''),
);
console.log(
  without.length
    ? `    ↳ 아직 대조군이 없는 게이트 ${without.length}개: ${without.map((g) => g.name).join(', ')}`
    : `    ↳ 대조군이 없는 게이트는 **없습니다** — 63개 전부 갖고 있습니다.`,
);
