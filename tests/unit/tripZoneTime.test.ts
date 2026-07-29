// tripZoneTime.test.ts — **「그 자리의 시계」** 파생 규칙 (2026-07-29 사용자 지적 · M-0049)
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 이 층이 필요한가
// ─────────────────────────────────────────────────────────────────────────────
// 사용자: *"사진 찍은 나라 또는 지역의 시간으로 적용되게 고정하고 … 한국시간으로 자동 환산"*.
//
// 결함이 둘이었다. **표시** — 순간 시각과 Day 그룹이 *보는 기기*의 시간대로 계산됐다.
// **저장** — EXIF 벽시계를 *넣는 기기*의 시간대로 해석해 절대시각이 틀어졌다(더 무겁다).
//
// 🔴 이 부류는 **CI가 UTC라 기본 설정에서는 구조적으로 안 보인다**(`check-timezone`이 유닛을
// 다른 시간대에서도 돌리는 이유). 그래서 여기서는 **기기 시간대에 의존하지 않는 단언만** 쓴다 —
// 오프셋을 명시적으로 넣고 결과를 확인한다. 기기가 어디에 있든 답이 같아야 한다.

import { describe, it, expect } from 'vitest';
import {
  zoneOffsetMin,
  resolveOffsetMin,
  atOffset,
  wallClockToInstant,
  homeConversion,
  deviceZone,
} from '../../src/domain/time';

const SEOUL = 'Asia/Seoul';
const SAIGON = 'Asia/Ho_Chi_Minh';
const PARIS = 'Europe/Paris';

describe('시간대 → 그 순간의 오프셋', () => {
  it('서울은 +540, 사이공은 +420', () => {
    expect(zoneOffsetMin('2026-07-29T10:08:00.000Z', SEOUL)).toBe(540);
    expect(zoneOffsetMin('2026-07-29T10:08:00.000Z', SAIGON)).toBe(420);
  });

  it('🔴 DST를 포함한다 — 오프셋은 시간대가 아니라 **시간대 × 순간**의 성질이다', () => {
    // 같은 파리인데 여름 +120, 겨울 +60. 여행이 전환일을 걸치면 순간마다 답이 다르다.
    expect(zoneOffsetMin('2026-07-29T12:00:00.000Z', PARIS)).toBe(120);
    expect(zoneOffsetMin('2026-01-29T12:00:00.000Z', PARIS)).toBe(60);
  });

  it('🔴 모르는 시간대는 **null**이다 — 0(UTC)으로 반올림하지 않는다', () => {
    // 「확인 불가」를 「UTC」로 적으면 사용자의 시각이 조용히 9시간 틀어진다(§8).
    expect(zoneOffsetMin('2026-07-29T10:08:00.000Z', 'Mars/Olympus')).toBeNull();
    expect(zoneOffsetMin('2026-07-29T10:08:00.000Z', '')).toBeNull();
  });

  it('파싱 못 하는 시각도 null', () => {
    expect(zoneOffsetMin('망가진값', SEOUL)).toBeNull();
  });

  it('기기 시간대는 항상 문자열을 준다(못 알아내도 빈 값이 아니다)', () => {
    expect(deviceZone().length).toBeGreaterThan(0);
  });
});

describe('시간대 결정 사다리', () => {
  const t = '2026-07-29T10:08:00.000Z';

  it('순간에 직접 적힌 오프셋이 여행 시간대를 이긴다(EXIF가 가장 강하다)', () => {
    expect(resolveOffsetMin(t, 420, SEOUL)).toBe(420);
  });

  it('순간에 없으면 여행 시간대에서 파생한다', () => {
    expect(resolveOffsetMin(t, null, SAIGON)).toBe(420);
    expect(resolveOffsetMin(t, undefined, SAIGON)).toBe(420);
  });

  it('🔴 둘 다 없으면 **모른다** — 기기 시간대로 반올림하지 않는다', () => {
    expect(resolveOffsetMin(t, null, '')).toBeNull();
  });

  it('오프셋 0은 값이다 — 없는 것으로 읽지 않는다(그리니치도 여행지다)', () => {
    expect(resolveOffsetMin(t, 0, SEOUL)).toBe(0);
  });

  it('음수 오프셋도 값이다(뉴욕 -240)', () => {
    expect(resolveOffsetMin(t, -240, SEOUL)).toBe(-240);
  });
});

describe('절대시각 → 그 자리의 벽시계', () => {
  // 사용자 화면의 실제 사례: 대학로 연극, 한국 19:08.
  const t = '2026-07-29T10:08:00.000Z';

  it('서울 오프셋이면 19:08', () => {
    expect(atOffset(t, 540)).toEqual({ date: '2026-07-29', time: '19:08', dateTime: '2026.07.29 19:08' });
  });

  it('🔴 같은 순간이 사이공에서는 17:08 — 기기가 어디 있든 이 답은 같다', () => {
    expect(atOffset(t, 420).time).toBe('17:08');
  });

  it('🔴 날짜 경계를 넘으면 **날짜도** 바뀐다(Day 그룹이 이 값을 쓴다)', () => {
    // 한국 새벽 00:30 = UTC 전날 15:30. 기기 기준으로 묶으면 하루가 밀린다(M-utc-slice의 형태).
    const midnight = '2026-07-28T15:30:00.000Z';
    expect(atOffset(midnight, 540)).toMatchObject({ date: '2026-07-29', time: '00:30' });
    expect(atOffset(midnight, 420)).toMatchObject({ date: '2026-07-28', time: '22:30' });
  });

  it('파싱 실패는 빈 문자열(예외로 화면을 죽이지 않는다)', () => {
    expect(atOffset('망가진값', 540).time).toBe('');
    expect(atOffset(t, Number.NaN).time).toBe('');
  });
});

describe('🔴 벽시계 + 오프셋 → 절대시각 (M-0049 저장 결함)', () => {
  it('사이공에서 19:08에 찍은 사진은 UTC 12:08이다', () => {
    // 예전 코드는 `new Date('2026-07-29T19:08:00')`로 파싱했다 — **넣는 기기**의 시간대로
    // 해석되므로, 한국에서 넣으면 10:08Z가 되어 **2시간 틀어진다.**
    expect(wallClockToInstant('2026-07-29T19:08:00', 420)).toBe('2026-07-29T12:08:00.000Z');
  });

  it('같은 벽시계라도 오프셋이 다르면 다른 순간이다', () => {
    expect(wallClockToInstant('2026-07-29T19:08:00', 540)).toBe('2026-07-29T10:08:00.000Z');
  });

  it('EXIF 표기(공백 구분·초 없음)도 읽는다', () => {
    expect(wallClockToInstant('2026-07-29 19:08', 540)).toBe('2026-07-29T10:08:00.000Z');
  });

  it('날짜 경계를 넘는 환산도 맞다', () => {
    expect(wallClockToInstant('2026-07-29T00:30:00', 540)).toBe('2026-07-28T15:30:00.000Z');
  });

  it('못 읽으면 null(추측해서 만들지 않는다)', () => {
    expect(wallClockToInstant('2026:07:29 19:08:00', 540)).toBeNull(); // EXIF 원본 표기 — 호출부가 먼저 바꿔야 한다
    expect(wallClockToInstant('2026-07-29T19:08:00', Number.NaN)).toBeNull();
  });
});

describe('한국시간 환산 꼬리표 (§8 침묵이 정상)', () => {
  const t = '2026-07-29T10:08:00.000Z';

  it('🔴 같은 시각이면 **아무것도 말하지 않는다**', () => {
    // 국내 여행에서 매번 「한국시간 19:08」이 붙으면 정보가 아니라 소음이다.
    expect(homeConversion(t, 540, SEOUL, '한국')).toBe('');
  });

  it('다르면 홈 시각을 말한다', () => {
    expect(homeConversion(t, 420, SEOUL, '한국')).toBe('한국 19:08');
  });

  it('🔴 날짜까지 다르면 **날짜를 함께** 말한다(시각만 주면 헷갈린다)', () => {
    // 뉴욕 저녁 = 한국 다음날 아침. 「한국 09:08」만 보면 어느 날인지 모른다.
    const ny = '2026-07-29T23:08:00.000Z'; // 뉴욕 19:08(-240)
    expect(homeConversion(ny, -240, SEOUL, '한국')).toBe('한국 2026.07.30 08:08');
  });

  it('홈 시간대를 모르면 조용하다(틀린 환산을 보여주지 않는다)', () => {
    expect(homeConversion(t, 420, 'Mars/Olympus', '한국')).toBe('');
  });
});
