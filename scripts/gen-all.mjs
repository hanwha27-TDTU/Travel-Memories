// gen-all.mjs — 생성물을 **의존 순서대로 한 번에** 다시 만든다.
//
// 🔴 왜 생겼나(2026-08-13 실측): 생성기가 9개인데 **어떤 순서로 돌려야 하는지 아무 데도
//    적혀 있지 않았고**, npm 스크립트가 있는 것은 4개뿐이었다. 나머지는 `node scripts/…`를
//    외워서 쳐야 했다. 그러다 실제로 헛돌았다 — `gen:module-designs`를 먼저 돌리고
//    `gen-registry`를 나중에 돌렸더니, 설계서가 **낡은 `registry.gen.ts`의 해시**를 품은 채
//    남아 게이트가 두 번 RED를 냈다. 순서를 알아야만 통과하는 절차는 **사람이 기억하는 층**이고,
//    그 층은 반드시 샌다(§18-I 「자동 옆의 수동」).
//
// 처방은 헌법이 이미 말한다: *"불가피한 중복은 손으로 하지 말고 기계화한다."*
// 순서를 산문으로 적는 대신 **실행 가능한 목록**으로 만든다.
//
// ─────────────────────────────────────────────────────────────────────────────
// 이 스크립트가 스스로에게 거는 규율 (§4 — 검사는 비공허해야 한다)
// ─────────────────────────────────────────────────────────────────────────────
// **`scripts/gen-*`를 디렉터리에서 훑어 대조한다.** CHAIN에도 SKIP에도 없는 생성기가 있으면
// **돌리기 전에 멈춘다**(exit 2). 그래서 새 생성기를 만든 사람은 *"여기 어디에 들어가는가"*를
// 반드시 답하게 된다 — 다음 형제가 자동으로 따라온다(§7 2층).
//
// 🔴 이 규율이 없으면 이 스크립트가 **가장 위험한 물건**이 된다: 「전부 재생성했다」고 말하면서
//    조용히 일부만 도는 것. 그 초록의 뜻은 「지켰다」가 아니라 **「안 봤다」**이다.
//
// 사용: npm run gen

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 실행 순서. **각 간선에 사유가 필수다**(§18-C — `안전을 위해`·`기존 순서라서`는 사유가 아니다).
 * 사유는 「앞의 어떤 출력이 뒤의 어떤 입력이 되는가」로만 쓴다.
 */
export const CHAIN = [
  { script: 'gen-constitution.mjs', why: '정본 docs/CONSTITUTION.md → src/app/constitution.gen.ts (다른 생성기가 이 정본 문구를 심는다)' },
  { script: 'gen-adapters.mjs', why: '같은 정본 → CLAUDE.md·AGENTS.md 마커 사이' },
  { script: 'gen-harness-law.mjs', why: '같은 정본의 §15·§18 → docs/HARNESS_RELEASE_LAW.md' },
  { script: 'gen-sync-release-contract.mjs', why: 'schemas/sync-release-contract.json → Edge 상수·앱 계약(등록부가 이 파생물을 센다)' },
  { script: 'gen-registry.mjs', why: '하네스·changelog·.claude/agents/ 실측 → src/app/registry.gen.ts + 문서 마커' },
  { script: 'gen-platform-map.mjs', why: '코드 자국 실측 → src/app/platformMap.gen.ts' },
  // 🔴 반드시 마지막이다. 설계서는 `src/**`의 **해시**를 품는데 그 목록에 위 생성물
  //    (`registry.gen.ts`·`platformMap.gen.ts`·`constitution.gen.ts`)이 들어 있다.
  //    먼저 돌리면 낡은 해시가 남고 `check-module-design-docs`가 RED가 된다 — 실측 사고다.
  { script: 'gen-module-design-docs.mjs', why: 'src/** 해시를 품는다 — 위 생성물이 확정된 뒤여야 한다' },
];

/** 여기서 안 도는 생성기와 **그 이유**. 이유 없는 제외는 결함이다(§7). */
export const SKIP = new Map([
  ['gen-version-file.mjs', 'dist/에 쓴다 — 산출물이 있어야 의미가 있어 `npm run build`가 직접 부른다'],
  ['gen-font-subsets.py', '폰트 바이너리와 파이썬 도구가 필요하고 결과가 커밋돼 있다 — 글꼴을 바꿀 때만 손으로 돌린다'],
]);

/** 디렉터리의 생성기 전부. 손으로 세지 않는다(M-0155 — 「전부」라는 낱말이 다섯 번 거짓이었다). */
export function discoverGenerators(dir) {
  return readdirSync(dir)
    .filter((f) => f.startsWith('gen-') && (f.endsWith('.mjs') || f.endsWith('.py')))
    .filter((f) => f !== 'gen-all.mjs')
    .sort();
}

/** 모집단 ↔ (CHAIN ∪ SKIP)의 어긋남. 양방향으로 본다 — 없는 것을 돌리려 해도 결함이다. */
export function coverageGaps(found, chain = CHAIN, skip = SKIP) {
  const planned = new Set([...chain.map((c) => c.script), ...skip.keys()]);
  const foundSet = new Set(found);
  return {
    unregistered: found.filter((f) => !planned.has(f)),
    missing: [...planned].filter((p) => !foundSet.has(p)).sort(),
  };
}

/** 자체검사 — 알려진 실패를 주입해 잡히는지 본다(§4). 실패하면 exit 2(전제 미충족). */
function selfTest() {
  const fails = [];
  const base = ['gen-a.mjs', 'gen-b.mjs'];
  const chain = [{ script: 'gen-a.mjs', why: 'x' }];
  const skip = new Map([['gen-b.mjs', 'y']]);

  const clean = coverageGaps(base, chain, skip);
  if (clean.unregistered.length || clean.missing.length) fails.push('정상 케이스를 결함으로 셌다');

  const extra = coverageGaps([...base, 'gen-c.mjs'], chain, skip);
  if (!extra.unregistered.includes('gen-c.mjs')) fails.push('등록 안 된 새 생성기를 못 잡았다');

  const gone = coverageGaps(['gen-a.mjs'], chain, skip);
  if (!gone.missing.includes('gen-b.mjs')) fails.push('사라진 생성기를 못 잡았다');

  if (!discoverGenerators(join(ROOT, 'scripts')).includes('gen-registry.mjs')) {
    fails.push('실제 디렉터리 훑기가 gen-registry.mjs를 못 봤다');
  }
  if (discoverGenerators(join(ROOT, 'scripts')).includes('gen-all.mjs')) {
    fails.push('자기 자신을 모집단에 넣었다(무한 재귀)');
  }
  return fails;
}

const problems = selfTest();
if (problems.length) {
  console.error('gen-all: 🔴 자체검사 실패 — 이 실행은 아무것도 재생성하지 않았습니다(판정 불가).');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(2);
}

const found = discoverGenerators(join(ROOT, 'scripts'));
const { unregistered, missing } = coverageGaps(found);
if (unregistered.length || missing.length) {
  console.error('gen-all: 🔴 생성기 목록이 실제와 어긋납니다 — 아무것도 재생성하지 않았습니다.');
  for (const u of unregistered) {
    console.error(`  - ${u}: CHAIN에 순서·사유와 함께 넣거나, SKIP에 **이유와 함께** 등록하세요.`);
  }
  for (const m of missing) console.error(`  - ${m}: 목록에는 있는데 파일이 없습니다(이름이 바뀌었나요?).`);
  process.exit(2);
}

for (const step of CHAIN) {
  process.stdout.write(`▶ ${step.script} ... `);
  try {
    execFileSync(process.execPath, [join(ROOT, 'scripts', step.script)], { cwd: ROOT, stdio: 'pipe' });
    console.log('OK');
  } catch (e) {
    console.log('FAIL');
    console.error(String(e.stdout ?? '') + String(e.stderr ?? ''));
    console.error(`gen-all: ${step.script}에서 멈췄습니다 — 뒤 단계는 **돌지 않았습니다**(순서가 의존이므로).`);
    process.exit(1);
  }
}

console.log(`gen-all: 생성기 ${CHAIN.length}개를 순서대로 실행했습니다.`);
console.log(`  · 여기서 안 도는 것 ${SKIP.size}개: ${[...SKIP].map(([k, v]) => `${k}(${v})`).join(' · ')}`);
console.log('  · 정직한 한계: **생성기가 돌았다**까지만 압니다. 커밋본과 같은지는 짝 게이트(check-*-gen 등)가 판정합니다.');
