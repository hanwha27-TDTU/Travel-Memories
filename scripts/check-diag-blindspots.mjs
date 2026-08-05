// check-diag-blindspots.mjs — 진단 사각지대 등록부가 **조용히 비지 않게** 한다.
//
// 사용자 지시(2026-08-05): *"니가 못보는 건 당연히 모두 넣어야 해..빼면 안 됨"*
//
// 산문으로 적어 둔 사각지대는 다음 세션이 못 찾는다 — 그래서 `src/domain/diagGroups.ts`의
// `BLIND_SPOTS`를 **데이터로** 두고, 이 게이트가 그 등록부의 규율을 강제한다:
//
//   A) 등록부가 비어 있지 않다 — 비면 「사각지대가 없다」는 뜻이 되는데 그건 거의 언제나 거짓이다
//   B) 항목마다 `what`·`whyDevCannot`이 채워져 있다 — 「무엇을」과 「왜 못 재는가」가 없으면
//      다음 사람이 그 항목을 판단할 수 없다
//   C) 🔴 `coveredBy`가 null이면 `pendingReason`이 **반드시** 있다 — 이유 없는 미구현은
//      결함이다(§7: *"적용하지 않는 대상마다 이유를 코드에 남긴다. 이유 없는 제외는 결함이다"*)
//   D) `coveredBy`에 적힌 도구 id가 **실제 등록부에 있다** — 없는 도구를 가리키면 그 항목은
//      덮였다고 적혀 있으면서 실제로는 안 덮인 것이다(가장 위험한 형태)
//   E) `group`이 실제 그룹 목록에 있다
//
// 🔴 **정직한 한계**: 이 게이트는 *"등록됐다"*까지만 안다. 등록부에 **애초에 안 적은** 사각지대는
// 볼 수 없다 — 그건 사람이 §9 4단계(세계를 본다)에서 채운다. 이 게이트가 하는 일은
// *"사각지대가 있다는 사실의 보증"*이 아니라 **"적어 둔 것이 조용히 사라지는 것의 차단"**이다.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** `BLIND_SPOTS` 배열의 항목을 소스에서 파싱한다(런타임 import 없이 — 게이트는 빌드 전에도 돈다). */
export function parseBlindSpots(src) {
  const start = src.indexOf('export const BLIND_SPOTS');
  if (start < 0) return null; // 파싱 실패는 「0건」과 다르다 — 부르는 쪽이 가른다
  const body = src.slice(start);
  const items = [];
  // 최상위 객체 리터럴 단위로 자른다. 항목이 `  {` … `  },` 형태로 들여쓰기돼 있다.
  for (const m of body.matchAll(/\n {2}\{\n([\s\S]*?)\n {2}\},/g)) {
    const chunk = m[1];
    const str = (k) => {
      const r = chunk.match(new RegExp(`\\b${k}:\\s*(['\`])([\\s\\S]*?)\\1\\s*,`));
      return r ? r[2] : null;
    };
    const coveredRaw = chunk.match(/\bcoveredBy:\s*(null|'([^']*)')/);
    items.push({
      what: str('what'),
      whyDevCannot: str('whyDevCannot'),
      group: str('group'),
      coveredBy: coveredRaw ? (coveredRaw[1] === 'null' ? null : coveredRaw[2]) : undefined,
      // 여러 줄 문자열 연결(`'a' +\n 'b'`)도 있으므로 존재 여부만 본다.
      hasPendingReason: /\bpendingReason:/.test(chunk),
    });
  }
  return items;
}

/** 그룹 목록을 소스에서 뽑는다. */
export function parseGroups(src) {
  const m = src.match(/export const DIAG_GROUPS = \[([\s\S]*?)\] as const;/);
  if (!m) return null;
  return [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
}

/** 도구 등록부(`CORE_TOOLS`)의 id 목록. */
export function parseToolIds(src) {
  const m = src.match(/export const CORE_TOOLS[\s\S]*?\n\];/);
  if (!m) return null;
  return [...m[0].matchAll(/\bid: '([\w-]+)'/g)].map((x) => x[1]);
}

/** 순수 검사 — 셀프테스트가 가짜 입력으로 직접 돌린다. */
export function checkBlindSpots(items, groups, toolIds) {
  const problems = [];
  if (items === null) return ['BLIND_SPOTS를 파싱하지 못함(형식 변경?) — 게이트가 공허해지므로 실패 처리'];
  if (!items.length) problems.push('BLIND_SPOTS가 비어 있음 — 「사각지대가 없다」는 거의 언제나 거짓이다');
  items.forEach((it, i) => {
    const at = `BLIND_SPOTS[${i}]${it.what ? ` (${it.what.slice(0, 30)}…)` : ''}`;
    if (!it.what) problems.push(`${at}: what이 비었음 — 무엇을 못 재는지 적어야 한다`);
    if (!it.whyDevCannot) problems.push(`${at}: whyDevCannot이 비었음 — 왜 못 재는지가 이 항목의 근거다`);
    if (!it.group) problems.push(`${at}: group이 비었음`);
    else if (groups && !groups.includes(it.group)) problems.push(`${at}: 알 수 없는 group '${it.group}'`);
    if (it.coveredBy === undefined) {
      problems.push(`${at}: coveredBy를 안 적었음 — 덮은 도구 id 또는 null을 명시해야 한다`);
    } else if (it.coveredBy === null) {
      if (!it.hasPendingReason) {
        problems.push(`${at}: 🔴 coveredBy가 null인데 pendingReason이 없음 — **이유 없는 미구현은 결함이다**(§7)`);
      }
    } else if (toolIds && !toolIds.includes(it.coveredBy)) {
      problems.push(`${at}: coveredBy '${it.coveredBy}' 도구가 등록부에 없음 — 덮였다고 적혔지만 실제로는 안 덮였다`);
    }
  });
  return problems;
}

// ── 셀프테스트: 알려진 위반을 주입해 RED로 잡히는지 확인(게이트 비공허, §4) ──
const G = ['local', 'upload'];
const T = ['roundtrip'];
const ok = { what: 'x', whyDevCannot: 'y', group: 'local', coveredBy: 'roundtrip', hasPendingReason: false };
const selfCases = [
  { name: '정합 통과', items: [ok], expectClean: true },
  { name: '빈 등록부 검출', items: [], expectClean: false },
  { name: '파싱 실패 검출', items: null, expectClean: false },
  { name: 'what 누락 검출', items: [{ ...ok, what: null }], expectClean: false },
  { name: 'whyDevCannot 누락 검출', items: [{ ...ok, whyDevCannot: null }], expectClean: false },
  { name: '🔴 이유 없는 미구현 검출', items: [{ ...ok, coveredBy: null, hasPendingReason: false }], expectClean: false },
  { name: '이유 있는 미구현은 통과', items: [{ ...ok, coveredBy: null, hasPendingReason: true }], expectClean: true },
  { name: '없는 도구를 가리키는 것 검출', items: [{ ...ok, coveredBy: 'nope' }], expectClean: false },
  { name: '알 수 없는 그룹 검출', items: [{ ...ok, group: 'zzz' }], expectClean: false },
  { name: 'coveredBy 미기재 검출', items: [{ ...ok, coveredBy: undefined }], expectClean: false },
];
const brokenSelf = selfCases.filter((c) => (checkBlindSpots(c.items, G, T).length === 0) !== c.expectClean);
if (brokenSelf.length) {
  console.error(`check-diag-blindspots: 셀프테스트 실패 — 게이트가 공허함: ${brokenSelf.map((c) => c.name).join(', ')}`);
  process.exit(2);
}

// ── 실제 검사 ──
const groupsSrc = readFileSync(join(ROOT, 'src/domain/diagGroups.ts'), 'utf8');
const toolsSrc = readFileSync(join(ROOT, 'src/ui/panels/diagnostics.ts'), 'utf8');
const items = parseBlindSpots(groupsSrc);
const groups = parseGroups(groupsSrc);
const toolIds = parseToolIds(toolsSrc);

const problems = checkBlindSpots(items, groups, toolIds);
if (groups === null) problems.push('DIAG_GROUPS를 파싱하지 못함');
if (toolIds === null) problems.push('CORE_TOOLS를 파싱하지 못함 — coveredBy 대조를 못 하므로 실패 처리');

if (problems.length) {
  console.error(`check-diag-blindspots: 사각지대 등록부 위반 ${problems.length}건.`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}

const covered = items.filter((i) => i.coveredBy).length;
console.log(
  `check-diag-blindspots: OK (셀프테스트 통과 · 사각지대 ${items.length}건 · 도구로 덮음 ${covered}건 · 이유 있는 대기 ${items.length - covered}건)`,
);
