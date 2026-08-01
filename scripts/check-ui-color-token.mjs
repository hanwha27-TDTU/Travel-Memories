#!/usr/bin/env node
// check-ui-color-token.mjs — **브랜드 색은 TS에 하드코딩하지 않는다**(색 SSOT는 tokens.css).
//
// 왜 생겼나(H-6 · 전수 감사 2026-08-01): `mapView.ts`가 지도 마커 색을 `'#f0836c'`로 **직접**
// 박아 뒀다 — `--a1`(여름 강조색)의 값을 손으로 복제한 것이다. 계절이 바뀌거나 토큰을 고치면
// 지도만 옛 색으로 남는다(§7 비대칭). 색이 두 곳에 있으면 갈라지는 것은 시간 문제다(§SSOT).
//
// 이 게이트는 `src/ui/**/*.ts`에서 **따옴표로 감싼 6자리 hex 색 리터럴**을 잡는다. CSS는
// 사진 위 유리/그림자 스크림에 정당한 리터럴이 많으므로(§H-6 조사) **TS만** 본다 — TS에서
// 브랜드 색을 박을 이유는 거의 없고, 있으면 tokens.css에서 읽어야 한다(getComputedStyle).
//
// 정당한 예외(토큰 폴백·캔버스 중립색 등)는 같은 줄에 `// color-token-ok: 이유`를 적으면
// 통과한다 — 이유 없는 예외는 결함이다(§7). PR 번호(`#118`)처럼 색이 아닌 `#`은 **따옴표로
// 감싼 6자리**만 세므로 오탐이 나지 않는다(문장 속 `#118`은 `'#118'`이 아니다).

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UI_DIR = 'src/ui';

/** 따옴표로 감싼 6자리 hex(#rrggbb). 3자리는 `#118`(PR 번호) 오탐이 많아 6자리만 본다. */
const HEX_RE = /['"`]#[0-9a-fA-F]{6}['"`]/;
const ALLOW = /color-token-ok/;

/** 한 소스에서 (줄번호, 내용) 위반 목록. 순수 함수라 자체검사가 직접 부른다. */
export function violations(src) {
  const out = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!HEX_RE.test(line)) continue;
    if (ALLOW.test(line)) continue; // 이유를 적은 예외
    out.push({ line: i + 1, text: line.trim() });
  }
  return out;
}

// ── 비공허 자체검사(§4) ─────────────────────────────────────────────────────
let selfTestCount = 0;
{
  const cases = [
    { name: '하드코딩 hex는 잡는다', src: "const c = '#f0836c';", clean: false },
    { name: '토큰에서 읽으면 통과', src: "const c = getComputedStyle(root).getPropertyValue('--a1');", clean: true },
    { name: 'color-token-ok 예외는 통과', src: "return v || '#f0836c'; // color-token-ok: 폴백", clean: true },
    { name: 'PR 번호(#118)는 오탐하지 않는다', src: "const note = 'PR #118로 병합';", clean: true },
    { name: '3자리 hex도 문장 속이면 안 센다(6자리만)', src: "const t = 'a#118b';", clean: true },
    { name: 'CSS var는 통과', src: "el.style.background = 'var(--a1)';", clean: true },
  ];
  const broken = cases.filter((c) => (violations(c.src).length === 0) !== c.clean);
  if (broken.length) {
    console.error(`check-ui-color-token: 셀프테스트 실패 — 게이트가 공허함: ${broken.map((c) => c.name).join(', ')}`);
    process.exit(2);
  }
  selfTestCount = cases.length;
}

function collectTs(dir) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  const out = [];
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...collectTs(rel));
    else if (e.name.endsWith('.ts') && !e.name.includes('.test.')) out.push(rel);
  }
  return out;
}

const files = collectTs(UI_DIR);
if (files.length === 0) {
  console.error(`check-ui-color-token: ${UI_DIR} 아래 .ts를 못 찾음 — 경로가 바뀌었으면 이 게이트도 고치세요(§4 대상 0 = 안 잰 것).`);
  process.exit(1);
}

let failed = false;
let checked = 0;
for (const rel of files) {
  const v = violations(readFileSync(join(ROOT, rel), 'utf8'));
  checked++;
  for (const { line, text } of v) {
    failed = true;
    console.error(`  ✗ ${rel}:${line} 하드코딩 색 리터럴 — tokens.css에서 읽으세요(getComputedStyle) 또는 이유와 함께 \`// color-token-ok:\` 표시.`);
    console.error(`      ${text}`);
  }
}
if (failed) {
  console.error('check-ui-color-token: 브랜드 색이 TS에 하드코딩됐습니다(색 SSOT는 tokens.css).');
  process.exit(1);
}
console.log(`check-ui-color-token: OK (셀프테스트 ${selfTestCount}건 · ${UI_DIR} ${checked}개 파일 · 하드코딩 색 0)`);
