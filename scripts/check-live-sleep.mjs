// check-live-sleep.mjs — 라이브 게이트의 **고정 대기(시계로 자기)**가 다시 늘어나는 것을 막는다.
//
// ── 왜 (T-016 · BGT-2 실측 2026-08-09) ──────────────────────────────────────
// 라이브 게이트의 시간이 어디로 가는지 성분별로 쟀다(게이트를 고치지 않고 playwright를 감싸서):
//
//     verify-editor-live · 전체 128.6s
//       🔴 고정 대기 137.3s / 351회 (겹쳐 돌아 합이 벽시계를 넘는다)
//          페이지 열기  8.2s / 35회
//          내용 기다리기 10.4s / 188회
//          evaluate     2.8s / 382회
//
// 즉 이 검사는 사실상 **자고 있는 검사**였다. 그리고 원문 이식 지시서(BGT)의 답은
// 「폰트 격리」였는데 **우리 병목이 아니었다** — 답을 베끼지 말고 재라는 T-016의 지시가 맞았다.
//
// ── 왜 문서가 아니라 게이트인가 ─────────────────────────────────────────────
// 🔴 **고정 대기는 오류도 경고도 내지 않는다. 그냥 느려진다.** 그래서 「내용을 기다려라」는
// 규율은 문서로는 안 지켜진다 — 실제로 M-0119에서 그 규율을 **적고 한 곳만 고쳤고**,
// 형제 166곳이 그대로 자고 있었다(§7 수평전개가 안 된 전형).
//
// ── 계약 ────────────────────────────────────────────────────────────────────
// 래칫은 **한 방향**이다. 기준선보다 많으면 RED(늘렸다), 적으면 RED(기록을 낮춰라).
// 모집단은 손목록이 아니라 **harness 원장에서 파생**한다 — 새 라이브 게이트가 생기면
// 기준선이 없어 RED가 되고, 그래서 다음 형제가 자동으로 따라온다(§7 2층).
//
// exit 0 = 통과 · exit 1 = 위반. 판정은 종료코드로 한다(§18-A).

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 🔴 **동결 기준선 — 숫자를 올리지 마라.** 줄일 때만 고친다.
 * 값은 T-018 완료 상태다. 편집기 라이브 게이트는 모든 고정 대기를 실제 완료 조건으로 바꿨다.
 */
export const SLEEP_BASELINE = Object.freeze({
  'verify-editor-live': 0,
  'verify-diagnostics-live': 11,
  'verify-authgate-live': 0,
});

/** 소스에서 고정 대기 호출부 수를 센다. 주석 속 글자는 세지 않는다(오탐은 틀린 게이트다 · §11 ③). */
export function countSleeps(source) {
  return source
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .reduce((n, l) => n + (l.match(/\.waitForTimeout\(/g) ?? []).length, 0);
}

/** 순수 판정 — 자체검사가 가짜 입력으로 부른다. */
export function findProblems(counts, baseline = SLEEP_BASELINE) {
  const problems = [];
  for (const [name, n] of Object.entries(counts)) {
    const base = baseline[name];
    if (base === undefined) {
      problems.push(`${name}: 기준선이 없는 라이브 게이트다(고정 대기 ${n}곳) — SLEEP_BASELINE에 등록하세요. 새 형제도 이 래칫을 진다(§7)`);
    } else if (n > base) {
      problems.push(`${name}: 고정 대기가 ${base} → ${n}곳으로 **늘었다**. 시계가 아니라 **내용**을 기다리세요(M-0119) — 클릭 뒤 동기 렌더면 \`settle()\`, 진짜 비동기면 \`waitForFunction\`/\`waitUntil\``);
    } else if (n < base) {
      problems.push(`${name}: 고정 대기를 ${base} → ${n}곳으로 줄였습니다 👏 — SLEEP_BASELINE을 ${n}로 낮추고 같은 커밋에 넣으세요(래칫은 한 방향이라 안 낮추면 다시 늘 수 있습니다)`);
    }
  }
  for (const name of Object.keys(baseline)) {
    if (!(name in counts)) problems.push(`${name}: 기준선에 있으나 원장(harness)에 없는 게이트다(지운 게이트?)`);
  }
  return problems;
}

// ── 자체검사: 알려진 실패를 주입해 RED를 본 뒤에만 신뢰한다(§4) ──────────────
const SELF = { pos: 0, neg: 0 };
{
  const base = { 'verify-a': 10 };
  if (findProblems({ 'verify-a': 10 }, base).length) { console.error('check-live-sleep: 셀프테스트 실패 — 정상을 걸렀다(오탐)'); process.exit(2); }
  SELF.neg += 1;
  const bad = [
    ['늘었다', { 'verify-a': 11 }, base, '늘었다'],
    ['줄었는데 기록을 안 낮췄다', { 'verify-a': 9 }, base, '낮추고'],
    ['기준선 없는 새 게이트', { 'verify-a': 10, 'verify-b': 3 }, base, '기준선이 없는'],
    ['유령 기준선', {}, base, '원장(harness)에 없는'],
  ];
  for (const [label, c, b, needle] of bad) {
    if (!findProblems(c, b).some((p) => p.includes(needle))) { console.error(`check-live-sleep: 셀프테스트 실패 — ${label}을(를) 놓쳤다`); process.exit(2); }
    SELF.pos += 1;
  }
  // 🔴 주석 속 글자를 세면 이 조항을 **설명하는 문장**이 게이트를 빨갛게 만든다(M-0118의 형태).
  if (countSleeps('// await page.waitForTimeout(200) 은 쓰지 마라\n  await page.waitForTimeout(200);\n') !== 1) {
    console.error('check-live-sleep: 셀프테스트 실패 — 주석 속 글자를 셌다(오탐)');
    process.exit(2);
  }
  SELF.neg += 1;
}

const isMain = process.argv[1] && process.argv[1].endsWith('check-live-sleep.mjs');
if (isMain) {
  // 모집단은 **harness 원장에서** 뽑는다 — 손으로 나열하면 새 라이브 게이트가 조용히 빠진다.
  const harness = readFileSync(join(ROOT, 'scripts/harness.mjs'), 'utf8');
  const live = [...harness.matchAll(/name:\s*'(verify-[\w-]+)',\s*cmd:\s*'node (scripts\/[\w-]+\.mjs)'/g)];
  if (!live.length) {
    console.error('check-live-sleep: harness에서 라이브 게이트를 하나도 찾지 못했습니다 — 모집단 0으로 조용히 통과시키지 않습니다(§2-J).');
    process.exit(1);
  }
  const counts = {};
  for (const [, name, rel] of live) {
    const p = join(ROOT, rel);
    if (!existsSync(p)) { console.error(`check-live-sleep: ${rel}가 없습니다.`); process.exit(1); }
    counts[name] = countSleeps(readFileSync(p, 'utf8'));
  }
  const problems = findProblems(counts);
  if (problems.length) {
    console.error('🔴 라이브 게이트의 고정 대기 래칫 위반 — 고정 대기는 오류도 경고도 안 내고 **그냥 느려집니다**:');
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(1);
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`check-live-sleep: OK (자체검사 양성 ${SELF.pos}·음성 ${SELF.neg} · 라이브 게이트 ${live.length}개 · 고정 대기 ${total}곳, 기준선 이하)`);
  console.log('  ↳ 정직한 한계: **개수**만 봅니다 — 남은 대기가 각각 정당한지(진짜 비동기를 기다리는지)는 보지 못합니다.');
}
