// check-csp.mjs — CSP ↔ 기술 스택 계약 게이트 (docs/DEPLOYMENT.md S-05)
// index.html의 meta CSP가 선언된 스택(Supabase Realtime·MapLibre 워커·Storage 썸네일)이
// 요구하는 소스를 포함하고, 금지 소스(unsafe-eval 등)를 넣지 않았는지 검사한다.
// 지도 제공자(A-006) 확정 시 아래 REQUIRED에 해당 호스트를 추가한다(CSP와 같은 커밋).
import { readFileSync } from 'node:fs';

// 지시어별 필수 소스. 스택 근거는 index.html의 CSP 주석 참조.
const REQUIRED = {
  'connect-src': ["'self'", 'https://*.supabase.co', 'wss://*.supabase.co'],
  'worker-src': ['blob:'],           // MapLibre GL blob: 워커
  'img-src': ['data:', 'blob:', 'https://*.supabase.co'],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
};
// script-src에 절대 들어가면 안 되는 소스(XSS 방어선).
const FORBIDDEN = { 'script-src': ["'unsafe-inline'", "'unsafe-eval'"] };

/** meta CSP content 문자열 → { 지시어: [소스...] } */
function parseCsp(content) {
  const out = {};
  for (const part of content.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length) out[tokens[0]] = tokens.slice(1);
  }
  return out;
}

/** html 텍스트를 검사해 위반 목록을 반환(빈 배열 = 통과). */
function checkHtml(html) {
  const m = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/s);
  if (!m) return ['index.html에 CSP meta 태그가 없음'];
  const csp = parseCsp(m[1]);
  const problems = [];
  for (const [dir, sources] of Object.entries(REQUIRED)) {
    if (!csp[dir]) { problems.push(`${dir} 지시어 누락`); continue; }
    for (const s of sources) {
      if (!csp[dir].includes(s)) problems.push(`${dir}에 ${s} 누락`);
    }
  }
  for (const [dir, sources] of Object.entries(FORBIDDEN)) {
    for (const s of sources) {
      if (csp[dir]?.includes(s)) problems.push(`${dir}에 금지 소스 ${s} 포함`);
    }
  }
  return problems;
}

// ── 셀프테스트: 알려진 실패 주입이 RED로 잡히는지 확인(게이트 비공허, CLAUDE.md §4) ──
const GOOD = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data: blob: https://*.supabase.co; connect-src 'self' https://*.supabase.co wss://*.supabase.co; worker-src 'self' blob:; script-src 'self'; object-src 'none'; base-uri 'self'" />`;
const selfCases = [
  { name: '정상 CSP 통과', html: GOOD, expectClean: true },
  { name: 'wss 누락 검출', html: GOOD.replace(' wss://*.supabase.co', ''), expectClean: false },
  { name: 'worker-src 누락 검출', html: GOOD.replace(" worker-src 'self' blob:;", ''), expectClean: false },
  { name: 'unsafe-eval 검출', html: GOOD.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'"), expectClean: false },
  { name: 'CSP 부재 검출', html: '<meta charset="UTF-8" />', expectClean: false },
];
const brokenSelf = selfCases.filter((c) => (checkHtml(c.html).length === 0) !== c.expectClean);
if (brokenSelf.length) {
  console.error(`check-csp: 셀프테스트 실패 — 게이트가 공허함: ${brokenSelf.map((c) => c.name).join(', ')}`);
  process.exit(2);
}

// ── 실제 검사 ──
const problems = checkHtml(readFileSync('index.html', 'utf8'));
if (problems.length) {
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('check-csp: CSP가 스택 계약과 불일치 — 지도/Realtime/썸네일이 조용히 차단된다.');
  process.exit(1);
}
console.log('check-csp: OK (셀프테스트 통과 · CSP 스택 계약 일치)');
