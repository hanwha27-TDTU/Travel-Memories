// tests/unit/tripClock.test.ts — **기억 시각을 화면에 내보내는 문**(`momentWhen`)과 그 주변.
//
// ── 왜 이 파일이 따로 있나 ─────────────────────────────────────────────
// `tripZoneTime.test.ts`는 **부품**(오프셋 계산·벽시계 변환)을 잰다. 여기서 재는 것은
// **사용자에게 나가는 것**이다 — 어떤 오프셋을 골랐는지, 그게 추정인지, 환산을 붙였는지.
//
// §10 ③이 말하는 자리가 정확히 여기다: M-0022에서 유닛 15건이 전부 통과했는데 화면 문장이
// 틀렸다. 숫자는 다 맞았고 **화면에 무엇이 나가는지 검사한 것이 하나도 없었다.** 그래서
// `momentWhen`은 문자열까지 돌려주도록 만들었고, 이 파일이 그 문자열을 잰다.
//
// 시간대 독립: 기대값을 `Asia/Seoul` 같은 **명시 시간대**로만 적는다. 기기 시간대에 기대는
// 케이스는 「미지정 폴백」 하나뿐이고, 거기서는 값이 아니라 **basis·caveat**를 잰다
// (check-timezone (B)가 이 스위트를 KST·HST에서 다시 돌린다).

import { describe, it, expect } from 'vitest';
import {
  momentWhen,
  zoneLabel,
  zonePreview,
  zoneOptions,
  isKnownZone,
  zonesForCountry,
  clockOffsetAtWall,
  inputClockHint,
  deviceZone,
  type TripClock,
} from '../../src/domain/time';

const VIETNAM: TripClock = { zone: 'Asia/Ho_Chi_Minh', homeZone: 'Asia/Seoul' };
const KOREA: TripClock = { zone: 'Asia/Seoul', homeZone: 'Asia/Seoul' };
const UNSET: TripClock = { zone: '', homeZone: 'Asia/Seoul' };

/** 사용자가 처음 지적한 그 화면: 「Day 1 · 7월 29일 (수) · 19:08」. */
const EVENING = '2026-07-29T12:08:00.000Z'; // 베트남 19:08 · 한국 21:08

describe('momentWhen — 그 자리의 시계로 그린다', () => {
  it('여행 시간대로 시각을 만든다(보는 기기와 무관하게)', () => {
    const w = momentWhen(EVENING, null, VIETNAM);
    expect(w.time).toBe('19:08');
    expect(w.date).toBe('2026-07-29');
    expect(w.dateTime).toBe('2026.07.29 19:08');
    expect(w.offsetMin).toBe(420);
    expect(w.basis).toBe('trip');
  });

  it('순간에 적힌 오프셋이 여행 시간대를 이긴다(EXIF OffsetTimeOriginal · 사용자 예외)', () => {
    const w = momentWhen(EVENING, 540, VIETNAM);
    expect(w.time).toBe('21:08');
    expect(w.basis).toBe('moment');
  });

  it('0은 값이다 — UTC 오프셋을 「없음」으로 뭉개지 않는다', () => {
    const w = momentWhen(EVENING, 0, VIETNAM);
    expect(w.offsetMin).toBe(0);
    expect(w.basis).toBe('moment');
    expect(w.time).toBe('12:08');
  });

  it('DST를 따라간다 — 오프셋은 시간대가 아니라 시간대×순간의 성질이다', () => {
    const paris: TripClock = { zone: 'Europe/Paris', homeZone: 'Asia/Seoul' };
    expect(momentWhen('2026-07-15T10:00:00.000Z', null, paris).offsetMin).toBe(120); // 여름
    expect(momentWhen('2026-01-15T10:00:00.000Z', null, paris).offsetMin).toBe(60); // 겨울
  });

  it('깨진 시각은 빈 문장이다 — 지어내지 않는다', () => {
    const w = momentWhen('not-a-date', null, VIETNAM);
    expect(w.time).toBe('');
    expect(w.date).toBe('');
    expect(w.home).toBe('');
    expect(w.caveat).toBe(''); // 값이 없으면 고지할 것도 없다(빈 자리에 경고를 붙이지 않는다)
  });
});

describe('momentWhen — 환산 꼬리표는 **다를 때만** 나온다(§8 침묵이 정상)', () => {
  it('시차가 있으면 집 시각을 함께 말한다', () => {
    const w = momentWhen(EVENING, null, VIETNAM);
    expect(w.home).toContain('21:08');
    // 이름은 **브라우저 tzdata가 주는 값**이라 여기 글자로 박지 않는다(ICU 판이 달라질 수 있다).
    // 우리가 보증할 것은 「id가 아니라 사람이 읽는 이름이 붙는다」이므로 같은 함수와 대조한다.
    expect(w.home).toContain(zoneLabel(EVENING, 'Asia/Seoul'));
    expect(w.home).not.toContain('Asia/'); // id가 새어 나오지 않는다
  });

  it('국내 여행이면 **아무것도 안 나온다** — 매줄 같은 시각이 붙으면 소음이다', () => {
    expect(momentWhen(EVENING, null, KOREA).home).toBe('');
  });

  it('날짜까지 달라지면 날짜를 함께 말한다(시각만 보이면 헷갈린다)', () => {
    // 베트남 7/29 23:30 = 한국 7/30 01:30.
    const w = momentWhen('2026-07-29T16:30:00.000Z', null, VIETNAM);
    expect(w.time).toBe('23:30');
    expect(w.home).toContain('2026.07.30');
  });

  it('집 시간대를 모르면 꼬리표 없이 지나간다(추정으로 채우지 않는다)', () => {
    expect(momentWhen(EVENING, null, { zone: 'Asia/Ho_Chi_Minh', homeZone: 'Nowhere/Nope' }).home).toBe('');
  });
});

describe('momentWhen — 시간대 미지정: 폴백은 쓰지만 **말한다**', () => {
  it('기기 시간대로 그리고 basis는 device다', () => {
    const w = momentWhen(EVENING, null, UNSET);
    expect(w.basis).toBe('device');
    expect(w.time).not.toBe(''); // 화면을 비우지 않는다 — 빈 칸이 곧 거짓말이다
  });

  it('추정임을 같은 자리에서 고지한다(M-0049의 근본형 = 조용히 기기 시계를 썼다)', () => {
    expect(momentWhen(EVENING, null, UNSET).caveat).toContain('이 기기 시간대');
  });

  it('시간대를 정하면 고지가 **사라진다** — 고쳤으면 조용해져야 한다', () => {
    expect(momentWhen(EVENING, null, VIETNAM).caveat).toBe('');
  });

  it('알 수 없는 시간대 id는 미지정과 같게 다룬다(오타를 조용히 UTC로 만들지 않는다)', () => {
    const w = momentWhen(EVENING, null, { zone: 'Asia/Seuol', homeZone: 'Asia/Seoul' });
    expect(w.basis).toBe('device');
    expect(w.caveat).not.toBe('');
  });
});

describe('zoneLabel — id가 아니라 사람이 읽는 이름', () => {
  it('id를 그대로 보이지 않고, 꼬리말(「표준시」)을 떼어 짧게 만든다', () => {
    // 정확한 글자는 브라우저 ICU가 정한다(Node는 「한국 표준시」→「한국」). 그래서 **성질**을 잰다:
    // ①id가 아니고 ②꼬리말이 없고 ③비어 있지 않다. 글자를 박으면 ICU 판이 바뀔 때 거짓 RED가 난다.
    const seoul = zoneLabel(EVENING, 'Asia/Seoul');
    expect(seoul).not.toContain('/');
    expect(seoul).not.toContain('표준시');
    expect(seoul).not.toBe('Seoul'); // 지역화가 실제로 일어났다
    expect(seoul.length).toBeGreaterThan(0);
  });

  it('시간대가 다르면 이름도 다르다(전부 같은 이름으로 뭉개지지 않는다)', () => {
    expect(zoneLabel(EVENING, 'Asia/Seoul')).not.toBe(zoneLabel(EVENING, 'Asia/Ho_Chi_Minh'));
  });

  it('모르는 id는 마지막 조각으로 되돌린다 — id 통째보다 낫고, 지어내지도 않는다', () => {
    expect(zoneLabel(EVENING, 'Mars/New_Base')).toBe('New Base');
  });

  it('빈 시간대는 빈 문자열이다', () => {
    expect(zoneLabel(EVENING, '')).toBe('');
  });
});

describe('zonePreview / isKnownZone — 고른 것이 맞는지 눈으로 확인시킨다(§12)', () => {
  it('시각과 UTC 오프셋을 함께 보여준다', () => {
    const p = zonePreview(EVENING, 'Asia/Ho_Chi_Minh');
    expect(p).toContain('19:08');
    expect(p).toContain('UTC+7');
  });

  it('30분 단위 시간대도 정확히 적는다(인도 +5:30)', () => {
    expect(zonePreview(EVENING, 'Asia/Kolkata')).toContain('UTC+5:30');
  });

  it('서쪽은 음수 부호를 붙인다', () => {
    expect(zonePreview(EVENING, 'Pacific/Honolulu')).toContain('UTC-10');
  });

  it('모르는 시간대는 빈 문자열 — 미리보기를 지어내지 않는다', () => {
    expect(zonePreview(EVENING, 'Mars/New_Base')).toBe('');
    expect(isKnownZone(EVENING, 'Mars/New_Base')).toBe(false);
    expect(isKnownZone(EVENING, 'Asia/Seoul')).toBe(true);
  });
});

describe('clockOffsetAtWall — 입력 칸이 벽시계를 읽는 자', () => {
  it('여행 시간대로 읽는다', () => {
    expect(clockOffsetAtWall('2026-07-29T19:08', VIETNAM)).toBe(420);
  });

  it('DST 전환을 넘어 각각 다르게 읽는다(같은 시간대·다른 계절)', () => {
    const paris: TripClock = { zone: 'Europe/Paris', homeZone: 'Asia/Seoul' };
    expect(clockOffsetAtWall('2026-07-15T12:00', paris)).toBe(120);
    expect(clockOffsetAtWall('2026-01-15T12:00', paris)).toBe(60);
  });

  it('시간대 미지정이면 기기로 읽고 **입력을 거부하지 않는다**', () => {
    const off = clockOffsetAtWall('2026-07-29T19:08', UNSET);
    expect(Number.isFinite(off)).toBe(true);
  });
});

describe('inputClockHint — 어느 시계로 적는 중인지 **늘** 말한다', () => {
  it('시간대가 있으면 그 이름을 말한다', () => {
    expect(inputClockHint(EVENING, VIETNAM)).toContain('인도차이나');
  });

  it('미지정이면 기기 시계임을 말하고 무엇을 하면 되는지 알려준다', () => {
    const h = inputClockHint(EVENING, UNSET);
    expect(h).toContain('이 기기 시간대');
    expect(h).toContain('여행 시간대를 정하면');
  });

  it('침묵하지 않는다 — 이 자리는 값의 뜻이 시계에 달렸다', () => {
    for (const c of [VIETNAM, KOREA, UNSET]) expect(inputClockHint(EVENING, c).length).toBeGreaterThan(0);
  });
});

describe('zoneOptions — 목록은 브라우저가 준다(우리가 표를 들지 않는다)', () => {
  it('실제 시간대 id들을 돌려준다', () => {
    const zs = zoneOptions();
    expect(zs.length).toBeGreaterThan(100);
    expect(zs).toContain('Asia/Seoul');
  });

  it('기기 시간대는 늘 알 수 있는 id다(폴백이 스스로 무효가 되지 않게)', () => {
    expect(isKnownZone(EVENING, deviceZone())).toBe(true);
  });
});

describe('zonesForCountry — 나라 → 시간대(데이터셋 0바이트)', () => {
  // 사용자 제안(2026-07-30): *"여행시간대 초기값은 사진찍은 장소로 셋팅..어때?"*
  // 좌표→시간대는 경계 데이터셋(수 MB)이 필요해 하지 않는다. 그런데 사진 GPS를 이미
  // 역지오코딩해 **나라 코드**를 얻고 있고, 나라→시간대는 브라우저가 안다.
  it('시간대가 하나뿐인 나라는 그것이 답이다', () => {
    expect(zonesForCountry('KR')).toEqual(['Asia/Seoul']);
    expect(zonesForCountry('VN')).toHaveLength(1);
  });

  it('🔴 여럿인 나라는 여럿으로 돌려준다 — 화면이 하나로 반올림하지 못하게(§8)', () => {
    expect(zonesForCountry('US').length).toBeGreaterThan(5);
    expect(zonesForCountry('UZ').length).toBeGreaterThan(1); // 사마르칸트·타슈켄트
  });

  it('돌려준 id는 실제로 오프셋을 계산할 수 있는 값이다(쓸 수 없는 값을 주지 않는다)', () => {
    for (const z of zonesForCountry('VN')) expect(isKnownZone(EVENING, z)).toBe(true);
    for (const z of zonesForCountry('KR')) expect(isKnownZone(EVENING, z)).toBe(true);
  });

  it('소문자·공백도 받는다(지오코더가 소문자로 준다 — kr)', () => {
    expect(zonesForCountry(' kr ')).toEqual(['Asia/Seoul']);
  });

  it('나라 코드가 아니면 빈 배열 — 지어내지 않는다', () => {
    expect(zonesForCountry('')).toEqual([]);
    expect(zonesForCountry('KOR')).toEqual([]); // alpha-3은 이 함수의 입력이 아니다
    expect(zonesForCountry('ZZ')).toEqual([]);
    expect(zonesForCountry('1!')).toEqual([]);
  });
});
