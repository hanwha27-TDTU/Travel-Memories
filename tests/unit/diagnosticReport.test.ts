import { describe, expect, it } from 'vitest';
import { redactDiagnosticText } from '../../src/domain/diagnosticReport';

describe('diagnostic report redaction boundary', () => {
  it('removes credentials, identity, and full URLs while preserving verdict context', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.signature12345';
    const source = [
      '총괄 판정: problem',
      `Authorization: Bearer ${jwt}`,
      'api_key=super-secret-value',
      'owner@example.com',
      'https://project-ref.supabase.co/rest/v1/trips?id=eq.private-id',
      '대기 3건',
    ].join('\n');

    const redacted = redactDiagnosticText(source);

    expect(redacted).toContain('총괄 판정: problem');
    expect(redacted).toContain('대기 3건');
    expect(redacted).not.toContain(jwt);
    expect(redacted).not.toContain('super-secret-value');
    expect(redacted).not.toContain('owner@example.com');
    expect(redacted).not.toContain('project-ref.supabase.co');
    expect(redacted).toContain('[비밀값 숨김]');
    expect(redacted).toContain('[이메일 숨김]');
    expect(redacted).toContain('[주소 숨김]');
  });

  // 사용자가 진단 화면의 JSON을 그대로 붙여 넣는 것이 가장 흔한 경로다. 열쇠말과 콜론 사이에
  // 닫는 따옴표가 끼어 있어도 값은 같은 비밀값이다(2026-08-12 실측 — 이 형태만 새 나갔다).
  it('hides secrets written in quoted JSON form', () => {
    const cases = [
      '{"api_key": "sk_live_SECRET123"}',
      '{"access_token":"opaque-token-value"}',
      "{'refresh_token' : 'rt_SECRET_VALUE'}",
      '{"password": "hunter2"}',
    ];
    const leaked = [
      'sk_live_SECRET123',
      'opaque-token-value',
      'rt_SECRET_VALUE',
      'hunter2',
    ];

    cases.forEach((source, i) => {
      const redacted = redactDiagnosticText(source);
      expect(redacted).not.toContain(leaked[i]);
      expect(redacted).toContain('[비밀값 숨김]');
    });
  });

  it('does not swallow the next field while hiding one', () => {
    const redacted = redactDiagnosticText('{"api_key": "s3cr3t", "대기": 3}');

    expect(redacted).not.toContain('s3cr3t');
    expect(redacted).toContain('대기');
    expect(redacted).toContain('3');
  });
});
