// tests/unit/router.test.ts — 운영 순수함수 직접 테스트 (TEST_PLAN: 미러 테스트 금지)
import { describe, it, expect } from 'vitest';
import { pathToRoute, pathToParam, searchToTripTarget } from '../../src/app/router';

const BASE = '/Travel-Memories/'; // GitHub Pages 하위경로 (vite.config.ts BASE)

describe('pathToRoute — GitHub Pages 하위경로(base) 인식', () => {
  it('base 루트 → home', () => {
    expect(pathToRoute('/Travel-Memories/', BASE)).toBe('home');
  });
  it('알려진 라우트를 해석한다', () => {
    expect(pathToRoute('/Travel-Memories/trips', BASE)).toBe('trips');
    expect(pathToRoute('/Travel-Memories/map', BASE)).toBe('map');
    expect(pathToRoute('/Travel-Memories/settings', BASE)).toBe('settings');
  });
  it('후행 슬래시·하위 세그먼트를 허용한다', () => {
    expect(pathToRoute('/Travel-Memories/trips/', BASE)).toBe('trips');
    expect(pathToRoute('/Travel-Memories/trips/abc-123', BASE)).toBe('trips');
  });
  it('알 수 없는 경로는 home으로 안전 폴백(빈 화면 금지)', () => {
    expect(pathToRoute('/Travel-Memories/nope', BASE)).toBe('home');
    expect(pathToRoute('/Travel-Memories/nope/deep/path', BASE)).toBe('home');
  });
  it('base 밖 경로(트레일링 슬래시 없는 진입 등)도 폴백한다', () => {
    expect(pathToRoute('/Travel-Memories', BASE)).toBe('home');
    expect(pathToRoute('/', BASE)).toBe('home');
    expect(pathToRoute('/other-app/trips', BASE)).toBe('home');
  });
  it("base='/'(로컬 프리뷰 등)에서도 동작한다", () => {
    expect(pathToRoute('/trips', '/')).toBe('trips');
    expect(pathToRoute('/', '/')).toBe('home');
  });
  it('파라미터 라우트 /trip/<id> → trip-detail', () => {
    expect(pathToRoute('/Travel-Memories/trip/abc-123', BASE)).toBe('trip-detail');
    expect(pathToParam('/Travel-Memories/trip/abc-123', BASE)).toBe('abc-123');
  });
});

describe('pathToParam — 2번째 세그먼트(id) 추출', () => {
  it('id가 있으면 반환', () => {
    expect(pathToParam('/Travel-Memories/trip/xyz', BASE)).toBe('xyz');
  });
  it('id가 없으면 undefined', () => {
    expect(pathToParam('/Travel-Memories/trip', BASE)).toBeUndefined();
    expect(pathToParam('/Travel-Memories/', BASE)).toBeUndefined();
    expect(pathToParam('/Travel-Memories/trip/', BASE)).toBeUndefined();
  });
});

describe('searchToTripTarget — URL 선택 대상 파싱', () => {
  it('순간과 사진을 함께 읽는다', () => {
    expect(searchToTripTarget('?moment=m-1&media=photo-1')).toEqual({ momentId: 'm-1', mediaId: 'photo-1' });
  });
  it('장소 연결 복구는 순간을 특정했을 때만 장소 입력 열기로 해석한다', () => {
    expect(searchToTripTarget('?moment=m-1&place=edit')).toEqual({ momentId: 'm-1', openPlaceEditor: true });
    expect(searchToTripTarget('?media=photo-1&place=edit')).toEqual({ mediaId: 'photo-1' });
  });
  it('사진만 온 대상은 상세 화면이 안전하게 무시할 수 있도록 그대로 둔다', () => {
    expect(searchToTripTarget('?media=photo-1')).toEqual({ mediaId: 'photo-1' });
  });
  it('빈 값·반복 값은 모호하므로 버린다', () => {
    expect(searchToTripTarget('?moment=&media=')).toBeUndefined();
    expect(searchToTripTarget('?moment=m-1&moment=m-2')).toBeUndefined();
  });
});
