// tests/unit/syncStatusVerdict.test.ts — **자동 동기화 상태를 뭐라고 말하는가.**
//
// ── 실제로 밟은 것(2026-07-27 사용자 진단 요약) ──────────────────────
//   unknown  자동 동기화: 지금 마지막 성공 19:45:03 / 정상 최근에 성공
// **72초 전에 성공했는데 「판정 불가」였고**, 그 하나가 총괄 판정 전체를 `unknown`으로
// 끌어내렸다(나머지 지표는 전부 ok였다). 원인은 판정이 `phase === 'ok'`일 때만 ok인데
// 그 순간 동기화가 **한 번 더 돌고 있었던**(`running`) 것이고, 화면 문구는 그 사실을
// 말하지 않아 사용자가 이유를 알 방법이 없었다 — 앱이 아는 것을 안 말한 것이다(§12).
//
// 그래서 이 검사는 **level만이 아니라 문장도 잰다**. M-0022에서 유닛 15건이 전부 통과했는데
// 화면 문장이 틀렸다 — 숫자는 다 맞았고 화면에 무엇이 나가는지 검사한 것이 없었다(§10 ③).

import { describe, it, expect } from 'vitest';
import { autoSyncVerdict, type SyncStatusLike } from '../../src/domain/syncStatusVerdict';

/** 로컬 19:45:03 — 표시가 로컬 시각이라 검사도 로컬로 만든다(check-timezone). */
const okAt = new Date(2026, 6, 26, 19, 45, 3).toISOString();
const st = (p: SyncStatusLike['phase'], lastOkAt: string | null = null, lastError: string | null = null): SyncStatusLike => ({
  phase: p,
  lastOkAt,
  lastError,
});

describe('① 진행 중 — **진행 중이라고 말한다**(이 파일이 생긴 이유)', () => {
  it('성공 이력이 있으면 ok — 마지막 결과가 성공이므로 "조용한 실패"가 아니다', () => {
    const v = autoSyncVerdict(st('running', okAt));
    expect(v.level).toBe('ok');
  });

  it('그리고 **지금 동기화 중임을 문장에 적는다** — 예전엔 「마지막 성공 …」만 보였다', () => {
    const v = autoSyncVerdict(st('running', okAt));
    expect(v.actual).toContain('지금 동기화 중');
    expect(v.actual).toContain('19:45:03'); // 근거가 되는 값도 함께 말한다
  });

  it('성공 이력이 없으면 **판정 불가** — 진짜로 결과를 모른다(정상으로 반올림 금지)', () => {
    const v = autoSyncVerdict(st('running', null));
    expect(v.level).toBe('unknown');
    expect(v.actual).toContain('첫 회차');
    expect(v.meaning).toContain('다시 확인'); // 판정 불가면 **해소 경로**를 준다
  });
});

describe('② 성공 — 값과 판정이 맞는다', () => {
  it('ok + 성공 시각이면 ok, 시각을 그대로 보여준다', () => {
    const v = autoSyncVerdict(st('ok', okAt));
    expect(v.level).toBe('ok');
    expect(v.actual).toBe('마지막 성공 19:45:03');
    expect(v.meaning).toBeUndefined(); // 정상엔 설명을 붙이지 않는다(침묵이 정상 — §8)
  });

  it('시각이 깨져 있으면 시각 없이 사실만 말한다(지어내지 않는다)', () => {
    const v = autoSyncVerdict(st('ok', 'not-a-date'));
    expect(v.level).toBe('ok');
    expect(v.actual).toBe('마지막 시도는 성공');
  });
});

describe('③ 실패 — 사유를 **그대로** 보여준다(조용히 삼키지 않는다)', () => {
  it('problem으로 판정하고 사유를 문장에 넣는다', () => {
    const v = autoSyncVerdict(st('failed', okAt, 'Failed to fetch'));
    expect(v.level).toBe('problem');
    expect(v.actual).toContain('Failed to fetch');
  });

  it('사유를 모르면 모른다고 적는다', () => {
    expect(autoSyncVerdict(st('failed', null, null)).actual).toContain('사유 불명');
  });

  it('성공 이력이 있어도 실패는 실패다(과거로 현재를 덮지 않는다)', () => {
    expect(autoSyncVerdict(st('failed', okAt, 'x')).level).toBe('problem');
  });
});

describe('④ 판정할 근거가 없는 상태들 — unknown이 맞다', () => {
  const cases: { phase: SyncStatusLike['phase']; contains: string }[] = [
    { phase: 'offline', contains: '오프라인' },
    { phase: 'signed-out', contains: '로그인' },
    { phase: 'idle', contains: '아직 실행 안 됨' },
  ];

  for (const c of cases) {
    it(`${c.phase}: unknown이고 왜 그런지 말한다`, () => {
      const v = autoSyncVerdict(st(c.phase, null));
      expect(v.level).toBe('unknown');
      expect(v.actual).toContain(c.contains);
    });
  }

  it('오프라인은 설명이 필요 없다(문장 자체가 이미 이유다)', () => {
    expect(autoSyncVerdict(st('offline', null)).meaning).toBeUndefined();
  });
});

describe('⑤ 총괄 판정을 끌어내리지 않는다 — 이게 사용자가 본 증상이었다', () => {
  it('나머지가 전부 ok일 때 running이 unknown을 만들지 않는다', () => {
    // 사용자 화면의 그 상태: 성공 19:45:03 · 보고서 19:46:15 · 그 사이 자동 동기화가 한 번 더.
    const levels = ['ok', 'ok', 'ok', autoSyncVerdict(st('running', okAt)).level];
    expect(levels.every((l) => l === 'ok')).toBe(true);
  });
});
