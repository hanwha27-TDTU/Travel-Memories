// check-hooks-wired.mjs — 「강제층(hook)이 살아 있는가」를 정적으로 대조한다.
//
// 왜 필요한가(T-003 · 헌법 S-09): 헌법은 *"CLAUDE.md는 맥락이고 강제는 hook과 CI다"*라고
// 못박았는데, `.claude/settings.json`의 `hooks`가 **통째로 비어 있었고 아무도 몰랐다.**
// 조항(1층)과 구조(2층 — 훅 스크립트)만으로는 다시 비워진다. 이 게이트가 3층이다(§7).
//
// 무엇을 판정하나:
//  ① 등록된 훅이 **하나 이상** 있는가(0이면 강제층이 죽은 것)
//  ② 필수 훅이 전부 등록돼 있는가(REQUIRED — 매처와 스크립트 쌍)
//  ③ 가리키는 스크립트가 **실제로 존재**하는가(죽은 참조 차단)
//  ④ 각 훅 스크립트의 **셀프테스트가 실제로 통과**하는가 — 훅도 공허할 수 있다(§4)
//
// 🔴 정직한 한계: 이 게이트는 훅이 **등록됐고 셀프테스트를 통과한다**까지만 안다.
// Claude Code 런타임이 실제로 그 훅을 발화시키는지는 정적으로 볼 수 없다(§2-J ②의 한계와 같다).
// 그래서 판정문도 「덮음」이 아니라 「등록·자체검사 통과」라고만 말한다.

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SETTINGS = join(ROOT, '.claude/settings.json');

/** 필수 훅 — 이유 없이 빼면 결함이다(§7). 새 훅을 더하면 여기에도 등록한다. */
const REQUIRED = [
  {
    event: 'PreToolUse',
    matcherIncludes: 'mcp__Supabase__execute_sql',
    script: 'scripts/hook-sql-safe.mjs',
    why: '운영 DB에 파괴적 SQL이 직접 나가는 것을 막는다(헌법 §0)',
  },
  {
    event: 'PreToolUse',
    matcherIncludes: 'Write',
    script: 'scripts/hook-secret-guard.mjs',
    why: 'service_role 키·DB 비밀번호가 파일에 쓰이는 것을 막는다(헌법 §0)',
  },
  {
    event: 'PreToolUse',
    matcherIncludes: 'Bash',
    script: 'scripts/hook-verify-exit.mjs',
    why: '검증 명령을 파이프에 넣어 종료코드를 잃는 것을 막는다(헌법 §18-A)',
  },
  {
    event: 'PreToolUse',
    matcherIncludes: 'Bash',
    script: 'scripts/hook-release-freeze.mjs',
    why: '릴리스 검증이 도는 중에 커밋을 얹어 검증을 취소·재시작시키는 것을 막는다(헌법 §18-H)',
  },
];

/** settings.json에서 (event, matcher, command) 삼중항을 전부 뽑는다. */
export function collectHooks(settings) {
  const out = [];
  const events = settings?.hooks ?? {};
  for (const [event, groups] of Object.entries(events)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      for (const h of g?.hooks ?? []) {
        if (h?.type === 'command' && typeof h.command === 'string') {
          out.push({ event, matcher: String(g.matcher ?? ''), command: h.command });
        }
      }
    }
  }
  return out;
}

/** 필수 훅이 전부 등록됐는지. 빠진 것들을 반환(빈 배열이면 통과). */
export function findMissing(hooks, required = REQUIRED) {
  return required.filter(
    (r) => !hooks.some((h) => h.event === r.event && h.matcher.includes(r.matcherIncludes) && h.command.includes(r.script)),
  );
}

// ── 셀프테스트: 알려진 실패를 주입해 잡히는지 확인한 뒤에만 이 게이트를 신뢰한다(§4) ──
(() => {
  // 🔴 정상 픽스처를 **손으로 나열하지 않는다.** 예전 판은 훅 둘을 베껴 적어 뒀고,
  // REQUIRED에 셋째를 더한 순간 「정상 설정을 결함으로 판정」하며 셀프테스트가 터졌다 —
  // 게이트를 넓히면 셀프테스트가 옛 전제를 못박고 있다(§11 ②). 원장에서 파생시킨다.
  const good = { hooks: { PreToolUse: REQUIRED.map((r) => ({
    matcher: r.matcherIncludes,
    hooks: [{ type: 'command', command: `node ${r.script}` }],
  })) } };
  if (findMissing(collectHooks(good)).length !== 0) throw new Error('SELF-TEST 실패: 정상 설정을 결함으로 판정(오탐).');
  if (findMissing(collectHooks({ hooks: {} })).length !== REQUIRED.length) {
    throw new Error('SELF-TEST 실패: 빈 hooks를 통과시킨다(게이트 공허) — T-003이 정확히 이 상태였다.');
  }
  // 스크립트만 바꿔치기해도 잡아야 한다(이름이 있는 것과 불리는 것은 다르다 · §2-F)
  const swapped = JSON.parse(JSON.stringify(good));
  swapped.hooks.PreToolUse[0].hooks[0].command = 'node scripts/does-not-exist.mjs';
  if (findMissing(collectHooks(swapped)).length === 0) throw new Error('SELF-TEST 실패: 다른 스크립트를 통과시킨다.');
})();

if (!existsSync(SETTINGS)) {
  console.error('check-hooks-wired: .claude/settings.json이 없습니다 — 강제층이 통째로 사라졌습니다.');
  process.exit(1);
}

let settings;
try {
  settings = JSON.parse(readFileSync(SETTINGS, 'utf8'));
} catch (e) {
  // 🔴 깨진 JSON은 **모든 설정을 조용히 무효화**한다 — 비어 있는 것보다 나쁘다.
  console.error(`check-hooks-wired: settings.json JSON 파싱 실패 — ${e.message}`);
  process.exit(1);
}

const hooks = collectHooks(settings);
let bad = 0;

// ① 대상 확보를 먼저 판정한다(§2-J ① — 0이면 나머지 검사가 공허하다).
if (hooks.length === 0) {
  console.error('  ✗ 등록된 command 훅이 0개입니다 — 헌법 S-09의 강제층이 죽었습니다.');
  bad++;
}

// ② 필수 훅 등록
for (const m of findMissing(hooks)) {
  console.error(`  ✗ 필수 훅 누락: ${m.event} / ${m.matcherIncludes} → ${m.script}  (${m.why})`);
  bad++;
}

// ③ 죽은 참조 + ④ 셀프테스트 실실행
const { execFileSync } = await import('node:child_process');
for (const h of hooks) {
  const m = /(scripts\/[\w.-]+\.mjs)/.exec(h.command);
  if (!m) continue;
  const rel = m[1];
  if (!existsSync(join(ROOT, rel))) {
    console.error(`  ✗ 훅이 없는 스크립트를 가리킵니다: ${rel} (${h.event}/${h.matcher})`);
    bad++;
    continue;
  }
  // 훅 스크립트의 selfTest를 직접 불러 **실제로** 돌린다(공허한 훅 차단).
  try {
    const mod = await import(`../${rel}`);
    if (typeof mod.selfTest !== 'function') {
      console.error(`  ✗ ${rel}에 export된 selfTest가 없습니다 — 훅이 공허해도 아무도 모릅니다(§4).`);
      bad++;
    } else {
      mod.selfTest();
    }
  } catch (e) {
    console.error(`  ✗ ${rel} 셀프테스트 실패: ${e instanceof Error ? e.message : String(e)}`);
    bad++;
  }
}

if (bad > 0) {
  console.error('check-hooks-wired: 강제층(hook)이 불완전합니다.');
  process.exit(1);
}
console.log(
  `check-hooks-wired: OK (셀프테스트 통과 · command 훅 ${hooks.length}개 **등록·자체검사 통과** · 필수 ${REQUIRED.length}종 존재)\n` +
    '  ↳ 정직한 한계: 런타임이 실제로 발화시키는지는 정적으로 볼 수 없습니다(등록까지만 보증).',
);
