#!/usr/bin/env node
// Dependabot 일반 version PR은 Ready로 열려 전체 harness/live를 실행한다.
// 원자 릴리스 규칙을 지키기 위해 security update만 허용한다.

import { readFileSync } from 'node:fs';

export function dependabotProblems(text) {
  const ecosystems = [...text.matchAll(/package-ecosystem:\s*([^\s]+)([\s\S]*?)(?=\n\s*- package-ecosystem:|$)/g)];
  if (!ecosystems.length) return ['package-ecosystem 설정이 없다'];
  return ecosystems
    .filter(([, , block]) => !/open-pull-requests-limit:\s*0\b/.test(block))
    .map(([, name]) => `${name}: 일반 version update가 활성화돼 있다`);
}

const good = 'updates:\n  - package-ecosystem: npm\n    directory: /\n    open-pull-requests-limit: 0\n';
const bad = good.replace(': 0', ': 5');
if (dependabotProblems(good).length || !dependabotProblems(bad).length) {
  console.error('check-dependabot-policy: 셀프테스트 실패 — 일반 업데이트 주입을 잡지 못함');
  process.exit(2);
}
if (process.argv.includes('--selftest')) {
  console.log('check-dependabot-policy: 셀프테스트 통과');
  process.exit(0);
}
const problems = dependabotProblems(readFileSync('.github/dependabot.yml', 'utf8'));
if (problems.length) {
  console.error('check-dependabot-policy: 원자 릴리스 정책 위반');
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exit(1);
}
console.log('check-dependabot-policy: OK — 일반 version update 중지·security update 전용');
