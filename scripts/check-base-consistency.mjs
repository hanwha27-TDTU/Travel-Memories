// check-base-consistency.mjs — base 경로 SSOT 게이트 (docs/DEPLOYMENT.md ADR-0010)
// base('/Travel-Memories/')의 SSOT는 vite.config.ts의 BASE다. 라우터·index.html은
// 빌드 시 파생(import.meta.env.BASE_URL / %BASE_URL%)되지만, 정적 자산인
// manifest.webmanifest는 빌드 변환을 거치지 않아 손편집 중복이 불가피하다 —
// 그 중복이 조용히 어긋나지 않도록 이 게이트가 기계로 대조한다(M-0001형 방지).
import { readFileSync } from 'node:fs';

function baseFromViteConfig(src) {
  const m = src.match(/export const BASE = '([^']+)'/);
  return m ? m[1] : null;
}

/** 위반 목록 반환(빈 배열 = 통과). */
function check(viteSrc, manifestText, indexHtml) {
  const problems = [];
  const base = baseFromViteConfig(viteSrc);
  if (!base) return ['vite.config.ts에서 BASE 추출 실패 — 선언 형식 확인'];
  if (!base.startsWith('/') || !base.endsWith('/')) problems.push(`BASE는 '/…/' 형태여야 함: ${base}`);

  let manifest;
  try { manifest = JSON.parse(manifestText); } catch { return [...problems, 'manifest.webmanifest JSON 파싱 실패']; }
  if (manifest.start_url !== base) problems.push(`manifest start_url(${manifest.start_url}) ≠ BASE(${base})`);
  if (manifest.scope !== base) problems.push(`manifest scope(${manifest.scope}) ≠ BASE(${base})`);

  // index.html의 base 의존 링크는 하드코딩 금지 — %BASE_URL%로 파생해야 한다.
  if (indexHtml.includes(`href="${base}`)) problems.push(`index.html에 base 하드코딩 링크 존재 — %BASE_URL% 사용`);
  if (!indexHtml.includes('rel="manifest"')) problems.push('index.html에 manifest 링크 없음(PWA 설치 불가)');
  return problems;
}

// ── 셀프테스트: 알려진 드리프트 주입이 RED로 잡히는지 확인(게이트 비공허) ──
const VITE_FIX = "export const BASE = '/App/';";
const MANI_FIX = '{"start_url": "/App/", "scope": "/App/"}';
const HTML_FIX = '<link rel="manifest" href="%BASE_URL%manifest.webmanifest" />';
const selfCases = [
  { name: '정합 통과', v: VITE_FIX, m: MANI_FIX, h: HTML_FIX, expectClean: true },
  { name: 'start_url 드리프트 검출', v: VITE_FIX, m: MANI_FIX.replace('"start_url": "/App/"', '"start_url": "/Other/"'), h: HTML_FIX, expectClean: false },
  { name: 'scope 드리프트 검출', v: VITE_FIX, m: MANI_FIX.replace('"scope": "/App/"', '"scope": "/"'), h: HTML_FIX, expectClean: false },
  { name: 'BASE 추출 실패 검출', v: 'const x = 1;', m: MANI_FIX, h: HTML_FIX, expectClean: false },
  { name: 'html 하드코딩 검출', v: VITE_FIX, m: MANI_FIX, h: HTML_FIX + '<link href="/App/x.png" />', expectClean: false },
  { name: 'manifest 링크 부재 검출', v: VITE_FIX, m: MANI_FIX, h: '<head></head>', expectClean: false },
];
const brokenSelf = selfCases.filter((c) => (check(c.v, c.m, c.h).length === 0) !== c.expectClean);
if (brokenSelf.length) {
  console.error(`check-base-consistency: 셀프테스트 실패 — 게이트가 공허함: ${brokenSelf.map((c) => c.name).join(', ')}`);
  process.exit(2);
}

// ── 실제 검사 ──
const problems = check(
  readFileSync('vite.config.ts', 'utf8'),
  readFileSync('public/manifest.webmanifest', 'utf8'),
  readFileSync('index.html', 'utf8'),
);
if (problems.length) {
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('check-base-consistency: base 경로가 SSOT(vite.config BASE)와 불일치.');
  process.exit(1);
}
console.log('check-base-consistency: OK (셀프테스트 통과 · BASE↔manifest↔index.html 정합)');
