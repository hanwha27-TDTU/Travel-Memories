#!/usr/bin/env node
// check-update-signal — 「접속하면 스스로 최신」 계약이 네 자리에서 같은가.
//
// 사용자 지시(2026-08-01): *"접속할 때 자동으로 최신 버젼으로 적용되도록 해주세요"* —
// 셸·설치형 PWA는 페이지를 다시 로드하지 않아 새 배포가 화면에 안 닿는다(M-0070).
//
// 계약의 네 자리(하나라도 조용히 빠지면 갱신 사슬이 끊기고, 그 결함은 **다음 배포까지 아무도
// 모른다** — 정확히 이번에 사용자가 발견한 형태):
//   ① 빌드 체인(package.json) — build가 gen-version-file.mjs를 돌려 신호를 심는다
//   ② 생성기(scripts/gen-version-file.mjs) — dist/version.json을 쓴다
//   ③ 앱(src/services/appUpdate.ts) — version.json을 no-store로 묻고, main.ts가 배선한다
//   ④ 서비스워커(public/sw.js) — version.json을 만지지 않는다(캐시하면 신호가 낡고,
//      ?ts= 쿼리 변형이 캐시 상한을 밀어 진짜 자산을 쫓아낸다)
//
// §4: 아래 셀프테스트가 주입 실패로 RED를 먼저 확인한 뒤에만 실제 검사를 돈다.

import { readFileSync } from 'node:fs';

export function pkgProblems(text) {
  const p = [];
  if (!/"build":[^\n]*gen-version-file\.mjs/.test(text)) {
    p.push('build 체인에 gen-version-file.mjs가 없다 — 배포에 신호가 안 심긴다');
  }
  return p;
}

export function genProblems(text) {
  const p = [];
  if (!text.includes('dist/version.json')) p.push('생성기가 dist/version.json을 쓰지 않는다');
  if (!/changelog\.ts/.test(text)) p.push('버전을 changelog(SSOT)에서 읽지 않는다 — 두 진실이 생긴다(§7)');
  return p;
}

export function appProblems(appText, mainText) {
  const p = [];
  if (!appText.includes('version.json?ts=')) p.push('appUpdate가 version.json을 캐시 우회 쿼리로 묻지 않는다');
  if (!appText.includes("cache: 'no-store'")) p.push('fetch에 no-store가 없다 — 브라우저 캐시가 신호를 낡게 둔다');
  if (!/wireAutoUpdate/.test(mainText)) p.push('main.ts가 wireAutoUpdate를 배선하지 않는다 — 코드는 있는데 아무도 안 부른다');
  return p;
}

export function swProblems(text) {
  const p = [];
  if (!/version\.json[^\n]*\)\s*\)?\s*return;|endsWith\('\/version\.json'\)\)\s*return;/.test(text)) {
    p.push('sw.js가 version.json을 통과시키지 않는다 — 신호가 캐시에 갇히거나 상한을 오염시킨다');
  }
  return p;
}

// ── 셀프테스트 (§4) ─────────────────────────────────────────────────────────
const GOOD_PKG = `"build": "tsc --noEmit && vite build && node scripts/gen-version-file.mjs",`;
const GOOD_GEN = `readFileSync('src/app/changelog.ts', 'utf8')\nwriteFileSync('dist/version.json', ...)`;
const GOOD_APP = `fetch(\`\${base}version.json?ts=\${Date.now()}\`, { cache: 'no-store' })`;
const GOOD_MAIN = `m.wireAutoUpdate()`;
const GOOD_SW = `if (url.pathname.endsWith('/version.json')) return;`;

function selfTest() {
  const cases = [
    ['정상 4자리 통과', () =>
      pkgProblems(GOOD_PKG).length + genProblems(GOOD_GEN).length +
      appProblems(GOOD_APP, GOOD_MAIN).length + swProblems(GOOD_SW).length === 0],
    ['빌드 체인에서 생성기 제거 → RED', () => pkgProblems(`"build": "tsc --noEmit && vite build",`).length > 0],
    ['생성기가 버전을 딴 데서 읽음 → RED', () => genProblems(`writeFileSync('dist/version.json', '{"version":"9.9"}')`).length > 0],
    ['no-store 제거 → RED', () => appProblems(`fetch(\`\${base}version.json?ts=1\`)`, GOOD_MAIN).length > 0],
    ['main 배선 제거 → RED', () => appProblems(GOOD_APP, `// 아무것도 안 부른다`).length > 0],
    ['sw 통과 규칙 제거 → RED', () => swProblems(`// version.json 언급 없음`).length > 0],
  ];
  const failed = cases.filter(([, fn]) => !fn());
  if (failed.length) {
    console.error('check-update-signal: 셀프테스트 실패 — 게이트 자체가 공허하다(§4).');
    for (const [name] of failed) console.error(`  ✗ ${name}`);
    process.exit(2);
  }
}

selfTest();
if (process.argv.includes('--selftest')) {
  console.log('check-update-signal: 셀프테스트 통과');
  process.exit(0);
}

const problems = [
  ...pkgProblems(readFileSync('package.json', 'utf8')).map((m) => `package.json: ${m}`),
  ...genProblems(readFileSync('scripts/gen-version-file.mjs', 'utf8')).map((m) => `gen-version-file.mjs: ${m}`),
  ...appProblems(
    readFileSync('src/services/appUpdate.ts', 'utf8'),
    readFileSync('src/main.ts', 'utf8'),
  ).map((m) => `appUpdate/main: ${m}`),
  ...swProblems(readFileSync('public/sw.js', 'utf8')).map((m) => `public/sw.js: ${m}`),
];

if (problems.length) {
  console.error('check-update-signal: 「접속하면 스스로 최신」 계약이 갈라졌다.');
  for (const m of problems) console.error(`  ✗ ${m}`);
  process.exit(1);
}
console.log('check-update-signal: OK — 빌드 신호·앱 확인·SW 무개입이 한 계약이다.');
