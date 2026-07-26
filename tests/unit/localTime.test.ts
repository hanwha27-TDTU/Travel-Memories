// localTime/localDateTime — 화면에 나가는 시각 문자열(§10 ③: 사용자 문장은 순수 함수로 뽑아야 검사된다).
//
// 이 둘은 `tripDetail`·`mapView`에 각각 `timeLabel`이라는 **같은 이름·다른 내용**으로 살아 있었고,
// DOM 클로저 안이라 검사할 수 없었다. domain/time.ts로 올리며 잠근다.
// 시간대 축은 `check-timezone`이 Asia/Seoul·Pacific/Honolulu로 재실행해 양방향을 본다.

import { describe, it, expect } from 'vitest';
import { localDate, localTime, localDateTime } from '../../src/domain/time';

/** 로컬 시각으로 조립한 ISO — 테스트가 실행 시간대와 무관하게 같은 답을 요구하게 한다. */
function isoAtLocal(y: number, mo: number, d: number, h: number, mi: number): string {
  return new Date(y, mo - 1, d, h, mi, 0, 0).toISOString();
}

describe('localTime', () => {
  it('로컬 시각을 HH:mm으로 준다', () => {
    expect(localTime(isoAtLocal(2026, 7, 26, 6, 48))).toBe('06:48');
  });

  it('자정과 정오를 24시간제로 구분한다', () => {
    expect(localTime(isoAtLocal(2026, 7, 26, 0, 0))).toBe('00:00');
    expect(localTime(isoAtLocal(2026, 7, 26, 12, 0))).toBe('12:00');
    expect(localTime(isoAtLocal(2026, 7, 26, 23, 59))).toBe('23:59');
  });

  it('한 자리 시/분을 0으로 채운다', () => {
    expect(localTime(isoAtLocal(2026, 1, 2, 3, 4))).toBe('03:04');
  });

  it('파싱 실패는 빈 문자열(화면에 "Invalid Date"를 내보내지 않는다)', () => {
    expect(localTime('아무거나')).toBe('');
    expect(localTime('')).toBe('');
  });
});

describe('localDateTime', () => {
  it('날짜 맥락이 없는 자리(지도 팝업)를 위해 날짜까지 준다', () => {
    expect(localDateTime(isoAtLocal(2026, 7, 26, 6, 48))).toBe('2026.07.26 06:48');
  });

  it('월·일을 0으로 채운다', () => {
    expect(localDateTime(isoAtLocal(2026, 1, 2, 3, 4))).toBe('2026.01.02 03:04');
  });

  it('파싱 실패는 빈 문자열', () => {
    expect(localDateTime('nope')).toBe('');
  });

  it('날짜 부분이 localDate와 같은 날을 가리킨다(같은 SSOT에서 파생)', () => {
    // UTC 자정 근처 — 옛 결함(M-utc-slice)이 정확히 여기서 하루 밀렸다.
    const iso = isoAtLocal(2026, 7, 26, 0, 30);
    expect(localDateTime(iso).slice(0, 10).replace(/\./g, '-')).toBe(localDate(iso));
  });
});
