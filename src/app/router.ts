// app/router.ts — 최소 history 라우터 (docs/DEPLOYMENT.md)
// GitHub Pages 하위경로(base) 인식 + 없는 경로는 안전 폴백(빈 화면 금지).
// 파라미터 라우트: /trip/<id> → 'trip-detail' (2번째 세그먼트가 id).

export type Route = 'home' | 'trips' | 'trip-detail' | 'map' | 'settings';
type RenderFn = (route: Route, param?: string) => void;

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

export function createRouter(render: RenderFn): {
  navigate: (route: Route, param?: string) => void;
  start: () => void;
} {
  function apply() {
    render(pathToRoute(window.location.pathname), pathToParam(window.location.pathname));
  }
  function navigate(route: Route, param?: string) {
    let target: string;
    if (route === 'home') target = BASE;
    else if (route === 'trip-detail') target = `${BASE}trip/${param ?? ''}`;
    else target = `${BASE}${route}`;
    window.history.pushState({}, '', target);
    apply();
  }
  function start() {
    window.addEventListener('popstate', apply);
    apply();
  }
  return { navigate, start };
}
