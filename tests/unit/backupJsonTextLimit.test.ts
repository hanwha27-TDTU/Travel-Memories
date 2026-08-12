// backupJsonTextLimit.test.ts — 큰 JSON 백업을 「형식 아님」이라 부르지 않는다 (T-021 · M-0147).
//
// 🔴 왜 이 유닛이 필요한가: 결함은 자료구조가 아니라 **사용자에게 가는 문장**에 있었다.
// V8 문자열 상한을 넘기면 디코드가 조용히 빈 문자열을 주고, 그 다음 줄의 JSON.parse가
// 터져 앱이 멀쩡한 백업을 「깨졌다」고 말한다. 그 말을 믿고 지우면 기억 유실이다.

import { describe, it, expect } from 'vitest';
import { decodeBackupJsonBytes, MAX_BACKUP_JSON_TEXT_BYTES } from '../../src/services/backup';

const enc = new TextEncoder();

describe('🔴 JSON 백업 디코드 경계', () => {
  it('상한은 V8 문자열 최대 길이와 같다 — 어림수가 아니라 실측 경계다', () => {
    expect(MAX_BACKUP_JSON_TEXT_BYTES).toBe(2 ** 29 - 24);
  });

  it('평범한 백업은 그대로 읽힌다', () => {
    const text = JSON.stringify({ backupVersion: 2, trips: [] });
    expect(decodeBackupJsonBytes(enc.encode(text))).toBe(text);
  });

  it('한국어가 들어가도 읽힌다 — 바이트가 글자보다 많아 상한이 더 안전해진다', () => {
    const text = JSON.stringify({ title: '부건이의 여행 기록' });
    const bytes = enc.encode(text);
    expect(bytes.byteLength).toBeGreaterThan(text.length);
    expect(decodeBackupJsonBytes(bytes)).toBe(text);
  });

  it('🔴 상한을 넘으면 「형식 아님」이 아니라 **크기 때문이라고** 말한다', () => {
    // 실제로 512MiB를 만들지 않는다 — 길이만 속여 판정 경로를 탄다(측정 대상은 문장이다).
    const huge = { byteLength: MAX_BACKUP_JSON_TEXT_BYTES + 1 } as Uint8Array;
    expect(() => decodeBackupJsonBytes(huge)).toThrow(/너무 커서/);
    expect(() => decodeBackupJsonBytes(huge)).not.toThrow(/형식/);
  });

  it('🔴 다음 행동을 알려준다 — ZIP 백업이 같은 자료를 복원한다', () => {
    const huge = { byteLength: MAX_BACKUP_JSON_TEXT_BYTES + 1 } as Uint8Array;
    expect(() => decodeBackupJsonBytes(huge)).toThrow(/ZIP/);
  });

  it('🔴 상한 안이어도 **글자가 0으로 돌아오면** 파일 탓을 하지 않는다(조용한 실패 잡기)', () => {
    // 512MiB를 실제로 만들지 않고, 브라우저가 보인 **그 거동**(바이트는 있는데 글자 0)만
    // 디코더에 심는다. 재는 대상은 크기가 아니라 「그때 무슨 문장이 나가는가」다.
    const real = globalThis.TextDecoder;
    class EmptyDecoder { decode(): string { return ''; } }
    globalThis.TextDecoder = EmptyDecoder as unknown as typeof TextDecoder;
    try {
      const bytes = enc.encode('{"backupVersion":2}');
      expect(bytes.byteLength).toBeGreaterThan(0);
      expect(() => decodeBackupJsonBytes(bytes)).toThrow(/읽는 데 실패/);
      expect(() => decodeBackupJsonBytes(bytes)).toThrow(/깨졌다는 뜻은 아니에요/);
    } finally {
      globalThis.TextDecoder = real;
    }
  });

  it('빈 파일은 빈 문자열을 그대로 돌려준다 — 0바이트는 조용한 실패가 아니다', () => {
    expect(decodeBackupJsonBytes(new Uint8Array(0))).toBe('');
  });
});
