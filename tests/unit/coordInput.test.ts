import { describe, it, expect } from 'vitest';
import {
  coordInputLabel,
  isUsableCoord,
  isRealCoord,
  orderPair,
  parseCoordinateInput,
  parseDms,
  swapCoord,
} from '../../src/domain/place/coordInput';
import { externalMapTargets } from '../../src/domain/place/externalMap';

// 대학로(혜화동로터리) — 원래 신고 사례의 좌표.
const LAT = 37.587;
const LNG = 127.0016;

describe('isUsableCoord', () => {
  it('지구 위의 좌표만 받는다', () => {
    expect(isUsableCoord(37.587, 127.0016)).toBe(true);
    expect(isUsableCoord(-33.86, 151.21)).toBe(true); // 시드니(남반구)
    expect(isUsableCoord(91, 127)).toBe(false); // 위도 초과
    expect(isUsableCoord(37, 181)).toBe(false); // 경도 초과
    expect(isUsableCoord(Number.NaN, 127)).toBe(false);
  });
  it('0,0은 거른다 — 파싱 실패의 흔적이지 사용자의 기억이 아니다', () => {
    expect(isUsableCoord(0, 0)).toBe(false);
  });
});

// 🔴 H-3: 「진짜 좌표인가」의 단일 판정. 예전엔 일곱~여덟 곳에 손으로 있어 갈라졌다(M-0060).
// 특히 NaN·null·undefined를 막는 곳과 안 막는 곳이 섞여 `NaN, NaN`이 화면에 통과했다.
describe('isRealCoord — 좌표 판정 SSOT', () => {
  it('지구 위의 유효 좌표는 true', () => {
    expect(isRealCoord(37.587, 127.0016)).toBe(true);
    expect(isRealCoord(-33.86, 151.21)).toBe(true);
  });
  it('🔴 NaN·null·undefined를 한꺼번에 거른다(갈라짐의 원인이었다)', () => {
    expect(isRealCoord(Number.NaN, 127)).toBe(false);
    expect(isRealCoord(37, Number.NaN)).toBe(false);
    expect(isRealCoord(null, 127)).toBe(false);
    expect(isRealCoord(37, null)).toBe(false);
    expect(isRealCoord(undefined, undefined)).toBe(false);
  });
  it('범위 밖·0,0을 거른다', () => {
    expect(isRealCoord(91, 127)).toBe(false);
    expect(isRealCoord(37, 181)).toBe(false);
    expect(isRealCoord(0, 0)).toBe(false);
  });
  it('한쪽만 0인 진짜 좌표는 통과한다(막는 것은 둘 다 0일 때만)', () => {
    expect(isRealCoord(0, 127.0016)).toBe(true);
    expect(isRealCoord(37.587, 0)).toBe(true);
  });
  it('문자열 등 숫자가 아닌 것은 false(unknown 경계)', () => {
    expect(isRealCoord('37' as unknown, '127' as unknown)).toBe(false);
  });
});

describe('orderPair — 위·경도 순서', () => {
  it('🔴 한국 좌표는 어느 순서로 넣어도 옳게 읽힌다(경도가 90을 넘는다)', () => {
    expect(orderPair(37.587, 127.0016)).toMatchObject({ lat: 37.587, lng: 127.0016, ambiguous: false });
    expect(orderPair(127.0016, 37.587)).toMatchObject({ lat: 37.587, lng: 127.0016, ambiguous: false });
  });
  it('🔴 둘 다 ±90 안이면 **모호하다고 밝힌다** — 조용히 추측하지 않는다(§8)', () => {
    const rome = orderPair(41.9, 12.5); // 로마 — 12.5도 위도일 수 있다
    expect(rome).toMatchObject({ lat: 41.9, lng: 12.5, ambiguous: true });
  });
  it('어느 순서로도 말이 안 되면 null', () => {
    expect(orderPair(200, 300)).toBeNull();
    expect(orderPair(0, 0)).toBeNull();
  });
  it('뒤바꾸면 더 이상 모호하지 않다(사용자가 정했으므로)', () => {
    const swapped = swapCoord(orderPair(41.9, 12.5)!);
    expect(swapped).toMatchObject({ lat: 12.5, lng: 41.9, ambiguous: false });
  });
});

describe('parseDms — 도·분·초', () => {
  it('N/S/E/W가 순서를 확정한다 — 모호하지 않다', () => {
    const c = parseDms('37°35\'13.2"N 127°00\'05.8"E');
    expect(c).not.toBeNull();
    expect(c!.lat).toBeCloseTo(37.587, 3);
    expect(c!.lng).toBeCloseTo(127.0016, 3);
    expect(c!.ambiguous).toBe(false);
  });
  it('경도가 먼저 와도 글자가 순서를 말해준다', () => {
    const c = parseDms('127°00\'05.8"E 37°35\'13.2"N');
    expect(c!.lat).toBeCloseTo(37.587, 3);
    expect(c!.lng).toBeCloseTo(127.0016, 3);
  });
  it('남반구·서반구는 음수가 된다', () => {
    const c = parseDms('33°51\'54.0"S 151°12\'36.0"E');
    expect(c!.lat).toBeCloseTo(-33.865, 3);
    expect(c!.lng).toBeCloseTo(151.21, 2);
  });
  it('둘 다 위도이면 좌표가 아니다', () => {
    expect(parseDms('37°N 38°N')).toBeNull();
  });
  it('분·초가 60을 넘으면 거른다(오타 방어)', () => {
    expect(parseDms('37°75\'00"N 127°00\'00"E')).toBeNull();
  });
});

describe('parseCoordinateInput — 평문', () => {
  it('쉼표·공백·슬래시 구분자를 모두 읽는다', () => {
    for (const s of ['37.587, 127.0016', '37.587,127.0016', '37.587 127.0016', '37.587/127.0016']) {
      const c = parseCoordinateInput(s);
      expect(c, s).not.toBeNull();
      expect(c!.lat).toBeCloseTo(LAT, 4);
      expect(c!.lng).toBeCloseTo(LNG, 4);
    }
  });
  it('앞뒤 공백을 무시한다', () => {
    expect(parseCoordinateInput('  37.587, 127.0016  ')!.lat).toBeCloseTo(LAT, 4);
  });
  it('🔴 평범한 장소 이름은 **반드시 null**이다 — 이름 검색을 좌표로 오인하면 기능이 사라진다', () => {
    for (const s of ['대학로', 'Roma Termini', '스타벅스 종로점', '경복궁', '제주 협재해변']) {
      expect(parseCoordinateInput(s), s).toBeNull();
    }
  });
  it('🔴 글자가 섞인 입력은 이름으로 본다(사용자가 타이핑 중일 수 있다)', () => {
    expect(parseCoordinateInput('스타벅스 37.5, 127.0')).toBeNull();
  });
  it('숫자 하나만으로는 좌표가 아니다', () => {
    expect(parseCoordinateInput('37.587')).toBeNull();
  });
  it('빈 입력은 null', () => {
    expect(parseCoordinateInput('')).toBeNull();
    expect(parseCoordinateInput('   ')).toBeNull();
  });
});

describe('parseCoordinateInput — 지도 링크', () => {
  it('구글: /maps/@위도,경도', () => {
    const c = parseCoordinateInput('https://www.google.com/maps/@37.587,127.0016,17z');
    expect(c).toMatchObject({ source: 'google', ambiguous: false });
    expect(c!.lat).toBeCloseTo(LAT, 4);
  });
  it('구글: !3d!4d(핀 지점)를 화면중심(@)보다 우선한다', () => {
    const c = parseCoordinateInput(
      'https://www.google.com/maps/place/X/@37.5000,127.0000,17z/data=!3m1!4b1!4m5!3d37.587!4d127.0016',
    );
    expect(c!.lat).toBeCloseTo(37.587, 4);
    expect(c!.lng).toBeCloseTo(127.0016, 4);
  });
  it('네이버: lat·lng 파라미터', () => {
    const c = parseCoordinateInput('https://map.naver.com/p?title=%EB%8C%80%ED%95%99%EB%A1%9C&lat=37.587&lng=127.0016');
    expect(c).toMatchObject({ source: 'naver', ambiguous: false });
    expect(c!.lng).toBeCloseTo(LNG, 4);
  });
  it('카카오: /link/map/이름,위도,경도', () => {
    const c = parseCoordinateInput('https://map.kakao.com/link/map/%EB%8C%80%ED%95%99%EB%A1%9C,37.587,127.0016');
    expect(c).toMatchObject({ source: 'kakao', ambiguous: false });
    expect(c!.lat).toBeCloseTo(LAT, 4);
  });
  it('🔴 얀덱스만 경도,위도 순서다 — 뒤집으면 다른 나라가 나온다', () => {
    const c = parseCoordinateInput('https://yandex.com/maps/?ll=127.0016,37.587&z=17');
    expect(c).toMatchObject({ source: 'yandex' });
    expect(c!.lat).toBeCloseTo(LAT, 4); // 위도가 37이어야 한다(127이면 뒤집힌 것)
    expect(c!.lng).toBeCloseTo(LNG, 4);
  });
  it('OpenStreetMap: #map=zoom/위도/경도', () => {
    const c = parseCoordinateInput('https://www.openstreetmap.org/#map=17/37.587/127.0016');
    expect(c).toMatchObject({ source: 'osm' });
    expect(c!.lat).toBeCloseTo(LAT, 4);
  });
  it('모르는 지도 링크도 숫자쌍이 있으면 읽되 출처는 일반 링크로 둔다', () => {
    const c = parseCoordinateInput('https://some-map.example/view?p=37.587,127.0016');
    expect(c).toMatchObject({ source: 'url' });
    expect(c!.lat).toBeCloseTo(LAT, 4);
  });
});

describe('🔴 왕복 — 앱이 내보낸 링크를 앱이 다시 읽는다', () => {
  // 「다른 지도에서 열기」로 나갔다가 그 URL을 그대로 붙여넣는 흐름. 나가는 길과 돌아오는
  // 길이 어긋나면 사용자는 자기가 방금 연 그 지점을 못 되찾는다.
  const targets = externalMapTargets({ name: '대학로', lat: LAT, lng: LNG });
  it('네 제공자 URL을 전부 되읽는다', () => {
    expect(targets.length).toBeGreaterThanOrEqual(4);
    for (const t of targets) {
      const back = parseCoordinateInput(t.url);
      expect(back, `${t.label}: ${t.url}`).not.toBeNull();
      expect(back!.lat, t.label).toBeCloseTo(LAT, 4);
      expect(back!.lng, t.label).toBeCloseTo(LNG, 4);
      expect(back!.ambiguous, t.label).toBe(false);
    }
  });
});

describe('coordInputLabel — 사용자에게 나가는 문장(§10 ③)', () => {
  it('출처와 값을 말한다', () => {
    const c = parseCoordinateInput('https://map.kakao.com/link/map/X,37.587,127.0016')!;
    expect(coordInputLabel(c)).toContain('카카오맵 링크');
    expect(coordInputLabel(c)).toContain('위도 37.58700');
    expect(coordInputLabel(c)).toContain('경도 127.00160');
  });
  it('🔴 모호했으면 그 사실을 화면에 적는다(조용히 추측하지 않는다)', () => {
    const rome = parseCoordinateInput('41.9, 12.5')!;
    expect(rome.ambiguous).toBe(true);
    expect(coordInputLabel(rome)).toContain('순서가 맞나요?');
  });
  it('확실하면 되묻지 않는다(정상은 조용하다 §8)', () => {
    const seoul = parseCoordinateInput('37.587, 127.0016')!;
    expect(coordInputLabel(seoul)).not.toContain('순서가 맞나요?');
  });
});
