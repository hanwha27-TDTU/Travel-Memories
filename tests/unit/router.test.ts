// tests/unit/router.test.ts — 운영 순수함수 직접 테스트 (TEST_PLAN: 미러 테스트 금지)
import { describe, it, expect } from 'vitest';
import { pathToRoute, pathToParam, routeToPath, searchToTripTarget, ROUTE_SEGMENTS, type Route } from '../../src/app/router';

const BASE = '/Travel-Memories/'; // GitHub Pages 하위경로 (vite.config.ts BASE)
const ALL_ROUTES = Object.keys(ROUTE_SEGMENTS) as Route[];

describe('pathToRoute — GitHub Pages 하위경로(base) 인식', () => {
  it('base 루트 → home', () => {
    expect(pathToRoute('/Travel-Memories/', BASE)).toBe('home');
  });
  it('후행 슬래시·하위 세그먼트를 허용한다', () => {
    expect(pathToRoute('/Travel-Memories/trip/', BASE)).toBe('trip-detail');
    expect(pathToRoute('/Travel-Memories/trip/abc-123', BASE)).toBe('trip-detail');
  });
  it('알 수 없는 경로는 home으로 안전 폴백(빈 화면 금지)', () => {
    expect(pathToRoute('/Travel-Memories/nope', BASE)).toBe('home');
    expect(pathToRoute('/Travel-Memories/nope/deep/path', BASE)).toBe('home');
  });
  it('base 밖 경로(트레일링 슬래시 없는 진입 등)도 폴백한다', () => {
    expect(pathToRoute('/Travel-Memories', BASE)).toBe('home');
    expect(pathToRoute('/', BASE)).toBe('home');
    expect(pathToRoute('/other-app/trip', BASE)).toBe('home');
  });
  it("base='/'(로컬 프리뷰 등)에서도 동작한다", () => {
    expect(pathToRoute('/trip/abc', '/')).toBe('trip-detail');
    expect(pathToRoute('/', '/')).toBe('home');
  });
  it('파라미터 라우트 /trip/<id> → trip-detail', () => {
    expect(pathToRoute('/Travel-Memories/trip/abc-123', BASE)).toBe('trip-detail');
    expect(pathToParam('/Travel-Memories/trip/abc-123', BASE)).toBe('abc-123');
  });

  // 🔴 T-031(M-0159) — 예전엔 `trips`·`map`·`settings`가 라우트로 **정의만** 되어 있었고,
  //    이 파일은 그것을 「알려진 라우트」로 **정상 케이스에 못박고 있었다.** 파싱은 맞았지만
  //    그려지는 것은 홈이었고 주소창만 그 라우트를 가리켰다 — 유닛이 「그래서 무엇이
  //    그려지는가」를 안 봐서 영원히 초록이었다(§11 ②: 전제가 바뀌면 케이스를 먼저 뒤집는다).
  it('화면이 없는 옛 라우트 셋은 이제 알 수 없는 경로로 폴백한다', () => {
    for (const dead of ['trips', 'map', 'settings']) {
      expect(pathToRoute(`/Travel-Memories/${dead}`, BASE)).toBe('home');
    }
  });
});

describe('routeToPath ↔ pathToRoute — 정의된 라우트 전수 왕복', () => {
  // 손으로 고른 몇 개가 아니라 **정의된 전부**를 돈다. 새 라우트가 생기면 이 검사가 자동으로
  // 그것까지 잰다(§7 — 다음 형제가 따라오는가).
  it('모든 라우트가 자기 경로에서 자기로 되돌아온다', () => {
    expect(ALL_ROUTES.length).toBeGreaterThan(0); // 모집단 0은 통과가 아니다(§4)
    for (const route of ALL_ROUTES) {
      const param = route === 'trip-detail' ? 'abc-123' : undefined;
      const path = routeToPath(route, param, undefined, BASE);
      expect(pathToRoute(path, BASE)).toBe(route);
      if (param) expect(pathToParam(path, BASE)).toBe(param);
    }
  });
  it('세그먼트가 서로 겹치지 않는다', () => {
    const segments = ALL_ROUTES.map((r) => ROUTE_SEGMENTS[r]);
    expect(new Set(segments).size).toBe(segments.length);
  });
  it('여행 상세는 선택 대상을 질의문자열로 싣고 되읽는다', () => {
    const path = routeToPath('trip-detail', 'trip-1', { momentId: 'm-1', openPlaceEditor: true }, BASE);
    expect(path).toBe('/Travel-Memories/trip/trip-1?moment=m-1&place=edit');
    expect(searchToTripTarget(path.slice(path.indexOf('?')))).toEqual({ momentId: 'm-1', openPlaceEditor: true });
  });
  it('홈은 base 자체다(빈 세그먼트)', () => {
    expect(routeToPath('home', undefined, undefined, BASE)).toBe(BASE);
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
