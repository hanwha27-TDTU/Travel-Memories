#!/usr/bin/env node
// Actions 태그는 움직이는 참조다. 제3자 실행 코드는 검증한 40자리 commit SHA로 고정한다.

import { readFileSync, readdirSync } from 'node:fs';

export function unpinnedActions(text) {
  return [...text.matchAll(/^\s*-?\s*uses:\s*([^\s#]+).*$/gm)]
    .map((match) => match[1])
    .filter((value) => value && !/@[0-9a-f]{40}$/i.test(value));
}

const good = 'steps:\n  - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4\n';
const bad = 'steps:\n  - uses: actions/checkout@v4\n';
if (unpinnedActions(good).length !== 0 || unpinnedActions(bad).length !== 1) {
  console.error('check-workflow-pins: 셀프테스트 실패 — 이동 태그 주입을 잡지 못함');
  process.exit(2);
}
if (process.argv.includes('--selftest')) {
  console.log('check-workflow-pins: 셀프테스트 통과');
  process.exit(0);
}

const problems = [];
for (const name of readdirSync('.github/workflows').filter((file) => /\.ya?ml$/.test(file))) {
  for (const action of unpinnedActions(readFileSync(`.github/workflows/${name}`, 'utf8'))) {
    problems.push(`${name}: ${action}`);
  }
}
if (problems.length) {
  console.error('check-workflow-pins: 이동 가능한 Action 참조 발견');
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exit(1);
}
console.log('check-workflow-pins: OK — 모든 GitHub Action이 commit SHA에 고정됨');
