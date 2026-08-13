#!/usr/bin/env node
// check-enforcement-parity — **두 AI가 같은 강제를 받는가.**
//
// 🔴 왜(사용자 지시 2026-08-12: *"코덱스와 클로드가 항상 같은 규칙 및 스킬을 보고 작업할 수
//    있도록 강제하도록 할 방법을 찾아 반영하자"*).
//
// **규칙**은 이미 같다 — `docs/CONSTITUTION.md` 하나가 두 어댑터에 심기고
// `check-adapter-parity`가 글자 단위로 대조한다. **스킬**도 라우팅 표가 공유되고
// `check-skill-routing`이 고아·미라우팅을 잡는다.
//
// 🔴 **갈라져 있던 것은 「강제」였다**(2026-08-12 실측):
//   ① `.claude/settings.json`의 훅 4개(파괴적 SQL·비밀키·파이프 금지·릴리스 얼림)는
//      **Claude Code 런타임만** 발화시킨다. 코덱스는 하나도 안 받는다.
//   ② 그런데 `AGENTS.md`(코덱스가 읽는 파일)는 *"실제 강제는 .claude/settings.json의
//      command hook과 CI 게이트가 한다"*고 적고 있었다 — **없는 보호막을 있다고 말한 것**이다.
//      방향이 나쁘다. 모르는 것보다 **틀리게 아는 것**이 위험하다.
//   ③ 그리고 **두 AI가 모두 받는 유일한 층**인 git 훅(`.githooks/`)은
//      `core.hooksPath`가 배선되지 않아 **아무에게도 안 걸리고 있었다.**
//
// 무엇을 판정하나:
//  A) `.githooks/`의 훅이 존재하고 **실행 가능**한가(모드 비트).
//  B) `package.json`의 `prepare`가 `core.hooksPath`를 `.githooks`로 **자동 배선**하는가.
//     — npm이 설치 뒤 자동으로 돌리므로, 사람이 기억하지 않아도 두 AI 모두 걸린다.
//  C) `scripts/hook-*.mjs`(Claude 전용 층)가 **전부 등록부에 있는가.**
//     등록 없는 훅은 RED — 다음 사람이 코덱스도 받는다고 오해하는 것을 막는다(§7).
//
// 🔴 정직한 한계 — 이 게이트가 **못 보는 것**:
//  · 어떤 사람의 로컬에서 `core.hooksPath`가 실제로 설정됐는지는 볼 수 없다. `prepare`가
//    **적혀 있는가**까지만 안다(§2-J ②와 같은 한계 — 파일이 그렇게 적혀 있다까지).
//  · 코덱스가 실제로 AGENTS.md를 읽었는지도 볼 수 없다. 그건 대화이지 파일이 아니다(§16과 같은 부류).
//
// 가정하는 세계(§18-G): 없음 — 작업트리 파일만 읽는다.
// 종료코드: 0 통과 · 1 위반 · 2 전제 미충족.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const GITHOOKS = '.githooks';

/**
 * Claude 전용 강제층의 등록부 — **누구를 묶는가**와 **다른 AI는 무엇이 대신하는가**.
 *
 * 🔴 새 훅을 만들면 여기에도 등록해야 한다. 안 하면 RED다.
 *    이유 없는 비대칭은 결함이고, **이유를 적어야 다음 사람이 판단할 수 있다**(§7).
 */
export const HOOK_REGISTRY = {
  'hook-sql-safe.mjs': {
    binds: 'claude-only',
    codexSubstitute:
      '없음. 코덱스가 파괴적 SQL을 직접 실행하는 것은 이 층이 막지 못한다 — 헌법 §0과 ' +
      'supabase-security-dev 헌장(두 AI가 같이 읽는다)이 유일한 층이다. git 훅으로 옮길 수 없다: ' +
      '이 훅은 파일이 아니라 **실행 직전의 명령**을 본다.',
  },
  'hook-secret-guard.mjs': {
    binds: 'claude-only',
    codexSubstitute:
      '배포 워크플로의 「Secret leak scan on build artifact」가 산출물을 검사한다 — 시점이 늦지만 ' +
      '**두 AI 모두** 통과해야 배포된다.',
  },
  'hook-verify-exit.mjs': {
    binds: 'claude-only',
    codexSubstitute:
      '없음. §18-A(파이프에 넣지 말고 종료코드로 판정)는 코덱스에게 **조항으로만** 걸린다. ' +
      '어긴 것을 잡는 검출기는 사용자다.',
  },
  'hook-release-freeze.mjs': {
    binds: 'claude-only',
    codexSubstitute:
      '없음. 릴리스 얼림(§18-H)은 코덱스의 커밋을 막지 못한다. 다만 잠금 상태는 파일에 남으므로 ' +
      '**보이기는 한다**(scripts/release-lock.mjs).',
  },
};

/** `.githooks/`에서 실행 가능한 훅 목록. */
export function executableGitHooks(dir, statFn, listFn) {
  const files = listFn(dir);
  return files.filter((f) => {
    if ((statFn(join(dir, f)).mode & 0o111) !== 0) return true;
    if (process.platform !== 'win32') return false;
    try {
      const mode = execFileSync('git', ['ls-files', '-s', '--', join(dir, f)], { encoding: 'utf8' });
      return /^100755\s/.test(mode);
    } catch {
      return false;
    }
  });
}

/** `prepare`가 `core.hooksPath`를 `.githooks`로 배선하는가. */
export function wiresGitHooks(pkg) {
  const p = pkg?.scripts?.prepare;
  return typeof p === 'string' && /core\.hooksPath/.test(p) && /\.githooks/.test(p);
}

function selfTest() {
  const exec = { mode: 0o755 };
  const plain = { mode: 0o644 };
  const cases = [
    [
      '실행 가능한 훅만 센다',
      () =>
        executableGitHooks('.githooks', (p) => (p.endsWith('a') ? exec : plain), () => ['a', 'b']).length === 1,
    ],
    [
      '실행 권한이 없으면 0개 — 있어도 안 도는 훅은 없는 것과 같다',
      () => executableGitHooks('.githooks', () => plain, () => ['a']).length === 0,
    ],
    ['prepare가 배선하면 참', () => wiresGitHooks({ scripts: { prepare: 'git config core.hooksPath .githooks' } })],
    ['prepare가 없으면 거짓', () => !wiresGitHooks({ scripts: {} })],
    [
      '🔴 다른 경로를 가리키면 거짓(오탐 아니라 실제로 안 걸린다)',
      () => !wiresGitHooks({ scripts: { prepare: 'git config core.hooksPath .other' } }),
    ],
    [
      'core.hooksPath를 안 만지는 prepare는 거짓',
      () => !wiresGitHooks({ scripts: { prepare: 'npm run build' } }),
    ],
  ];
  const failed = cases.filter(([, fn]) => !fn());
  if (failed.length) {
    console.error('check-enforcement-parity: 셀프테스트 실패 — 게이트가 공허하다(§4).');
    for (const [name] of failed) console.error(`  ✗ ${name}`);
    process.exit(2);
  }
}

selfTest();
if (process.argv.includes('--selftest')) {
  console.log('check-enforcement-parity: 셀프테스트 통과 (잡아야 할 것 4 · 잡으면 안 되는 것 2)');
  process.exit(0);
}

if (!existsSync(GITHOOKS) || !existsSync('package.json')) {
  console.error('check-enforcement-parity: .githooks 또는 package.json이 없습니다 — 재지 못했습니다.');
  process.exit(2);
}

const problems = [];

// A) 두 AI가 모두 받는 층이 실제로 실행 가능한가.
const hooks = executableGitHooks(GITHOOKS, statSync, readdirSync);
if (hooks.length === 0) {
  problems.push('.githooks/에 실행 가능한 훅이 없습니다 — 두 AI가 공통으로 받는 층이 비어 있습니다');
}

// B) 배선이 자동인가. 사람이 기억해서 켜는 층은 반드시 새어 나간다.
if (!wiresGitHooks(JSON.parse(readFileSync('package.json', 'utf8')))) {
  problems.push(
    'package.json의 prepare가 core.hooksPath를 .githooks로 배선하지 않습니다 — ' +
      '배선이 수동이면 새 클론에서 훅이 아무에게도 안 걸립니다(2026-08-12에 실제로 그랬다)',
  );
}

// C) Claude 전용 훅이 전부 등록돼 있는가 — 이유 없는 비대칭 차단.
const claudeHooks = readdirSync('scripts').filter((f) => f.startsWith('hook-') && f.endsWith('.mjs'));
if (claudeHooks.length === 0) {
  console.error('check-enforcement-parity: Claude 훅을 하나도 못 찾았습니다 — 재지 못했습니다.');
  process.exit(2);
}
for (const h of claudeHooks) {
  const reg = HOOK_REGISTRY[h];
  if (!reg) {
    problems.push(`${h}: 등록부에 없습니다 — 코덱스가 이 강제를 받는지 아무도 모릅니다`);
  } else if (reg.binds === 'claude-only' && !reg.codexSubstitute) {
    problems.push(`${h}: Claude 전용인데 코덱스 쪽 대체를 안 적었습니다(이유 없는 비대칭 · §7)`);
  }
}
for (const known of Object.keys(HOOK_REGISTRY)) {
  if (!claudeHooks.includes(known)) problems.push(`${known}: 등록부에 있는데 파일이 없습니다(죽은 참조)`);
}

if (problems.length) {
  console.error('check-enforcement-parity: 두 AI가 받는 강제가 갈라져 있습니다.');
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}

const onlyClaude = Object.values(HOOK_REGISTRY).filter((r) => r.binds === 'claude-only').length;
console.log(
  `check-enforcement-parity: 공통 층 git 훅 ${hooks.length}개(${hooks.join(', ')}) 자동 배선됨 · ` +
    `Claude 전용 훅 ${claudeHooks.length}개 전부 등록(그중 ${onlyClaude}개는 코덱스 대체를 명시).`,
);
console.log(
  `    ↳ 정직한 한계: **어떤 사람의 로컬에서 core.hooksPath가 실제로 설정됐는지**는 못 봅니다 — ` +
    `prepare가 적혀 있다까지만 압니다. 코덱스가 AGENTS.md를 읽었는지도 못 봅니다(대화는 파일이 아니다).`,
);
