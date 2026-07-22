// app/router.ts — 최소 history 라우터 (docs/DEPLOYMENT.md)
// GitHub Pages 하위경로(base) 인식 + 없는 경로는 안전 폴백(빈 화면 금지).

export type Route = 'home' | 'trips' | 'map' | 'settings';
type RenderFn = (route: Route) => void;

const BASE = import.meta.env.BASE_URL; // vite가 '/Travel-Memories/'로 주입

const ROUTES: Record<string, Route> = {
  '': 'home',
  'trips': 'trips',
  'map': 'map',
  'settings': 'settings',
};

function pathToRoute(pathname: string): Route {
  const rel = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname.replace(/^\//, '');
  const key = rel.replace(/\/+$/, '').split('/')[0] ?? '';
  return ROUTES[key] ?? 'home'; // 알 수 없는 경로 → 안전 폴백
}

export function createRouter(render: RenderFn): { navigate: (r: Route) => void; start: () => void } {
  function apply() {
    render(pathToRoute(window.location.pathname));
  }
  function navigate(route: Route) {
    const target = route === 'home' ? BASE : `${BASE}${route}`;
    window.history.pushState({}, '', target);
    apply();
  }
  function start() {
    window.addEventListener('popstate', apply);
    apply();
  }
  return { navigate, start };
}
