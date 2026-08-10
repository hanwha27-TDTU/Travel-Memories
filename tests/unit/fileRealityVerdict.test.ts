// tests/unit/fileRealityVerdict.test.ts — 「🖼️ 파일 실물」 판정과 **문장**을 잠근다.
//
// 왜 문장까지 잠그나: 이 저장소의 최빈 결함군은 *자료구조는 옳고 화면 문장만 틀린* 부류다
// (§10 ③ · M-0022는 유닛 15건이 전부 통과한 채로 났다). 특히 이 도구는 **파괴적 오해**를
// 부를 수 있다 — 「비어 있다」를 읽은 사용자가 그 기록을 지우면, 다른 기기에 있던 사본까지
// 되살릴 수 없게 된다(M-0048). 그래서 문장이 *지우지 말라*고 말하는지까지 잰다.

import { describe, it, expect } from 'vitest';
import {
  fileRealityMetrics,
  fileRealityHeadline,
  fileRealityScopeNote,
  worstOf,
  type FileRealityInput,
  type KindTally,
} from '../../src/domain/fileRealityVerdict';

const K = (over: Partial<KindTally> = {}): KindTally => ({ rows: 10, empty: 0, serverMissing: 0, ...over });
const IN = (over: Partial<FileRealityInput> = {}): FileRealityInput => ({
  photo: K(),
  audio: K({ rows: 2 }),
  video: K({ rows: 0 }),
  sweep: { at: '2026-08-05T12:00:00.000Z', checked: 12, failed: [], totalAtRun: 12 },
  ...over,
});

const metric = (i: FileRealityInput, label: string) => fileRealityMetrics(i).find((m) => m.label === label)!;

describe('바이트가 비어 있는 기록 — 존재(T-010)', () => {
  it('전부 성하면 조용하다(정상은 침묵 · §8)', () => {
    const m = metric(IN(), '바이트가 비어 있는 사진 기록');
    expect(m.level).toBe('ok');
    expect(m.meaning).toBeUndefined(); // 정상엔 설명을 붙이지 않는다
    expect(m.expected).toBe('0개');
  });

  it('비어 있으면 problem이고 개수를 말한다', () => {
    const m = metric(IN({ photo: K({ empty: 3 }) }), '바이트가 비어 있는 사진 기록');
    expect(m.level).toBe('problem');
    expect(m.actual).toBe('3개');
  });

  it('🔴 **지우라고 하지 않는다** — 다른 기기에 사본이 있을 수 있다(M-0048)', () => {
    const m = metric(IN({ photo: K({ empty: 1 }) }), '바이트가 비어 있는 사진 기록');
    expect(m.meaning).toContain('지우지 마시고');
    expect(m.meaning).toContain('다른 기기');
  });

  it('사진·소리·영상을 **따로** 센다 — 합치면 이름이 사라진다(M-0048 곁가지)', () => {
    const ms = fileRealityMetrics(IN({ audio: K({ rows: 2, empty: 2 }) }));
    expect(metric(IN({ audio: K({ rows: 2, empty: 2 }) }), '바이트가 비어 있는 소리 기록').level).toBe('problem');
    expect(ms.find((m) => m.label === '바이트가 비어 있는 사진 기록')!.level).toBe('ok');
    expect(metric(IN({ video: K({ rows: 1, empty: 1 }) }), '바이트가 비어 있는 영상 기록').level).toBe('problem');
  });
});

describe('열리지 않는 파일 — 열림(T-011)', () => {
  it('🔴 한 번도 안 열어 봤으면 **ok가 아니다** — 안 해 본 것을 정상으로 반올림 금지', () => {
    const m = metric(IN({ sweep: null }), '열리지 않는 파일');
    expect(m.level).toBe('todo');
    expect(m.actual).toContain('아직');
  });

  it('🔴 그런데 `unknown`도 아니다 — 사용자가 한 번 누르면 해소된다(M-0035 과도한 unknown)', () => {
    expect(metric(IN({ sweep: null }), '열리지 않는 파일').level).not.toBe('unknown');
  });

  it('안 해 봤으면 **무엇을 누르면 되는지** 말한다(막다른 문장 금지)', () => {
    expect(metric(IN({ sweep: null }), '열리지 않는 파일').meaning).toContain('열어 보기');
  });

  it('열어 봤고 전부 열리면 ok — 몇 개를 봤는지 함께 말한다', () => {
    const m = metric(IN(), '열리지 않는 파일');
    expect(m.level).toBe('ok');
    expect(m.actual).toContain('12개');
  });

  it('안 열리는 것이 있으면 problem이고, 여기서도 지우라고 하지 않는다', () => {
    const m = metric(IN({ sweep: { at: 'x', checked: 12, failed: ['a1b2c3d4'], totalAtRun: 12 } }), '열리지 않는 파일');
    expect(m.level).toBe('problem');
    expect(m.actual).toBe('1개');
    expect(m.meaning).toContain('지우지 마세요');
  });

  it('🔴 잰 뒤 자료가 늘었으면 그 초록은 **옛 것**이다 — 낡은 초록은 초록이 아니다', () => {
    const m = metric(
      IN({ photo: K({ rows: 20 }), sweep: { at: 'x', checked: 12, failed: [], totalAtRun: 12 } }),
      '열리지 않는 파일',
    );
    expect(m.level).toBe('todo');
    expect(m.actual).toContain('늘었');
  });

  it('자료가 줄었을 때는 다시 재라고 하지 않는다(지운 것은 정상이다)', () => {
    const m = metric(
      IN({ photo: K({ rows: 4 }), audio: K({ rows: 1 }), sweep: { at: 'x', checked: 12, failed: [], totalAtRun: 12 } }),
      '열리지 않는 파일',
    );
    expect(m.level).toBe('ok');
  });
});

describe('판정 문장 — 한정을 생략하지 않는다(§7-C)', () => {
  it('🔴 문장이 **이 기기**라고 못박는다 — 「없다」로 계정 전체를 판정하지 않는다', () => {
    expect(fileRealityHeadline(IN())).toContain('이 기기');
  });

  it('🔴 조사가 맞는다 — 실기기에 「71개**이** 모두 성해요」가 나갔다(M-0110)', () => {
    // 🔴 **문장 전체를 잠근다.** 옛 검사는 `toContain('모두 성해요')`만 봐서 조사 오류를
    //    통째로 지나쳤다 — 조각만 재면 그 조각 밖은 안 재는 것이다(§4).
    expect(fileRealityHeadline(IN())).toBe('이 기기의 사진·소리·영상 12개가 모두 성해요');
  });

  it('개수가 바뀌어도 조사는 「가」다(단위가 「개」인 한)', () => {
    expect(fileRealityHeadline(IN({ photo: K({ rows: 69 }), sweep: { at: 'x', checked: 71, failed: [], totalAtRun: 71 } }))).toBe('이 기기의 사진·소리·영상 71개가 모두 성해요');
  });

  it('🔴 sweep 뒤 새 파일이 늘면 확인한 것과 아직 확인 전인 것을 함께 말한다(상위 headline ↔ todo 모순 금지)', () => {
    const i = IN({ photo: K({ rows: 78 }), audio: K({ rows: 12 }), sweep: { at: 'x', checked: 78, failed: [], totalAtRun: 78 } });
    expect(fileRealityHeadline(i)).toBe('이 기기의 사진·소리·영상: 확인한 78개는 모두 성하고, 새 12개는 아직 확인 전이에요');
    expect(metric(i, '열리지 않는 파일').level).toBe('todo');
  });

  it('비어 있는 것과 열리지 않는 것을 **나눠** 말한다', () => {
    const s = fileRealityHeadline(IN({ photo: K({ empty: 2 }), sweep: { at: 'x', checked: 12, failed: ['z'], totalAtRun: 12 } }));
    expect(s).toContain('비어 있는 것 2개');
    expect(s).toContain('열리지 않는 것 1개');
  });

  it('아직 안 열어 봤으면 **확인 전**이라고 말한다(성하다고 하지 않는다)', () => {
    const s = fileRealityHeadline(IN({ sweep: null }));
    expect(s).toContain('확인 전');
    expect(s).not.toContain('모두 성해요');
  });

  it('🔴 빈 상태를 초록으로 칠하지 않는다 — 비교할 것이 없는 것과 정상은 다르다', () => {
    const s = fileRealityHeadline(IN({ photo: K({ rows: 0 }), audio: K({ rows: 0 }), video: K({ rows: 0 }), sweep: null }));
    expect(s).toContain('아직 없어요');
  });
});

describe('🔴 시야의 경계를 화면에 말한다', () => {
  it('무엇만 보는지 못박는다', () => {
    expect(fileRealityScopeNote()).toContain('이 기기에 내려받은 바이트');
  });

  it('🔴 **다른 기기에서 확인하라**고 말한다 — 「이 기기에 없다」는 「없다」가 아니다(M-0048)', () => {
    expect(fileRealityScopeNote()).toContain('다른 기기');
  });

  it('서버 대조는 어느 도구가 하는지 가리킨다(막다른 문장 금지)', () => {
    expect(fileRealityScopeNote()).toContain('저장 상태');
  });

  it('마크다운을 쓰지 않는다 — textContent로 그려진다(§5 7항)', () => {
    expect(fileRealityScopeNote()).not.toContain('**');
    expect(fileRealityHeadline(IN())).not.toContain('**');
  });
});

describe('심각도 합성', () => {
  it('problem이 가장 세다', () => expect(worstOf(['ok', 'todo', 'problem', 'unknown'])).toBe('problem'));
  it('unknown이 todo보다 세다', () => expect(worstOf(['ok', 'todo', 'unknown'])).toBe('unknown'));
  it('todo가 ok보다 세다', () => expect(worstOf(['ok', 'todo'])).toBe('todo'));
  it('전부 정상이면 ok', () => expect(worstOf(['ok', 'ok'])).toBe('ok'));
});
