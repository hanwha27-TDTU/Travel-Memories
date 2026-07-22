// check-secret-leak.mjs — 자격증명 형태 스캔 (docs/SECURITY.md)
// 키워드가 아니라 형태로 탐지: service_role JWT, postgres:// URL, secret 키 접두어.
// 소스 트리와 (있으면) 빌드 산출물(dist)을 스캔. 발견 시 비영 종료.
//
// [M-0004] 파일당 첫 매치만 검사하던 구현은 "anon JWT가 먼저 나오는 번들"에서
// 뒤따르는 service_role JWT를 통과시켰다(재현 확인). 반드시 matchAll로 모든
// 후보를 각각 판정하고, 실행 시마다 알려진-실패 주입 셀프테스트를 먼저 돌려
// 게이트가 비공허함을 증명한 뒤에만 실제 스캔한다(CLAUDE.md 작업규율 §4).
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['src', 'index.html', 'public', 'dist'].filter(existsSync);
const SKIP = new Set(['node_modules', '.git', 'docs']);
const EXT = /\.(ts|tsx|js|mjs|cjs|json|html|css|webmanifest|map)$/;

// 주의: 전역(g) 플래그 필수 — matchAll은 g 없는 정규식에서 예외를 던진다.
const PATTERNS = [
  { name: 'postgres 연결 URL', re: /postgres(?:ql)?:\/\/[^\s"']+/g },
  { name: 'Supabase secret 키', re: /\bsb_secret_[A-Za-z0-9]/g },
  { name: 'service_role JWT(평문)', re: /"role"\s*:\s*"service_role"/g },
  // base64url JWT payload에 service_role이 들어간 경우까지 디코드 검사
  { name: 'service_role JWT(base64)', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, jwt: true },
];

/** JWT 후보 문자열의 payload role이 service_role인지 판정(anon/publishable 허용). */
function isServiceRoleJwt(candidate) {
  try {
    const payload = JSON.parse(Buffer.from(candidate.split('.')[1], 'base64url').toString('utf8'));
    return payload.role === 'service_role';
  } catch {
    return false; // 디코드 불가 = JWT 아님(다른 base64 조각)
  }
}

/** 텍스트에서 시크릿 형태를 모두 찾아 [{name, sample}]로 반환. 모든 매치를 개별 판정. */
function scanText(text) {
  const findings = [];
  for (const p of PATTERNS) {
    for (const m of text.matchAll(p.re)) {
      if (p.jwt && !isServiceRoleJwt(m[0])) continue;
      findings.push({ name: p.name, sample: m[0].slice(0, 24) });
    }
  }
  return findings;
}

// ── 셀프테스트: 알려진 실패를 주입해 RED로 잡히는지 확인한 뒤에만 게이트를 신뢰 ──
function fakeJwt(role) {
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ role, iss: 'selftest' })}.sigsigsigsig`;
}

function selfTest() {
  const anon = fakeJwt('anon');
  const svc = fakeJwt('service_role');
  const cases = [
    // [M-0004 회귀] anon이 먼저 나와도 뒤의 service_role을 잡아야 한다
    { name: 'anon 뒤 service_role(번들 시나리오)', text: `const a="${anon}";\nconst b="${svc}";`, expectHit: true },
    { name: 'service_role 단독', text: `key: "${svc}"`, expectHit: true },
    { name: 'anon 단독(허용)', text: `key: "${anon}"`, expectHit: false },
    { name: 'postgres URL', text: 'db = "postgresql://user:pw@host:5432/db"', expectHit: true },
    { name: 'sb_secret_ 접두어', text: 'const k = "sb_secret_abc123"', expectHit: true },
    { name: 'service_role 평문', text: '{"role": "service_role"}', expectHit: true },
    { name: '평범한 코드(허용)', text: 'const role = "user"; fetch("https://x.supabase.co")', expectHit: false },
  ];
  const broken = [];
  for (const c of cases) {
    const hit = scanText(c.text).length > 0;
    if (hit !== c.expectHit) broken.push(c.name);
  }
  if (broken.length) {
    console.error(`check-secret-leak: 셀프테스트 실패 — 게이트가 공허함: ${broken.join(', ')}`);
    process.exit(2);
  }
}

// ── 실제 스캔 ──
let hits = 0;
function scanFile(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return; }
  for (const f of scanText(text)) {
    console.error(`  ✗ [${f.name}] ${path}`);
    hits++;
  }
}
function walk(path) {
  const st = statSync(path);
  if (st.isDirectory()) {
    if (SKIP.has(path.split('/').pop())) return;
    for (const e of readdirSync(path)) walk(join(path, e));
  } else if (EXT.test(path)) {
    scanFile(path);
  }
}

selfTest();
for (const r of ROOTS) walk(r);
if (hits > 0) {
  console.error(`check-secret-leak: ${hits}건의 시크릿 형태 발견 — 배포 차단.`);
  process.exit(1);
}
console.log('check-secret-leak: OK (셀프테스트 통과 · 시크릿 형태 없음)');
