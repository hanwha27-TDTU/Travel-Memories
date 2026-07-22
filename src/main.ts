// main.ts — 앱 부트스트랩 (Phase 0B 골격)
import './ui/styles/tokens.css';
import './ui/styles/app.css';
import { createRouter, type Route } from './app/router';
import { renderHome } from './ui/screens/home';
import { db } from './offline/db';

const appEl = document.getElementById('app');
if (!appEl) throw new Error('#app 마운트 지점을 찾을 수 없습니다.');
const root: HTMLElement = appEl;

// 로컬 DB 오픈(오프라인 우선). 실패해도 앱은 뜬다.
db().open().catch((e) => console.warn('IndexedDB 열기 실패:', e));

function render(route: Route): void {
  switch (route) {
    case 'home':
    default:
      renderHome(root);
      break;
  }
}

const router = createRouter(render);
router.start();
