// check-page-size-parity.mjs — 페이지 크기 상수가 **두 곳에서 갈라지지 않게**.
//
// 왜: 「서버 계약」 진단이 *"서버가 한 번에 주는 행수가 앱의 가정 이상인가"*를 재는데, 그
// **가정값**을 `serverContract.ts`가 자기 상수로 들고 있다. 진짜 가정은 `canonicalSync.ts`의
// `PAGE_SIZE`(실제로 페이지를 나눠 받는 코드)다. 둘이 갈라지면 진단이 **엉뚱한 값을 기준으로
// 판정**하고, 그때 초록은 아무 뜻도 없다.
//
// 이건 §7 실행 규율 2번(SSOT — 손편집 중복 자체가 결함)의 전형이다. 값을 한쪽에서 import하면
// 좋겠지만 `canonicalSync.ts`의 상수는 모듈 사설(export 안 함)이고, 그걸 export로 여는 것은
// 「이 값은 밖에서 쓰라고 있는 것」이라는 잘못된 신호를 준다. 그래서 **복제는 두되 기계가
// 대조**한다(`gen-registry`와 같은 패턴).
//
// 🔴 정직한 한계: 이 게이트는 *두 숫자가 같은가*까지만 안다. 그 숫자가 **서버의 실제 상한과
// 맞는지**는 정적으로 볼 수 없다 — 그건 진단 도구가 런타임에 재는 몫이다(§10 ② 상태 의존).

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** `const NAME = 123;` 형태에서 숫자를 뽑는다(export 여부 무관). */
export function readNumericConst(src, name) {
  const m = src.match(new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*(\\d+)\\s*;`));
  return m ? Number(m[1]) : null;
}

/** 순수 검사 — 셀프테스트가 가짜 입력으로 직접 돌린다. */
export function comparePageSizes(real, assumed) {
  const problems = [];
  if (real === null) problems.push('canonicalSync.ts에서 PAGE_SIZE를 찾지 못함 — 이름이 바뀌었나?');
  if (assumed === null) problems.push('serverContract.ts에서 ASSUMED_PAGE_SIZE를 찾지 못함 — 이름이 바뀌었나?');
  if (real !== null && assumed !== null && real !== assumed) {
    problems.push(
      `페이지 크기가 갈라짐: canonicalSync PAGE_SIZE=${real} ≠ serverContract ASSUMED_PAGE_SIZE=${assumed}\n` +
        `      → 진단이 틀린 기준으로 판정하게 된다. 둘을 같게 맞추세요.`,
    );
  }
  return problems;
}

// ── 셀프테스트: 알려진 실패를 주입해 RED로 잡히는지 확인(§4) ──
const selfCases = [
  { name: '같으면 통과', real: 1000, assumed: 1000, expectClean: true },
  { name: '다르면 검출', real: 1000, assumed: 500, expectClean: false },
  { name: 'real 파싱 실패 검출', real: null, assumed: 1000, expectClean: false },
  { name: 'assumed 파싱 실패 검출', real: 1000, assumed: null, expectClean: false },
];
const brokenSelf = selfCases.filter((c) => (comparePageSizes(c.real, c.assumed).length === 0) !== c.expectClean);
if (brokenSelf.length) {
  console.error(`check-page-size-parity: 셀프테스트 실패 — 게이트가 공허함: ${brokenSelf.map((c) => c.name).join(', ')}`);
  process.exit(2);
}
// 추출기 자체도 잰다 — 정규식이 조용히 안 맞으면 위 셀프테스트는 통과하고 실검사만 죽는다.
if (readNumericConst('const PAGE_SIZE = 1000;', 'PAGE_SIZE') !== 1000) {
  console.error('check-page-size-parity: 셀프테스트 실패 — 상수 추출기가 사설 const를 못 읽음.');
  process.exit(2);
}
if (readNumericConst('export const ASSUMED_PAGE_SIZE = 1000;', 'ASSUMED_PAGE_SIZE') !== 1000) {
  console.error('check-page-size-parity: 셀프테스트 실패 — 상수 추출기가 export const를 못 읽음.');
  process.exit(2);
}

// ── 실제 검사 ──
const real = readNumericConst(readFileSync(join(ROOT, 'src/services/canonicalSync.ts'), 'utf8'), 'PAGE_SIZE');
const assumed = readNumericConst(readFileSync(join(ROOT, 'src/services/serverContract.ts'), 'utf8'), 'ASSUMED_PAGE_SIZE');
const problems = comparePageSizes(real, assumed);

if (problems.length) {
  console.error('check-page-size-parity: 페이지 크기 계약 위반.');
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log(`check-page-size-parity: OK (셀프테스트 통과 · PAGE_SIZE=${real} 양쪽 일치)`);
