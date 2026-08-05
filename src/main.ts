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
import { installAutoSync } from './services/autoSync';
import { wireShellAuthReturn, currentUser } from './services/auth';
import { isConfigured } from './services/supabase/client';

// 런타임 오류를 앱이 스스로 모은다 — 개발자가 볼 수 없는 영역에 낸 창(진단 도구).
// 가장 먼저 설치해야 이후 초기화에서 나는 오류도 잡힌다.
installErrorLog();
// 사람이 [동기화]를 기억하지 않아도 되게 — 온라인 복귀·화면 복귀·주기 트리거를 건다.
// (사용자 제안 2026-07-26: "휴먼에러를 방지하기 위해서")
installAutoSync();

// 셸(ADR-0037): 구글 로그인이 시스템 브라우저에서 딥링크로 돌아오면 세션으로 교환.
// 크롬에서는 무행동 — 부트에서 한 번만 배선한다.
wireShellAuthReturn();

// 저장된 테마·계절 선호를 문서에 반영(첫 페인트 전).
initTheme();

// 서비스워커 — 앱 껍데기를 캐시해 재방문·오프라인을 빠르게 한다(규칙·위험은 public/sw.js 머리주석).
// 여행 중 데이터로 여는 앱이라 재방문에 같은 파일을 다시 받지 않는 것이 실제 이득이다.
//   · **첫 페인트 뒤에** 등록한다 — 등록이 초기 렌더와 대역폭을 다투지 않게.
//   · 개발 서버에서는 등록하지 않는다 — 캐시가 HMR을 가려 "고쳤는데 안 바뀐다"를 만든다.
//   · 실패해도 조용히 넘어간다: 캐시는 **속도**일 뿐이고, 앱은 이것 없이도 완전히 동작한다.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const base = import.meta.env.BASE_URL; // vite.config.ts의 BASE가 SSOT
    void navigator.serviceWorker
      .register(`${base}sw.js`, { scope: base })
      .catch((e) => console.warn('서비스워커 등록 실패(앱 동작에는 영향 없음):', e));
  });
}

// 자동 갱신 — 셸·설치형 PWA는 페이지를 다시 로드할 일이 없어 새 배포가 화면에 안 닿는다.
// 시작·복귀 때 배포의 version.json을 묻고 **안전할 때** 새로고침한다(services/appUpdate.ts).
if (import.meta.env.PROD) {
  void import('./services/appUpdate').then((m) => m.wireAutoUpdate());
  // 셸(APK) 자체가 바뀌면(아이콘·권한·서명·네이티브) 재설치가 필요하다 — 새 APK가 나왔음을
  // 앱 안에서 배너로 알린다(services/shellUpdate.ts). 크롬에서는 무행동.
  void import('./services/shellUpdate').then((m) => m.wireShellUpdate());
}

const appEl = document.getElementById('app');
if (!appEl) throw new Error('#app 마운트 지점을 찾을 수 없습니다.');
const root: HTMLElement = appEl;

// 로컬 DB 오픈(오프라인 우선). 실패해도 앱은 뜬다.
db().open().catch((e) => console.warn('IndexedDB 열기 실패:', e));

/**
 * 로그아웃(클라우드 모드) 중엔 딥링크(`/trip/<id>` 북마크·뒤로가기)로도 이 기기의 로컬 여행이
 * 안 보이게 한다 — 홈 화면 잠금(signedOutLockState, home.ts)과 **같은 경계**다. 홈만 가려도
 * 이 라우트가 그대로 열려 있으면 그 자체로 우회로가 된다.
 */
async function guardTripDetail(): Promise<boolean> {
  if (!isConfigured()) return true; // 진짜 로컬 전용 빌드엔 "다른 계정" 개념이 없다
  return (await currentUser()) !== null;
}

const router: ReturnType<typeof createRouter> = createRouter((route: Route, param?: string) => {
  switch (route) {
    case 'trip-detail':
      void guardTripDetail().then((allowed) => {
        if (allowed) renderTripDetail(root, param ?? '', router.navigate);
        else router.navigate('home');
      });
      break;
    case 'home':
    default:
      renderHome(root, router.navigate);
      break;
  }
});
router.start();
