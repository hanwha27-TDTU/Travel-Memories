#!/usr/bin/env node
// check-no-synthetic-italic.mjs — **한글에 인위적 기울임을 쓰지 않는다.**
//
// 왜 생겼나(2026-07-26 사용자 실기기): "디자인이 전반적으로 조잡해요."
// 원인 중 하나가 보조 안내문 4종의 `font-style: italic`이었다. 한글 글꼴에는 **진짜 이탤릭
// 자형이 없다.** 그래서 브라우저가 정자체를 억지로 비스듬히 밀어 그린다(synthetic oblique) —
// 획 두께 균형이 무너지고, 세로획이 어긋나고, 문장이 길수록 읽기 어려워진다. 라틴 문자에서
// 자연스러운 것이 한글에서는 그대로 조잡함이 된다.
//
// 위계가 필요하면 **크기·색·간격**으로 준다. 그건 글꼴이 실제로 가진 수단이다.
//
// 이 게이트가 §10 ①(계약 결함)에 해당하는 이유: 답이 데이터가 아니라 코드에 있다.
// 정적으로 볼 수 있으면 정적으로 잠근다 — 사람이 다음에 또 붙이는 것을 막는 층이다.
//
// 예외를 둬야 한다면 `ALLOWED`에 **이유와 함께** 적는다(이유 없는 제외는 결함이다 — §7).

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS_DIR = join(ROOT, 'src/ui/styles');

/**
 * 근거 있는 예외. 비면 규율이 죽는 게 아니라 **비어 있는 것이 정상**이다 —
 * 이 앱의 화면 문자열은 전부 한글이므로 지금은 예외가 없다.
 * (라틴 전용 요소가 생기면 셀렉터와 이유를 여기 적는다.)
 */
export const ALLOWED = {};

/** `font-style: italic|oblique` 선언을 찾는다. 주석 안은 세지 않는다. */
export function findItalics(css) {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const lines = noComments.split('\n');
  let selector = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const sel = line.match(/^\s*([^{}]+?)\s*\{/);
    if (sel) selector = (sel[1] ?? '').trim();
    if (/font-style\s*:\s*(italic|oblique)/i.test(line)) out.push({ line: i + 1, selector, text: line.trim() });
  }
  return out.filter((h) => !(h.selector in ALLOWED));
}

// ── 비공허 자체검사 ─────────────────────────────────────────────────────────
let selfTestCount = 0;
{
  const cases = [
    { name: '기울임이 없으면 정상', css: '.a { color: red; }', clean: true },
    { name: 'italic 검출(원래 결함이 정확히 이 형태였다)', css: '.guide-note { color: red; font-style: italic; }', clean: false },
    { name: 'oblique도 같은 것이다', css: '.a { font-style: oblique; }', clean: false },
    { name: '공백이 달라도 잡는다', css: '.a { font-style:italic }', clean: false },
    { name: '주석 속 언급은 세지 않는다(오탐 방지)', css: '/* font-style: italic 을 쓰지 않는다 */\n.a { color: red; }', clean: true },
    { name: 'font-style: normal 은 정상', css: '.a { font-style: normal; }', clean: true },
    { name: '셀렉터를 함께 보고한다', css: '.se-gap { font-style: italic; }', clean: false, sel: '.se-gap' },
  ];
  const broken = cases.filter((c) => {
    const hits = findItalics(c.css);
    if ((hits.length === 0) !== c.clean) return true;
    return Boolean(c.sel) && hits[0]?.selector !== c.sel;
  });
  if (broken.length) {
    console.error(`check-no-synthetic-italic: 셀프테스트 실패 — 게이트가 공허함: ${broken.map((c) => c.name).join(', ')}`);
    process.exit(2);
  }
  selfTestCount = cases.length;
}

const files = readdirSync(CSS_DIR).filter((f) => f.endsWith('.css'));
const problems = [];
for (const f of files) {
  for (const h of findItalics(readFileSync(join(CSS_DIR, f), 'utf8'))) {
    problems.push(`src/ui/styles/${f}:${h.line}  ${h.selector || '(셀렉터 불명)'} — ${h.text}`);
  }
}
if (problems.length) {
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error(
    'check-no-synthetic-italic: 한글에는 진짜 이탤릭 자형이 없어 브라우저가 억지로 기울입니다(조잡해집니다).\n' +
      '  → 위계는 크기·색·간격으로 주세요. 라틴 전용이라면 ALLOWED에 셀렉터와 이유를 적으세요.',
  );
  process.exit(1);
}
console.log(
  `check-no-synthetic-italic: OK (셀프테스트 ${selfTestCount}건 · CSS ${files.length}개 · 근거 있는 예외 ${Object.keys(ALLOWED).length}개)`,
);
