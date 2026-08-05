// check-gate-integrity.mjs — "게이트가 목적에 맞게 작동하고 있는가? 게이트에 대조군이 있는가?"
// (사용자 질문 2026-08-05)를 기계로 되묻는 메타 게이트.
//
// 왜 필요한가: §4는 "알려진 실패를 주입해 RED로 잡히는지 확인한 뒤에만 게이트를 신뢰한다"고
// 말하고, 실측(2026-08-05)으로 이 저장소의 check-*.mjs 45개는 **지금은** 전부 그 규율을
// 지키고 있었다(자체 셀프테스트 보유 + harness.mjs 배선 100%). 그런데 그건 "지금은 그렇다"이지
// "앞으로도 그럴 것이다"가 아니다 — §11이 바로 그 얘기다: **게이트를 만들었다고 그 자리가
// 지켜지는 것이 아니다. 게이트도 검사받아야 한다.** 새 게이트가 셀프테스트 없이 태어나거나,
// harness.mjs 배선을 빼먹으면 그 순간부터 "공허하게 통과하는 게이트"가 조용히 하나 늘어난다 —
// 그리고 지금까지는 그걸 잡는 장치가 **없었다**(이 파일이 그 장치다).
//
// 무엇을 대조군(control)으로 삼는가: 이 저장소가 이미 지키고 있는 두 관례를 SSOT로 삼는다.
//   ① harness.mjs의 gates 배열에 { name: '<파일명>', cmd: '... scripts/<파일명>.mjs' }로 배선됐는가
//   ② 소스에 "셀프테스트 실패/공허" 계열 문구(§4 규율의 실행 흔적)가 있는가
// 둘 다 코드 스타일 관례라 100% 의미론적 보증은 아니다(정직한 한계는 파일 끝에 적는다) — 그래도
// "새 게이트가 이 둘 중 하나 없이 조용히 생기는 것"은 확실히 잡는다.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'check-gate-integrity'; // 이 파일 자신 — harness 배선·자기 자신 존재 검사에서 제외하지 않는다(자기도 대상이다)

/** scripts/의 check-*.mjs 파일명(확장자 제외) 목록. */
export function listCheckFiles(dir) {
  return readdirSync(dir)
    .filter((f) => f.startsWith('check-') && f.endsWith('.mjs'))
    .map((f) => f.slice(0, -4))
    .sort();
}

/**
 * harness.mjs 소스에서 실제로 실행되는 스크립트 파일명(확장자 제외) 집합을 뽑는다.
 * `name:` 필드가 아니라 `cmd:`의 실제 경로에서 뽑는다 — 표시 이름과 파일명이 다를 수 있다
 * (예: `check-known-index`는 `scripts/known.mjs --selftest`를 돈다. 이름=파일명을 가정하면
 * 이 정당한 예외를 "파일 없음"으로 오탐한다 — 실측 2026-08-05, 첫 실행에서 바로 걸렸다).
 */
export function wiredScriptFiles(harnessSrc) {
  return new Set([...harnessSrc.matchAll(/cmd:\s*'[^']*scripts\/([A-Za-z0-9_-]+)\.mjs/g)].map((m) => m[1]));
}

/** §4 규율의 실행 흔적 — "셀프테스트/자체검사/SELF-TEST" + "실패/공허" 근접 등장. */
export function hasSelfTestMarker(src) {
  return /(셀프테스트|자체검사|SELF-TEST)[\s\S]{0,10}(실패|공허)/.test(src);
}

/**
 * 파일 목록 × harness 배선 × 소스 맵을 대조해 문제 목록을 만든다. 순수 함수(§10 ③) — 실제
 * 파일시스템과 분리해 셀프테스트가 가짜 입력으로 돌 수 있게 한다.
 */
/**
 * 🔴 **셀프테스트에 「실패를 기대하는 케이스」가 있는가** (2026-08-05 사용자 질문에서 강화).
 *
 * `hasSelfTestMarker`는 *"셀프테스트라는 말이 나온다"*까지만 안다. **통과 케이스만 있고 실패
 * 케이스가 없어도 그 문구는 붙는다** — 그러면 대조군이 있다고 보고되면서 실제로는 한쪽만
 * 재는 셈이다. 대조군의 본질은 *"정상이 통과한다"*가 아니라 **"이상이 걸린다"**이다.
 *
 * 그래서 **실패를 기대하는 흔적**을 따로 본다. 이 저장소의 셀프테스트는 세 가지 문체를 쓴다:
 *   ⓐ 케이스 표에 부정 기대 — `clean: false` · `expectClean: false`
 *   ⓑ 단언식 throw — *"…를 통과시킴" · "안 냈다" · "못 잡…"* 같은 실패 문구
 *   ⓒ 주입 기록 — `RED` · `주입` · `검출`
 * 셋 중 하나도 없으면 그 셀프테스트는 **정상만 재고 있을 가능성이 높다.**
 *
 * 🔴 **오탐을 피하려고 문체를 실측했다**: 첫 판은 `expectClean: false`만 봤는데 **셋이 오탐**이었다
 * (`clean: false`를 쓰는 문체). 오탐은 빡빡한 게이트가 아니라 **틀린 게이트**이고, 사람이 무시하기
 * 시작하면 그 게이트는 죽는다(§11 ③). 넓히기 전에 48개 전부를 눈으로 대조했다.
 *
 * **정직한 한계**: 이건 여전히 *흔적*이다. 실패 케이스가 **의미 있는지**(진짜 결함을 잡는지)는
 * 기계가 못 본다 — 그 자리는 §4의 **실코드 주입**뿐이다. 실제로 이번 세션에 셀프테스트를
 * 통과한 채로 실코드에서 오탐 12건을 낸 게이트가 있었다(M-0106).
 */
export function hasNegativeCase(src) {
  return [
    /\b(expectClean|clean|ok|valid|pass)\s*:\s*false/,
    /RED/,
    /주입/,
    /toThrow/i,
    /통과시킴|안 냈다|못 잡|잡지 못|놓침|오탐|검출/,
  ].some((p) => p.test(src));
}

export function findProblems(files, wired, srcOf) {
  const problems = [];
  for (const f of files) {
    if (!wired.has(f)) problems.push(`${f}: harness.mjs gates 배열에 배선되지 않음 — 돌지 않는 게이트는 없는 게이트보다 나쁘다`);
    const src = srcOf(f);
    if (!hasSelfTestMarker(src)) problems.push(`${f}: 셀프테스트(대조군) 흔적을 찾지 못함 — §4 "알려진 실패 주입" 규율 미확인`);
    else if (!hasNegativeCase(src)) {
      problems.push(
        `${f}: 셀프테스트에 **실패를 기대하는 케이스**가 없음 — 정상만 재는 대조군은 대조군이 아니다(§4). ` +
          `\`clean: false\` 같은 부정 기대나 "…를 통과시킴" 류의 단언을 하나 이상 두세요`,
      );
    }
  }
  return problems;
}

// ── 셀프테스트: 알려진 위반 셋을 주입해 RED로 잡히는지 확인(게이트 비공허, §4) ──
// 대조군을 갖춘 게이트의 최소 모양: 셀프테스트 문구 **+ 실패를 기대하는 케이스**.
const GOOD_SRC = "// 셀프테스트 실패 시 exit(2)\nconst cases=[{clean:false}];\nif (bad) console.error('셀프테스트 실패');\n";
const NO_TEST_SRC = "// 그냥 검사만 한다\nif (bad) console.error('실패');\n";
// 🔴 셀프테스트라고 **말은 하는데 정상만 재는** 게이트 — 이게 새 검사가 잡을 대상이다.
const PASS_ONLY_SRC = "// 셀프테스트 실패 시 exit(2)\nconst cases=[{clean:true}];\nif (bad) console.error('셀프테스트 실패');\n";
const selfCases = [
  {
    name: '정합 통과(배선+셀프테스트 둘 다 있음)',
    files: ['check-a', 'check-b'],
    wired: new Set(['check-a', 'check-b']),
    src: { 'check-a': GOOD_SRC, 'check-b': GOOD_SRC },
    expectClean: true,
  },
  {
    name: '🔴 셀프테스트가 정상만 재는 것 검출(대조군이 한쪽만 있음)',
    files: ['check-a'],
    wired: new Set(['check-a']),
    src: { 'check-a': PASS_ONLY_SRC },
    expectClean: false,
  },
  {
    name: '배선 누락 검출',
    files: ['check-a', 'check-b'],
    wired: new Set(['check-a']),
    src: { 'check-a': GOOD_SRC, 'check-b': GOOD_SRC },
    expectClean: false,
  },
  {
    name: '셀프테스트 부재 검출',
    files: ['check-a', 'check-b'],
    wired: new Set(['check-a', 'check-b']),
    src: { 'check-a': GOOD_SRC, 'check-b': NO_TEST_SRC },
    expectClean: false,
  },
  {
    name: '문구는 있으나 "실패/공허"와 안 붙어 있으면 미검출(정직한 한계 — 아래 참고)',
    files: ['check-a'],
    wired: new Set(['check-a']),
    src: { 'check-a': '// 셀프테스트를 했다. 그리고 별개로 저 아래에서 실패를 로그로 남긴다.\n'.repeat(1) },
    expectClean: false, // "셀프테스트" 뒤 10자 이내에 "실패/공허"가 없으므로 여전히 걸려야 한다
  },
];
const brokenSelf = selfCases.filter(
  (c) => (findProblems(c.files, c.wired, (f) => c.src[f]).length === 0) !== c.expectClean,
);
if (brokenSelf.length) {
  console.error(`check-gate-integrity: 셀프테스트 실패 — 게이트가 공허함: ${brokenSelf.map((c) => c.name).join(', ')}`);
  process.exit(2);
}

// ── 실제 검사 ──
const scriptsDir = join(ROOT, 'scripts');
// 🔴 **자기 자신을 빼지 않는다.** 예전엔 여기서 `.filter((f) => f !== SELF)`로 제외해 놓고
// 위 주석은 *"제외하지 않는다(자기도 대상이다)"*라고 적혀 있었다 — 주석과 코드가 반대였고,
// 보고 숫자도 하나 적었다(47 vs 실제 48). §11의 대상은 **이 게이트 자신도 포함**이다.
// 실측으로 자기도 두 관례를 지킨다(하네스 배선 ✅ · 대조군 표식 ✅)이므로 뺄 이유가 없었다.
const files = listCheckFiles(scriptsDir);

// 🔴 **자기 자신이 목록에 있는지 못을 박는다**(2026-08-05 · §4 주입에서 나옴).
// 위 제외를 되돌리는 주입을 해 봤더니 **초록이었다** — 대상이 하나 줄었을 뿐 남은 것들은
// 다 통과하므로, 게이트는 *자기가 빠졌다는 사실*을 원리적으로 못 본다. 그 자리를 산문으로
// 두면 다음 사람이 "자기 검사는 자기참조 같은데?" 하고 다시 뺀다. 한 줄로 못을 박는다.
if (!files.includes(SELF)) {
  console.error(`check-gate-integrity: 자기 자신(${SELF})이 검사 대상에서 빠졌습니다 — 게이트도 검사받는다(§11).`);
  process.exit(2);
}
const harnessSrc = readFileSync(join(ROOT, 'scripts/harness.mjs'), 'utf8');
const wired = wiredScriptFiles(harnessSrc);
const srcOf = (f) => readFileSync(join(scriptsDir, `${f}.mjs`), 'utf8');
const problems = findProblems(files, wired, srcOf);

// 반대 방향도 본다 — harness가 존재하지 않는 파일을 가리키면(이름 오타·삭제 뒤 미정리) 그 줄은
// 실행 시점에야 죽는다. 여기서 정적으로 먼저 잡는다. `known.mjs`처럼 check- 접두사가 아닌
// 파일도 게이트일 수 있으므로(위 wiredScriptFiles 주석) 접두사로 거르지 않고 전부 본다.
for (const w of wired) {
  try {
    readFileSync(join(scriptsDir, `${w}.mjs`), 'utf8');
  } catch {
    problems.push(`harness.mjs가 'scripts/${w}.mjs'를 가리키지만 그런 파일이 없음(이름 변경·삭제 뒤 미정리?)`);
  }
}

if (problems.length) {
  console.error(`check-gate-integrity: 게이트 자체의 무결성(대조군·배선) 위반 ${problems.length}건.`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log(`check-gate-integrity: OK (셀프테스트 통과 · check-*.mjs ${files.length}개 전부 배선+대조군 보유)`);
