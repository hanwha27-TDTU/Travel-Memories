// bytesReconcile.test.ts — **바이트 대조 주기**의 판정 규칙.
//
// 왜 이 파일이 있나 (2026-07-28 사용자 지시: *"이거 신경 안 쓰도록 설계를 수정해야 할 거 같은데…"*)
//
// 헌법의 데이터 안전 불변식은 *"정확한 read-back으로 확인"*을 요구하는데, 그 규율이 **행에만**
// 걸려 있고 **바이트(R2 파일)에는 없었다.** 그래서 어긋나면 사람이 진단을 열어 버튼을 눌러야만
// 고쳐졌고, 심지어 **기기마다 정반대 판정**이 나왔다(M-0048).
//
// 이제 동기화가 스스로 대조한다. 그 「언제 대조하나」가 여기서 재는 것이다 — 비용(R2 목록
// 조회)과 정확성 사이의 계약이라 **경계값을 못박아 둔다.**

import { describe, it, expect } from 'vitest';
import { reconcileDue, BYTES_RECONCILE_EVERY_MS } from '../../src/services/sync';

describe('바이트 대조 주기 — 언제 서버 목록을 물어보나', () => {
  const NOW = Date.parse('2026-07-28T12:00:00.000Z');
  const ago = (ms: number): string => new Date(NOW - ms).toISOString();

  it('한 번도 안 쟀으면 잰다', () => {
    expect(reconcileDue(null, NOW, false)).toBe(true);
  });

  it('방금 쟀으면 자동 동기화에서는 건너뛴다(요금이 조용히 새지 않게)', () => {
    expect(reconcileDue(ago(60_000), NOW, false)).toBe(false);
  });

  it('🔴 사용자가 직접 부른 동기화는 **주기와 무관하게** 항상 잰다', () => {
    // 사람이 의심해서 누른 버튼이 곧 확실한 경로여야 한다(§12). "방금 쟀으니 안 잰다"고
    // 하면 사용자는 같은 화면을 다시 보고 또 누르게 된다 — 그게 없애려던 바로 그 노동이다.
    expect(reconcileDue(ago(1_000), NOW, true)).toBe(true);
  });

  it('주기가 지나면 자동으로도 잰다', () => {
    expect(reconcileDue(ago(BYTES_RECONCILE_EVERY_MS + 1), NOW, false)).toBe(true);
  });

  it('경계값 — 정확히 주기만큼 지났으면 잰다(같으면 재는 쪽)', () => {
    expect(reconcileDue(ago(BYTES_RECONCILE_EVERY_MS), NOW, false)).toBe(true);
    expect(reconcileDue(ago(BYTES_RECONCILE_EVERY_MS - 1), NOW, false)).toBe(false);
  });

  it('🔴 표식이 깨졌으면 **재는 쪽**으로 기운다 — 안 재고 넘어가지 않는다', () => {
    // 「모르는 것」을 「괜찮다」로 반올림하지 않는다(비타협 원칙 #4 · §8).
    expect(reconcileDue('망가진값', NOW, false)).toBe(true);
    expect(reconcileDue('', NOW, false)).toBe(true);
  });

  it('미래 시각이 적혀 있어도 죽지 않는다(기기 시계가 틀어진 경우)', () => {
    // 시계가 앞서 있으면 한동안 안 재게 된다 — 자료를 잃는 방향은 아니고, 사용자가 버튼을
    // 누르면(`deep`) 즉시 재므로 막다른 길이 없다. 그 사실을 여기 못박아 둔다.
    expect(reconcileDue(new Date(NOW + 86_400_000).toISOString(), NOW, false)).toBe(false);
    expect(reconcileDue(new Date(NOW + 86_400_000).toISOString(), NOW, true)).toBe(true);
  });
});
