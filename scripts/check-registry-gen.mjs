// check-registry-gen.mjs — 생성 레지스트리(src/app/registry.gen.ts) 드리프트 게이트.
//
// 커밋된 registry.gen.ts가 SSOT에서 재생성한 결과와 정확히 같은지 대조한다(손편집 중복 방지·§7).
// 다르면 RED — `node scripts/gen-registry.mjs`로 재생성 후 커밋하라는 뜻. 비공허 자체검사 내장.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect, render } from './gen-registry.mjs';
import { runSelfTest } from './gate-selftest-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src/app/registry.gen.ts');

// ── 비공허 자체검사: 다른 내용이면 반드시 불일치로 잡혀야 한다 ──
runSelfTest('check-registry-gen', () => {
  const base = {
    appVersion: '0.0',
    agents: ['a'],
    agentCount: 1,
    logicalRoleCount: 1,
    skillCount: 1,
    screenCount: 1,
    migrationCount: 1,
    changelogCount: 1,
    researchCount: 1,
    // 🔴 새 필드를 더하면 여기도 함께 넓힌다 — 안 그러면 **셀프테스트가 옛 전제를 못박아**
    //    render가 터진다(§11 ②). 2026-08-12에 실제로 그랬고, §18-G의 빈 세계가 잡았다.
    gateControl: [{ name: 'x', control: true, runnable: true, cleanExit: true }],
    gateControlCount: 1,
    gateRunnableCount: 1,
    gateCleanExitCount: 1,
  };
  const a = render({ ...base, gates: ['x'], gateCount: 1 });
  const b = render({ ...base, gates: ['y'], gateCount: 2 });
  if (a === b) throw new Error('SELF-TEST 실패: 다른 레지스트리가 같은 렌더로 나옴(게이트 공허).');
  // 에이전트 목록도 렌더에 실제로 실리는가 — 안 실리면 아래 「양방향 대조」가 공허해진다.
  const c = render({ ...base, gates: ['x'], gateCount: 1, agents: ['zzz-agent'] });
  if (c === a || !c.includes('zzz-agent')) {
    throw new Error('SELF-TEST 실패: 에이전트 목록이 렌더에 반영되지 않음.');
  }
});

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
 *
 * 🔴 이름은 **경계까지** 맞춘다. `indexOf('export const AGENT_CATEGORY')`는
 * `AGENT_CATEGORY_LABEL`을 먼저 집어 엉뚱한 리터럴의 키(`core`·`design`…)를 돌려줬다 —
 * 게이트를 에이전트로 넓히자마자 드러난 구멍이다(§11 ①: 대상을 넓히면 다시 주입하라).
 */
export function recordKeys(source, constName) {
  const start = source.search(new RegExp(`export const ${constName}(?![\\w$])`));
  if (start < 0) return [];
  const open = source.indexOf('{', start);
  const close = source.indexOf('\n};', open);
  const body = source.slice(open, close);
  return [...body.matchAll(/^\s*(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*:/gm)].map((m) => m[1] ?? m[2]);
}

// 비공허 자체검사: 빠진 키가 있으면 반드시 드러나야 한다.
runSelfTest('check-registry-gen', () => {
  const sample =
    "export const T: Record<string, string> = {\n  a: '1',\n  'b-c': '2',\n  '지운것': '3',\n};\n";
  const keys = recordKeys(sample, 'T');
  if (keys.join(',') !== 'a,b-c,지운것') throw new Error(`SELF-TEST 실패: 키 추출이 틀림(${keys}).`);
  if (recordKeys(sample, '없는것').length !== 0) throw new Error('SELF-TEST 실패: 없는 상수를 찾았다고 함.');
  // 접두사 충돌 주입: `T_LABEL`이 먼저 나와도 `T`를 찾아야 한다(실제로 여기서 뚫렸다).
  const prefixed =
    "export const T_LABEL: Record<string, string> = {\n  wrong: '1',\n};\n" +
    "export const T: Record<string, string> = {\n  right: '2',\n};\n";
  const pk = recordKeys(prefixed, 'T');
  if (pk.join(',') !== 'right') throw new Error(`SELF-TEST 실패: 접두사가 같은 상수를 집었다(${pk}).`);
});

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

// ── 에이전트 편집 메타(설명·분류) 완전성 — 게이트와 **같은 규율**(§7 형제 대칭) ──
// 왜 필요한가: 가이드 화면이 에이전트 이름을 **손으로 나열**하고 있었다. 그래서 에이전트가
// 늘어도 화면은 옛 목록을 보여줬고(실측: `disaster-recovery-guardian`이 화면에 없었다),
// 반대로 지운 에이전트가 화면에 남아도 아무도 몰랐다. 목록을 registry에서 파생시킨 이상
// **말(설명·분류)이 따라오는지**를 게이트가 물어야 그 자리가 다시 낡지 않는다.
const agentsTs = readFileSync(join(ROOT, 'src/app/agents.ts'), 'utf8');
const agentDescribed = new Set(recordKeys(agentsTs, 'AGENT_DESC'));
const agentCategorized = new Set(recordKeys(agentsTs, 'AGENT_CATEGORY'));
const agentProblems = [];
for (const a of reg.agents) {
  if (!agentDescribed.has(a)) agentProblems.push(`AGENT_DESC에 '${a}' 설명 없음`);
  if (!agentCategorized.has(a)) agentProblems.push(`AGENT_CATEGORY에 '${a}' 분류 없음`);
}
// 반대 방향 — 지운 에이전트의 설명이 남으면 화면이 없는 역할을 있다고 말한다.
for (const k of [...agentDescribed, ...agentCategorized]) {
  if (!reg.agents.includes(k)) {
    agentProblems.push(`agents.ts에 '${k}'가 있으나 .claude/agents/엔 없음(지운 에이전트?)`);
  }
}

if (agentProblems.length > 0) {
  console.error('check-registry-gen: 에이전트 편집 메타(src/app/agents.ts)가 에이전트 목록과 어긋남.');
  for (const p of [...new Set(agentProblems)]) console.error(`  - ${p}`);
  console.error('  → src/app/agents.ts의 AGENT_DESC·AGENT_CATEGORY를 같은 커밋에서 맞추세요.');
  process.exit(1);
}

console.log(
  `check-registry-gen: OK — 게이트 ${reg.gateCount}·에이전트 ${reg.agentCount}·화면 ${reg.screenCount}·마이그 ${reg.migrationCount} 자동 집계 일치, ` +
    `게이트 설명·분류 ${reg.gateCount}/${reg.gateCount} · 에이전트 설명·분류 ${reg.agentCount}/${reg.agentCount}.`,
);
