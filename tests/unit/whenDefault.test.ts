// tests/unit/whenDefault.test.ts — **순간의 발생 시각을 무엇으로 채우고, 뭐라고 말하는가.**
//
// 왜 유닛이 필요한가: 여기서 나오는 것은 값만이 아니라 **사용자에게 가는 문장**이다.
// M-0022에서 유닛 15건이 전부 통과했는데 화면 문장이 틀렸다 — 숫자는 다 맞았고
// **화면에 무엇이 나가는지 검사한 것이 하나도 없었다**(§10 ③). 그래서 라벨까지 잰다.
//
// 배경(2026-07-27 사용자): 생성 폼에 시각 칸이 없어 `occurredAt`이 조용히 `now`로 찍혔다.
// 7/16~19 여행을 7/27에 정리하면 순간이 전부 7/27이 된다 — 사진 이름은 EXIF의 7/16인데.
// 그리고 *"사후에 소급하는 경우가 더 많아요"*가 우선순위를 정했다.

import { describe, it, expect } from 'vitest';
import { guessOccurredAt, outsideTripWarning, humanWhen } from '../../src/domain/moment/whenDefault';

/** 로컬 시각으로 ISO를 만든다 — 이 검사는 시간대에 의존하면 안 된다(check-timezone). */
const local = (y: number, mo: number, d: number, h = 0, mi = 0): string =>
  new Date(y, mo - 1, d, h, mi, 0, 0).toISOString();

const NOW = local(2026, 7, 27, 2, 26);

describe('① 사진이 있으면 사진이 답이다 — 앱이 아는 것을 사람에게 묻지 않는다', () => {
  it('한 장이면 그 사진의 촬영시각', () => {
    const g = guessOccurredAt({
      photoTakenAts: [local(2026, 7, 16, 9, 30)],
      previousOccurredAt: null,
      tripStartDate: '2026-07-16',
      now: NOW,
    });
    expect(g.source).toBe('photo');
    expect(g.at).toBe(local(2026, 7, 16, 9, 30));
    expect(g.label).toContain('📷 사진에서');
    expect(g.label).toContain('2026-07-16 09:30');
  });

  it('여러 장이면 **가장 이른 것** — 그 순간의 시작이 그 순간이다', () => {
    const g = guessOccurredAt({
      photoTakenAts: [local(2026, 7, 16, 12, 5), local(2026, 7, 16, 9, 30), local(2026, 7, 16, 11, 0)],
      previousOccurredAt: null,
      tripStartDate: null,
      now: NOW,
    });
    expect(g.at).toBe(local(2026, 7, 16, 9, 30));
    // 몇 장 중에서 골랐는지 말한다 — 사용자가 "왜 9:30이지?"를 물을 자리가 여기다.
    expect(g.label).toContain('3장 중 가장 이른 것');
  });

  it('한 장일 때는 개수 문구를 붙이지 않는다(1장 중 가장 이른 것은 말이 안 된다)', () => {
    const g = guessOccurredAt({
      photoTakenAts: [local(2026, 7, 16, 9, 30)],
      previousOccurredAt: null,
      tripStartDate: null,
      now: NOW,
    });
    expect(g.label).not.toContain('장 중');
  });

  it('사진이 **직전 순간·여행 시작일보다 우선**한다', () => {
    const g = guessOccurredAt({
      photoTakenAts: [local(2026, 7, 18, 15, 0)],
      previousOccurredAt: local(2026, 7, 16, 9, 0),
      tripStartDate: '2026-07-16',
      now: NOW,
    });
    expect(g.source).toBe('photo');
  });

  it('시각을 못 읽는 사진은 **버린다** — 지어낸 값으로 정렬하지 않는다', () => {
    const g = guessOccurredAt({
      photoTakenAts: ['', 'not-a-date', local(2026, 7, 16, 9, 30)],
      previousOccurredAt: null,
      tripStartDate: null,
      now: NOW,
    });
    expect(g.at).toBe(local(2026, 7, 16, 9, 30));
  });

  // 2026-07-27: 스크린샷·탑승권 QR처럼 EXIF가 없는 사진은 **아예 넘어오지 않는다**(화면이
  // null을 걸러낸다). 예전엔 파일 수정시각으로 채워져 「📷 사진에서」라고 말하면서 실은
  // *앱에 넣은 시각*을 보여줬다 — 근거를 거짓으로 대는 것이라 그 경로를 끊었다.
  it('EXIF 없는 사진만 고르면 사진 근거를 쓰지 않는다(거짓 근거 금지)', () => {
    const g = guessOccurredAt({
      photoTakenAts: [], // 화면이 null을 걸러 빈 배열로 준다
      previousOccurredAt: local(2026, 7, 16, 9, 0),
      tripStartDate: '2026-07-16',
      now: NOW,
    });
    expect(g.source).toBe('previous');
    expect(g.label).not.toContain('사진에서');
  });

  it('전부 못 읽으면 사진이 없는 것과 같다(다음 근거로 내려간다)', () => {
    const g = guessOccurredAt({
      photoTakenAts: ['x', 'y'],
      previousOccurredAt: local(2026, 7, 16, 9, 0),
      tripStartDate: null,
      now: NOW,
    });
    expect(g.source).toBe('previous');
  });
});

describe('② 사진이 없으면 — 소급 입력은 순차적이다', () => {
  it('직전 순간과 같은 시각을 물려준다(날짜를 아홉 번 다시 고르지 않게)', () => {
    const g = guessOccurredAt({
      photoTakenAts: [],
      previousOccurredAt: local(2026, 7, 16, 9, 0),
      tripStartDate: '2026-07-16',
      now: NOW,
    });
    expect(g.source).toBe('previous');
    expect(g.at).toBe(local(2026, 7, 16, 9, 0));
    expect(g.label).toContain('⬆ 직전 순간과 같은 시각');
  });

  it('첫 순간이면 여행 시작일 **00:00** — 00:00은 "시각 미정"의 표시다', () => {
    const g = guessOccurredAt({
      photoTakenAts: [],
      previousOccurredAt: null,
      tripStartDate: '2026-07-16',
      now: NOW,
    });
    expect(g.source).toBe('tripStart');
    expect(g.at).toBe(local(2026, 7, 16, 0, 0)); // 로컬 자정 — UTC로 해석해 하루 밀리면 안 된다(M-0018)
    expect(g.label).toContain('시각을 정해 주세요'); // 미정임을 말한다
  });

  it('여행 날짜조차 없으면 지금 — 그리고 그것도 지금이라고 말한다', () => {
    const g = guessOccurredAt({ photoTakenAts: [], previousOccurredAt: null, tripStartDate: null, now: NOW });
    expect(g.source).toBe('now');
    expect(g.at).toBe(NOW);
    expect(g.label).toContain('⏱ 지금');
  });

  it('여행 시작일이 날짜 형식이 아니면 믿지 않는다', () => {
    const g = guessOccurredAt({
      photoTakenAts: [],
      previousOccurredAt: null,
      tripStartDate: '2026/07/16',
      now: NOW,
    });
    expect(g.source).toBe('now');
  });
});

describe('③ 근거를 **반드시** 말한다 — 추측을 사실처럼 보이게 두지 않는다', () => {
  // 이 무리가 §10 ③(전달 결함)의 방어선이다. 값이 맞아도 근거가 없으면 사용자는
  // 그게 추측인지 모르고, 틀렸을 때 고칠 생각을 못 한다.
  const cases: { name: string; input: Parameters<typeof guessOccurredAt>[0] }[] = [
    { name: 'photo', input: { photoTakenAts: [NOW], previousOccurredAt: null, tripStartDate: null, now: NOW } },
    { name: 'previous', input: { photoTakenAts: [], previousOccurredAt: NOW, tripStartDate: null, now: NOW } },
    { name: 'tripStart', input: { photoTakenAts: [], previousOccurredAt: null, tripStartDate: '2026-07-16', now: NOW } },
    { name: 'now', input: { photoTakenAts: [], previousOccurredAt: null, tripStartDate: null, now: NOW } },
  ];

  for (const c of cases) {
    it(`${c.name}: 라벨이 비어 있지 않고 **값을 포함한다**`, () => {
      const g = guessOccurredAt(c.input);
      expect(g.label.length).toBeGreaterThan(0);
      expect(g.label).toContain(humanWhen(g.at)); // 근거만이 아니라 **고른 값**도 보여야 한다
    });
  }
});

describe('④ 여행 기간 밖은 **막지 않고 말한다**', () => {
  it('기간 안이면 침묵한다', () => {
    expect(outsideTripWarning(local(2026, 7, 17, 12, 0), '2026-07-16', '2026-07-19')).toBeNull();
  });

  it('경계일(첫날·마지막날)은 기간 안이다', () => {
    expect(outsideTripWarning(local(2026, 7, 16, 0, 0), '2026-07-16', '2026-07-19')).toBeNull();
    expect(outsideTripWarning(local(2026, 7, 19, 23, 59), '2026-07-16', '2026-07-19')).toBeNull();
  });

  it('이전이면 그렇게 말한다', () => {
    const w = outsideTripWarning(local(2026, 7, 15, 12, 0), '2026-07-16', '2026-07-19');
    expect(w).toContain('이전');
    expect(w).toContain('2026-07-16 ~ 2026-07-19'); // 어느 기간인지 함께 말한다
  });

  it('이후면 그렇게 말한다 — 사용자가 실제로 밟은 경우(7/27에 7/16 여행 정리)', () => {
    const w = outsideTripWarning(local(2026, 7, 27, 2, 26), '2026-07-16', '2026-07-19');
    expect(w).toContain('이후');
  });

  it('한쪽만 있어도 그쪽은 판정한다(있는 근거는 쓴다)', () => {
    expect(outsideTripWarning(local(2026, 7, 15), '2026-07-16', null)).toContain('이전');
    expect(outsideTripWarning(local(2026, 7, 20), null, '2026-07-19')).toContain('이후');
  });

  it('여행 날짜를 모르면 **말하지 않는다**(모르는 것을 문제로 반올림하지 않는다)', () => {
    expect(outsideTripWarning(NOW, null, null)).toBeNull();
  });

  it('시각이 깨져 있으면 말하지 않는다', () => {
    expect(outsideTripWarning('not-a-date', '2026-07-16', '2026-07-19')).toBeNull();
  });
});
