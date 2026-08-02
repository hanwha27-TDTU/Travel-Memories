// services/shellUpdate.ts — **새 APK(셸)가 나오면 앱 안에서 알린다** (플레이북 §5-2).
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 (2026-08-02)
// ─────────────────────────────────────────────────────────────────────────────
// 웹 내용은 재설치 없이 자동 갱신된다(appUpdate.ts). 그러나 **셸 자체**(아이콘·권한·서명·
// 네이티브 코드)가 바뀌면 새 APK를 받아 설치해야 하는데, 예전엔 사용자가 그 사실을 알 길이
// 없어 가이드에서 **수동으로** 받아야 했다. 서명 사고(2026-08-02) 때 이 불편이 드러났다.
// 이제 셸이 스스로 최신 APK 버전을 확인해 하단 배너로 알리고, 한 번 탭하면 받게 한다.
//
// 🔴 원리적 한계(정직하게): 사이드로드 앱은 안드로이드 보안상 **완전 무인 자기설치가 불가**하다.
//    받은 뒤 「설치」 확인 1탭은 어떤 앱도 못 없앤다. 이 배너가 없애는 것은 *"새 앱이 나온 걸
//    모른다"*까지다.
//
// 🔴 함정 D(플레이북): 릴리스 '자산'(releases/download/…)은 302+CORS 없음이라 fetch가 조용히
//    막힌다 → api.github.com의 릴리스 '설명'에 심은 shell-version 마커를 읽는다(apk.ts).
// 🔴 함정 E(플레이북): 「닫기」를 저장하지 않는다(세션 한정). 저장하면 설치를 미룬 사용자가
//    **영영** 안내를 못 받는다 — 배너는 설치 전까지 열 때마다 다시 뜨고, 설치되면 버전이
//    같아져 저절로 사라진다.
// 🔴 크롬·옛 APK(App 플러그인 없음)에서는 **무행동** — 웹 경로에 손대지 않는다(ADR-0036 규율).

import { shellPlugin } from './capacitorShell';
import { APK_LATEST_URL, APK_RELEASE_API, parseShellBuild } from '../app/apk';

/** 셸 App 플러그인의 최소 모양 — 여기서는 현재 build(versionCode)만 읽는다. */
interface AppInfoPlugin {
  getInfo(): Promise<{ build?: string | number }>;
}

/** 확인 사이 최소 간격(복귀 연타가 API를 두드리지 않게). 무인증 GitHub API는 시간당 60회. */
const CHECK_MIN_MS = 60_000;
const BANNER_ID = 'shell-update-banner';

let dismissedBuild: number | null = null; // 🔴 세션 한정 — 저장 금지(함정 E)
let lastCheckAt: number | null = null;

/** 지금 설치된 셸의 versionCode. 셸이 아니면(크롬) null. */
async function currentBuild(): Promise<number | null> {
  const app = shellPlugin<AppInfoPlugin>('App');
  if (!app) return null;
  try {
    const info = await app.getInfo();
    const n = Number(info.build);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** 릴리스 설명의 최신 셸 versionCode. 못 읽으면 null(오프라인·마커 없음·차단). */
async function remoteBuild(): Promise<number | null> {
  try {
    const res = await fetch(APK_RELEASE_API, {
      cache: 'no-store',
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { body?: unknown };
    return parseShellBuild(typeof body.body === 'string' ? body.body : '');
  } catch {
    return null;
  }
}

/** 배너를 그린다(이미 있으면 다시 만들지 않는다). [업데이트]=외부 다운로드, [✕]=세션 닫기. */
function showBanner(build: number): void {
  if (document.getElementById(BANNER_ID)) return;
  const bar = document.createElement('div');
  bar.id = BANNER_ID;
  bar.className = 'shell-update-banner';
  bar.setAttribute('role', 'status');

  const msg = document.createElement('span');
  msg.className = 'shell-update-msg';
  msg.textContent = '새 앱 버전이 있어요';

  const dl = document.createElement('a');
  dl.className = 'shell-update-go';
  dl.textContent = '업데이트';
  dl.href = APK_LATEST_URL; // 셸에서 github.com은 allowNavigation 밖 → Capacitor가 외부로 연다
  dl.target = '_blank';
  dl.rel = 'noopener';

  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'shell-update-x';
  x.setAttribute('aria-label', '나중에');
  x.textContent = '✕';
  x.addEventListener('click', () => {
    dismissedBuild = build; // 세션에만 — 다음 실행 땐 다시 뜬다(함정 E)
    bar.remove();
  });

  bar.append(msg, dl, x);
  document.body.appendChild(bar);
}

/** 한 번 확인해 필요하면 배너를 띄운다. 셸에서만 동작. */
export async function checkShellUpdate(): Promise<void> {
  const cur = await currentBuild();
  if (cur === null) return; // 크롬·옛 APK — 무행동
  const now = Date.now();
  if (lastCheckAt !== null && now - lastCheckAt < CHECK_MIN_MS) return;
  lastCheckAt = now;
  const remote = await remoteBuild();
  if (remote === null || remote <= cur || dismissedBuild === remote) return;
  showBanner(remote);
}

/** main.ts에서 1회 배선 — 시작 + 복귀(visible) 때 확인. 크롬에서는 조용히 비켜선다. */
export function wireShellUpdate(): void {
  if (!shellPlugin('App')) return; // 셸이 아니면 아무것도 하지 않는다
  void checkShellUpdate();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkShellUpdate();
  });
}
