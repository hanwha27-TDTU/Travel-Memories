// tests/unit/trashVerdict.test.ts — 「저장·삭제·휴지통」 도구의 판정과 **화면 문장**을 잠근다.
//
// 왜 문장까지 재는가(§10 ③): 이 저장소에서 자료구조는 옳고 **사용자에게 가는 문장만 틀린**
// 결함이 반복해서 났다(M-0021 엉뚱한 곳 지목 · M-0022 계산해놓고 화면에 안 알림 · M-0028
// 한정 생략 · M-0046 찾아보지도 않고 「없다」). 유닛이 level만 재면 그 층은 영원히 안 잡힌다.

import { describe, it, expect } from 'vitest';
import {
  trashSourceMetric,
  emptyOnRestoreMetric,
  orphanTrashedMetric,
  trashMetrics,
  trashHeadline,
  type TrashObservation,
} from '../../src/domain/trashVerdict';

/** 정상(클라우드 있고 휴지통 비었고 서버를 읽었다) 기준값 — 각 검사가 필요한 곳만 덮어쓴다. */
const clean = (over: Partial<TrashObservation> = {}): TrashObservation => ({
  cloudConfigured: true,
  serverTrashCount: 0,
  unavailableReason: null,
  localTrashCount: 0,
  emptyOnRestore: [],
  orphans: [],
  ...over,
});

describe('① 휴지통 목록의 기준', () => {
  it('서버를 읽었으면 정상 — 모든 기기가 같은 목록을 본다', () => {
    const m = trashSourceMetric(clean({ serverTrashCount: 5 }));
    expect(m.level).toBe('ok');
    expect(m.actual).toContain('서버');
    expect(m.meaning).toBeUndefined(); // 정상은 침묵한다(§5 1항)
  });

  it('🔴 서버를 못 읽으면 정상도 문제도 아닌 **확인 불가**다', () => {
    const m = trashSourceMetric(clean({ serverTrashCount: null, unavailableReason: '로그인 상태가 아닙니다' }));
    expect(m.level).toBe('unknown');
    // §7-E: unknown을 낼 거면 **왜 모르는지** 말해야 한다. 이유 없는 unknown은 정보가 0이다.
    expect(m.meaning).toContain('로그인 상태가 아닙니다');
    // 그리고 사용자가 지금 보는 것이 무엇인지 밝힌다(§7-C 한정 생략 방지).
    expect(m.actual).toContain('다를 수 있');
  });

  it('🔴 개수를 대조하지 않는다 — 로컬이 서버보다 적은 것은 **정상**이다(불변식 #8)', () => {
    // 다른 기기가 지운 항목은 이 기기에 사본이 없으면 tombstone을 만들지 않는다.
    // 개수로 판정하면 이 정상 상태를 영원히 경고한다(§7-D 오탐 = 틀린 진단).
    const m = trashSourceMetric(clean({ serverTrashCount: 40, localTrashCount: 2 }));
    expect(m.level).toBe('ok');
  });

  it('🔴 클라우드가 없는 배포는 「모름」이 아니라 **정상**이다 — 읽을 서버가 없다(§7-E)', () => {
    // 과도한 unknown도 결함이다: 총괄 판정을 끌어내려 정상 화면을 이상하게 보이게 만든다.
    const m = trashSourceMetric(clean({ cloudConfigured: false, serverTrashCount: null }));
    expect(m.level).toBe('ok');
    // 기대값도 「서버」가 아니어야 한다 — 서버가 없는데 서버를 기대하면 영원히 어긋난다.
    expect(m.expected).toBe('이 기기');
  });

  it('🔴 클라우드가 없으면 「연결이 돌아오면」이라 말하지 않는다 — 돌아올 연결이 없다', () => {
    const m = trashSourceMetric(clean({ cloudConfigured: false, serverTrashCount: null }));
    expect(m.meaning ?? '').not.toContain('연결이 돌아오면');
    expect(m.meaning).toBeUndefined(); // 정상이므로 침묵한다
  });
});

describe('② 되살려도 자료가 비는 항목 (bytesMissing)', () => {
  it('없으면 정상이고 침묵한다', () => {
    const m = emptyOnRestoreMetric(clean());
    expect(m.level).toBe('ok');
    expect(m.actual).toBe('없음');
    expect(m.meaning).toBeUndefined();
  });

  it('있으면 할 일 — 종류별 개수를 이름과 함께 말한다', () => {
    const m = emptyOnRestoreMetric(
      clean({
        emptyOnRestore: [
          { domain: 'media', label: '사진 aaaaaaaa' },
          { domain: 'media', label: '사진 bbbbbbbb' },
          { domain: 'audio', label: '소리 cccccccc' },
          { domain: 'video', label: '영상 dddddddd' },
        ],
      }),
    );
    expect(m.level).toBe('todo');
    // §7-G 곁가지: **숫자를 합치면 이름이 사라진다.** 종류를 부를 수 있어야 한다.
    expect(m.actual).toContain('사진 2');
    expect(m.actual).toContain('소리 1');
    expect(m.actual).toContain('영상 1');
  });

  it('🔴 원인을 못박지 않는다 — 관측까지만 말한다(§7-I)', () => {
    const m = emptyOnRestoreMetric(clean({ emptyOnRestore: [{ domain: 'media', label: '사진 aaaaaaaa' }] }));
    // 「지워졌습니다」·「서버가 잃었습니다」 같은 단정은 사용자를 엉뚱한 곳으로 보낸다(M-0056).
    for (const 단정 of ['지웠', '지워졌', '사라졌습니다', '때문입니다']) {
      expect(m.meaning).not.toContain(단정);
    }
    // 대신 **다음에 할 일**을 준다(막다른 문장 금지 · §7-D).
    expect(m.meaning).toContain('다른 기기');
  });

  it('되살리기가 막힌다고 말하지 않는다 — 되살리기는 되고 자료만 빈다', () => {
    const m = emptyOnRestoreMetric(clean({ emptyOnRestore: [{ domain: 'audio', label: '소리 aaaaaaaa' }] }));
    expect(m.meaning).toContain('되살리기는 되지만');
  });
});

describe('③ 되살릴 곳이 없는 항목 (부모 영구삭제)', () => {
  it('없으면 정상이고 침묵한다', () => {
    const m = orphanTrashedMetric(clean());
    expect(m.level).toBe('ok');
    expect(m.meaning).toBeUndefined();
  });

  it('있으면 문제 — 되살릴 수 없다는 뜻이므로 할 일보다 급하다', () => {
    const m = orphanTrashedMetric(clean({ orphans: [{ label: '사진 aaaaaaaa' }, { label: '비용 bbbbbbbb' }] }));
    expect(m.level).toBe('problem');
    expect(m.actual).toBe('2건');
    expect(m.meaning).toContain('돌아갈 곳이 없');
  });
});

describe('판정 한 문장 (headline)', () => {
  it('🔴 빈 상태를 「정상」으로 뭉개지 않는다 — 비었으면 비었다고 말한다(§7-C)', () => {
    expect(trashHeadline(clean({ serverTrashCount: 0 }))).toBe('휴지통이 비어 있습니다');
  });

  it('서버를 읽었고 항목이 있으면 **기기 간 일치**를 말한다', () => {
    expect(trashHeadline(clean({ serverTrashCount: 7 }))).toContain('7건');
    expect(trashHeadline(clean({ serverTrashCount: 7 }))).toContain('모든 기기');
  });

  it('서버를 못 읽었으면 그 사실이 문장에 나온다', () => {
    const h = trashHeadline(clean({ serverTrashCount: null, unavailableReason: '오프라인' }));
    expect(h).toContain('이 기기');
  });

  it('🔴 클라우드 없는 배포는 「못 읽었다」가 아니라 **개수를 그냥 말한다**', () => {
    expect(trashHeadline(clean({ cloudConfigured: false, serverTrashCount: null }))).toBe('휴지통이 비어 있습니다');
    const h = trashHeadline(clean({ cloudConfigured: false, serverTrashCount: null, localTrashCount: 4 }));
    expect(h).toBe('휴지통에 4건이 있습니다');
    expect(h).not.toContain('보여주고 있어요'); // 「못 읽어서 대신 보여준다」는 뜻이 새면 안 된다
  });

  it('🔴 가장 급한 것을 가리킨다 — 지표를 늘려도 문장이 엉뚱한 곳을 보지 않게(M-0021)', () => {
    const both = clean({
      serverTrashCount: 3,
      emptyOnRestore: [{ domain: 'media', label: 'x' }],
      orphans: [{ label: 'y' }],
    });
    // 문제(orphan)가 할 일(emptyOnRestore)보다 먼저 나와야 한다.
    expect(trashHeadline(both)).toContain('되살릴 곳이 없');
  });

  it('문제가 없고 할 일만 있으면 할 일을 가리킨다', () => {
    const h = trashHeadline(clean({ serverTrashCount: 3, emptyOnRestore: [{ domain: 'audio', label: 'x' }] }));
    expect(h).toContain('자료가 비는');
  });
});

describe('지표 묶음', () => {
  it('세 지표를 **계약된 순서**로 낸다 — 화면 자리도 계약이다(§7 사용자 대면 대칭)', () => {
    const ms = trashMetrics(clean());
    expect(ms).toHaveLength(3);
    expect(ms[0].expected).toBe('서버');
    expect(ms[1].expected).toBe('없음');
    expect(ms[2].expected).toBe('없음');
  });

  it('🔴 모든 지표에 기대값이 있다 — 없으면 지표가 아니라 맥락이다(§4)', () => {
    const ms = trashMetrics(
      clean({
        serverTrashCount: null,
        unavailableReason: '오프라인',
        emptyOnRestore: [{ domain: 'media', label: 'x' }],
        orphans: [{ label: 'y' }],
      }),
    );
    for (const m of ms) {
      expect(m.expected.length).toBeGreaterThan(0);
      expect(m.actual.length).toBeGreaterThan(0);
    }
  });

  it('🔴 화면 문자열에 마크다운을 쓰지 않는다 — textContent로 그리므로 `**`가 그대로 찍힌다(§5 7항)', () => {
    const ms = trashMetrics(
      clean({
        serverTrashCount: null,
        unavailableReason: '오프라인',
        emptyOnRestore: [{ domain: 'media', label: 'x' }],
        orphans: [{ label: 'y' }],
      }),
    );
    for (const m of ms) {
      expect(m.actual).not.toContain('**');
      expect(m.expected).not.toContain('**');
      expect(m.meaning ?? '').not.toContain('**');
    }
    expect(trashHeadline(clean({ orphans: [{ label: 'y' }] }))).not.toContain('**');
  });
});
