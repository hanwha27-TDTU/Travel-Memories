#!/usr/bin/env node
// check-edge-cors — 모든 Edge Function이 **사전요청(OPTIONS)**에 답하고 CORS 헤더를 붙이는가.
//
// 🔴 M-0148(2026-08-12 실측): `geocode`에는 OPTIONS 분기도 CORS 헤더도 **아예 없었다.**
//    앱은 `*.github.io`에서 `*.supabase.co`를 부르므로 브라우저가 사전요청을 먼저 보내는데,
//    그 요청에는 본문이 없어 핸들러의 `req.json()`이 던지고 **400**이 나갔다 — 본 요청은
//    나가지도 못했다. 형제인 `media-sign`은 처음부터 둘 다 갖고 있었다. **형제 하나만
//    조용히 빠져 있었고**, 앱이 그 실패를 삼켜 화면에는 아무 말도 안 나왔다(§7 · §8).
//
// 그래서 조항·구조만으로는 안 된다. 다음 Edge Function이 자동으로 따라오게 이 게이트가 묻는다.
//
// 가정하는 세계(§18-G): 없음 — `supabase/functions/*/index.ts`를 작업트리에서 읽기만 한다.
// 종료코드: 0 통과 · 1 위반 · 2 셀프테스트 실패(공허).

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'supabase/functions';

/**
 * 주석을 지운다. **이 게이트를 만들자마자 내 주석에 걸렸다** — 규칙을 설명하려고 적은
 * `req.json()` 한 조각이 코드보다 앞서 있어 순서 판정이 뒤집혔다(§11 ③ 오탐도 결함이다).
 */
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * 사전요청을 **본문을 읽기 전에** 답하는가. 순서가 틀리면 `req.json()`이 먼저 던진다.
 *
 * 파일 전체에서 잰다 — 진입 방식이 두 가지이기 때문이다(`serve(async …)` 직접 전달 ·
 * 이름 붙인 `handler`를 나중에 `serve(handler)`). 핸들러를 찾아 자르는 방식은 후자를 놓쳤다.
 */
export function answersPreflight(src) {
  const code = stripComments(src);
  const opts = code.search(/req\.method\s*===\s*['"]OPTIONS['"]/);
  if (opts < 0) return false;
  const parse = code.search(/req\.json\s*\(/);
  return parse < 0 || opts < parse;
}

/** 사전요청에 필요한 세 헤더를 다 적었는가. 하나라도 빠지면 브라우저가 거절한다. */
export function hasCorsHeaders(src) {
  const code = stripComments(src);
  return (
    /['"]Access-Control-Allow-Origin['"]/.test(code) &&
    /['"]Access-Control-Allow-Headers['"]/.test(code) &&
    /['"]Access-Control-Allow-Methods['"]/.test(code)
  );
}

function selfTest() {
  const good = `
    const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'a', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
    DENO?.serve(async (req) => {
      if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
      const body = await req.json();
    });`;
  const noOpts = `
    const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'a', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
    DENO?.serve(async (req) => { const body = await req.json(); });`;
  const lateOpts = `
    const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'a', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
    DENO?.serve(async (req) => {
      const body = await req.json();
      if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    });`;
  const noHeaders = `
    DENO?.serve(async (req) => {
      if (req.method === 'OPTIONS') return new Response('ok');
      const body = await req.json();
    });`;
  // 이름 붙인 핸들러를 나중에 넘기는 형태 — media-sign이 이 모양이고, 첫 판이 이걸 놓쳤다.
  const namedHandler = `
    const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'a', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
    async function handler(req) {
      if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
      const body = await req.json();
    }
    if (DENO) DENO.serve(handler);`;
  // 주석이 코드를 이기지 않는가 — 이 게이트가 스스로 걸렸던 자리다.
  const commented = `
    const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'a', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
    DENO?.serve(async (req) => {
      // 아래 req.json()은 본문 없는 요청에서 던진다
      if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
      const body = await req.json();
    });`;

  const cases = [
    ['제대로 된 함수는 통과', () => answersPreflight(good) && hasCorsHeaders(good)],
    ['OPTIONS 분기가 없으면 RED (M-0148의 실제 형태)', () => !answersPreflight(noOpts)],
    ['OPTIONS가 req.json() 뒤에 있으면 RED (순서가 곧 결함이다)', () => !answersPreflight(lateOpts)],
    ['CORS 헤더가 없으면 RED', () => !hasCorsHeaders(noHeaders)],
    ['헤더가 하나라도 빠지면 RED', () => !hasCorsHeaders(`{ 'Access-Control-Allow-Origin': '*' }`)],
    ['이름 붙인 핸들러도 통과(오탐 금지)', () => answersPreflight(namedHandler) && hasCorsHeaders(namedHandler)],
    ['주석 속 req.json()이 순서를 뒤집지 않는다(오탐 금지)', () => answersPreflight(commented)],
  ];
  const failed = cases.filter(([, fn]) => !fn());
  if (failed.length) {
    console.error('check-edge-cors: 셀프테스트 실패 — 게이트가 공허하다(§4).');
    for (const [name] of failed) console.error(`  ✗ ${name}`);
    process.exit(2);
  }
}

selfTest();
if (process.argv.includes('--selftest')) {
  console.log('check-edge-cors: 셀프테스트 통과 (잡아야 할 것 3 · 잡으면 안 되는 것 4)');
  process.exit(0);
}

if (!existsSync(ROOT)) {
  console.error(`check-edge-cors: ${ROOT}가 없습니다 — 잴 대상을 확보하지 못했습니다.`);
  process.exit(2);
}

const fns = readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(ROOT, d.name, 'index.ts')))
  .map((d) => d.name);

// 🔴 대상 0에서 공허하게 통과하지 않는다(§4 — 검사 자신에게도 건다).
if (fns.length === 0) {
  console.error('check-edge-cors: Edge Function을 하나도 못 찾았습니다 — 재지 못했습니다.');
  process.exit(2);
}

const problems = [];
for (const name of fns) {
  const src = readFileSync(join(ROOT, name, 'index.ts'), 'utf8');
  if (!answersPreflight(src)) problems.push(`${name}: 사전요청(OPTIONS)을 본문 읽기 전에 답하지 않습니다`);
  if (!hasCorsHeaders(src)) problems.push(`${name}: Access-Control-Allow-{Origin,Headers,Methods}가 없습니다`);
}

if (problems.length) {
  console.error('check-edge-cors: 브라우저가 못 부르는 Edge Function이 있습니다(M-0148).');
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('  → 앱은 다른 출처에서 부릅니다. 사전요청에 답하지 않으면 본 요청은 나가지도 못합니다.');
  process.exit(1);
}

console.log(`check-edge-cors: Edge Function ${fns.length}개 전부 사전요청에 답하고 CORS를 붙입니다 (${fns.join(', ')})`);
