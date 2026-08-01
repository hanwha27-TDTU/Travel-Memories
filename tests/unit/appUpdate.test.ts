// tests/unit/appUpdate.test.ts — 자동 갱신의 순수 판단(services/appUpdate.ts).
//
// 🔴 잠그는 것 둘: ① 버전 비교(문자열 비교로 되돌아가면 '1.9' > '1.47'이 돼 갱신이 멈춘다)
// ② 안전 규칙(입력 중·창 열림에는 새로고침하지 않는다 — 저장 안 된 글은 아직 기억이 아니라서
// 더 쉽게 사라진다. 비타협 원칙 #1의 이웃).

import { describe, it, expect } from 'vitest';
import { isNewer, shouldCheck, safeToReload, CHECK_MIN_MS, CURRENT_VERSION } from '../../src/services/appUpdate';
import { CHANGELOG } from '../../src/app/changelog';

describe('isNewer — 점 구분 숫자 비교', () => {
  it('한 단계 위를 새것으로 본다', () => {
    expect(isNewer('1.47', '1.46')).toBe(true);
    expect(isNewer('1.46', '1.47')).toBe(false);
    expect(isNewer('1.47', '1.47')).toBe(false);
  });
  it('🔴 문자열 비교 함정 — 1.9와 1.47은 숫자로 가른다', () => {
    expect(isNewer('1.47', '1.9')).toBe(true); // 47 > 9 (이 저장소의 +0.01 규약)
    expect(isNewer('2.0', '1.99')).toBe(true);
  });
  it('자릿수가 달라도 안전하다', () => {
    expect(isNewer('1.47.1', '1.47')).toBe(true);
    expect(isNewer('1.47', '1.47.0')).toBe(false);
  });
  it('실행 중 버전은 changelog 맨 앞과 같다(SSOT)', () => {
    expect(CURRENT_VERSION).toBe(CHANGELOG[0]?.version);
  });
});

describe('shouldCheck — 스로틀', () => {
  it('첫 확인은 항상 허용', () => {
    expect(shouldCheck(null, 0)).toBe(true);
  });
  it('간격 안 재확인은 막고, 지나면 허용', () => {
    expect(shouldCheck(1_000, 1_000 + CHECK_MIN_MS - 1)).toBe(false);
    expect(shouldCheck(1_000, 1_000 + CHECK_MIN_MS)).toBe(true);
  });
});

describe('safeToReload — 새로고침 안전 규칙', () => {
  it('창도 입력도 없을 때만 안전하다', () => {
    expect(safeToReload(false, false)).toBe(true);
  });
  it('🔴 열린 창(overlay)이 있으면 새로고침하지 않는다', () => {
    expect(safeToReload(true, false)).toBe(false);
  });
  it('🔴 이번 표시 기간에 입력이 있었으면 새로고침하지 않는다(글을 날릴 수 있다)', () => {
    expect(safeToReload(false, true)).toBe(false);
  });
});
