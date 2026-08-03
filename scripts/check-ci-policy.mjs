// check-ci-policy.mjs — 헌법 §15(CI 실행 정책)에서 워크플로가 조용히 벗어나는 것을 막는다.
//
// 왜 필요한가: §15는 *"어떤 초록이 무엇을 뜻하는가"*를 계약으로 정한다. 그런데 그 뜻은
// 워크플로 파일이 실제로 그렇게 돌 때만 참이다. 조항(1층)과 파일(2층)만 있으면 갈라진다 —
// 이 저장소가 ROADMAP에서 실제로 겪은 부채가 그 형태였다(§7 3층이 없으면 드리프트한다).
//
// 무엇을 판정하나:
//  ① `ci.yml`이 **main에서 돌지 않는가**(④ 중복 제거) — push 트리거가 없어야 한다
//  ② 전체 검사(`harness`·`live-render`)가 **draft에서 제외**되는가(①②)
//  ③ 취소 정책이 켜져 있는가(③)
//  ④ `deploy-pages.yml`이 **여전히 harness를 돌리는가** — main 쪽 초록의 근거(④의 전제)
//
// 🔴 정직한 한계: 이 게이트는 **파일이 그렇게 적혀 있다**까지만 안다. GitHub이 실제로 그
// 일정대로 도는지는 정적으로 볼 수 없다(§2-J ②의 한계와 같다). 판정문도 그렇게만 말한다.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CI = '.github/workflows/ci.yml';
const DEPLOY = '.github/workflows/deploy-pages.yml';

/** 트리거 블록(`on:` ~ 다음 최상위 키)만 잘라낸다 — 주석의 낱말을 트리거로 오탐하지 않게. */
export function triggerBlock(yaml) {
  const m = /^on:\s*$([\s\S]*?)^(?=[a-z][\w-]*:)/m.exec(yaml);
  return m ? m[1] : '';
}

/** 주석 줄을 걷어낸다(설명문이 판정을 흔들지 않게 — 오탐도 결함 · §2-B ③). */
export function stripComments(yaml) {
  return String(yaml)
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

/**
 * `jobs:` 아래 2칸 들여쓴 job 블록의 본문을 뽑는다.
 *
 * 🔴 정규식으로 하려다 **내 셀프테스트에 잡혔다**: `(?=…|$)`에 `m` 플래그가 붙으면 `$`가
 * 모든 줄 끝에 매치돼 lazy 캡처가 **첫 줄에서 끝난다.** 줄 단위로 세는 편이 정확하고 읽힌다.
 */
export function jobBody(yaml, job) {
  const lines = String(yaml).split('\n');
  const start = lines.findIndex((l) => new RegExp(`^\\s{2}${job}:\\s*$`).test(l));
  if (start === -1) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s{2}[\w-]+:\s*$/.test(lines[i])) break; // 다음 job
    if (/^[\w-]+:/.test(lines[i])) break; // 다음 최상위 키
    body.push(lines[i]);
  }
  return body.join('\n');
}

/** §15 위반을 모두 찾아 문자열 배열로. 빈 배열이면 통과. */
export function findPolicyViolations(ciYaml, deployYaml) {
  const bad = [];
  const ci = stripComments(ciYaml);
  const trig = stripComments(triggerBlock(ciYaml));

  // ① main에서 돌지 않는다 — push 트리거 자체가 없어야 한다(④)
  if (/^\s*push:/m.test(trig)) {
    bad.push('§15④ ci.yml에 push 트리거가 있습니다 — main 병합 뒤 harness가 deploy와 중복으로 돕니다.');
  }
  // ①의 짝: pull_request 트리거가 있어야 draft를 알 수 있다(①②의 전제)
  if (!/^\s*pull_request:/m.test(trig)) {
    bad.push('§15① ci.yml에 pull_request 트리거가 없습니다 — draft 여부를 알 수 없어 ①②가 성립하지 않습니다.');
  }
  if (!/ready_for_review/.test(trig)) {
    bad.push('§15② ready_for_review 타입이 없습니다 — Ready 전환 시 전체 검사가 돌지 않습니다.');
  }

  // ② 전체 검사가 draft에서 제외되는가
  for (const job of ['harness', 'live-render']) {
    const body = jobBody(ci, job);
    if (body === null) {
      bad.push(`§15② ci.yml에 '${job}' job이 없습니다 — 전체 Required 층이 사라졌습니다.`);
      continue;
    }
    if (!/if:[^\n]*draft\s*==\s*false/.test(body)) {
      bad.push(`§15① '${job}'에 draft 제외 조건이 없습니다 — 작업 중에도 전체가 돌아 ①이 무너집니다.`);
    }
  }

  // ①의 좁은 검사가 존재하는가 — 없으면 draft에서 아무것도 안 재게 된다
  if (!/^\s{2}fast-gates:/m.test(ci)) {
    bad.push('§15① fast-gates job이 없습니다 — draft에서 아무 검사도 돌지 않습니다.');
  }

  // ③ 취소 정책
  if (!/cancel-in-progress:\s*true/.test(ci)) {
    bad.push('§15③ ci.yml에 cancel-in-progress: true가 없습니다 — 낡은 실행이 계속 돕니다.');
  }

  // ④ main 쪽 초록의 근거 — deploy가 harness를 돌려야 ④가 「중복 제거」이지 「검사 면제」가 아니다
  if (!/npm run harness/.test(stripComments(deployYaml))) {
    bad.push('§15④ deploy-pages.yml이 harness를 돌리지 않습니다 — main에서 재는 층이 통째로 사라집니다.');
  }
  return bad;
}

// ── 셀프테스트: 알려진 실패를 주입해 잡히는지 + 정상이 통과하는지 양쪽(§2-B) ──
(() => {
  const goodCi = [
    'on:', '  pull_request:', '    types: [opened, synchronize, reopened, ready_for_review]', '',
    'concurrency:', '  cancel-in-progress: true', '',
    'jobs:', '  fast-gates:', '    runs-on: x',
    '  harness:', '    if: ${{ github.event.pull_request.draft == false }}', '    runs-on: x',
    '  live-render:', '    if: ${{ github.event.pull_request.draft == false }}', '    runs-on: x',
  ].join('\n');
  const goodDeploy = 'jobs:\n  build:\n    steps:\n      - run: npm run harness\n';
  if (findPolicyViolations(goodCi, goodDeploy).length !== 0) {
    throw new Error('SELF-TEST 실패: 정상 설정을 위반으로 판정(오탐).');
  }
  // 주입 ①: push 트리거 부활(=main 중복)
  if (findPolicyViolations(goodCi.replace('on:', 'on:\n  push:\n    branches: ["**"]'), goodDeploy).length === 0) {
    throw new Error('SELF-TEST 실패: push 트리거를 통과시킨다.');
  }
  // 주입 ②: draft 가드 제거
  if (findPolicyViolations(goodCi.replace(/    if: \$\{\{ github\.event\.pull_request\.draft == false \}\}\n/, ''), goodDeploy).length === 0) {
    throw new Error('SELF-TEST 실패: draft 가드 누락을 통과시킨다.');
  }
  // 주입 ③: 취소 정책 끔
  if (findPolicyViolations(goodCi.replace('cancel-in-progress: true', 'cancel-in-progress: false'), goodDeploy).length === 0) {
    throw new Error('SELF-TEST 실패: 취소 정책 해제를 통과시킨다.');
  }
  // 주입 ④: deploy에서 harness 제거 → main에서 재는 층이 사라진다
  if (findPolicyViolations(goodCi, 'jobs:\n  build:\n    steps:\n      - run: npm run build\n').length === 0) {
    throw new Error('SELF-TEST 실패: deploy의 harness 제거를 통과시킨다.');
  }
  // 주석 안의 낱말은 판정을 흔들면 안 된다(오탐 방지)
  if (findPolicyViolations(`# push: 를 쓰지 않는 이유를 설명한다\n${goodCi}`, goodDeploy).length !== 0) {
    throw new Error('SELF-TEST 실패: 주석 안의 push를 트리거로 오탐한다.');
  }
})();

for (const f of [CI, DEPLOY]) {
  if (!existsSync(join(ROOT, f))) {
    console.error(`check-ci-policy: ${f}가 없습니다 — CI 층이 사라졌습니다.`);
    process.exit(1);
  }
}

const violations = findPolicyViolations(
  readFileSync(join(ROOT, CI), 'utf8'),
  readFileSync(join(ROOT, DEPLOY), 'utf8'),
);

if (violations.length > 0) {
  for (const v of violations) console.error(`  ✗ ${v}`);
  console.error('check-ci-policy: 워크플로가 헌법 §15에서 벗어났습니다.');
  process.exit(1);
}
console.log(
  'check-ci-policy: OK (셀프테스트 통과 · ci.yml은 PR 전용·draft 제외·취소 켜짐 · deploy가 main harness를 담당)\n' +
    '  ↳ 정직한 한계: 파일이 그렇게 **적혀 있다**까지만 봅니다 — 실제 실행 일정은 정적으로 볼 수 없습니다.',
);
