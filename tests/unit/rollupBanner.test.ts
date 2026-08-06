// 총괄 배너 문장 — 사용자가 진단을 열자마자 읽는 **첫 한 줄**이다.
//
// 🔴 이 파일이 존재하는 이유(§4): 라이브 검사만으로는 이 갈래를 **가를 수 없다.**
// 「구조적 확인 불가가 총괄을 끌어내리지 않는다」를 실제 앱에서 재려면 *다른 이상이 하나도
// 없는* 상태가 필요한데, 픽스처엔 늘 무언가 하나가 켜져 있다. 그 상태에서 라이브는
// **가려져서 통과**한다 — 초록이 「없다」가 아니라 「못 갈랐다」인 자리다.

import { describe, it, expect } from 'vitest';
import { rollupBanner, bannerLevelOf } from '../../src/ui/panels/diagnostics';

const base = { badLabels: [], todoLabels: [], structuralCount: 0 };

describe('총괄 배너 — 구조적 확인 불가는 비정상으로 분류하지 않는다(사용자 지적 2026-08-06)', () => {
  it('🔴 다른 이상이 하나도 없고 구조적 확인 불가만 있으면 「이상 없음」이다', () => {
    const line = rollupBanner({ ...base, bannerLevel: 'ok', structuralCount: 1 });
    expect(line).toContain('이상 없음');
    expect(line).not.toContain('확인하지 못한 항목이 있어요');
  });

  // 🔴 그러나 숨기지 않는다 — 앱이 자기 시야의 경계를 말한다(§8 · §7-C).
  it('대신 경계를 개수로 말한다', () => {
    expect(rollupBanner({ ...base, bannerLevel: 'ok', structuralCount: 2 })).toContain('잴 수 없는 항목 2개');
  });

  it('구조적 확인 불가가 없으면 그 꼬리를 붙이지 않는다(없는 말을 하지 않는다)', () => {
    expect(rollupBanner({ ...base, bannerLevel: 'ok' })).toBe('이상 없음 · 방금 확인했어요');
  });

  // 🔴 일시적 확인 불가는 그대로 반영한다 — 사용자가 눌러서 풀 수 있는 상태다(§8).
  it('일시적 확인 불가는 여전히 「확인하지 못한 항목이 있어요」다', () => {
    expect(rollupBanner({ ...base, bannerLevel: 'unknown' })).toContain('확인하지 못한 항목이 있어요');
  });

  it('문제·할 일은 개수와 이름을 함께 말한다(§7-C — 손으로 쓰지 않는다)', () => {
    expect(rollupBanner({ ...base, bannerLevel: 'problem', badLabels: ['a', 'b'] })).toBe(
      '지금 확인할 것 2가지 — a · b',
    );
    expect(rollupBanner({ ...base, bannerLevel: 'todo', todoLabels: ['c'] })).toBe('해두면 좋은 일 1가지 — c');
  });

  it('구조적 꼬리는 어느 등급에도 붙는다 — 경계는 등급과 무관한 사실이다', () => {
    for (const bannerLevel of ['ok', 'todo', 'problem', 'unknown'] as const) {
      expect(rollupBanner({ ...base, bannerLevel, badLabels: ['x'], todoLabels: ['y'], structuralCount: 1 })).toContain(
        '잴 수 없는 항목 1개',
      );
    }
  });

  it('마크다운을 쓰지 않는다(textContent로 그려진다 · 진단 헌장 §5-7)', () => {
    for (const bannerLevel of ['ok', 'todo', 'problem', 'unknown'] as const) {
      expect(rollupBanner({ ...base, bannerLevel, structuralCount: 1 })).not.toContain('**');
    }
  });
});

describe('bannerLevelOf — 무엇을 총괄에 세는가', () => {
  const p = (level: 'ok' | 'todo' | 'problem' | 'unknown', unknownKind: 'structural' | 'transient' = 'transient') =>
    ({ level, unknownKind }) as const;

  // 🔴 이 검사가 이 파일의 존재 이유다 — 라이브 픽스처엔 늘 다른 이상이 하나 켜져 있어
  // 이 갈래가 가려진다(실제로 주입해 보니 라이브가 통과했다 · §4).
  it('구조적 확인 불가만 있으면 총괄은 정상이다', () => {
    expect(bannerLevelOf([p('ok'), p('unknown', 'structural')])).toBe('ok');
  });

  it('일시적 확인 불가는 총괄에 그대로 반영한다 — 눌러서 풀 수 있는 상태다', () => {
    expect(bannerLevelOf([p('ok'), p('unknown', 'transient')])).toBe('unknown');
  });

  it('구조적이 섞여 있어도 진짜 문제는 가려지지 않는다', () => {
    expect(bannerLevelOf([p('problem'), p('unknown', 'structural')])).toBe('problem');
    expect(bannerLevelOf([p('todo'), p('unknown', 'structural')])).toBe('todo');
  });

  it('전부 구조적이라 셀 것이 없으면 정상이다(빈 배열을 확인 불가로 읽지 않는다)', () => {
    expect(bannerLevelOf([p('unknown', 'structural'), p('unknown', 'structural')])).toBe('ok');
  });
});
