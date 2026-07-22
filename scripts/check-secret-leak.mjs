// check-secret-leak.mjs — 자격증명 형태 스캔 (docs/SECURITY.md)
// 키워드가 아니라 형태로 탐지. 스캔 범위: git 추적 파일 전체(docs/ 제외) + 빌드 산출물(dist).
// docs/ 제외 사유: 계약 문서는 차단 대상 "형태" 자체를 서술해야 한다(예시 URL 등) —
// 실행물이 아니므로 유출 표면이 아니며, 실행물·산출물은 전부 스캔한다.
//
// [M-0004] 파일당 첫 매치만 검사하던 구현은 "anon JWT가 먼저 나오는 번들"에서
// 뒤따르는 service_role JWT를 통과시켰다(재현 확인). 반드시 matchAll로 모든
// 후보를 각각 판정하고, 실행 시마다 알려진-실패 주입 셀프테스트를 먼저 돌려
// 게이트가 비공허함을 증명한 뒤에만 실제 스캔한다(CLAUDE.md 작업규율 §4).
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const SKIP_PREFIX = ['docs/'];
const BINARY_EXT = /\.(png|jpg|jpeg|webp|gif|ico|woff2?|ttf|otf|zip|gz|mp4|heic)$/i;

// 주의: 전역(g) 플래그 필수 — matchAll은 g 없는 정규식에서 예외를 던진다.
// 셀프테스트 픽스처는 반드시 문자열 연결로 조립한다(이 파일 자신도 스캔 대상 —
// 리터럴로 쓰면 스캐너가 자기 자신을 차단한다).
const PATTERNS = [
  { name: 'postgres 연결 URL', re: /postgres(?:ql)?:\/\/[^\s"'`]+/g },
  { name: 'Supabase secret 키', re: /\bsb_secret_[A-Za-z0-9]/g },
  { name: 'Supabase access token', re: /\bsbp_[A-Za-z0-9]{16,}/g },
  { name: 'Google API 키', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { name: 'PEM 개인키', re: /-{5}BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-{5}/g },
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
    { name: 'postgres URL', text: 'db = "postgres' + 'ql://user:pw@host:5432/db"', expectHit: true },
    { name: 'sb_secret_ 접두어', text: 'const k = "sb_' + 'secret_abc123"', expectHit: true },
    { name: 'sbp_ access token', text: 'token = "sbp' + '_0123456789abcdef0123"', expectHit: true },
    { name: 'Google API 키', text: 'maps = "AIz' + 'a' + 'A'.repeat(35) + '"', expectHit: true },
    { name: 'PEM 개인키', text: '-'.repeat(5) + 'BEGIN PRIVATE KEY' + '-'.repeat(5), expectHit: true },
    { name: 'service_role 평문', text: '{"role"' + ': "service' + '_role"}', expectHit: true },
    { name: '평범한 코드(허용)', text: 'const role = "user"; fetch("https://x.supabase.co")', expectHit: false },
    { name: 'publishable 키(허용)', text: 'key = "sb_publishable_abc123"', expectHit: false },
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

// ── 스캔 대상 수집: git 추적 파일 전체(docs/ 제외) + dist ──
function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

function distFiles(dir = 'dist') {
  if (!existsSync(dir)) return [];
  const acc = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) acc.push(...distFiles(p));
    else acc.push(p);
  }
  return acc;
}

let hits = 0;
function scanFile(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return; }
  for (const f of scanText(text)) {
    console.error(`  ✗ [${f.name}] ${path}`);
    hits++;
  }
}

selfTest();

const targets = [...trackedFiles(), ...distFiles()]
  .filter((p) => !SKIP_PREFIX.some((s) => p.startsWith(s)))
  .filter((p) => !BINARY_EXT.test(p));

// .env 계열이 추적되면 내용과 무관하게 차단(.env.example만 허용, .gitignore와 이중 방어)
for (const p of targets) {
  if (/(^|\/)\.env(\..+)?$/.test(p) && !p.endsWith('.env.example')) {
    console.error(`  ✗ [.env 추적 금지] ${p}`);
    hits++;
  }
}

for (const p of targets) scanFile(p);

if (hits > 0) {
  console.error(`check-secret-leak: ${hits}건의 시크릿 형태 발견 — 배포 차단.`);
  process.exit(1);
}
console.log(`check-secret-leak: OK (셀프테스트 통과 · ${targets.length}개 파일 시크릿 형태 없음)`);
