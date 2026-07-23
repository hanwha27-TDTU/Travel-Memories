// tests/unit/registry.test.ts — DOMAIN_REGISTRY 불변식 (docs/DATA_MODEL.md 대칭성)
import { describe, it, expect } from 'vitest';
import { DOMAIN_REGISTRY, USER_DOMAINS } from '../../src/domain/registry';

describe('DOMAIN_REGISTRY 불변식', () => {
  it('key·table은 비어 있지 않고 중복이 없다', () => {
    const keys = DOMAIN_REGISTRY.map((d) => d.key);
    const tables = DOMAIN_REGISTRY.map((d) => d.table);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(tables).size).toBe(tables.length);
    for (const d of DOMAIN_REGISTRY) {
      expect(d.key.length).toBeGreaterThan(0);
      expect(d.table).toMatch(/^[a-z_]+$/);
    }
  });
  it('제외(⛔)는 침묵 공백이 아니라 명시적 사유를 갖는다', () => {
    for (const d of DOMAIN_REGISTRY) {
      if ('excludeReason' in d && d.excludeReason !== undefined) {
        expect(d.excludeReason.length).toBeGreaterThan(0);
      }
    }
  });
  it('완전 배선 대상은 사용자 도메인 9종이다', () => {
    expect(USER_DOMAINS).toEqual([
      'trip', 'tripDay', 'moment', 'place', 'media',
      'expense', 'companion', 'reflection', 'tag',
    ]);
  });
});
