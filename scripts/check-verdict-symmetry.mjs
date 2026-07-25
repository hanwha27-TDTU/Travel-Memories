// check-verdict-symmetry.mjs — **진단 도구 판정 계약**의 수평 대칭을 정적으로 강제한다.
//
// 왜(실제 사고 2026-07-26, CLAUDE.md 「수평전개와 대칭성」):
// 진단 화면 여섯 개를 적대적으로 리뷰했더니 **같은 결함이 세 곳에서 동형 반복**되고 있었다 —
// 정상 항목을 이상 항목과 같은 무게로 전량 나열하는 형태. 그리고 셋 다 "각자 자기 렌더 코드를
// 가지고 있어서" 생긴 드리프트였다. 사용자가 실기기에서 먼저 봤다("너무 나열되어 있기도 하구요").
//
// 교훈은 M-0006과 **같은 형태**다: 규율을 문서에 적는 것과 구조가 그것을 강제하는 것은 다르다.
// LESSONS §3에 이미 "도메인 대칭성"이 적혀 있었는데도 cascade는 사진·비용만 조용히 빠졌다.
// 그래서 이번엔 세 층으로 간다 — 헌법 조항(CLAUDE.md) + 구조적 강제(공용 렌더러 하나) + 이 게이트.
//
// 검사 항목(전부 실제로 발생한 결함에서 역산했다):
//  A) 지표에 **기대값이 있다.** `actual`만 있고 `expected`가 없는 지표 = 기준 없는 숫자 = 옛 화면.
//  B) 화면 문자열에 **마크다운 리터럴이 없다.** textContent로 그리므로 `**`가 그대로 찍힌다
//     (저장소 경고 문구에서 실제로 노출됐다).
//  C) `.guide-card`를 만드는 코드는 **ic / mid 구조 계약**을 지킨다. 진단 허브만 이 계약을
//     어겨 힌트 텍스트가 16px 셰브론 트랙에 들어가 레이아웃이 깨졌다.
//  D) 진단 도구 등록부의 각 항목이 **필드를 빠짐없이** 갖는다(하나만 조용히 빠지는 게 최빈 결함군).
//  E) 판정 패널이 **옛 나열형 클래스**(r2-row/se-item)로 되돌아가지 않는다 — 공용 렌더러 우회 금지.
//
// 정직한 한계: 정적 검사는 "필드가 있다"까지만 본다. 기대값이 **말이 되는지**는 못 본다.
// 그건 tests/unit/verdict.test.ts가 실제 실행으로, 그리고 사람 리뷰가 본다. 두 층이 함께 있어야 한다.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 화면에 그려지는 문자열을 담는 파일 — 여기서 마크다운 리터럴은 결함이다. */
const TEXT_SURFACES = [
  'src/ui/panels/verdict.ts',
  'src/ui/panels/diagnostics.ts',
  'src/ui/screens/diagnosticsHub.ts',
  'src/services/envReport.ts',
  'src/services/diagnostics.ts',
  'src/domain/integrity.ts',
];

/** 판정 렌더러를 우회하면 안 되는 파일과, 거기서 금지된 옛 나열형 클래스. */
const NO_LEGACY_ROWS = { file: 'src/ui/panels/diagnostics.ts', banned: ['r2-row', 'r2-table', 'se-item', 'se-findings'] };

// ── 검사 A: 지표에 기대값이 있는가 ──────────────────────────────────────────
/**
 * `actual:` 를 가진 객체 리터럴은 `expected:` 와 `level:` 도 가져야 한다.
 * 객체 경계는 중괄호 깊이로 잡는다(중첩 리터럴을 부모로 오인하지 않게).
 */
export function metricsMissingExpected(src) {
  const bad = [];
  for (const m of src.matchAll(/\bactual:/g)) {
    // 이 `actual:` 을 감싸는 가장 가까운 `{` 를 뒤로 훑어 찾는다.
    let depth = 0;
    let start = -1;
    for (let i = m.index; i >= 0; i--) {
      const c = src[i];
      if (c === '}') depth++;
      else if (c === '{') {
        if (depth === 0) {
          start = i;
          break;
        }
        depth--;
      }
    }
    if (start < 0) continue;
    let d = 0;
    let end = src.length;
    for (let j = start; j < src.length; j++) {
      if (src[j] === '{') d++;
      else if (src[j] === '}') {
        d--;
        if (d === 0) {
          end = j + 1;
          break;
        }
      }
    }
    const obj = src.slice(start, end);
    const missing = ['label:', 'expected:', 'level:'].filter((k) => !obj.includes(k));
    if (missing.length) bad.push(`지표 리터럴에 ${missing.join(', ')} 누락 — 기준 없는 숫자는 판정이 아니다 (…${obj.slice(0, 60).replace(/\s+/g, ' ')}…)`);
  }
  return bad;
}

// ── 검사 B: 화면 문자열의 마크다운 리터럴 ───────────────────────────────────
/** 주석은 제외한다(주석에는 강조를 써도 화면에 안 나온다). 따옴표/백틱 문자열만 본다. */
export function markdownInStrings(src) {
  const bad = [];
  const noComments = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  for (const m of noComments.matchAll(/(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g)) {
    const body = m[2];
    if (/\*\*[^*]+\*\*/.test(body)) bad.push(`화면 문자열에 마크다운 강조: "${body.slice(0, 70)}"`);
  }
  return bad;
}

// ── 검사 C: guide-card 구조 계약 ────────────────────────────────────────────
export function guideCardContract(src) {
  if (!/'guide-card(?: |')/.test(src)) return [];
  // ⚠️ 부분문자열로 보면 안 된다(이 게이트 자신의 결함, 2026-07-26 주입시험에서 발견):
  // 실제 결함이었던 `guide-card-icon` 은 `guide-card-ic` 를 포함하므로 includes()로는 통과한다.
  // 게이트가 원래 결함을 그대로 통과시키면 게이트가 아니다. 클래스 토큰 경계로 본다.
  const hasClass = (c) => new RegExp(`['"\\s]${c}(?=['"\\s])`).test(src);
  const missing = ['guide-card-ic', 'guide-card-mid'].filter((c) => !hasClass(c));
  return missing.length
    ? [`.guide-card 를 만들면서 ${missing.join(', ')} 를 쓰지 않음 — CSS는 ic/mid/우측 3트랙을 전제한다(레이아웃이 깨진다)`]
    : [];
}

// ── 검사 D: 도구 등록부 필드 완전성 ─────────────────────────────────────────
const TOOL_FIELDS = ['id:', 'icon:', 'label:', 'hint:', 'lead:', 'probe:'];
export function toolRegistryComplete(src) {
  const bad = [];
  for (const m of src.matchAll(/\{\s*\n\s*id:\s*'([\w-]+)'/g)) {
    let d = 0;
    let end = src.length;
    for (let j = m.index; j < src.length; j++) {
      if (src[j] === '{') d++;
      else if (src[j] === '}') {
        d--;
        if (d === 0) {
          end = j + 1;
          break;
        }
      }
    }
    const obj = src.slice(m.index, end);
    const missing = TOOL_FIELDS.filter((f) => !obj.includes(f));
    if (missing.length) bad.push(`진단 도구 '${m[1]}' 에 ${missing.join(', ')} 누락 — 한 도구만 조용히 빠지는 게 최빈 결함군이다`);
  }
  return bad;
}

// ── 검사 E: 공용 렌더러 우회 ────────────────────────────────────────────────
export function legacyRows(src, banned) {
  return banned.filter((c) => src.includes(`'${c}`) || src.includes(` ${c}'`)).map((c) => `옛 나열형 클래스 '${c}' 사용 — 판정 렌더러(renderTool)를 우회하고 있다`);
}

// ── 셀프테스트: 알려진 실패가 RED로 잡히는지(게이트 비공허, CLAUDE.md §4) ──
{
  const cases = [
    { name: '정상 지표 통과', fn: () => metricsMissingExpected(`const m = { label: 'a', actual: '1', expected: '0', level: 'ok' };`), clean: true },
    {
      name: '기대값 누락 검출(실제 결함 — 옛 진단 5줄)',
      fn: () => metricsMissingExpected(`const m = { label: 'a', actual: '1', level: 'ok' };`),
      clean: false,
    },
    {
      name: '중첩 리터럴을 부모로 오인하지 않는다',
      fn: () => metricsMissingExpected(`const v = { meta: { x: 1 }, label: 'a', actual: '1', expected: '0', level: 'ok' };`),
      clean: true,
    },
    { name: '마크다운 없는 문자열 통과', fn: () => markdownInStrings(`const t = '앱 데이터를 지울 수 있습니다.';`), clean: true },
    {
      name: '마크다운 리터럴 검출(실제 결함 — 저장소 경고)',
      fn: () => markdownInStrings(`const t = '브라우저가 **앱 데이터를 지울 수 있습니다.** 백업하세요';`),
      clean: false,
    },
    { name: '주석 안 강조는 결함이 아니다', fn: () => markdownInStrings(`// 이것은 **강조**된 주석이다\nconst t = '평범한 문자열';`), clean: true },
    {
      name: 'guide-card 계약 통과',
      fn: () => guideCardContract(`el('button', 'guide-card'); el('span','guide-card-ic'); el('span','guide-card-mid');`),
      clean: true,
    },
    {
      name: 'guide-card 계약 위반 검출(실제 결함 — 진단 허브)',
      fn: () => guideCardContract(`el('button', 'guide-card'); el('span','guide-card-icon'); el('span','guide-card-label');`),
      clean: false,
    },
    { name: 'guide-card 를 안 쓰는 파일은 무관', fn: () => guideCardContract(`el('div', 'other');`), clean: true },
    {
      // 이 게이트 자신의 결함: 부분문자열 검사는 원래 결함(guide-card-icon)을 통과시켰다.
      name: '부분문자열 통과를 막는다(guide-card-icon ≠ guide-card-ic)',
      fn: () => guideCardContract(`el('button','guide-card'); el('span','guide-card-icon'); el('span','guide-card-mid');`),
      clean: false,
    },
    {
      name: '도구 등록부 완전',
      fn: () => toolRegistryComplete(`const T = [{\n  id: 'a', icon: 'x', label: 'L', hint: 'h', lead: 'l', probe: p,\n}];`),
      clean: true,
    },
    {
      name: '도구 필드 누락 검출(형제엔 있는데 하나만 빠짐)',
      fn: () => toolRegistryComplete(`const T = [{\n  id: 'a', icon: 'x', label: 'L', hint: 'h', probe: p,\n}];`),
      clean: false,
    },
    { name: '옛 나열형 클래스 없음', fn: () => legacyRows(`el('div', 'vd-metric')`, ['r2-row', 'se-item']), clean: true },
    { name: '옛 나열형 클래스 검출(렌더러 우회)', fn: () => legacyRows(`el('div', 'r2-row')`, ['r2-row', 'se-item']), clean: false },
  ];
  const broken = cases.filter((c) => (c.fn().length === 0) !== c.clean);
  if (broken.length) {
    console.error(`check-verdict-symmetry: 셀프테스트 실패 — 게이트가 공허함: ${broken.map((c) => c.name).join(', ')}`);
    process.exit(2);
  }
}

// ── 실제 검사 ───────────────────────────────────────────────────────────────
const problems = [];
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

for (const rel of TEXT_SURFACES) {
  for (const p of markdownInStrings(read(rel))) problems.push(`${rel}: ${p}`);
}
for (const p of metricsMissingExpected(read('src/ui/panels/diagnostics.ts'))) problems.push(`src/ui/panels/diagnostics.ts: ${p}`);
for (const p of toolRegistryComplete(read('src/ui/panels/diagnostics.ts'))) problems.push(`src/ui/panels/diagnostics.ts: ${p}`);
for (const p of legacyRows(read(NO_LEGACY_ROWS.file), NO_LEGACY_ROWS.banned)) problems.push(`${NO_LEGACY_ROWS.file}: ${p}`);

// guide-card 계약은 그것을 만드는 **모든** 화면에 건다(수평전개 — 한 곳만 고치고 끝내지 않는다).
function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (f.endsWith('.ts')) out.push(p);
  }
  return out;
}
let cardFiles = 0;
for (const abs of walk(join(ROOT, 'src/ui'))) {
  const src = readFileSync(abs, 'utf8');
  const found = guideCardContract(src);
  if (/'guide-card(?: |')/.test(src)) cardFiles++;
  for (const p of found) problems.push(`${relative(ROOT, abs)}: ${p}`);
}

if (problems.length) {
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('check-verdict-symmetry: 진단 판정 계약 위반 — 도구 간 대칭이 깨졌다.');
  process.exit(1);
}
console.log(`check-verdict-symmetry: OK (셀프테스트 14건 통과 · guide-card 화면 ${cardFiles}곳 계약 준수 · 지표 기대값·도구 필드·문구 전부 정상)`);
