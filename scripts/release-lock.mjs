// release-lock.mjs — 릴리스 묶음의 **경계를 물건으로 만든다**(헌법 §18-H).
//
// ── 왜 있는가 (실측 2026-08-09) ──────────────────────────────────────────────
// v2.07 릴리스에서 CI가 네 번 돌았다. 필요한 것은 **한 번**이었다.
//
//     #552 failure   04b3abfb   18:33 → 18:37   ← 게이트가 CI에서만 죽음(M-0135)
//     #553 cancelled b8ff17fb   18:41 → 18:43   ← 내가 다음 커밋을 얹어 **취소시킴**
//     #554 success   2d672fdc   18:43 → 18:47
//     #555 success   06c7d668   19:11 → 19:14   ← 또 얹어서 **처음부터 다시**
//
// 검증 자체는 3~4분이다. 그런데 첫 Ready부터 마지막 초록까지 **41분**이 걸렸다.
// 사용자가 물었다 — *"왜 이렇게 배포가 길어지니?"* 답은 CI가 아니라 나였다.
//
// 🔴 **핵심은 「커밋 하나 더」의 값이 커밋 하나가 아니라는 것이다.** `cancel-in-progress`가
// 켜져 있으므로 새 커밋은 **돌고 있던 검증을 버리고 처음부터** 시작시킨다. 헌법 §15가
// *"하네스 뒤 코드를 바꾸면 묶음이 깨진다"*고 이미 적어 뒀지만, 조항은 커밋 순간에
// 아무 말도 하지 않는다. 그래서 값이 **보이지 않았고**, 안 보이는 값은 계산되지 않는다.
//
// ── 무엇을 하는가 ────────────────────────────────────────────────────────────
// 릴리스 검증을 시작하면 저장소를 **얼린다**(`arm`). 얼어 있는 동안 `git commit`·`git push`는
// PreToolUse 훅이 막는다. 정말 커밋해야 하면 — 빨간 게이트를 고치는 것처럼 **정당한 경우가
// 있다** — `reopen`에 **이유를 적고** 다시 연다. 그 순간 묶음은 「다시 열렸다」로 세어진다.
//
// 즉 이 도구는 커밋을 금지하지 않는다. **결정을 보이게 만든다.** 이유 없는 예외를 막고
// 세는 것은 이 저장소가 이미 쓰는 형태다(§7의 `NO_OP_REQUIRED`).
//
// 계약: exit 0 = 정상 · exit 1 = 잘못된 전이. 판정은 종료코드로 한다(§18-A).

import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LOCK_PATH = join(ROOT, '.release-lock.json');

/**
 * 잠금이 **낡으면 스스로 풀린다**. 세션이 끊기거나 릴리스를 잊고 넘어가면, 얼어붙은 저장소가
 * 다음 사람의 모든 커밋을 막는다 — 그건 이 장치가 막으려던 것보다 큰 사고다.
 * (`hook-secret-guard`·`hook-verify-exit`과 같은 자세: **판정 불가는 통과시킨다**.)
 */
export const STALE_MS = 3 * 60 * 60 * 1000;

/** 이유 없는 재개방을 막는다 — 「그냥」·「하나만」은 이유가 아니다. */
export const MIN_REASON = 10;

export const EMPTY = Object.freeze({ armed: false, candidate: null, armedAt: null, reopens: [] });

/**
 * 상태 전이 — 순수 함수(자체검사가 가짜 시각으로 부른다).
 * @returns `{ state }` 또는 `{ error }`
 */
export function nextState(state, action, arg, now) {
  const s = { ...EMPTY, ...(state ?? {}), reopens: [...(state?.reopens ?? [])] };
  if (action === 'arm') {
    if (s.armed) return { error: `이미 얼려 있습니다(후보 ${s.candidate}) — 다시 열려면 reopen에 이유를 적으세요` };
    if (!arg) return { error: '릴리스 후보를 적으세요(보통 HEAD의 SHA)' };
    return { state: { ...s, armed: true, candidate: arg, armedAt: now } };
  }
  if (action === 'reopen') {
    if (!s.armed) return { error: '얼려 있지 않습니다 — 다시 열 것이 없습니다' };
    if (!arg || arg.trim().length < MIN_REASON) return { error: `왜 묶음을 다시 여는지 ${MIN_REASON}자 이상 적으세요 — 이유 없는 예외는 결함입니다(§7)` };
    return { state: { ...s, armed: false, armedAt: null, reopens: [...s.reopens, { at: now, reason: arg.trim(), candidate: s.candidate }] } };
  }
  if (action === 'close') {
    if (!s.armed) return { error: '얼려 있지 않습니다 — 닫을 묶음이 없습니다' };
    return { state: { ...EMPTY }, closed: { candidate: s.candidate, reopens: s.reopens } };
  }
  return { error: `모르는 동작: ${action}` };
}

/** 지금 이 명령을 막아야 하는가 — 순수 함수. `null`이면 통과. */
export function blockedBy(command, state, now) {
  if (!state?.armed) return null;
  if (state.armedAt && now - state.armedAt > STALE_MS) return null; // 낡은 잠금은 잠금이 아니다
  if (typeof command !== 'string' || !command) return null;
  for (const raw of command.split('\n')) {
    const line = raw.trim();
    if (!line || isProse(line)) continue;
    for (const seg of line.split(/;|&&|\|\||\|/).map((x) => x.trim())) {
      if (FROZEN.some((re) => re.test(seg))) return { line: seg, candidate: state.candidate };
    }
  }
  return null;
}

/**
 * 얼어 있는 동안 막는 명령. **저장소의 머리를 움직이는 것**만 고른다 —
 * 조사·읽기는 자유여야 한다(막으면 사람이 잠금을 꺼 버리고, 꺼진 장치는 없는 장치다).
 */
const FROZEN = [
  /^git\s+commit\b/,
  /^git\s+push\b/,
  /^git\s+merge\b/,
  /^git\s+rebase\b/,
  /^git\s+cherry-pick\b/,
  /^git\s+revert\b/,
];

/** 산문 줄인가 — 히어독·문서 본문이 명령 문자열에 섞여 들어온다(hook-verify-exit과 같은 규율). */
export function isProse(line) {
  if (/^[-*>#]/.test(line)) return true;
  if (line.includes('**')) return true;
  if (line.startsWith('//')) return true;
  return false;
}

export function readLock() {
  if (!existsSync(LOCK_PATH)) return { ...EMPTY };
  try {
    return { ...EMPTY, ...JSON.parse(readFileSync(LOCK_PATH, 'utf8')) };
  } catch {
    return { ...EMPTY }; // 깨진 잠금은 잠금이 아니다
  }
}

function writeLock(state) {
  if (!state.armed && !state.reopens.length) rmSync(LOCK_PATH, { force: true });
  else writeFileSync(LOCK_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

// ── 자체검사: 알려진 실패를 주입해 RED를 본 뒤에만 신뢰한다(§4) ──────────────
const SELF = { pos: 0, neg: 0 };

export function selfTest() {
  const T0 = 1_700_000_000_000;
  // ① 전이
  const armed = nextState(EMPTY, 'arm', 'abc1234', T0).state;
  if (!armed?.armed) throw new Error('SELF-TEST 실패: arm이 얼리지 못했다');
  SELF.neg += 1;
  const bad = [
    ['두 번 얼림', armed, 'arm', 'def', '이미 얼려 있습니다'],
    ['후보 없는 arm', EMPTY, 'arm', '', '릴리스 후보를 적으세요'],
    ['안 얼린 채 reopen', EMPTY, 'reopen', '이유를 충분히 적었다', '얼려 있지 않습니다'],
    ['이유 없는 reopen', armed, 'reopen', '급함', '이상 적으세요'],
    ['안 얼린 채 close', EMPTY, 'close', '', '닫을 묶음이 없습니다'],
    ['모르는 동작', armed, 'frobnicate', '', '모르는 동작'],
  ];
  for (const [label, st, act, arg, needle] of bad) {
    if (!String(nextState(st, act, arg, T0).error ?? '').includes(needle)) throw new Error(`SELF-TEST 실패: ${label}을(를) 놓쳤다`);
    SELF.pos += 1;
  }
  const reopened = nextState(armed, 'reopen', '빨간 게이트 check-x를 고치려고 다시 엽니다', T0).state;
  if (reopened.armed || reopened.reopens.length !== 1) throw new Error('SELF-TEST 실패: reopen이 세어지지 않았다');
  SELF.neg += 1;

  // ② 차단 판정
  const mustBlock = [
    'git commit -m "docs: 후속과제"',
    'git push -u origin claude/x',
    'git add -A && git commit -m x',
    'git rebase origin/main',
  ];
  for (const c of mustBlock) {
    if (!blockedBy(c, armed, T0)) throw new Error(`SELF-TEST 실패: 막아야 할 것을 놓쳤다 — ${c}`);
    SELF.pos += 1;
  }
  const mustPass = [
    ['조사는 자유', 'git status --porcelain', armed],
    ['읽기는 자유', 'git log --oneline -5', armed],
    ['닫혀 있으면 자유', 'git commit -m x', EMPTY],
    ['다시 연 뒤에는 자유', 'git commit -m x', reopened],
    // 🔴 산문 속 같은 글자를 명령으로 읽으면 **규율을 적는 일 자체를 규율이 막는다**
    //    (hook-verify-exit이 실제로 그렇게 사고를 냈다 · §11 ③).
    ['산문', '- 이때는 git commit 을 하지 않는다', armed],
    ['강조 문장', '**git push** 는 묶음이 닫힌 뒤에', armed],
    ['문자열 안', 'echo "git commit" >> notes.md', armed],
    // 낡은 잠금은 잠금이 아니다 — 얼어붙은 저장소가 더 큰 사고다.
    ['3시간 지난 잠금', 'git commit -m x', armed],
  ];
  for (const [label, c, st] of mustPass) {
    const now = label.startsWith('3시간') ? T0 + STALE_MS + 1 : T0;
    if (blockedBy(c, st, now)) throw new Error(`SELF-TEST 실패: 오탐 — ${label}`);
    SELF.neg += 1;
  }
}

selfTest();

const isMain = process.argv[1] && process.argv[1].endsWith('release-lock.mjs');
if (isMain) {
  const [action, ...rest] = process.argv.slice(2);
  const arg = rest.join(' ').trim();
  const state = readLock();
  const now = Date.now();

  if (!action || action === 'status' || action === '--status') {
    const stale = state.armed && state.armedAt && now - state.armedAt > STALE_MS;
    console.log(
      state.armed
        ? `release-lock: 🔒 얼려 있음 — 후보 ${state.candidate}${stale ? ' (3시간 넘어 **낡음**: 훅이 더는 막지 않습니다)' : ''}`
        : 'release-lock: 열려 있음 — 평상시입니다',
    );
    console.log(`  묶음 재개방 ${state.reopens.length}회${state.reopens.length ? ':' : ' — 이 묶음은 한 번에 닫혔습니다'}`);
    for (const r of state.reopens) console.log(`   · ${r.reason}`);
    console.log(`  ↳ 정직한 한계: 이 잠금은 **내 명령**만 막습니다(PreToolUse 훅). 사람이 터미널에서 직접 치는 것은 보지 못합니다.`);
    console.log(`  ↳ 자체검사 양성 ${SELF.pos}·음성 ${SELF.neg}`);
    process.exit(0);
  }

  const r = nextState(state, action.replace(/^--/, ''), arg, now);
  if (r.error) {
    console.error(`release-lock: ${r.error}`);
    process.exit(1);
  }
  writeLock(r.state);
  if (action.endsWith('arm')) console.log(`release-lock: 🔒 저장소를 얼렸습니다 — 후보 ${arg}. 묶음이 닫힐 때까지 commit·push를 막습니다(§18-H).`);
  else if (action.endsWith('reopen')) console.log(`release-lock: 묶음을 다시 엽니다(${r.state.reopens.length}회째) — "${arg}". 검증은 **처음부터 다시** 돕니다.`);
  else console.log(`release-lock: 묶음을 닫았습니다 — 후보 ${r.closed.candidate} · 재개방 ${r.closed.reopens.length}회. 🔴 완료 보고에 이 숫자를 적으세요(§18-H).`);
}
