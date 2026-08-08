// 진단 보고서는 사용자가 직접 전달하는 경계다. 개별 수집기가 안전하다고 가정하지 않고
// 마지막 한 번 더 전체 문자열을 정리한다. 새 수집기가 추가돼도 이 경계를 우회하지 않는다.

const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const SECRET_PAIR = /\b(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const URL = /https?:\/\/[^\s)\]}>'"]+/gi;

/**
 * 진단 보고서의 최종 반출 경계. 원문을 변형하지 않는 것이 목적이 아니라, 지원에 필요한
 * 판정·개수는 남기고 계정·서버·인증을 식별할 수 있는 값은 내보내지 않는 것이 목적이다.
 */
export function redactDiagnosticText(value: string): string {
  return value
    .replace(BEARER, 'Bearer [비밀값 숨김]')
    .replace(JWT, '[비밀값 숨김]')
    .replace(SECRET_PAIR, (_match, key: string) => `${key}=[비밀값 숨김]`)
    .replace(EMAIL, '[이메일 숨김]')
    .replace(URL, '[주소 숨김]');
}
