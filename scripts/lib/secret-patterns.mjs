// lib/secret-patterns.mjs — 자격증명 "형태" 탐지의 단일 진실원(SSOT).
//
// 왜 뽑았나: 같은 판정을 **두 곳**이 필요로 한다 —
//   ① `check-secret-leak.mjs`(게이트) — 추적 파일·빌드 산출물을 커밋/배포 전에 훑는다
//   ② `hook-secret-guard.mjs`(PreToolUse hook) — **파일에 쓰이기 전에** 막는다
// 손으로 두 벌 쓰면 갈라진다(헌법 §7 · M-0060이 정확히 그 형태였다). 여기 한 곳만 고친다.
//
// 🔴 키워드가 아니라 **형태**로 탐지한다. `service_role`이라는 *낱말*은 계약 문서가
// 반드시 서술해야 하는 것이라(docs/SECURITY.md) 낱말을 막으면 문서를 못 고친다 —
// 오탐도 결함이다(gates-mechanization-dev §2-B ③).
//
// 주의: 전역(g) 플래그 필수 — matchAll은 g 없는 정규식에서 예외를 던진다.
// 셀프테스트 픽스처는 반드시 **문자열 연결로 조립**한다(이 파일도 스캔 대상 —
// 리터럴로 쓰면 스캐너가 자기 자신을 차단한다).

export const PATTERNS = [
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
export function isServiceRoleJwt(candidate) {
  try {
    const payload = JSON.parse(Buffer.from(candidate.split('.')[1], 'base64url').toString('utf8'));
    return payload.role === 'service_role';
  } catch {
    return false; // 디코드 불가 = JWT 아님(다른 base64 조각)
  }
}

/** 텍스트에서 시크릿 형태를 모두 찾아 [{name, sample}]로 반환. 모든 매치를 개별 판정. */
export function scanText(text) {
  const findings = [];
  for (const p of PATTERNS) {
    for (const m of text.matchAll(p.re)) {
      if (p.jwt && !isServiceRoleJwt(m[0])) continue;
      findings.push({ name: p.name, sample: m[0].slice(0, 24) });
    }
  }
  return findings;
}

/** 셀프테스트용 가짜 JWT 조립(리터럴 금지 — 위 주석 참조). */
export function fakeJwt(role) {
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ role, iss: 'selftest' })}.sigsigsigsig`;
}
