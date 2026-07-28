// tests/unit/externalMap.test.ts — **바깥 지도 링크와 그 문장이 정직한가.**
//
// 왜 문장까지 검사하나(§10 ③): 여기서 만드는 것은 URL만이 아니라 **사용자에게 갈 말**이다.
// 좌표가 없어 *이름으로 찾은* 경우 그 사실을 말하지 않으면, 앱이 엉뚱한 곳을 그 장소라고
// 우기는 셈이 된다. M-0022가 그 자리에서 났다 — 숫자는 다 맞았고 화면 문장만 틀렸는데
// 유닛 15건이 전부 통과했다. 그래서 문장을 자료구조에서 떼어 여기서 잰다.
//
// 🔴 2026-07-28에 지도가 넷이 되면서(구글·얀덱스·네이버·카카오) **새 위험 둘**이 생겼고,
//    둘 다 "눌렀더니 엉뚱한 곳이 열린다"로 나타난다 — 조용하지 않고 즉시 드러나지만,
//    드러나는 곳이 **사용자의 화면**이라 여기서 잡아야 한다:
//      ① 얀덱스만 **경도,위도** 순서다(나머지 셋은 위도,경도) → 뒤집으면 다른 나라가 열린다
//      ② 카카오 링크는 경로가 **쉼표로 나뉜다** → 이름에 쉼표가 있으면 좌표 자리가 밀린다

import { describe, it, expect } from 'vitest';
import {
  externalMapTargets,
  externalMapConsentText,
  isUsableCoord,
  MAP_PROVIDER_IDS,
  type MapProviderId,
} from '../../src/domain/place/externalMap';

const P = (name: string, lat: number | null = null, lng: number | null = null) => ({ name, lat, lng });
/** 제공자 하나만 꺼낸다 — 검사가 순서에 기대지 않게. */
const one = (place: ReturnType<typeof P>, id: MapProviderId) =>
  externalMapTargets(place).find((t) => t.id === id)!;

describe('① 좌표가 있으면 **좌표로 정확히** 집는다', () => {
  it('네 지도 전부에 링크가 생긴다(하나만 두면 여행지의 절반에서 쓸모가 없다)', () => {
    const ids = externalMapTargets(P('김포국제공항', 37.5583, 126.7906)).map((t) => t.id);
    expect(ids.sort()).toEqual([...MAP_PROVIDER_IDS].sort());
  });

  it('구글 Maps URLs 형식 — api=1이 없으면 나머지가 전부 무시된다', () => {
    const t = one(P('김포국제공항', 37.5583, 126.7906), 'google');
    expect(t.url).toContain('https://www.google.com/maps/search/?api=1&query=');
    expect(t.precision).toBe('coords');
  });

  it('구글: 좌표가 URL에 그대로 들어간다(순서: 위도,경도)', () => {
    const t = one(P('제주', 33.4996, 126.5312), 'google');
    expect(decodeURIComponent(t.url.split('query=')[1]!)).toBe('33.4996,126.5312');
  });

  it('🔴 어느 지도에도 API 키가 붙지 않는다 — 전부 그냥 링크다(그래서 무료다)', () => {
    for (const t of externalMapTargets(P('제주', 33.4996, 126.5312))) {
      expect(t.url, t.id).not.toMatch(/[?&](api_?key|apikey|key)=/i);
    }
  });

  it('소수 6자리까지만 — 그 이상은 정밀도를 **가장**하는 것이다', () => {
    const t = one(P('x', 37.123456789, 126.987654321), 'google');
    expect(decodeURIComponent(t.url.split('query=')[1]!)).toBe('37.123457,126.987654');
  });

  it('좌표로 집었으면 **단서를 달지 않는다**(달 이유가 없다)', () => {
    for (const t of externalMapTargets(P('제주', 33.5, 126.5))) expect(t.caveat, t.id).toBeNull();
  });
});

describe('🔴 ② 얀덱스만 **경도,위도** 순서다 — 뒤집으면 다른 나라가 열린다', () => {
  const seoul = P('김포국제공항', 37.565642, 126.800932); // 위도 37.5, 경도 126.8

  it('얀덱스 `ll`은 경도가 먼저다', () => {
    const t = one(seoul, 'yandex');
    expect(t.url).toContain('ll=126.800932,37.565642');
  });

  it('얀덱스 `pt`(핀)도 같은 순서다 — 중심과 핀이 어긋나면 안 된다', () => {
    expect(one(seoul, 'yandex').url).toContain('pt=126.800932,37.565642');
  });

  it('나머지 셋은 **위도가 먼저**다(얀덱스와 반대인 것을 못 박는다)', () => {
    expect(decodeURIComponent(one(seoul, 'google').url)).toContain('query=37.565642,126.800932');
    expect(one(seoul, 'naver').url).toContain('lat=37.565642');
    expect(one(seoul, 'naver').url).toContain('lng=126.800932');
    expect(decodeURIComponent(one(seoul, 'kakao').url)).toContain(',37.565642,126.800932');
  });

  it('위도·경도를 바꿔 넣으면 **다른 URL**이 된다(검사가 공허하지 않다는 증거)', () => {
    const flipped = one(P('뒤집힘', 126.800932 - 90, 37.565642), 'yandex'); // 억지 좌표
    expect(flipped.url).not.toBe(one(seoul, 'yandex').url);
  });
});

describe('🔴 ③ 카카오 링크는 경로가 쉼표로 나뉜다 — 이름의 쉼표가 좌표를 밀어낸다', () => {
  it('이름에 쉼표가 있어도 좌표 자리가 유지된다', () => {
    const t = one(P('서울시청, 본관', 37.5665, 126.978), 'kakao');
    const path = decodeURIComponent(t.url.split('/link/map/')[1]!);
    // 쉼표로 나눴을 때 **정확히 3조각**이어야 한다: 이름 · 위도 · 경도
    const parts = path.split(',');
    expect(parts).toHaveLength(3);
    expect(parts[1]).toBe('37.5665');
    expect(parts[2]).toBe('126.978');
  });

  it('이름이 비어도 링크가 깨지지 않는다(빈 자리가 생기지 않게)', () => {
    const t = one(P('', 37.5665, 126.978), 'kakao');
    const parts = decodeURIComponent(t.url.split('/link/map/')[1]!).split(',');
    expect(parts).toHaveLength(3);
    expect(parts[0]!.length).toBeGreaterThan(0);
  });
});

describe('④ 좌표가 없으면 이름으로 찾되 **그렇다고 말한다**', () => {
  it('이름이 URL 인코딩돼 들어간다(한글·공백·&가 URL을 깨지 않게)', () => {
    for (const t of externalMapTargets(P('제주 흑돼지 & 국수'))) {
      expect(t.precision, t.id).toBe('name');
      expect(t.url, t.id).not.toContain(' ');
      expect(decodeURIComponent(t.url), t.id).toContain('제주 흑돼지 & 국수');
    }
  });

  it('🔴 「이름으로 찾았다」는 사실을 화면 문장으로 남긴다', () => {
    const t = one(P('공항'), 'google');
    expect(t.caveat).toBeTruthy();
    expect(t.caveat).toContain('이름');
  });

  it('같은 이름이 여러 곳일 수 있다는 것까지 말한다(모르는 것을 확신처럼 말하지 않는다)', () => {
    expect(one(P('공항'), 'google').caveat).toContain('다른 곳이 열릴 수 있');
  });

  it('좌표일 때와 **정밀도가 다르다** — 자료구조가 그 차이를 들고 있다', () => {
    expect(one(P('공항', 37.5, 126.8), 'google').precision).toBe('coords');
    expect(one(P('공항'), 'google').precision).toBe('name');
  });
});

describe('⑤ 열 곳이 없으면 **빈 배열** — 없는 것을 지어내지 않는다', () => {
  it('이름도 좌표도 없으면 비운다(버튼 자체를 만들지 않는다)', () => {
    expect(externalMapTargets(P(''))).toEqual([]);
    expect(externalMapTargets(P('   '))).toEqual([]);
  });

  it('공백뿐인 이름은 이름이 아니다', () => {
    expect(externalMapTargets(P('  \t \n '))).toEqual([]);
  });
});

describe('⑥ 못 쓸 좌표는 **없는 것으로 친다** — 엉뚱한 곳을 열지 않는다', () => {
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
    expect(one(P('어딘가', 0, 0), 'google').precision).toBe('name'); // 좌표 대신 이름으로 내려간다
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

describe('🔴 ⑦ 동의 문구는 **무엇이 어디로** 나가는지 말한다 (PRIVACY)', () => {
  it('좌표를 열 때는 그 좌표를 문구에 보여준다 — 무엇이 나가는지 숨기지 않는다', () => {
    const text = externalMapConsentText(one(P('제주', 33.4996, 126.5312), 'google'));
    expect(text).toContain('33.4996,126.5312');
    expect(text).toContain('구글');
  });

  it('🔴 **받는 회사 이름**이 문구에 든다 — 구글 동의가 얀덱스 동의가 되지 않게', () => {
    expect(externalMapConsentText(one(P('제주', 33.5, 126.5), 'yandex'))).toContain('얀덱스');
    expect(externalMapConsentText(one(P('제주', 33.5, 126.5), 'kakao'))).toContain('카카오');
    expect(externalMapConsentText(one(P('제주', 33.5, 126.5), 'naver'))).toContain('네이버');
  });

  it('얀덱스 문구에 구글이 섞이지 않는다(복사한 문장이 남지 않게)', () => {
    expect(externalMapConsentText(one(P('제주', 33.5, 126.5), 'yandex'))).not.toContain('구글');
  });

  it('이름으로 갈 때는 **이름이** 나간다고 말한다(좌표라고 하지 않는다)', () => {
    const text = externalMapConsentText(one(P('김포공항'), 'google'));
    expect(text).toContain('김포공항');
    expect(text).not.toContain('좌표(');
  });

  it('이 앱이 평소엔 위치를 안 보낸다는 사실을 함께 말한다(왜 묻는지가 드러나게)', () => {
    expect(externalMapConsentText(one(P('제주', 33.5, 126.5), 'google'))).toContain(
      '평소 위치를 밖으로 보내지 않',
    );
  });

  it('처음 한 번뿐임을 밝힌다 — 매번 물을 거라는 오해를 만들지 않는다', () => {
    expect(externalMapConsentText(one(P('제주', 33.5, 126.5), 'google'))).toContain('처음 한 번');
  });

  it('문구가 `sends`에서 파생된다 — 손으로 다시 적지 않는다(SSOT)', () => {
    const t = one(P('제주', 33.5, 126.5), 'google');
    expect(externalMapConsentText(t)).toContain(t.sends);
  });
});
