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
});
