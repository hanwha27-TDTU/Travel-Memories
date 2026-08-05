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
//   F) 🔴 **도구마다 `group`이 있다** — v1.76이 분류를 만들고 도구에는 안 걸었다(M-0015 재발)
//   G) 🔴 **도구가 없는 단계는 등록부에 이유가 있다** — 빈 단계는 화면에서 「검사됨」으로 읽힌다
//   H) 🔴 **단계 아이콘이 흑백 두부로 안 그려진다** — 육안에서 나왔지만 규칙이 정확해 기계로 잡는다
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

/** 도구의 `{id, group}` 쌍. `group`이 없으면 `null`로 들어온다(그게 잡을 대상이다). */
export function parseToolGroups(src) {
  const m = src.match(/export const CORE_TOOLS[\s\S]*?\n\];/);
  if (!m) return null;
  // `\s*`가 줄바꿈까지 먹으므로 선택 그룹 안에 `\n`을 또 두면 **영원히 안 맞는다**(첫 판에서
  // 실제로 그랬다 — 도구 12개가 전부 「group 없음」으로 잡혔다). 공백은 한 번만 소비한다.
  return [...m[0].matchAll(/\bid: '([\w-]+)',\s*(?:group: '([a-z]+)',)?/g)].map((x) => ({
    id: x[1],
    group: x[2] ?? null,
  }));
}

/**
 * 🔴 **분류가 도구까지 닿았는가** — F·G (2026-08-05 추가).
 *
 * 왜 생겼나: v1.76이 경로축 8단계를 만들고 인계에 *"재분류했다"*고 적었는데, **실제로는
 * 사각지대 등록부에만 걸렸고 도구에는 안 걸렸다.** `DIAG_GROUPS`를 `src` 전체에서 찾으면
 * 자기 파일 밖에서 쓰는 곳이 하나도 없었고, 허브는 도구를 평평하게 나열하고 있었다 —
 * M-0015(*"만들어 놓고 화면에서 부르지 않음"*)의 재발이다. 문서를 고치러 왔다가 찾았다(§9 2단계).
 *
 *   F) 도구마다 `group`이 있고 실존 그룹이다 — 타입이 이미 막지만, 등록부가 손편집이라
 *      **게이트가 같은 질문을 한 번 더 한다**(타입은 리팩터로 느슨해질 수 있다)
 *   G) 🔴 **도구가 하나도 없는 단계는 사각지대 등록부에 이유가 있어야 한다.** 없으면 그
 *      단계는 화면에서 「검사됨」처럼 보이면서 아무도 안 보는 자리가 된다(§8).
 */
export function checkToolGroups(toolGroups, groups, items) {
  const problems = [];
  if (toolGroups === null) return ['CORE_TOOLS의 group을 파싱하지 못함 — 분류 대조가 공허해지므로 실패 처리'];
  for (const t of toolGroups) {
    if (!t.group) problems.push(`도구 '${t.id}': group이 없음 — 경로축 어느 단계인지 밝혀야 한다(§7)`);
    else if (groups && !groups.includes(t.group)) problems.push(`도구 '${t.id}': 알 수 없는 group '${t.group}'`);
  }
  for (const g of groups ?? []) {
    if (toolGroups.some((t) => t.group === g)) continue;
    const why = (items ?? []).some((i) => i.group === g && i.coveredBy === null);
    if (!why) {
      problems.push(
        `그룹 '${g}': 도구가 하나도 없는데 사각지대 등록부에 이유가 없음 — ` +
          `빈 단계는 「검사됨」으로 읽힌다. 도구를 만들거나 BLIND_SPOTS에 이유와 함께 올려라(§7·§8)`,
      );
    }
  }
  return problems;
}

/** `GROUP_META`의 `{group, icon}` 쌍. */
export function parseGroupIcons(src) {
  const m = src.match(/export const GROUP_META[\s\S]*?\n\};/);
  if (!m) return null;
  return [...m[0].matchAll(/(\w+): \{ icon: '([^']+)'/g)].map((x) => ({ group: x[1], icon: x[2] }));
}

/**
 * 🔴 **단계 아이콘이 흑백 두부로 그려지지 않는가** — H (2026-08-05, 육안에서 나옴).
 *
 * 유니코드에는 **기본이 글자 표현인 이모지**가 있다(`Emoji_Presentation=No`). `🛡`·`🖼`·`☁`가
 * 그렇다 — 뒤에 이형자 선택자 U+FE0F를 안 붙이면 **흑백 윤곽선**으로 그려진다. 실제로
 * 허브를 캡처해 보니 여덟 단계 중 둘만 흑백이었다(2026-08-05). 형제 여덟이 같은 자리에서
 * 같은 무게로 서야 하는데 둘만 다르게 보였다 — §7 사용자 대면 대칭이다.
 *
 * 이건 눈으로만 잡히는 부류로 보이지만 **규칙이 정확해서 기계로 잡을 수 있다**: 아이콘은
 * ①한 글자이면서 `Emoji_Presentation=Yes`이거나 ②U+FE0F로 끝나야 한다. Node의 유니코드
 * 속성 이스케이프(`\p{Emoji_Presentation}`)가 그 판정을 정확히 해 준다 — 표를 손으로 들고
 * 있지 않아도 된다(§7 2층: 다음 단계가 자동으로 따라온다).
 */
export function checkGroupIcons(icons) {
  if (icons === null) return ['GROUP_META를 파싱하지 못함 — 아이콘 대조가 공허해지므로 실패 처리'];
  const problems = [];
  for (const { group, icon } of icons) {
    if (!icon) problems.push(`그룹 '${group}': icon이 비었음`);
    else if (!/^\p{Emoji_Presentation}$/u.test(icon) && !icon.endsWith('️')) {
      problems.push(
        `그룹 '${group}': 아이콘 '${icon}'이 **흑백 글자꼴로 그려진다** — ` +
          `뒤에 U+FE0F(이형자 선택자)를 붙여라. 형제 단계와 다르게 보인다(§7)`,
      );
    }
  }
  return problems;
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

// F·G 셀프테스트 — 분류가 도구까지 닿았는가.
const pending = { what: 'x', whyDevCannot: 'y', group: 'upload', coveredBy: null, hasPendingReason: true };
const groupCases = [
  { name: '정합 통과(두 그룹 다 도구 있음)', tg: [{ id: 'a', group: 'local' }, { id: 'b', group: 'upload' }], items: [], expectClean: true },
  { name: '🔴 group 없는 도구 검출(v1.76이 뚫린 자리)', tg: [{ id: 'a', group: null }, { id: 'b', group: 'upload' }], items: [], expectClean: false },
  { name: '알 수 없는 group 검출', tg: [{ id: 'a', group: 'zzz' }, { id: 'b', group: 'upload' }], items: [], expectClean: false },
  { name: '🔴 이유 없는 빈 단계 검출', tg: [{ id: 'a', group: 'local' }], items: [], expectClean: false },
  { name: '이유 있는 빈 단계는 통과', tg: [{ id: 'a', group: 'local' }], items: [pending], expectClean: true },
  { name: '파싱 실패 검출', tg: null, items: [], expectClean: false },
];
// H 셀프테스트 — 흑백으로 그려질 아이콘을 잡는가.
const iconCases = [
  { name: '컬러 기본 이모지 통과', icons: [{ group: 'a', icon: '📒' }], expectClean: true },
  { name: 'VS16 붙인 것 통과', icons: [{ group: 'a', icon: '🛡️' }], expectClean: true },
  { name: '🔴 VS16 없는 방패 검출(실제로 이렇게 나갔다)', icons: [{ group: 'a', icon: '🛡' }], expectClean: false },
  { name: '🔴 VS16 없는 구름 검출', icons: [{ group: 'a', icon: '☁' }], expectClean: false },
  { name: '빈 아이콘 검출', icons: [{ group: 'a', icon: '' }], expectClean: false },
  { name: '파싱 실패 검출', icons: null, expectClean: false },
];
const brokenIcons = iconCases.filter((c) => (checkGroupIcons(c.icons).length === 0) !== c.expectClean);
if (brokenIcons.length) {
  console.error(`check-diag-blindspots: 셀프테스트 실패(아이콘) — 게이트가 공허함: ${brokenIcons.map((c) => c.name).join(', ')}`);
  process.exit(2);
}

const brokenGroups = groupCases.filter((c) => (checkToolGroups(c.tg, G, c.items).length === 0) !== c.expectClean);
if (brokenGroups.length) {
  console.error(`check-diag-blindspots: 셀프테스트 실패(분류) — 게이트가 공허함: ${brokenGroups.map((c) => c.name).join(', ')}`);
  process.exit(2);
}

// ── 실제 검사 ──
const groupsSrc = readFileSync(join(ROOT, 'src/domain/diagGroups.ts'), 'utf8');
const toolsSrc = readFileSync(join(ROOT, 'src/ui/panels/diagnostics.ts'), 'utf8');
const items = parseBlindSpots(groupsSrc);
const groups = parseGroups(groupsSrc);
const toolIds = parseToolIds(toolsSrc);

const toolGroups = parseToolGroups(toolsSrc);

const problems = checkBlindSpots(items, groups, toolIds);
problems.push(...checkToolGroups(toolGroups, groups, items ?? []));
problems.push(...checkGroupIcons(parseGroupIcons(groupsSrc)));
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
