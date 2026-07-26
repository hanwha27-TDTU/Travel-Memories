// check-registry-gen.mjs — 생성 레지스트리(src/app/registry.gen.ts) 드리프트 게이트.
//
// 커밋된 registry.gen.ts가 SSOT에서 재생성한 결과와 정확히 같은지 대조한다(손편집 중복 방지·§7).
// 다르면 RED — `node scripts/gen-registry.mjs`로 재생성 후 커밋하라는 뜻. 비공허 자체검사 내장.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect, render } from './gen-registry.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src/app/registry.gen.ts');

// ── 비공허 자체검사: 다른 내용이면 반드시 불일치로 잡혀야 한다 ──
(() => {
  const a = render({ gates: ['x'], gateCount: 1, appVersion: '0.0', agentCount: 1, screenCount: 1, migrationCount: 1, changelogCount: 1, researchCount: 1 });
  const b = render({ gates: ['y'], gateCount: 2, appVersion: '0.0', agentCount: 1, screenCount: 1, migrationCount: 1, changelogCount: 1, researchCount: 1 });
  if (a === b) throw new Error('SELF-TEST 실패: 다른 레지스트리가 같은 렌더로 나옴(게이트 공허).');
})();

if (!existsSync(OUT)) {
  console.error('check-registry-gen: src/app/registry.gen.ts 없음 — node scripts/gen-registry.mjs 먼저 실행.');
  process.exit(1);
}

const expected = render(collect());
const actual = readFileSync(OUT, 'utf8');

if (expected !== actual) {
  console.error(
    'check-registry-gen: registry.gen.ts가 SSOT와 어긋남(손 스냅샷 드리프트).\n' +
      '  → node scripts/gen-registry.mjs 로 재생성 후 커밋하세요.',
  );
  process.exit(1);
}

const reg = collect();

// ── 게이트 편집 메타(설명·카테고리) 완전성 ──
// 왜 여기인가: 게이트 목록의 정본은 registry이고, gates.ts는 그 목록에 **사람이 붙이는 말**이다.
// 목록이 늘 때 말이 안 따라오면 가이드 화면에 `check-edge-fn-ops` 같은 이름만 뜬다 — 사용자에겐
// 아무 뜻도 아니다(§8). 실제로 이 표는 12개에서 멈춰 게이트 10개가 이름만 뜨고 있었다.
const gatesTs = readFileSync(join(ROOT, 'src/app/gates.ts'), 'utf8');

/**
 * gates.ts의 한 Record 리터럴에서 키를 뽑는다(순수 — 자체검사가 직접 부른다).
 * 따옴표 키는 **따옴표 안 전체**를 받는다. `[\w-]+`로 좁히면 ASCII 밖 키가 조용히 안 뽑히고,
 * 안 뽑힌 키는 "없는 게이트가 남아 있다" 검사를 통과해 버린다(주입해 보고 발견한 구멍).
 */
export function recordKeys(source, constName) {
  const start = source.indexOf(`export const ${constName}`);
  if (start < 0) return [];
  const open = source.indexOf('{', start);
  const close = source.indexOf('\n};', open);
  const body = source.slice(open, close);
  return [...body.matchAll(/^\s*(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*:/gm)].map((m) => m[1] ?? m[2]);
}

// 비공허 자체검사: 빠진 키가 있으면 반드시 드러나야 한다.
(() => {
  const sample =
    "export const T: Record<string, string> = {\n  a: '1',\n  'b-c': '2',\n  '지운것': '3',\n};\n";
  const keys = recordKeys(sample, 'T');
  if (keys.join(',') !== 'a,b-c,지운것') throw new Error(`SELF-TEST 실패: 키 추출이 틀림(${keys}).`);
  if (recordKeys(sample, '없는것').length !== 0) throw new Error('SELF-TEST 실패: 없는 상수를 찾았다고 함.');
})();

const described = new Set(recordKeys(gatesTs, 'GATE_DESC'));
const categorized = new Set(recordKeys(gatesTs, 'GATE_CATEGORY'));
const metaProblems = [];
for (const g of reg.gates) {
  if (!described.has(g)) metaProblems.push(`GATE_DESC에 '${g}' 설명 없음`);
  if (!categorized.has(g)) metaProblems.push(`GATE_CATEGORY에 '${g}' 분류 없음`);
}
// 반대 방향도 본다 — 지운 게이트의 설명이 남으면 화면이 없는 검사를 있다고 말한다.
for (const k of [...described, ...categorized]) {
  if (!reg.gates.includes(k)) metaProblems.push(`gates.ts에 '${k}'가 있으나 harness엔 없음(지운 게이트?)`);
}

if (metaProblems.length > 0) {
  console.error('check-registry-gen: 게이트 편집 메타(src/app/gates.ts)가 게이트 목록과 어긋남.');
  for (const p of [...new Set(metaProblems)]) console.error(`  - ${p}`);
  console.error('  → src/app/gates.ts의 GATE_DESC·GATE_CATEGORY를 같은 커밋에서 맞추세요.');
  process.exit(1);
}

console.log(
  `check-registry-gen: OK — 게이트 ${reg.gateCount}·에이전트 ${reg.agentCount}·화면 ${reg.screenCount}·마이그 ${reg.migrationCount} 자동 집계 일치, 게이트 설명·분류 ${reg.gateCount}/${reg.gateCount}.`,
);
