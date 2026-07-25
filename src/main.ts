// main.ts — 앱 부트스트랩 (Phase 0B 골격)
import './ui/styles/fonts.css';
import './ui/styles/tokens.css';
import './ui/styles/app.css';
import { createRouter, type Route } from './app/router';
import { renderHome } from './ui/screens/home';
import { renderTripDetail } from './ui/screens/tripDetail';
import { initTheme } from './ui/theme';
import { db } from './offline/db';
import { installErrorLog } from './app/errorLog';

// 런타임 오류를 앱이 스스로 모은다 — 개발자가 볼 수 없는 영역에 낸 창(진단 도구).
// 가장 먼저 설치해야 이후 초기화에서 나는 오류도 잡힌다.
installErrorLog();

// 저장된 테마·계절 선호를 문서에 반영(첫 페인트 전).
initTheme();

const appEl = document.getElementById('app');
if (!appEl) throw new Error('#app 마운트 지점을 찾을 수 없습니다.');
const root: HTMLElement = appEl;

// 로컬 DB 오픈(오프라인 우선). 실패해도 앱은 뜬다.
db().open().catch((e) => console.warn('IndexedDB 열기 실패:', e));

const router: ReturnType<typeof createRouter> = createRouter((route: Route, param?: string) => {
  switch (route) {
    case 'trip-detail':
      renderTripDetail(root, param ?? '', router.navigate);
      break;
    case 'home':
    default:
      renderHome(root, router.navigate);
      break;
  }
});
router.start();
