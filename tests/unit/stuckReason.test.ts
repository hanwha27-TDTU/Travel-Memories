// tests/unit/stuckReason.test.ts — 「막힌 작업」이 **왜 막혔는지** 말하는 문장.
//
// 🔴 M-0107(2026-08-05 · 사용자 실기기): 화면이 「막힌 작업 13건」이라고만 말했다. 그리고
// *"[실패 재시도]를 눌러 주세요"*라고 시켰는데, 그 13건은 **눌러도 절대 안 풀리는** 부류였다
// (부모가 영구삭제돼 서버에 관계가 없어진 사진들 — FK 위반이라 매번 4xx로 다시 굳는다).
// 원인을 알아내는 데 **실서버를 직접 조회**해야 했다 — 앱이 본 응답을 버렸기 때문이다(§12).
//
// 이 검사는 §10 ③(전달 결함)의 자리다: 자료구조는 옳았고 틀린 것은 **사용자에게 가는 말**뿐이다.
// 그래서 그 말을 순수 함수로 뽑아 여기서 직접 돌린다.

import { describe, it, expect } from 'vitest';
import { stuckReasonOf } from '../../src/services/diagnostics';
import { stuckMeaning } from '../../src/ui/panels/diagnostics';

describe('stuckReasonOf — 앱이 아는 만큼만 말한다', () => {
  it('서버가 준 메시지가 있으면 그대로 쓴다', () => {
    expect(stuckReasonOf('insert or update on table "media" violates foreign key constraint', 409))
      .toContain('foreign key');
  });

  it('메시지가 없으면 상태 코드로 갈래를 가른다 — 사용자가 할 일이 다르기 때문이다', () => {
    expect(stuckReasonOf(undefined, 401)).toContain('권한');
    expect(stuckReasonOf(undefined, 403)).toContain('권한');
    expect(stuckReasonOf(undefined, 409)).toContain('관계 충돌');
    expect(stuckReasonOf(undefined, 503)).toContain('서버 오류');
    expect(stuckReasonOf(undefined, 400)).toContain('거절');
  });

  it('🔴 아무것도 없으면 **모른다고 적는다** — 그럴듯한 문장으로 채우지 않는다(원칙 #4)', () => {
    const s = stuckReasonOf(undefined, undefined);
    expect(s).toContain('기록되지 않았');
    // 「알 수 없는 오류」처럼 원인을 아는 척하는 말이 들어가면 안 된다.
    expect(s).not.toContain('오류가 발생');
  });
});

describe('stuckMeaning — 화면 문장', () => {
  it('사유를 모르면 옛 문장 그대로다(없는 말을 지어내지 않는다)', () => {
    expect(stuckMeaning([])).toBe(
      '보내다 실패해 멈춘 작업이에요. 동기화를 눌러도 저절로 풀리지 않습니다 — 아래 [실패 재시도]를 눌러 주세요.',
    );
  });

  it('사유가 있으면 많은 순으로 두 가지까지 말한다', () => {
    const out = stuckMeaning([
      { reason: '서버가 관계 충돌로 거절했어요(409)', count: 13 },
      { reason: '서버가 권한을 거절했어요(403)', count: 2 },
    ]);
    expect(out).toContain('서버가 말한 이유');
    expect(out).toContain('관계 충돌');
    expect(out).toContain('13건');
    expect(out).toContain('403');
    expect(out).not.toContain('외 ');
  });

  it('셋 이상이면 나머지는 개수로만 — 화면을 사유 목록으로 덮지 않는다', () => {
    const out = stuckMeaning([
      { reason: 'A', count: 3 },
      { reason: 'B', count: 2 },
      { reason: 'C', count: 1 },
      { reason: 'D', count: 1 },
    ]);
    expect(out).toContain('외 2가지');
    expect(out).not.toContain('C');
  });
});
