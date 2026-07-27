// tests/unit/externalMap.test.ts — **바깥 지도 링크와 그 문장이 정직한가.**
//
// 왜 문장까지 검사하나(§10 ③): 여기서 만드는 것은 URL만이 아니라 **사용자에게 갈 말**이다.
// 좌표가 없어 *이름으로 찾은* 경우 그 사실을 말하지 않으면, 앱이 엉뚱한 곳을 그 장소라고
// 우기는 셈이 된다. M-0022가 그 자리에서 났다 — 숫자는 다 맞았고 화면 문장만 틀렸는데
// 유닛 15건이 전부 통과했다. 그래서 문장을 자료구조에서 떼어 여기서 잰다.

import { describe, it, expect } from 'vitest';
import {
  externalMapTarget,
  externalMapConsentText,
  isUsableCoord,
} from '../../src/domain/place/externalMap';

const P = (name: string, lat: number | null = null, lng: number | null = null) => ({ name, lat, lng });

describe('① 좌표가 있으면 **좌표로 정확히** 집는다', () => {
  it('구글 Maps URLs 형식 — api=1이 없으면 나머지가 전부 무시된다', () => {
    const t = externalMapTarget(P('김포국제공항', 37.5583, 126.7906))!;
    expect(t.url).toContain('https://www.google.com/maps/search/?api=1&query=');
    expect(t.precision).toBe('coords');
  });

  it('좌표가 URL에 그대로 들어간다(순서: 위도,경도)', () => {
    const t = externalMapTarget(P('제주', 33.4996, 126.5312))!;
    expect(decodeURIComponent(t.url.split('query=')[1]!)).toBe('33.4996,126.5312');
  });

  it('🔴 API 키가 붙지 않는다 — Maps URLs는 키가 필요 없다(그래서 무료다)', () => {
    const t = externalMapTarget(P('제주', 33.4996, 126.5312))!;
    expect(t.url).not.toMatch(/key=/i);
  });

  it('소수 6자리까지만 — 그 이상은 정밀도를 **가장**하는 것이다', () => {
    const t = externalMapTarget(P('x', 37.123456789, 126.987654321))!;
    expect(decodeURIComponent(t.url.split('query=')[1]!)).toBe('37.123457,126.987654');
  });

  it('좌표로 집었으면 **단서를 달지 않는다**(달 이유가 없다)', () => {
    expect(externalMapTarget(P('제주', 33.5, 126.5))!.caveat).toBeNull();
  });
});

describe('② 좌표가 없으면 이름으로 찾되 **그렇다고 말한다**', () => {
  it('이름이 URL 인코딩돼 들어간다(한글·공백·&가 URL을 깨지 않게)', () => {
    const t = externalMapTarget(P('제주 흑돼지 & 국수'))!;
    expect(t.precision).toBe('name');
    expect(decodeURIComponent(t.url.split('query=')[1]!)).toBe('제주 흑돼지 & 국수');
    expect(t.url).not.toContain(' ');
  });

  it('🔴 「이름으로 찾았다」는 사실을 화면 문장으로 남긴다', () => {
    const t = externalMapTarget(P('공항'))!;
    expect(t.caveat).toBeTruthy();
    expect(t.caveat).toContain('이름');
  });

  it('같은 이름이 여러 곳일 수 있다는 것까지 말한다(모르는 것을 확신처럼 말하지 않는다)', () => {
    expect(externalMapTarget(P('공항'))!.caveat).toContain('다른 곳이 열릴 수 있');
  });

  it('버튼 라벨도 좌표일 때와 **다르다** — 라벨만 보고도 구분된다', () => {
    const byCoord = externalMapTarget(P('공항', 37.5, 126.8))!;
    const byName = externalMapTarget(P('공항'))!;
    expect(byCoord.label).not.toBe(byName.label);
    expect(byName.label).toContain('이름');
  });
});

describe('③ 열 곳이 없으면 **null** — 없는 것을 지어내지 않는다', () => {
  it('이름도 좌표도 없으면 null(버튼 자체를 만들지 않는다)', () => {
    expect(externalMapTarget(P(''))).toBeNull();
    expect(externalMapTarget(P('   '))).toBeNull();
  });

  it('공백뿐인 이름은 이름이 아니다', () => {
    expect(externalMapTarget(P('  \t \n '))).toBeNull();
  });
});

describe('④ 못 쓸 좌표는 **없는 것으로 친다** — 엉뚱한 곳을 열지 않는다', () => {
  it('지구 밖 좌표는 거부한다(무결성 점검의 COORD_RANGE와 같은 기준)', () => {
    expect(isUsableCoord(91, 0)).toBe(false);
    expect(isUsableCoord(0, 181)).toBe(false);
    expect(isUsableCoord(-90.1, 10)).toBe(false);
  });

  it('NaN·Infinity를 좌표로 쓰지 않는다', () => {
    expect(isUsableCoord(NaN, 10)).toBe(false);
    expect(isUsableCoord(10, Infinity)).toBe(false);
  });

  it('🔴 0,0(Null Island)은 "좌표 없음"의 흔한 형태다 — 대서양 한가운데를 열지 않는다', () => {
    expect(isUsableCoord(0, 0)).toBe(false);
    const t = externalMapTarget(P('어딘가', 0, 0))!;
    expect(t.precision).toBe('name'); // 좌표 대신 이름으로 내려간다
  });

  it('경계값은 쓸 수 있다(±90 / ±180)', () => {
    expect(isUsableCoord(90, 180)).toBe(true);
    expect(isUsableCoord(-90, -180)).toBe(true);
  });

  it('좌표 하나만 있으면 쓰지 않는다(짝이 아니면 점을 찍을 수 없다)', () => {
    expect(isUsableCoord(37.5, null)).toBe(false);
    expect(isUsableCoord(null, 126.8)).toBe(false);
  });
});

describe('🔴 ⑤ 동의 문구는 **무엇이 나가는지**를 그대로 말한다 (PRIVACY)', () => {
  it('좌표를 열 때는 그 좌표를 문구에 보여준다 — 무엇이 나가는지 숨기지 않는다', () => {
    const t = externalMapTarget(P('제주', 33.4996, 126.5312))!;
    const text = externalMapConsentText(t);
    expect(text).toContain('33.4996,126.5312');
    expect(text).toContain('구글');
  });

  it('이름으로 갈 때는 **이름이** 나간다고 말한다(좌표라고 하지 않는다)', () => {
    const text = externalMapConsentText(externalMapTarget(P('김포공항'))!);
    expect(text).toContain('김포공항');
    expect(text).not.toContain('좌표(');
  });

  it('이 앱이 평소엔 위치를 안 보낸다는 사실을 함께 말한다(왜 묻는지가 드러나게)', () => {
    const text = externalMapConsentText(externalMapTarget(P('제주', 33.5, 126.5))!);
    expect(text).toContain('평소 위치를 밖으로 보내지 않');
  });

  it('처음 한 번뿐임을 밝힌다 — 매번 물을 거라는 오해를 만들지 않는다', () => {
    const text = externalMapConsentText(externalMapTarget(P('제주', 33.5, 126.5))!);
    expect(text).toContain('처음 한 번');
  });

  it('문구가 `sends`에서 파생된다 — 손으로 다시 적지 않는다(SSOT)', () => {
    const t = externalMapTarget(P('제주', 33.5, 126.5))!;
    expect(externalMapConsentText(t)).toContain(t.sends);
  });
});
