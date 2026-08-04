#!/usr/bin/env node
// 공개 배포물에 운영 소스맵이 섞이지 않는지 검사한다.
// GitHub Pages는 dist를 그대로 공개하므로 설정과 실제 산출물을 둘 다 본다.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function productionArtifactProblems(viteSource, distFiles = []) {
  const problems = [];
  if (!/build\s*:\s*\{[\s\S]*?sourcemap\s*:\s*false/.test(viteSource)) {
    problems.push('vite.config.ts의 build.sourcemap이 false가 아니다');
  }
  for (const file of distFiles) {
    if (/\.map$/i.test(file)) problems.push(`공개 산출물에 소스맵이 있다: ${file}`);
  }
  return problems;
}

function filesBelow(dir, prefix = '') {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...filesBelow(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

const good = `export default { build: { target: 'es2022', sourcemap: false } };`;
const bad = good.replace('sourcemap: false', 'sourcemap: true');
const selfTests = [
  ['정상 설정과 산출물은 통과', productionArtifactProblems(good, ['assets/app.js']).length === 0],
  ['sourcemap:true 주입을 RED로 잡음', productionArtifactProblems(bad, []).length > 0],
  ['실제 .map 산출물 주입을 RED로 잡음', productionArtifactProblems(good, ['assets/app.js.map']).length > 0],
];
const failed = selfTests.filter(([, ok]) => !ok);
if (failed.length) {
  console.error('check-production-artifacts: 셀프테스트 실패 — 게이트가 공허하다.');
  for (const [name] of failed) console.error(`  ✗ ${name}`);
  process.exit(2);
}
if (process.argv.includes('--selftest')) {
  console.log('check-production-artifacts: 셀프테스트 통과');
  process.exit(0);
}

const problems = productionArtifactProblems(
  readFileSync('vite.config.ts', 'utf8'),
  filesBelow('dist'),
);
if (problems.length) {
  console.error('check-production-artifacts: 공개 배포물 보안 결함');
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exit(1);
}
console.log(`check-production-artifacts: OK — 운영 소스맵 비활성${existsSync('dist') ? '·실제 dist 확인' : ' (dist 미생성: 설정 확인)'}`);
