// app/router.ts — 최소 history 라우터 (docs/DEPLOYMENT.md)
// GitHub Pages 하위경로(base) 인식 + 없는 경로는 안전 폴백(빈 화면 금지).
// 파라미터 라우트: /trip/<id> → 'trip-detail' (2번째 세그먼트가 id).
//
// 🔴 **라우트는 「그려지는 화면」과 같은 수여야 한다**(2026-08-14 · T-031 · M-0161).
//    예전엔 `trips`·`map`·`settings` 셋이 여기 **정의만 되어** 있었다. 아무도 그 라우트로
//    이동하지 않았고(`navigate(...)` 호출 0건), URL로 직접 들어가면 `main.ts`의 switch가
//    `default`로 받아 **홈을 그리면서 주소창은 `/map`으로 남았다.** 유닛은 통과했다 —
//    파싱만 재고 「그래서 무엇이 그려지는가」를 안 봤기 때문이다(M-0158과 같은 사각지대:
//    진입점은 유닛이 못 부른다).
//
//    셋을 **지웠다.** 화면이 없었기 때문이다 — 여행 목록은 홈이 그리고, 지도는 여행 상세
//    안에서 열리며, 설정에 해당하는 것은 홈에서 오버레이로 여는 데이터 관리·진단이다.
//    그 URL들은 이제 「알 수 없는 경로」라 기존 폴백 규칙(→ 홈)을 그대로 탄다.
//
//    **다시 늘릴 때의 계약**: 아래 `ROUTE_SEGMENTS`에 한 줄을 더하면 `Route` 유니온이 커지고,
//    `main.ts`의 switch가 그 라우트를 다루지 않으면 **컴파일이 안 된다**(exhaustive `never` 가드).
//    산문이 아니라 타입이 지킨다(§7 2층). 되돌아감은 `check-screen-lifecycle`이 막는다(3층).

/**
 * 라우트 ↔ URL 첫 세그먼트의 **단일 진실원**. 경로 해석(`pathToRoute`)과 경로 조립(`routeToPath`)이
 * 둘 다 여기서 파생되므로 둘이 갈라질 수 없다(§17 — 모순을 검사하는 것보다 불가능하게 만드는 것이 낫다).
 */
export const ROUTE_SEGMENTS = {
  home: '',
  'trip-detail': 'trip',
} as const;

export type Route = keyof typeof ROUTE_SEGMENTS;

export interface TripNavigationTarget {
  momentId?: string;
  mediaId?: string;
  /** 해당 순간의 장소 입력을 바로 열어, 대장 장소를 명시적으로 다시 고르게 한다. */
  openPlaceEditor?: boolean;
}
type RenderFn = (route: Route, param?: string, target?: TripNavigationTarget) => void;

const BASE = import.meta.env.BASE_URL; // vite가 '/Travel-Memories/'로 주입

/** 세그먼트 → 라우트. 위 표를 뒤집어 **파생**한다 — 손으로 두 번 적으면 갈라진다(§2). */
const ROUTES: Record<string, Route> = Object.fromEntries(
  (Object.keys(ROUTE_SEGMENTS) as Route[]).map((route) => [ROUTE_SEGMENTS[route], route]),
);

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

/**
 * 라우트 → 경로. `pathToRoute`와 **같은 표**에서 파생하므로 둘이 갈라질 수 없다.
 * 순수 함수라 유닛이 **정의된 라우트 전부를** 왕복시킬 수 있다(§10 ③ — 화면 배선은
 * `main.ts`에 있어 유닛이 못 부르지만, 주소 조립은 여기서 잰다).
 *
 * 🔴 `param`을 쓰는 라우트는 지금 `trip-detail` 하나뿐이라 분기가 하나다. 두 번째가 생기면
 *    이 분기를 데이터로 올려야 한다 — 그때까지 없는 일반화를 미리 만들지 않는다.
 */
export function routeToPath(
  route: Route,
  param?: string,
  target?: TripNavigationTarget,
  base: string = BASE,
): string {
  const segment = ROUTE_SEGMENTS[route];
  if (route !== 'trip-detail') return `${base}${segment}`;
  const query = new URLSearchParams();
  if (target?.momentId) query.set('moment', target.momentId);
  if (target?.mediaId) query.set('media', target.mediaId);
  if (target?.openPlaceEditor && target.momentId) query.set('place', 'edit');
  return `${base}${segment}/${param ?? ''}${query.size ? `?${query}` : ''}`;
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
  // place=edit은 순간 하나를 특정했을 때만 의미가 있다. 그렇지 않으면 URL이 모호하다.
  const openPlaceEditor = momentId !== undefined && one('place') === 'edit';
  return momentId || mediaId
    ? { ...(momentId ? { momentId } : {}), ...(mediaId ? { mediaId } : {}), ...(openPlaceEditor ? { openPlaceEditor: true } : {}) }
    : undefined;
}

export function createRouter(render: RenderFn): {
  navigate: (route: Route, param?: string, target?: TripNavigationTarget) => void;
  start: () => void;
} {
  function apply() {
    render(pathToRoute(window.location.pathname), pathToParam(window.location.pathname), searchToTripTarget(window.location.search));
    // 화면 이동 신호 — 자동 갱신(appUpdate)이 입력 이력만 새 화면 기준으로 초기화한다.
    // 🔴 `hashchange`가 아니다: 이 라우터는 History API(pushState/popstate)라 hash가 안 바뀐다.
    // 예전엔 appUpdate가 hashchange를 기다렸고 그건 **한 번도 발화하지 않았다**(H-4).
    window.dispatchEvent(new Event('bj:route'));
  }
  function navigate(route: Route, param?: string, target?: TripNavigationTarget) {
    window.history.pushState({}, '', routeToPath(route, param, target));
    apply();
  }
  function start() {
    window.addEventListener('popstate', apply);
    apply();
  }
  return { navigate, start };
}
