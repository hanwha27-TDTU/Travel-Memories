// app/router.ts — 최소 history 라우터 (docs/DEPLOYMENT.md)
// GitHub Pages 하위경로(base) 인식 + 없는 경로는 안전 폴백(빈 화면 금지).
// 파라미터 라우트: /trip/<id> → 'trip-detail' (2번째 세그먼트가 id).

export type Route = 'home' | 'trips' | 'trip-detail' | 'map' | 'settings';
export interface TripNavigationTarget {
  momentId?: string;
  mediaId?: string;
}
type RenderFn = (route: Route, param?: string, target?: TripNavigationTarget) => void;

const BASE = import.meta.env.BASE_URL; // vite가 '/Travel-Memories/'로 주입

const ROUTES: Record<string, Route> = {
  '': 'home',
  'trips': 'trips',
  'trip': 'trip-detail',
  'map': 'map',
  'settings': 'settings',
};

function relSegments(pathname: string, base: string): string[] {
  const rel = pathname.startsWith(base) ? pathname.slice(base.length) : pathname.replace(/^\//, '');
  return rel.replace(/\/+$/, '').split('/');
}

/** 경로 → 라우트. base 주입 가능한 순수함수(tests/unit에서 직접 테스트 — 미러 금지). */
export function pathToRoute(pathname: string, base: string = BASE): Route {
  const key = relSegments(pathname, base)[0] ?? '';
  return ROUTES[key] ?? 'home'; // 알 수 없는 경로 → 안전 폴백
}

/** 경로의 파라미터(2번째 세그먼트). 예: /trip/abc → 'abc'. 없으면 undefined. */
export function pathToParam(pathname: string, base: string = BASE): string | undefined {
  const seg = relSegments(pathname, base)[1];
  return seg && seg.length > 0 ? seg : undefined;
}

/** Empty or repeated query values are ambiguous, so the detail screen receives no target. */
export function searchToTripTarget(search: string): TripNavigationTarget | undefined {
  const params = new URLSearchParams(search);
  const one = (key: string): string | undefined => {
    const values = params.getAll(key).filter(Boolean);
    return values.length === 1 ? values[0] : undefined;
  };
  const momentId = one('moment');
  const mediaId = one('media');
  return momentId || mediaId ? { ...(momentId ? { momentId } : {}), ...(mediaId ? { mediaId } : {}) } : undefined;
}

export function createRouter(render: RenderFn): {
  navigate: (route: Route, param?: string, target?: TripNavigationTarget) => void;
  start: () => void;
} {
  function apply() {
    render(pathToRoute(window.location.pathname), pathToParam(window.location.pathname), searchToTripTarget(window.location.search));
    // 화면 이동 신호 — 자동 갱신(appUpdate)이 「입력을 떠난 안전한 순간」으로 이 이벤트를 듣는다.
    // 🔴 `hashchange`가 아니다: 이 라우터는 History API(pushState/popstate)라 hash가 안 바뀐다.
    // 예전엔 appUpdate가 hashchange를 기다렸고 그건 **한 번도 발화하지 않았다**(H-4).
    window.dispatchEvent(new Event('bj:route'));
  }
  function navigate(route: Route, param?: string, target?: TripNavigationTarget) {
    let path: string;
    if (route === 'home') path = BASE;
    else if (route === 'trip-detail') {
      const query = new URLSearchParams();
      if (target?.momentId) query.set('moment', target.momentId);
      if (target?.mediaId) query.set('media', target.mediaId);
      path = `${BASE}trip/${param ?? ''}${query.size ? `?${query}` : ''}`;
    } else path = `${BASE}${route}`;
    window.history.pushState({}, '', path);
    apply();
  }
  function start() {
    window.addEventListener('popstate', apply);
    apply();
  }
  return { navigate, start };
}
