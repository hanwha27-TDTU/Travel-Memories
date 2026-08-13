// check-font-subsets.mjs — 제목 웹폰트 조각(unicode-range)과 실제 파일의 정합 게이트.
//
// 무엇을 지키나: `fonts.css`는 생성물(`scripts/gen-font-subsets.py`)이다. 조각을 추가·이름변경
// 하고 CSS를 안 고치면 **조용히 폴백 폰트로 돌아간다** — 화면은 멀쩡히 뜨고 글자만 갈라진다.
// 그게 애초에 이 폰트를 번들한 이유(기기별 자간 갈라짐)라, 눈치채기 전까지 되돌아간 줄 모른다.
//
// 이 게이트가 **못** 보는 것: 브라우저가 실제로 어느 조각을 받는지. 그건 CSS 캐스케이드와
// 화면에 뜬 글자에 달린 런타임 사실이라 `verify-editor-live`가 실제 요청으로 확인한다(§10).
// 여기서는 저장소만으로 확인 가능한 것 — 참조 무결성과 순서 계약 — 만 본다.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSelfTest } from './gate-selftest-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS = join(ROOT, 'src/ui/styles/fonts.css');
const FONT_DIR = join(ROOT, 'src/ui/styles/fonts');

/** @font-face 블록에서 (파일명, unicode-range)를 선언 순서대로 뽑는다(순수). */
export function parseFaces(css) {
  const out = [];
  for (const m of css.matchAll(/@font-face\s*\{([\s\S]*?)\}/g)) {
    const body = m[1];
    const file = body.match(/url\(\s*['"]([^'"]+)['"]/)?.[1] ?? null;
    const range = body.match(/unicode-range:\s*([^;]+);/)?.[1]?.trim() ?? null;
    out.push({ file, range, display: /font-display:\s*swap/.test(body) });
  }
  return out;
}

/** unicode-range 문자열이 덮는 코드포인트 수(대략 — 구간 합). */
export function rangeSpan(range) {
  let n = 0;
  for (const part of range.split(',')) {
    const m = part.trim().match(/^U\+([0-9A-Fa-f]+)(?:-([0-9A-Fa-f]+))?$/);
    if (!m) return NaN;
    n += m[2] ? parseInt(m[2], 16) - parseInt(m[1], 16) + 1 : 1;
  }
  return n;
}

// ── 비공허 자체검사(§4) ──
runSelfTest('check-font-subsets', () => {
  const sample = `@font-face { src: url('./fonts/a.woff2') format('woff2'); font-display: swap; unicode-range: U+AC00-AC01,U+AC04; }`;
  const f = parseFaces(sample);
  if (f.length !== 1 || f[0].file !== './fonts/a.woff2') throw new Error('SELF-TEST 실패: @font-face 파싱이 틀림.');
  if (rangeSpan(f[0].range) !== 3) throw new Error('SELF-TEST 실패: 구간 폭 계산이 틀림.');
  if (!Number.isNaN(rangeSpan('U+ZZZZ')) === true) throw new Error('SELF-TEST 실패: 잘못된 구간을 통과시킴.');
  if (parseFaces('@font-face { src: url("./x.woff2"); }')[0].display !== false)
    throw new Error('SELF-TEST 실패: font-display 누락을 못 봄.');
});

const css = readFileSync(CSS, 'utf8');
const faces = parseFaces(css);
const problems = [];

if (faces.length === 0) problems.push('fonts.css에 @font-face가 하나도 없습니다(폰트가 통째로 빠졌나?).');

const referenced = new Set();
for (const f of faces) {
  if (!f.file) {
    problems.push('src: url(...)이 없는 @font-face가 있습니다.');
    continue;
  }
  const name = f.file.replace(/^\.\/fonts\//, '');
  referenced.add(name);
  if (!existsSync(join(FONT_DIR, name))) problems.push(`CSS가 참조하는 파일이 없습니다: ${name}`);
  if (!f.range) problems.push(`${name}: unicode-range가 없습니다 — 조각이 아니라 통짜로 내려갑니다.`);
  else if (Number.isNaN(rangeSpan(f.range))) problems.push(`${name}: unicode-range 문법 오류.`);
  // swap이 없으면 폰트 도착 전 글자가 투명해진다(사용자가 빈 화면을 본다).
  if (!f.display) problems.push(`${name}: font-display: swap이 없습니다.`);
}

// 고아 파일 — 만들어 놓고 CSS에 안 걸면 빌드에 안 실려 커버리지가 조용히 빈다.
// 원본(Pretendard-ExtraBold.woff2)은 생성 원본이라 참조되지 않는 것이 정상이다.
const GENERATION_SOURCE = 'Pretendard-ExtraBold.woff2';
for (const f of readdirSync(FONT_DIR)) {
  if (!f.endsWith('.woff2') || f === GENERATION_SOURCE) continue;
  if (!referenced.has(f)) problems.push(`CSS가 안 쓰는 폰트 파일이 남아 있습니다: ${f}`);
}
if (!existsSync(join(FONT_DIR, GENERATION_SOURCE)))
  problems.push(`생성 원본이 없습니다: ${GENERATION_SOURCE} — 조각을 다시 만들 수 없습니다.`);

// 순서 계약: 한글 블록을 성기게 덮는 조각(ko-ext)은 정밀한 조각보다 **먼저** 선언돼야 한다.
// 뒤에 오면 흔한 음절까지 그 조각이 이겨 442KB를 매번 내려받는다.
const coarse = faces.findIndex((f) => f.range && /U\+AC00-D7A3/i.test(f.range));
const precise = faces.findIndex((f) => f.range && /U\+AC0[0-9A-F]/i.test(f.range) && f.range.split(',').length > 50);
if (coarse >= 0 && precise >= 0 && coarse > precise) {
  problems.push(
    '한글 블록 전체를 덮는 조각이 정밀 조각보다 뒤에 선언됐습니다 — ' +
      '겹치면 뒤 선언이 이기므로 흔한 글자에도 큰 조각이 내려갑니다.',
  );
}

if (problems.length > 0) {
  console.error('check-font-subsets: 폰트 조각 선언과 실제 파일이 어긋납니다.');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('  → python3 scripts/gen-font-subsets.py 로 재생성한 뒤 커밋하세요.');
  process.exit(1);
}

console.log(`check-font-subsets: OK — 조각 ${faces.length}개, 참조·구간·swap·선언순서 정합.`);
