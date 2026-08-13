#!/usr/bin/env node
// check-date-freshness — **적어 둔 날짜가 오늘과 어긋나 있지 않은가.**
//
// 🔴 왜(사용자 제안 2026-08-13): *"날짜 관련 정합성을 머지 전에 다시 한 번 체크하게 하자 —
//    날짜가 넘어가는 시점과 틀려졌을 때를 미연에 방지."* 재보니 **제안의 전제가 틀렸고,
//    그래서 제안이 더 필요했다**: 이 저장소에는 적어 둔 날짜를 오늘과 대조하는 게이트가
//    **하나도 없었다.** 즉 날짜가 낡아도 CI는 초록이다 — 막아 주는 층이 없어서 안 터지는
//    것이지 안전해서가 아니다.
//
// 그 값은 바로 그날 치렀다. 세션 도중 날짜가 08-12 → 08-13으로 넘어갔고, 실수 원장에
// `2026-08-12`를 적었다. 게이트 64개가 전부 초록이었고 **사람이 눈으로 발견**했다.
//
// 무엇을 판정하나:
//  A) **미래 날짜 금지**(항상) — 추적 중인 모든 `.md`와 changelog. 오늘+1일을 넘는 날짜는
//     오타이거나 앞당겨 적은 것이다. 이건 릴리스 여부와 무관하게 늘 참이라 늘 잰다.
//  B) **릴리스가 얼려 있으면**(§18-H `.release-lock.json`의 `armed`) **최신 changelog 항목의
//     날짜가 오늘이어야 한다.** 이게 사용자가 요청한 「머지 전 재확인」이다.
//     🔴 얼려 있지 않을 때 이걸 재면 **§15 축적 기간에 오탐**이 난다 — 그때 최신 항목은
//     「지난 릴리스」라 날짜가 과거인 것이 정상이다. 그래서 잠금을 앵커로 쓴다.
//  C) 대상 파일이 0이면 통과가 아니라 **exit 2**(모집단 0에서 공허하게 초록을 내지 않는다).
//
// 🔴 왜 ±1일을 허용하나 — **오탐 많은 게이트는 사람이 무시해서 죽는다**(§11 ③).
//    CI는 UTC이고 사용자는 KST(+9)다. KST 08-14 아침은 UTC로 아직 08-13이고, 반대로
//    UTC 자정 직후는 KST로 이미 다음 날이다. 하루 차이는 **정상적으로 생긴다.**
//    그러므로 이 게이트가 잡는 것은 「시간대 차이」가 아니라 **「이틀 이상 낡은 날짜」**다.
//
// 🔴 정직한 한계 — 못 보는 것:
//    ① 날짜가 **그럴듯하게 틀린 것**은 못 본다. 어제 날짜로 적으면 허용 범위 안이다.
//    ② 어떤 날짜가 **무엇의 날짜인지**는 모른다 — 형식만 본다. 「이 사건이 정말 그날
//       일어났는가」는 사람만 안다(§8 — 계산이 아니라 판단이다).
//    ③ 얼리지 않고 머지하면 B는 **돌지 않는다.** 그건 이 게이트의 구멍이 아니라
//       §18-H를 안 지킨 것이고, 그 자리는 `release:arm`이 막는다.
//
// 가정하는 세계(§18-G): runtimeEnv — **시스템 시계를 읽는다.** 작업트리 밖에서 값을
//    가져오는 유일한 자리이고, 그래서 원장에 그렇게 선언했다.
// 종료코드: 0 통과 · 1 위반 · 2 전제 미충족(모집단 0 · 자체검사 실패).

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSelfTest } from './gate-selftest-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHANGELOG = 'src/app/changelog.ts';
const LOCK = '.release-lock.json';

/** 시간대 때문에 정상적으로 생기는 하루 차이는 위반이 아니다(머리말 참조). */
export const TOLERANCE_DAYS = 1;

/** `YYYY-MM-DD`. 앞뒤에 숫자가 붙은 것(버전·해시 조각)은 날짜가 아니다. */
const DATE_RE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g;

/** 두 `YYYY-MM-DD` 사이의 일수(a - b). 문자열만 받는다 — 시계는 호출자가 준다. */
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
}

/**
 * A) 미래 날짜를 찾는다. 허용치를 **넘는** 것만 위반이다.
 *
 * 🔴 생성 블록·인용은 가리지 않는다 — 미래 날짜는 어디에 있든 틀린 값이기 때문이다.
 */
export function findFutureDates(text, file, today) {
  const out = [];
  for (const m of text.matchAll(DATE_RE)) {
    const gap = daysBetween(m[0], today);
    if (gap > TOLERANCE_DAYS) out.push(`${file}: ${m[0]} — 오늘(${today})보다 ${gap}일 미래입니다`);
  }
  return out;
}

/** changelog에서 **맨 앞(최신)** 항목의 버전과 날짜를 뽑는다. 못 읽으면 `null`. */
export function newestRelease(src) {
  const m = /version:\s*'([\d.]+)'\s*,\s*\n\s*date:\s*'(\d{4}-\d{2}-\d{2})'/.exec(src);
  return m ? { version: m[1], date: m[2] } : null;
}

/**
 * B) 릴리스가 얼려 있을 때만 잰다 — 최신 항목이 **오늘 것**인가.
 *
 * @returns 위반 문자열 배열(빈 배열이면 통과) · 얼려 있지 않으면 빈 배열
 */
export function findStaleReleaseDate(newest, today, armed) {
  if (!armed || !newest) return [];
  const gap = daysBetween(today, newest.date);
  if (gap <= TOLERANCE_DAYS) return [];
  return [
    `${CHANGELOG}: 최신 항목 v${newest.version}의 날짜가 ${newest.date}인데 오늘은 ${today}입니다(${gap}일 낡음).` +
      ' 릴리스를 얼린 상태이므로 이 날짜는 **머지·배포일**이어야 합니다.',
  ];
}

runSelfTest('check-date-freshness', () => {
  const T = '2026-08-13';
  // ── 잡아야 하는 것 ──
  if (findFutureDates('회의는 2026-09-01에', 'x.md', T).length !== 1) throw new Error('SELF-TEST 실패: 미래 날짜를 못 잡았다.');
  if (findStaleReleaseDate({ version: '2.26', date: '2026-08-11' }, T, true).length !== 1) {
    throw new Error('SELF-TEST 실패: 얼린 상태에서 이틀 낡은 날짜를 못 잡았다.');
  }
  // ── 잡으면 안 되는 것(오탐 금지) ──
  if (findFutureDates('오늘은 2026-08-13', 'x.md', T).length !== 0) throw new Error('SELF-TEST 실패: 오늘 날짜를 미래로 봤다.');
  if (findFutureDates('내일 2026-08-14', 'x.md', T).length !== 0) throw new Error('SELF-TEST 실패: 시간대 하루 차이를 위반으로 봤다(KST는 UTC보다 앞선다).');
  if (findFutureDates('버전 1-2-3456과 12026-01-01', 'x.md', T).length !== 0) throw new Error('SELF-TEST 실패: 날짜가 아닌 숫자를 날짜로 봤다.');
  if (findStaleReleaseDate({ version: '2.26', date: '2026-08-12' }, T, true).length !== 0) {
    throw new Error('SELF-TEST 실패: 하루 차이(시간대)를 낡음으로 봤다.');
  }
  if (findStaleReleaseDate({ version: '2.26', date: '2026-07-01' }, T, false).length !== 0) {
    throw new Error('SELF-TEST 실패: 얼리지 않았는데 쟀다 — §15 축적 기간에 오탐이 난다.');
  }
  // ── 파서 ──
  if (newestRelease("version: '2.26',\n    date: '2026-08-12',") === null) throw new Error('SELF-TEST 실패: 최신 항목을 못 읽었다.');
  if (newestRelease('아무것도 없음') !== null) throw new Error('SELF-TEST 실패: 없는 항목을 읽었다고 했다.');
  if (daysBetween('2026-08-13', '2026-08-11') !== 2) throw new Error('SELF-TEST 실패: 일수 계산이 틀렸다.');
});

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain && process.argv.includes('--selftest')) {
  console.log('check-date-freshness: 셀프테스트 통과 (잡아야 할 것 3 · 잡으면 안 되는 것 5 · 파서 3)');
  process.exit(0);
}

if (isMain) {
  const today = new Date().toISOString().slice(0, 10);

  // 🔴 한글 경로가 있으므로 `-z`로 받는다. 기본 출력은 한글을 이스케이프해 파일을 못 연다(M-0138).
  let tracked = [];
  try {
    tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  } catch {
    console.error('check-date-freshness: git ls-files를 못 돌렸습니다 — 대상 목록을 확보하지 못했습니다.');
    process.exit(2);
  }
  const targets = tracked.filter((f) => f.endsWith('.md') || f === CHANGELOG);

  // C) 목록 확보를 **먼저 판정**한다 — 대상 0에서 공허하게 통과하지 않는다(§4).
  if (targets.length === 0) {
    console.error('check-date-freshness: 검사할 문서를 하나도 못 찾았습니다 — 재지 못했습니다.');
    process.exit(2);
  }

  const problems = [];
  for (const f of targets) {
    const path = join(ROOT, f);
    if (!existsSync(path)) continue;
    problems.push(...findFutureDates(readFileSync(path, 'utf8'), f, today));
  }

  const lockPath = join(ROOT, LOCK);
  let armed = false;
  if (existsSync(lockPath)) {
    try {
      armed = JSON.parse(readFileSync(lockPath, 'utf8')).armed === true;
    } catch {
      // 잠금을 못 읽으면 **얼리지 않은 것으로 반올림하지 않는다** — 모르는 것은 말한다(§8).
      console.error(`check-date-freshness: ${LOCK}을 읽지 못했습니다 — 릴리스 여부를 판정할 수 없습니다.`);
      process.exit(2);
    }
  }

  const changelogPath = join(ROOT, CHANGELOG);
  const newest = existsSync(changelogPath) ? newestRelease(readFileSync(changelogPath, 'utf8')) : null;
  if (armed && newest === null) {
    console.error(`check-date-freshness: 릴리스를 얼렸는데 ${CHANGELOG}의 최신 항목을 못 읽었습니다.`);
    process.exit(2);
  }
  problems.push(...findStaleReleaseDate(newest, today, armed));

  if (problems.length) {
    console.error('check-date-freshness: **날짜가 오늘과 어긋납니다**.');
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error('  → 날짜는 손으로 적는 값이라 날이 바뀌면 조용히 낡습니다. 그 자리를 오늘 날짜로 고치세요.');
    process.exit(1);
  }

  console.log(
    `check-date-freshness: 문서 ${targets.length}개에 미래 날짜 없음` +
      (armed
        ? ` · 릴리스 얼림 상태에서 최신 항목 v${newest.version}(${newest.date})이 오늘(${today})과 일치.`
        : ` · 릴리스가 얼려 있지 않아 **최신 항목 날짜는 재지 않았습니다**(§15 축적 중에는 과거가 정상).`),
  );
  console.log(
    `    ↳ 정직한 한계: **형식만** 봅니다 — 그럴듯하게 틀린 날짜(어제로 적기)와 「그 사건이 정말 그날인가」는 못 봅니다.` +
      ` 시간대 때문에 ±${TOLERANCE_DAYS}일은 허용합니다(CI는 UTC · 사용자는 KST).`,
  );
}
