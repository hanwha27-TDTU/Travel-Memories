// scripts/verify-editor-live.mjs — 사진 편집기 라이브 렌더 검증(선택 게이트, 브라우저 필요).
// dist를 /Travel-Memories/ 경로로 서빙하고 실제 Chromium으로 편집기 전체 흐름을 확인한다:
// 열기 → 값 표시 → 프리셋 → 슬라이더(픽셀 read-back) → 원본 비교 홀드 → 실행취소 →
// 브러시 표시 → Esc confirm → 배치 2장 → 저장 → 뷰어 탐색. 콘솔 에러 0까지 확인.
// 사용: npm run build && node scripts/verify-editor-live.mjs
//
// @live-covers: screens/home.ts, screens/tripDetail.ts, screens/mapView.ts, screens/dataManager.ts,
// @live-covers: screens/guide.ts, screens/mechChecks.ts, screens/designOverview.ts
// @live-covers: screens/placeRegistry.ts
// ↑ `check-live-coverage`가 읽는다. **여기 적은 화면은 이 스크립트가 실제로 연다** — 선언과
//   실제가 어긋나면 게이트는 못 잡는다(정직한 한계). 화면을 더 열면 여기도 늘려라.
// (Playwright는 devDependency가 아니므로 전역 설치본을 폴백으로 찾는다.)
import { createServer } from 'node:http';
import { launchLiveBrowser } from './live-browser-lib.mjs';
import { readFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// 기대값을 여기 손으로 적지 않는다 — 생성기와 **같은 SSOT**에서 읽어 화면과 대조한다.
// (숫자를 적어 두면 이 검사 자체가 다음 드리프트의 씨앗이 된다.)
import { collect as collectRegistry } from './gen-registry.mjs';
import { collect as collectConstitution } from './gen-constitution.mjs';
import { runSelfTest } from './gate-selftest-lib.mjs';
import { proveCheckCounts } from './live-browser-lib.mjs';

// 대조군(§4): 판정 기록기가 **실패를 실제로 세는가.** 안 세면 이 게이트는 무슨 일이 있어도 초록이다.
// 🔴 이 줄은 **템플릿 문자열 밖**이어야 한다 — 안에 넣으면 실행되지 않는 가짜 대조군이 된다(M-0155).
runSelfTest('verify-editor-live', () => proveCheckCounts());

let chromium;
for (const spec of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs']) {
  try { ({ chromium } = await import(spec)); break; } catch { /* 다음 후보 */ }
}
if (!chromium) {
  console.error('playwright를 찾을 수 없습니다 — npm i -D playwright 또는 전역 설치 후 재실행');
  process.exit(2);
}

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const BASE = '/Travel-Memories/';

/**
 * 🔴 **`dist`가 지금 소스보다 낡았으면 멈춘다.**
 *
 * 2026-07-27에 이 구멍을 밟았다: 알려진 실패를 주입했는데 **빌드가 타입 오류로 죽었고**,
 * 그래서 `dist`는 옛 번들 그대로였다 — 라이브 검사는 초록을 냈다. 주입 검증이 통과했으니
 * "검사가 살아 있다"고 믿을 뻔했다. **낡은 번들을 재는 검사는 공허한 게이트다**(§4·§2-B).
 *
 * `npm run build`가 실패해도 옛 `dist`는 남는다는 게 핵심이다 — 없어지지 않으므로
 * "빌드했겠지"라는 가정이 조용히 성립한다. 그래서 시각을 직접 비교한다.
 */
function assertDistFresh() {
  const newest = (dir) => {
    let t = 0;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      t = Math.max(t, e.isDirectory() ? newest(full) : statSync(full).mtimeMs);
    }
    return t;
  };
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let built;
  try {
    built = statSync(join(DIST, 'index.html')).mtimeMs;
  } catch {
    console.error('verify-editor-live: dist가 없습니다 — `npm run build` 먼저.');
    process.exit(2);
  }
  const src = Math.max(newest(join(root, 'src')), newest(join(root, 'public')));
  if (src > built) {
    const age = Math.round((src - built) / 1000);
    console.error(
      `verify-editor-live: **dist가 소스보다 ${age}초 낡았습니다.** 낡은 번들을 재면 검사가 공허해집니다.\n` +
        '  → `npm run build`가 성공했는지 확인하고 다시 실행하세요(빌드가 실패해도 옛 dist는 남습니다).',
    );
    process.exit(2);
  }
}
assertDistFresh();
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.map': 'application/json', '.woff2': 'font/woff2' };

/**
 * 서버가 **실제로 파일을 내준** 경로 기록. 서비스워커 검사가 이걸 센다 —
 * 브라우저 쪽 `fromServiceWorker()`는 "워커가 처리했다"일 뿐 "네트워크를 안 탔다"가 아니다.
 */
const served = [];

/** dist를 BASE 경로로 서빙하는 서버를 만든다(오프라인 검사가 자기 서버를 따로 띄운다). */
function makeServer(log) {
  return createServer(async (req, res) => {
    let p = new URL(req.url, 'http://x').pathname;
    if (!p.startsWith(BASE)) { res.writeHead(404).end(); return; }
    p = p.slice(BASE.length) || 'index.html';
    log.push(p);
    const headers = { 'cache-control': 'no-store' };
    try {
      const buf = await readFile(join(DIST, p));
      res.writeHead(200, { ...headers, 'content-type': MIME[extname(p)] ?? 'application/octet-stream' }).end(buf);
    } catch {
      const buf = await readFile(join(DIST, 'index.html'));
      res.writeHead(200, { ...headers, 'content-type': 'text/html' }).end(buf);
    }
  });
}

const server = createServer(async (req, res) => {
  let p = new URL(req.url, 'http://x').pathname;
  if (!p.startsWith(BASE)) { res.writeHead(404).end(); return; }
  p = p.slice(BASE.length) || 'index.html';
  served.push(p);
  // `no-store` — 브라우저 HTTP 캐시를 원천 차단한다. 이게 없으면 서비스워커 검사가 **공허해진다**:
  // 워커 캐시를 통째로 무력화해도 브라우저 캐시가 서버 요청을 막아 그대로 통과했다(실제로 겪음).
  // 워커의 `fetch()`도 HTTP 캐시를 타므로 페이지 쪽 CDP 설정만으로는 부족했다.
  // 이제 서버 요청이 줄어든 것은 **오직 워커의 Cache Storage 덕분**이 된다.
  const headers = { 'cache-control': 'no-store' };
  try {
    const buf = await readFile(join(DIST, p));
    res.writeHead(200, { ...headers, 'content-type': MIME[extname(p)] ?? 'application/octet-stream' }).end(buf);
  } catch {
    const buf = await readFile(join(DIST, 'index.html'));
    res.writeHead(200, { ...headers, 'content-type': 'text/html' }).end(buf);
  }
});
await new Promise((r) => server.listen(4173, r));

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok, extra }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };

async function observeViewerObjectUrls(targetPage) {
  await targetPage.evaluate(() => {
    window.__liveOriginalCreateObjectURL = URL.createObjectURL.bind(URL);
    window.__liveObjectUrlBlobs = new Map();
    window.__liveOriginalShowSaveFilePicker = window.showSaveFilePicker;
    // 이 블록은 anchor fallback의 정직한 `requested` 판정을 재므로 브라우저 구현 유무를 고정한다.
    window.showSaveFilePicker = undefined;
    URL.createObjectURL = (blob) => {
      const url = window.__liveOriginalCreateObjectURL(blob);
      window.__liveObjectUrlBlobs.set(url, blob);
      return url;
    };
  });
}

async function stopObservingViewerObjectUrls(targetPage) {
  await targetPage.evaluate(() => {
    URL.createObjectURL = window.__liveOriginalCreateObjectURL;
    delete window.__liveOriginalCreateObjectURL;
    delete window.__liveObjectUrlBlobs;
    if (window.__liveOriginalShowSaveFilePicker) {
      window.showSaveFilePicker = window.__liveOriginalShowSaveFilePicker;
    } else {
      delete window.showSaveFilePicker;
    }
    delete window.__liveOriginalShowSaveFilePicker;
  });
}

// 브라우저를 **띄우지 못하는 것**은 앱의 결함이 아니라 전제 미충족이다(브라우저 바이너리
// 없음·판 불일치·샌드박스 제약). harness가 SKIP과 FAIL을 가르므로 여기서 그 신호를 정확히
// 준다 — 크래시로 죽으면 harness는 이걸 "위반을 찾음(FAIL)"으로 읽고, 그건 **오탐**이다(§2-B ③).
const browser = await launchLiveBrowser(chromium, { gate: 'verify-editor-live', cleanup: () => server.close() });
// Windows 전용 파일 드롭 경로를 CI(Linux)에서도 실제 렌더로 재기 위해
// 이 페이지의 UA를 명시적으로 Windows로 고정한다. 재는 대상은 OS가 아니라 앱 배선이다.
const page = await browser.newPage({
  viewport: { width: 412, height: 915 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36',
  // 🔴 **터치가 있는 기기로 연다**(2026-08-06). 사용자의 기기는 손가락이고, 터치에는 마우스에
  // 없는 경로가 있다 — 브라우저가 제스처를 스크롤로 가져간다. 마우스로만 재던 검사가
  // 「꾹 눌러 순서 바꾸기」의 실제 결함을 통째로 놓쳤다(헌법 §17).
  hasTouch: true,
});
// 📍 「내 위치」를 **실제로 눌러** 재려면 브라우저가 위치를 줘야 한다(§13 4항 — 라벨만 읽는
// 것과 눌러 보는 것은 다른 층이다). 실제 GPS는 이 환경에 없으므로 **결정적인 가짜 위치**를
// 넣는다. 재는 대상은 위성이 아니라 **배선**이다: 눌렀을 때 좌표가 필드에 들어가는가,
// 정확도가 배지 문장이 되는가, 실패 사유가 화면에 나오는가, 버튼이 잠긴 채 남지 않는가.
await page.context().grantPermissions(['geolocation', 'clipboard-read', 'clipboard-write'], { origin: 'http://localhost:4173' });
await page.context().setGeolocation({ latitude: 37.5665, longitude: 126.978, accuracy: 18 });

// 지도 타일을 **가로채 1×1 PNG로 답한다.** 샌드박스는 tile.openstreetmap.org를 막으므로
// 지도를 열어 두는 동안 타일 요청이 전부 실패하고, 그게 「콘솔 에러 0」을 깨뜨린다 —
// **앱의 결함이 아니라 환경 때문**이다. 검사를 약하게 만드는 대신(그러면 진짜 에러도 놓친다)
// 요청을 결정적으로 만든다. 타일 그림 자체는 이 검사의 관심사가 아니다(레이아웃·배선을 잰다).
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
/**
 * 요청된 타일의 **확대수준(z)** 기록.
 *
 * 왜 이걸 재는가(2026-07-30 M-0050): 「지도가 부정확하다」 신고의 절반은 좌표가 아니라
 * **확대수준**이었다 — 지점이 하나뿐일 때 zoom이 초기값 10에 남아, 핀 하나가 김포~남양주가
 * 다 보이는 화면 위에 떠 있었다. MapLibre의 `map` 객체는 화면 밖(클로저 안)이라 DOM으로는
 * 볼 수 없는데, **앱이 어느 z의 타일을 실제로 요청했는지**는 밖에서 관측된다.
 * 자료구조가 아니라 *앱이 실제로 한 일*을 재는 자리다(§10 ③).
 */
const tileZooms = [];
let kakaoSdkRequests = 0;
let tomtomTileRequests = 0;
/**
 * Node 쪽 조건이 참이 될 때까지 기다린다 — **못 채워도 던지지 않는다.**
 *
 * 던지지 않는 이유(§4): 이 함수를 쓰는 자리는 대개 「0건이면 아래 판정이 공허하다」를 재는
 * 전제 검사다. 조건이 끝내 거짓이면 그건 **판정할 값**이지 사고가 아니다 — 검사가 그 사실을
 * 화면에 적어야 한다. 시간으로 자면 그 0이 「없다」인지 「아직 안 봤다」인지 갈리지 않는다.
 */
async function waitUntil(fn, timeoutMs = 15000, stepMs = 100) {
  const end = Date.now() + timeoutMs;
  let matched = await fn();
  while (!matched && Date.now() < end) {
    await new Promise((r) => setTimeout(r, stepMs));
    matched = await fn();
  }
  return matched;
}

/**
 * 클릭 뒤 **화면이 실제로 다시 그려질 때까지** 기다린다 — 시계가 아니라 브라우저의 렌더 파이프라인에.
 *
 * ── 왜 (T-016 · BGT-2 실측 2026-08-09) ─────────────────────────────────────
 * 이 검사의 시간이 어디로 가는지 성분별로 쟀다(게이트를 고치지 않고 playwright를 감싸서):
 *
 *     전체 128.6s · 고정 대기 **137.3s/351회**(겹쳐 돌아 100% 초과) ·
 *     페이지 열기 8.2s/35회 · 내용 기다리기 10.4s/188회 · evaluate 2.8s/382회
 *
 * 🔴 **이 게이트는 사실상 「자고 있는」 검사였다.** 그리고 원문 이식 지시서(BGT)의 답은
 * 폰트 격리였는데 **우리 병목이 아니었다** — 답을 베끼지 말고 재라는 T-016의 지시가 맞았다.
 *
 * ── 왜 rAF 두 번인가 ────────────────────────────────────────────────────────
 * 이 앱은 Vanilla TS라 클릭 핸들러가 **동기적으로** DOM을 다시 그린다. 그걸 250ms 자면서
 * 기다리는 것은 「내용이 아니라 시간을 기다리는 것」이고, M-0119가 정확히 그 형태의 결함이었다
 * (*"시간이 아니라 **내용**을 기다림"*). 규율은 이미 있었는데 **형제 166곳이 안 따라왔다**(§7).
 *
 * rAF를 두 번 기다리면 ①핸들러가 만든 DOM 변경이 스타일·레이아웃을 거쳐 **실제로 한 프레임
 * 그려졌음**이 보장되고 ②그 값은 시계가 아니라 **브라우저가 정한다**(느린 CI에서도 참이다).
 * 보통 16~32ms다.
 *
 * 🔴 **아무 데나 쓰지 않는다.** 네트워크·워커·디코드·애니메이션처럼 **진짜 비동기 일**을
 * 기다리는 자리는 그대로 뒀다(400ms 이상 자던 자리들). 거기서 rAF는 「아직 안 끝났다」를
 * 「끝났다」로 반올림한다 — 그게 M-0119를 되살리는 길이다.
 */
async function settle(p = page) {
  await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/**
 * 44px 표적 검사에서 **빼는 것과 그 이유**. 🔴 **한 곳에만 둔다** — `coverSweep`이 화면마다
 * 쓰고 홈 전수 검사도 쓴다. 두 벌로 두면 한쪽만 고쳐지는 날이 온다(§2 · §7 2층).
 * 🔴 **이유 없는 제외는 결함이다**(§7).
 */
const TOUCH_TARGET_EXCEPTIONS = [
  // 64×64 썸네일 셀 위에 얹힌 삭제 버튼. 44px로 넓히면 셀의 절반 이상을 덮어 **사진을
  // 누르려던 손이 사진을 지운다** — 미달보다 나쁘다(§3-E · M-0162). 대체 경로로 [전체 해제]가
  // 있고 그쪽은 44px이다. 근본 처방(칸을 키우거나 삭제를 칸 밖으로)은 배치 결정이라 T-044.
  'pick-x',
  // 위와 같은 형태 — 저장된 사진 격자 칸 위 우상단.
  'photo-del',
  // 비용 칩 안의 환율 상세 펼치기(≈ 환산값). 형제 `.chip-x`와 같은 처방(칩 높이를 꽉 채우되
  // **칩 밖으로는 안 나간다**)을 받아 19px → 칩 높이가 됐지만, 알약 칩 자체가 30px이라
  // 44px에는 못 미친다. 밖으로 넓히면 아래 사진 격자에 보이지 않는 표적이 얹힌다(M-0162).
  // 근본 처방(칩을 키우거나 컨트롤을 칩 밖으로)은 배치 결정이라 T-044에 함께 묶었다.
  'chip-approx',
  // 🔴 아래 셋은 **면제가 아니라 더 엄한 검사로 보내는 것**이다(§11 ③ — 오탐도 결함이다).
  //    `closeButtonTarget()`이 이 셋을 ①세로 히트 44px ②**덮는 것 0**으로 각각 잰다.
  //    여기서 `min(w,h)`로 재면 가로 36px을 미달이라 부르는데, 가로로 넓히는 것은 M-0162에서
  //    **이웃의 터치를 훔쳐** 미달보다 나쁜 상태를 만들었다 — 그래서 세로만 넓힌 결정이다.
  //    두 검사가 서로 다른 답을 내면 그게 §17이 말하는 모순이다. 판정은 한 곳에서 한다.
  'pe-close',
  'map-close',
  'single-photo-moment-close',
];

/**
 * 🔴 **폴드 커버 폭(344px)에서 지금 열려 있는 화면을 훑는다**(T-043 · 2026-08-15).
 *
 * 왜 헬퍼인가: 사용자가 요청한 커버 화면 최적화에서 **홈만 재고 나머지는 「안 봤다」**로 남았다.
 * 화면마다 손으로 측정을 쓰면 항목이 갈라지므로, **재는 것을 한 곳에서 정한다**(§7 2층).
 *
 * 재는 것(`ui-responsive-dev` §2 규율):
 *  ① 페이지 가로 넘침 — 모든 폭에서 0이어야 한다
 *  ② **자르는 상자**의 가로 넘침 — 자식이 아니라 자르는 쪽에서 잰다(§3 1.32-B)
 *  ③ 버튼·칩 글자가 두 줄로 갈라졌는가
 *  ④ 44px 미달 터치 표적(부모가 클릭을 받는 자식과 `::after` 확장은 오탐이므로 제외)
 *
 * 🔴 **뷰포트를 바꾸고 반드시 되돌린다**(§3-C — 뒤따르는 검사가 보는 화면을 바꾸지 않는다).
 * 🔴 **모집단을 먼저 판정한다** — 화면이 안 열렸으면 0을 재고 통과할 수 있다(§4).
 */
async function coverSweep(label, rootSelector, exceptions = TOUCH_TARGET_EXCEPTIONS) {
  const keep = page.viewportSize();
  await page.setViewportSize({ width: 344, height: 820 });
  await settle(page);
  const m = await page.evaluate(({ root, exc }) => {
    const scope = root ? document.querySelector(root) : document.body;
    if (!scope) return null;
    const vis = (n) => n.getClientRects().length > 0 && getComputedStyle(n).visibility !== 'hidden';
    const name = (n) => `${n.tagName.toLowerCase()}${typeof n.className === 'string' && n.className ? '.' + n.className.trim().split(/\s+/)[0] : ''}`;
    const hit = (n) => {
      const r = n.getBoundingClientRect();
      const a = getComputedStyle(n, '::after');
      const g = (v) => Math.abs(parseFloat(v) || 0);
      const has = a.content !== 'none' && a.position === 'absolute';
      return { w: r.width + (has ? g(a.left) + g(a.right) : 0), h: r.height + (has ? g(a.top) + g(a.bottom) : 0) };
    };
    // 🔴 **자르는 상자만 말하면 원자료 덤프다**(§8). 「무엇이 튀어나왔나」까지 말해야
    //    사람이 고칠 자리를 안다 — 상자는 결과이고 원인은 그 안의 자식이다.
    const clipped = [];
    for (const box of scope.querySelectorAll('*')) {
      if (!vis(box)) continue;
      const cs = getComputedStyle(box);
      if (cs.overflowX === 'visible') continue;
      // 🔴 `text-overflow: ellipsis`는 **자르겠다고 선언한 상자**다(`…`가 그 자리에 보인다).
      //    그걸 넘침이라 부르면 고쳐 둔 것을 결함이라 부르는 오탐이고, 오탐이 많은 게이트는
      //    사람이 무시해서 죽는다(§11 ③). 자르는 것과 **말없이 사라지는 것**은 다른 일이다.
      if (cs.textOverflow === 'ellipsis') continue;
      const over = box.scrollWidth - box.clientWidth;
      if (over <= 1) continue;
      const edge = box.getBoundingClientRect().left + box.clientWidth;
      let worst = null;
      for (const kid of box.querySelectorAll('*')) {
        if (!vis(kid)) continue;
        const past = Math.round(kid.getBoundingClientRect().right - edge);
        if (past > 1 && (!worst || past > worst.past)) worst = { n: name(kid), past };
      }
      clipped.push(`${name(box)}(+${over} ← ${worst ? `${worst.n} +${worst.past}` : '자식 없음'})`);
    }
    const split = [];
    for (const b of scope.querySelectorAll('button, label, .chip, .status-chip, .moment-picker')) {
      if (!vis(b)) continue;
      const span = b.querySelector('.moment-picker-text') ?? b;
      const txt = (b.textContent ?? '').trim();
      if (span.getClientRects().length > 1 && txt.length > 0 && txt.length <= 24) split.push(`"${txt.slice(0, 14)}"`);
    }
    const controls = [...scope.querySelectorAll('button, a[href], [role="button"]')].filter(vis);
    const small = [];
    for (const b of controls) {
      const cls = typeof b.className === 'string' ? b.className : '';
      if (exc.some((e) => cls.split(/\s+/).includes(e))) continue;
      const anc = b.parentElement?.closest('.is-actionable, button, a[href], [role="button"]');
      if (anc) { const ah = hit(anc); if (Math.min(ah.w, ah.h) >= 44) continue; }
      const { w, h } = hit(b);
      if (Math.min(w, h) < 44) small.push(`${cls.split(/\s+/)[0] || b.tagName}(${Math.round(w)}x${Math.round(h)})`);
    }
    return {
      controls: controls.length,
      pageOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      clipped: [...new Set(clipped)],
      split: [...new Set(split)],
      small: [...new Set(small)],
    };
  }, { root: rootSelector, exc: exceptions });
  if (keep) await page.setViewportSize(keep);
  await settle(page);

  check(`폴드 커버 344px · ${label}: 화면을 실제로 열었다(모집단 0은 통과가 아니다)`,
    (m?.controls ?? 0) > 0, JSON.stringify(m));
  if ((m?.controls ?? 0) > 0) {
    check(`폴드 커버 344px · ${label}: 가로로 넘치지 않는다(페이지·자르는 상자 둘 다)`,
      m.pageOverflow === 0 && m.clipped.length === 0, JSON.stringify({ pageOverflow: m.pageOverflow, clipped: m.clipped }));
    check(`폴드 커버 344px · ${label}: 버튼·칩 글자가 두 줄로 갈라지지 않는다`,
      m.split.length === 0, JSON.stringify(m.split));
    check(`폴드 커버 344px · ${label}: 44px 미달 터치 표적이 없다(예외는 이유와 함께 등록)`,
      m.small.length === 0, JSON.stringify(m.small));
  }
  return m;
}

/**
 * 닫기 버튼의 **누를 수 있는 넓이**와 **그 영역이 덮는 다른 조작 요소**를 함께 잰다(T-041).
 *
 * 🔴 **둘을 함께 재는 것이 계약이다.** 넓히기만 재면 이웃의 터치를 훔치면서 통과하고,
 *    덮음만 재면 아무것도 안 넓히고 통과한다 — M-0162에서 전자를 실제로 만들었다.
 *    셋(`.pe-close`·`.map-close`·`.single-photo-moment-close`)이 **이 함수 하나를 지난다**:
 *    손으로 세 벌 쓰면 한쪽만 고쳐지는 날이 온다(§7 2층).
 */
async function closeButtonTarget(selector) {
  return page.evaluate((sel) => {
    const n = document.querySelector(sel);
    if (!n) return null;
    const r = n.getBoundingClientRect();
    const a = getComputedStyle(n, '::after');
    const g = (v) => Math.abs(parseFloat(v) || 0);
    const has = a.content !== 'none' && a.position === 'absolute';
    const w = r.width + (has ? g(a.left) + g(a.right) : 0);
    const h = r.height + (has ? g(a.top) + g(a.bottom) : 0);
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const stolen = [];
    for (const dx of [-w / 2 + 1, 0, w / 2 - 1]) for (const dy of [-h / 2 + 1, 0, h / 2 - 1]) {
      const el = document.elementFromPoint(cx + dx, cy + dy)?.closest('button, a[href], input, select, textarea, [role="button"]');
      if (el && el !== n && !n.contains(el) && !el.contains(n)) stolen.push(el.className || el.tagName);
    }
    return {
      visible: `${Math.round(r.width)}x${Math.round(r.height)}`,
      hit: `${Math.round(w)}x${Math.round(h)}`,
      min: Math.min(w, h),
      hitH: h, // 세로만 넓히므로 판정은 이 값으로 한다(가로는 보이는 크기 그대로)
      stolen: [...new Set(stolen)],
      // 🔴 같은 클래스가 **여러 개** 있으면 `querySelector`는 첫 번째를 잡고 `elementFromPoint`는
      //    다른 것을 잡을 수 있다 — 그러면 「자기 자신을 덮는다」는 이상한 판정이 나온다.
      //    개수를 함께 보고해 그 경우를 사람이 바로 알아보게 한다(오탐과 진짜 결함을 가른다).
      count: document.querySelectorAll(sel).length,
    };
  }, selector);
}
await page.route('**://tile.openstreetmap.org/**', (route) => {
  const m = /\/(\d+)\/\d+\/\d+\.png/.exec(route.request().url());
  if (m) tileZooms.push(Number(m[1]));
  return route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1X1 });
});
await page.route('https://api.tomtom.com/**', (route) => {
  tomtomTileRequests += 1;
  return route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1X1 });
});
// 한국 지도 경로는 Kakao SDK를 **결정적 가짜 구현**으로 실행한다. 외부망·쿼터를 쓰지 않되
// 앱이 SDK를 요청하고, Kakao 제공자를 고르고, 단일 지점 확대수준을 설정하는 배선은 실제 DOM에서 잰다.
await page.route('https://dapi.kakao.com/v2/maps/sdk.js**', (route) => {
  kakaoSdkRequests += 1;
  return route.fulfill({
    status: 200,
    contentType: 'text/javascript',
    body: `(() => {
      const listeners = new WeakMap();
      const bucket = (target) => { let b = listeners.get(target); if (!b) { b = {}; listeners.set(target, b); } return b; };
      const emit = (target, name, value) => queueMicrotask(() => { for (const fn of bucket(target)[name] || []) fn(value); });
      class LatLng { constructor(lat, lng) { this.lat = lat; this.lng = lng; } getLat() { return this.lat; } getLng() { return this.lng; } }
      class LatLngBounds { constructor() { this.points = []; } extend(p) { this.points.push(p); } }
      class Map {
        constructor(container, options) {
          this.container = container; this.center = options.center; this.setLevel(options.level);
          const surface = document.createElement('div'); surface.dataset.kakaoFixture = 'map'; surface.style.height = '100%'; container.appendChild(surface);
          emit(this, 'tilesloaded');
        }
        setCenter(p) { this.center = p; }
        setLevel(level) { this.level = level; this.container.dataset.kakaoLevel = String(level); }
        setBounds() { emit(this, 'tilesloaded'); }
      }
      class Marker {
        constructor(options) { this.map = options.map; this.position = options.position; }
        setMap(map) { this.map = map; }
        setPosition(p) { this.position = p; }
        getPosition() { return this.position; }
      }
      class CustomOverlay { constructor(options) { this.options = options; this.map = null; } setMap(map) { this.map = map; } }
      window.kakao = { maps: {
        load: (done) => done(), LatLng, LatLngBounds, Map, Marker, CustomOverlay,
        event: {
          addListener(target, name, fn) { const b = bucket(target); (b[name] ||= []).push(fn); },
          removeListener(target, name, fn) { const b = bucket(target); b[name] = (b[name] || []).filter((x) => x !== fn); },
        },
      }};
    })();`,
  });
});
// 앱 시작 직후 기존 좌표 배지를 보강하는 역지오코딩도 외부망에 새지 않게 기본 응답을 둔다.
// 뒤의 역지오코딩 검사는 더 나중에 등록한 구체 fixture가 우선한다. 그 fixture를 해제한 뒤에는
// 이 fallback을 다시 걸어, 테스트가 샌드박스 밖 네트워크에 우연히 기대지 않게 한다.
const defaultReverseRoute = (route) => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ error: 'fixture offline' }),
});
await page.route('**/reverse**', defaultReverseRoute);
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(`http://localhost:4173${BASE}`);

async function createTripFromModal(title, start = '', end = '') {
  await page.locator('.trip-form .btn-primary').click();
  const modal = page.locator('.trip-editor-modal');
  await modal.waitFor();
  await modal.locator('input').first().fill(title);
  if (start) await modal.locator('input[type="date"]').nth(0).fill(start);
  if (end) await modal.locator('input[type="date"]').nth(1).fill(end);
  await modal.locator('button[type="submit"]').click();
  await modal.waitFor({ state: 'detached' });
  await page.locator('.trip-card', { hasText: title }).first().waitFor();
}

// v0.43: 홈 목록에서 여행 삭제(확인 → 카드 제거) + 실행취소 복원
await createTripFromModal('삭제 테스트 여행');
const delN0 = await page.locator('.trip-card').count();
page.once('dialog', (d) => d.accept()); // 삭제 확인 창 수락
await page.locator('.trip-delete').first().click();
await page.waitForFunction((n) => document.querySelectorAll('.trip-card').length === n, delN0 - 1);
const delN1 = await page.locator('.trip-card').count();
check('홈 목록 삭제(확인) → 카드 제거', delN1 === delN0 - 1, `${delN0}→${delN1}`);
await page.locator('.undo-toast .undo-btn').click();
await page.waitForFunction((n) => document.querySelectorAll('.trip-card').length === n, delN0);
const delN2 = await page.locator('.trip-card').count();
check('삭제 실행취소 → 여행 복원', delN2 === delN0, `${delN1}→${delN2}`);
page.once('dialog', (d) => d.accept()); // 정리: 테스트 여행 다시 삭제(본 흐름과 분리)
await page.locator('.trip-delete').first().click();
await page.waitForFunction((n) => document.querySelectorAll('.trip-card').length === n, delN0 - 1);

await createTripFromModal('편집기 검증 여행', '2024-01-15', '2026-03-20');

check('홈 입력칸은 사진 제목 검색', await page.locator('.trip-form input[type="search"]').count() === 1);
check('여행 기간 옆 달력 경과 표기', (await page.locator('.trip-card .trip-meta').first().textContent()).includes('(2년 2개월 5일)'));
const titleBadgeOrder = await page.locator('.app-title-row').evaluate((row) => {
  const children = [...row.children];
  return children.findIndex((e) => e.classList.contains('app-version')) < children.findIndex((e) => e.classList.contains('sync-note'));
});
check('동기화 배지는 버전 배지 바로 옆', titleBadgeOrder);
check('Bugeon Journey는 홈 버튼', await page.locator('.app-title-home').count() === 1);

await page.locator('.trip-edit').first().click();
await page.locator('.trip-editor-modal input[type="date"]').nth(1).fill('2026-03-21');
await page.locator('.trip-editor-modal button[type="submit"]').click();
await page.locator('.trip-editor-modal').waitFor({ state: 'detached' });
check('여행 카드 편집 버튼과 별도 창 저장', (await page.locator('.trip-card .trip-meta').first().textContent()).includes('(2년 2개월 6일)'));
// 뒤의 기존 시각·환율 시나리오는 기간 미정 여행을 전제로 하므로 픽스처 변경을 되돌린다.
await page.locator('.trip-edit').first().click();
await page.locator('.trip-editor-modal input[type="date"]').nth(0).fill('');
await page.locator('.trip-editor-modal input[type="date"]').nth(1).fill('');
await page.locator('.trip-editor-modal button[type="submit"]').click();
await page.locator('.trip-editor-modal').waitFor({ state: 'detached' });

// v0.44: 설계 개요도(배선맵) — 개발자 정보 → 설계 개요도 → 자가점검·4단계·실카운트
await page.locator('.app-version').click();
await page.getByRole('button', { name: /설계 개요도 열기/ }).click();
await page.waitForSelector('.bp-score');
const bpStages = await page.locator('.bp-stage').count();
check('설계 개요도: 4단계 렌더', bpStages === 4, `stages=${bpStages}`);
const bpScore = await page.$eval('.bp-score-badge', (e) => e.textContent);
check('설계 개요도: 자가점검 점수(100)', bpScore === '100', `score=${bpScore}`);
await page
  .waitForFunction(() => {
    const row = [...document.querySelectorAll('.bp-src-row')].find((r) => r.textContent.includes('trips'));
    return row && (row.querySelector('.bp-src-val')?.textContent ?? '') === '1';
  }, null, { timeout: 5000 })
  .catch(() => {});
const bpTrip = await page.evaluate(() => {
  const row = [...document.querySelectorAll('.bp-src-row')].find((r) => r.textContent.includes('trips'));
  return row?.querySelector('.bp-src-val')?.textContent ?? '?';
});
check('설계 개요도: 실카운트(여행=1) 자동 채움', bpTrip === '1', `trips=${bpTrip}`);
await page.keyboard.press('Escape');
await settle(page);
while ((await page.locator('.guide-overlay').count()) > 0) {
  await page.keyboard.press('Escape');
  await settle(page);
}

// v0.49: 환율 기준통화 설정 — 데이터 관리 → 카드 → 통화 선택기(UZS 포함) 렌더·저장
await page.locator('.data-open').click();
await page.waitForSelector('.guide-overlay');
await page.waitForSelector('.dm-usage-total');
// T-043 — 커버 폭에서 **오버레이 안쪽**을 잰다. 지금까지 344px는 홈만 봤다(§4 — 안 잰 것은
// 통과가 아니다). 오버레이는 자기 스크롤 상자를 가지므로 페이지 넘침이 0이어도 안이 잘린다.
await coverSweep('데이터 관리 오버레이', '.guide-overlay');
const dmVisual = await page.evaluate(() => {
  const weight = (selector) => Number.parseInt(getComputedStyle(document.querySelector(selector)).fontWeight, 10);
  const rightEdges = [...document.querySelectorAll('.dm-usage-val')]
    .map((node) => node.getBoundingClientRect().right);
  const iconContract = [...document.querySelectorAll('.dm-usage svg, .dm-tool-group svg')].every((node) =>
    node.getAttribute('fill') === 'none'
      && node.getAttribute('stroke') === 'currentColor'
      && node.getAttribute('aria-hidden') === 'true',
  );
  const body = document.querySelector('.guide-body');
  return {
    titleIcons: document.querySelectorAll('.dm-title-icon').length,
    usageIcons: document.querySelectorAll('.dm-usage-ic').length,
    groupIcons: document.querySelectorAll('.dm-group-icon').length,
    menuIcons: document.querySelectorAll('.dm-card-icon').length,
    menuCards: document.querySelectorAll('.dm-tool-group .guide-card').length,
    iconContract,
    hasDecorativeEmoji: /\p{Extended_Pictographic}/u.test(body?.textContent ?? ''),
    hasPlainRecordLabel: [...document.querySelectorAll('.dm-usage-name')].some((node) => node.textContent === '기록'),
    weights: {
      title: weight('.dm-usage-title'),
      rowLabel: weight('.dm-usage-name'),
      rowValue: weight('.dm-usage-line:not(.dm-usage-total) .dm-usage-val'),
      totalValue: weight('.dm-usage-total .dm-usage-val'),
      menuLabel: weight('.dm-tool-group .guide-card-label'),
      menuHint: weight('.dm-tool-group .guide-card-hint'),
    },
    valueEdgeSpread: Math.max(...rightEdges) - Math.min(...rightEdges),
    overflowX: body ? body.scrollWidth - body.clientWidth : Number.POSITIVE_INFINITY,
  };
});
check(
  'v2.16 데이터 관리: 저장 3종과 메뉴 전부가 같은 단색 SVG 아이콘 계약을 쓴다',
  dmVisual.titleIcons === 1
    && dmVisual.usageIcons === 3
    && dmVisual.groupIcons === 1
    && dmVisual.menuIcons === dmVisual.menuCards
    && dmVisual.menuCards >= 9
    && dmVisual.iconContract,
  JSON.stringify(dmVisual),
);
check(
  'v2.16 데이터 관리: 장식 이모지를 없애고 텍스트 기록을 간결한 「기록」으로 말한다',
  !dmVisual.hasDecorativeEmoji && dmVisual.hasPlainRecordLabel,
  JSON.stringify(dmVisual),
);
check(
  'v2.16 데이터 관리: 개별 항목은 본문 무게이고 합계만 한 단계 강조한다',
  dmVisual.weights.title <= 650
    && dmVisual.weights.rowLabel <= 600
    && dmVisual.weights.rowValue <= 600
    && dmVisual.weights.totalValue >= 700
    && dmVisual.weights.totalValue > dmVisual.weights.rowValue
    && dmVisual.weights.menuLabel <= 600
    && dmVisual.weights.menuHint <= 400,
  JSON.stringify(dmVisual.weights),
);
check(
  'v2.16 데이터 관리: 좁은 화면에서도 용량 숫자 열이 맞고 가로 넘침이 없다',
  dmVisual.valueEdgeSpread <= 1 && dmVisual.overflowX <= 0,
  `right spread=${dmVisual.valueEdgeSpread.toFixed(1)}px · overflow=${dmVisual.overflowX}px`,
);
if (process.env.DATA_MANAGER_SCREENSHOT) {
  await page.screenshot({ path: resolve(process.env.DATA_MANAGER_SCREENSHOT), fullPage: false });
}
await page.getByText('환율 기준통화', { exact: false }).first().click();
await page.waitForSelector('.dm-row select');
const fxOpts = await page.$$eval('.dm-row select option', (els) => els.map((e) => e.value));
check('환율 설정: 통화 선택기 렌더(UZS·KRW 포함)', fxOpts.includes('UZS') && fxOpts.includes('KRW'), `n=${fxOpts.length}`);
// v0.51: 국기가 코드에서 파생되어 모든 옵션에 붙는지(손 테이블 없음)
const fxLabels = await page.$$eval('.dm-row select option', (els) => els.map((e) => e.textContent ?? ''));
const noFlag = fxLabels.filter((t) => !/^[\u{1F1E6}-\u{1F1FF}]{2}/u.test(t));
check('환율 설정: 모든 통화에 국기 표시', noFlag.length === 0, noFlag.slice(0, 3).join(' | '));
check('환율 설정: 국기+심볼+코드 형식(KRW)', fxLabels.some((t) => t === '\u{1F1F0}\u{1F1F7} \u20A9 KRW'), fxLabels[0] ?? '');
const fxDefault = await page.$eval('.dm-row select', (s) => s.value);
check('환율 설정: 기본 기준통화 KRW', fxDefault === 'KRW', fxDefault);
// 선택 변경 → localStorage 저장 read-back(성공 토스트가 아니라 실제 저장값을 되읽어 확인)
await page.selectOption('.dm-row select', 'USD');
await settle(page);
const fxSaved = await page.evaluate(() => localStorage.getItem('bj.fxBase'));
check('환율 설정: 선택이 실제로 저장됨(read-back)', fxSaved === 'USD', String(fxSaved));
await page.selectOption('.dm-row select', 'KRW'); // 이후 테스트 영향 없도록 원복
await settle(page);
await page.keyboard.press('Escape');
await settle(page);
while ((await page.locator('.guide-overlay').count()) > 0) {
  await page.keyboard.press('Escape');
  await settle(page);
}

// ── v1.77: 위치관리대장 — 검색·좌표 뒤집기 미리보기가 **실제로 도는가** ──────────
//
// 왜 이 층인가: 좌표 순서를 틀리면 **기억이 엉뚱한 곳에 찍힌다**(M-0057에서 실제로 기니만
// 앞바다에 찍혔다). 그 사고를 막는 장치가 「뒤집으면 여기」 미리보기인데, 그건 **화면에
// 그려져야만** 사용자를 구한다 — 자료구조에만 있으면 M-0022의 형태다(§10 ③).
//
// 픽스처를 Dexie에 직접 심는다(§13 1항 — 앱에서 그 상태를 못 만들면 데이터를 넣어 실제
// 렌더러로 그린다). 두 장소를 넣는다:
//   · 모호한 좌표(41.3, 69.2 타슈켄트) — 뒤집어도 말이 되므로 [이걸로 바꾸기]가 **나와야** 한다
//   · 모호하지 않은 좌표(37.5, 127.0 서울) — 뒤집으면 위도 127로 불가능하므로 **안 나와야** 한다
// 🔴 "있어야 할 때 있는가"만 재면 절반이다. **"없어야 할 때 없는가"**를 함께 재야 공허하지 않다(§4).
const prSeed = await page.evaluate(async () => {
  const now = new Date().toISOString();
  const rows = [
    { id: 'pr-live-amb', name: '라이브검사 모호좌표', latitude: 41.3111, longitude: 69.2797 },
    { id: 'pr-live-clear', name: '라이브검사 명확좌표', latitude: 37.5665, longitude: 127.0016 },
  ].map((r) => ({
    ...r, formattedAddress: null, provider: null, providerPlaceId: null,
    countryCode: null, country: null, region: null, city: null, district: null, postcode: null,
    category: null, memo: null, precision: null, spanMeters: null, mapPicked: false,
    version: 1, baseVersion: 0, createdAt: now, updatedAt: now, deletedAt: null,
    clientOperationId: `pr-live-${r.id}`,
  }));
  await new Promise((resolve, reject) => {
    const req = indexedDB.open('journey-archive');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('localPlaces', 'readwrite');
      for (const r of rows) tx.objectStore('localPlaces').put(r);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
  return rows.length;
});
check('위치관리대장: 픽스처 주입(장소 2건)', prSeed === 2, String(prSeed));

await page.locator('.data-open').click();
await page.waitForSelector('.guide-overlay');
await page.getByRole('button', { name: /위치관리대장/ }).click();
await page.waitForSelector('.pr-list .pr-row', { timeout: 10000 });
const prRows = await page.locator('.pr-row').count();
check('위치관리대장: 목록이 그려진다', prRows >= 2, `행 ${prRows}개`);

// 검색 — 한 글자로도 걸러지는가(사용자 요청: "한글자라도 동일하면")
await page.fill('.pr-search', '모호');
await settle(page);
const prFiltered = await page.locator('.pr-row').count();
const prCountText = await page.locator('.pr-count').textContent();
check('위치관리대장: 검색이 실제로 거른다', prFiltered === 1, `행 ${prFiltered}개`);
// 🔴 「N개 찾음」만 보면 전체가 N개인 줄 안다 — 전체 수를 **함께** 말하는가(§7-C 한정 생략).
check('위치관리대장: 찾은 수와 전체 수를 함께 말한다', /찾음.*전체/.test(prCountText ?? ''), prCountText ?? '');

// 모호한 좌표 → [이걸로 바꾸기]가 **있어야** 한다
await page.locator('.pr-row').first().locator('.pr-edit-open').click();
await settle(page);
const ambSwap = await page.locator('.pr-row').first().locator('.pr-preview-swap button').count();
const ambWhy = await page.locator('.pr-row').first().locator('.pr-preview-why').count();
check('위치관리대장: 모호한 좌표면 [이걸로 바꾸기]가 나온다', ambSwap === 1, `버튼 ${ambSwap}개`);
check('위치관리대장: 왜 모호한지 화면에 말한다(자료구조에만 있으면 M-0022)', ambWhy === 1, `설명 ${ambWhy}개`);

// 눌러 본다 — 그리는 것과 도는 것은 다른 층이다(§13 4항). 저장은 안 누른다(읽기 전용 유지).
const beforeSwap = await page.locator('.pr-row').first().locator('.pr-coord-input').inputValue();
await page.locator('.pr-row').first().locator('.pr-preview-swap button').click();
await settle(page);
const afterSwap = await page.locator('.pr-row').first().locator('.pr-coord-input').inputValue();
check('위치관리대장: [이걸로 바꾸기]를 누르면 실제로 뒤집힌다', beforeSwap !== afterSwap && afterSwap.startsWith('69.2797'), `${beforeSwap} → ${afterSwap}`);
// 뒤집은 뒤에는 더 이상 모호하지 않다고 말해야 하는가? — 69.2797, 41.3111도 둘 다 유효하므로
// 여전히 모호하다. 즉 **버튼이 남아 있는 것이 옳다**(뒤집기를 되돌릴 수 있어야 한다).
const afterSwapBtn = await page.locator('.pr-row').first().locator('.pr-preview-swap button').count();
check('위치관리대장: 뒤집은 뒤에도 되돌릴 수단이 남는다', afterSwapBtn === 1, `버튼 ${afterSwapBtn}개`);

// 🔴 없어야 할 때 없는가 — 명확한 좌표(서울)에는 [이걸로 바꾸기]가 **없어야** 한다
await page.fill('.pr-search', '명확');
await settle(page);
await page.locator('.pr-row').first().locator('.pr-edit-open').click();
await settle(page);
const clearSwap = await page.locator('.pr-row').first().locator('.pr-preview-swap button').count();
check('위치관리대장: 🔴 명확한 좌표면 [이걸로 바꾸기]가 **없다**(오탐 차단)', clearSwap === 0, `버튼 ${clearSwap}개`);

await page.locator('.pr-row').first().getByRole('button', { name: /지도에서 수정/ }).click();
await page.waitForSelector('.map-overlay');
check('위치관리대장: 지도에서 핀 좌표 수정 창이 열린다', await page.locator('.map-pick-confirm').count() === 1);
await page.keyboard.press('Escape');
await page.waitForSelector('.map-overlay', { state: 'detached' });

// 뒷정리 — 심은 픽스처를 지운다(§3-C, 내 상태를 남기지 않는다)
await page.keyboard.press('Escape');
await settle(page);
while ((await page.locator('.guide-overlay').count()) > 0) {
  await page.keyboard.press('Escape');
  await settle(page);
}
await page.evaluate(async () => {
  await new Promise((resolve) => {
    const req = indexedDB.open('journey-archive');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('localPlaces', 'readwrite');
      for (const id of ['pr-live-amb', 'pr-live-clear']) tx.objectStore('localPlaces').delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    };
    req.onerror = () => resolve();
  });
});

// v1.60: canonical 최종본은 일반 병합과 다른 위험 작업 — 경고와 2단계 확인까지만 누른다.
// 실제 두 번째 버튼은 클라우드 전체 교체이므로 라이브 픽스처에서 실행하지 않는다.
await page.locator('.data-open').click();
await page.waitForSelector('.guide-overlay');
await page.getByRole('button', { name: /백업 \(내보내기\)/ }).click();
const backupPanelText = await page.$eval('.guide-detail-body', (node) => node.textContent ?? '');
check(
  'v2.14 백업: 기본 Android 저장 위치를 화면에서 미리 알려 준다',
  backupPanelText.includes('내 저장공간/Download/Bugeon Journey'),
  backupPanelText.slice(0, 220),
);
check(
  'v2.14 백업: 브라우저에는 Android 전용 다른 폴더 버튼을 노출하지 않는다',
  await page.getByRole('button', { name: /다른 폴더 선택 백업/ }).count() === 0,
  `count=${await page.getByRole('button', { name: /다른 폴더 선택 백업/ }).count()}`,
);
check(
  'v2.14 백업: ZIP과 JSON 두 복원 호환 형식을 같은 화면에서 제공한다',
  await page.getByRole('button', { name: /여행별 폴더 백업 \(ZIP\)/ }).count() === 1
    && await page.getByRole('button', { name: /단일 파일 백업 \(JSON\)/ }).count() === 1,
  '',
);
if (process.env.BACKUP_SCREENSHOT) {
  await page.screenshot({ path: resolve(process.env.BACKUP_SCREENSHOT), fullPage: false });
}
await page.keyboard.press('Escape');
await settle(page);
while ((await page.locator('.guide-overlay').count()) > 0) {
  await page.keyboard.press('Escape');
  await settle(page);
}

// Android 셸 표면은 같은 원격 웹을 그리지만 BackupFiles 플러그인이 있을 때만 보조 선택 문을
// 보여 준다. 브라우저 페이지를 네이티브라고 사후 조작하지 않고 별도 context의 시작 전역으로 잰다.
const backupShellContext = await browser.newContext({ viewport: { width: 412, height: 915 }, hasTouch: true });
await backupShellContext.addInitScript(() => {
  Object.defineProperty(window, 'Capacitor', {
    configurable: true,
    value: {
      isNativePlatform: () => true,
      Plugins: { OriginalPhotos: {}, BackupFiles: {} },
    },
  });
});
const backupShellPage = await backupShellContext.newPage();
await backupShellPage.goto(`http://localhost:4173${BASE}`, { waitUntil: 'networkidle' });
await backupShellPage.getByRole('button', { name: /데이터 관리/ }).first().click();
await backupShellPage.getByRole('button', { name: /백업 \(내보내기\)/ }).click();
check(
  'v2.14 백업: Android 셸에는 기본 ZIP과 다른 폴더 선택 ZIP을 함께 제공한다',
  await backupShellPage.getByRole('button', { name: /여행별 폴더 백업 \(ZIP\)/ }).count() === 1
    && await backupShellPage.getByRole('button', { name: /다른 폴더 선택 백업 \(ZIP\)/ }).count() === 1,
  '',
);
if (process.env.BACKUP_SHELL_SCREENSHOT) {
  await backupShellPage.screenshot({ path: resolve(process.env.BACKUP_SHELL_SCREENSHOT), fullPage: false });
}
await backupShellContext.close();

await page.locator('.data-open').click();
await page.waitForSelector('.guide-overlay');
await page.getByRole('button', { name: /이 기기를 클라우드 최종본으로/ }).click();
const canonicalText = await page.$eval('.guide-body', (b) => b.textContent ?? '');
check(
  '최종본 지정: 일반 병합이 아니며 클라우드 전용·다른 기기 로컬 항목의 영향을 경고한다',
  canonicalText.includes('일반 동기화와 다릅니다') &&
    canonicalText.includes('클라우드에만 있던 항목') &&
    canonicalText.includes('다른 기기'),
  canonicalText.slice(0, 180),
);
await page.getByRole('button', { name: '이 기기를 최종본으로 지정', exact: true }).click();
const canonicalConfirm = page.getByRole('button', { name: '정말 이 기기 기준으로 클라우드 교체', exact: true });
check('최종본 지정: 첫 클릭은 실행하지 않고 두 번째 확인 버튼을 펼친다', await canonicalConfirm.isVisible(), '');
const warningStatus = await page.$eval('.dm-status', (n) => n.textContent ?? '');
check('최종본 지정: 마지막 확인이 제거 범위를 다시 말한다', warningStatus.includes('이 기기에 없는 클라우드 항목'), warningStatus);
await page.getByRole('button', { name: '취소', exact: true }).click();
check(
  '최종본 지정: 취소하면 실행 버튼으로 되돌아간다',
  await page.getByRole('button', { name: '이 기기를 최종본으로 지정', exact: true }).isVisible(),
  '',
);
await page.keyboard.press('Escape');
await settle(page);
while ((await page.locator('.guide-overlay').count()) > 0) {
  await page.keyboard.press('Escape');
  await settle(page);
}

// ── v0.55: R2 설정 가이드 — 데이터 관리 → 카드 → 단계·위험 경고 렌더 ──
await page.locator('.data-open').click();
await page.waitForSelector('.guide-overlay');
await page.getByText('R2 저장소 설정', { exact: false }).first().click();
await page.waitForSelector('.r2-step');
const r2Steps = await page.locator('.r2-step').count();
check('R2 가이드: 단계 카드 렌더', r2Steps >= 8, `steps=${r2Steps}`);
const r2Danger = await page.locator('.r2-note-danger').count();
check('R2 가이드: 위험 경고 표시(버킷 잠금·토큰 오입력 등)', r2Danger >= 5, `danger=${r2Danger}`);
const r2Text = await page.$eval('.guide-body', (b) => b.textContent ?? '');
check('R2 가이드: 버킷 잠금 경고 포함', r2Text.includes('버킷 잠금'), '');
check('R2 가이드: 캡처 금지 경고 포함', r2Text.includes('캡처 금지'), '');
check('R2 가이드: 검증 사다리 포함', r2Text.includes('검증 사다리'), '');
// v0.56 읽기 정책 B — 공개 URL을 켜지 않는다는 지시가 화면에 실제로 떠야 한다.
// (문서에만 있고 가이드가 옛 지시를 유지하면 사용자가 공개 URL을 켜 버린다 = 원칙 #3 위반)
check('R2 가이드: 공개 URL 금지 지시 렌더', r2Text.includes('공개 URL은 켜지 않는다'), '');
check('R2 가이드: 시크릿 4개로 안내', r2Text.includes('시크릿 4개'), '');
check('R2 가이드: 값 목록에 R2_PUBLIC_BASE 행 없음', (await page.locator('.r2-key', { hasText: 'R2_PUBLIC_BASE' }).count()) === 0, '');
check('R2 가이드: 연결 확인 버튼(사다리 2번) 존재', (await page.locator('[data-probe-r2]').count()) === 1, '');
// 로컬 전용 모드에서 눌러도 앱이 죽지 않고 상태를 말해야 한다.
await page.locator('[data-probe-r2]').click();
await page.waitForSelector('.r2-probe-note:not([hidden])', { timeout: 3000 });
const probeText = await page.$eval('.r2-probe-note', (n) => n.textContent ?? '');
check('R2 가이드: 연결 확인이 상태를 알려줌', probeText.length > 0, probeText);
await page.keyboard.press('Escape');
await settle(page);
while ((await page.locator('.guide-overlay').count()) > 0) {
  await page.keyboard.press('Escape');
  await settle(page);
}

// v0.46: 기계화 검증 흐름도 — 개발자 정보 → 열기 → 4단계 + 게이트 카드가 실제 harness 개수와 일치
await page.locator('.app-version').click();
await page.getByRole('button', { name: /기계화 검증 흐름도 열기/ }).click();
await page.waitForSelector('.mc-flow');
const mcSteps = await page.locator('.mc-step').count();
check('기계화 검증 흐름도: 4단계 렌더', mcSteps === 4, `steps=${mcSteps}`);
const mcBadge = await page.$eval('.mc-badge', (e) => e.textContent);
check('기계화 검증 흐름도: 게이트 개수 배지(자동 집계)', /자동 검사 \d+가지/.test(mcBadge ?? ''), mcBadge ?? '');
// 카테고리별 게이트 카드 개수 합 = 배지의 개수. **전부 REGISTRY 파생이어야 한다.**
//
// 2026-07-27 전제 변경: 예전엔 `+ 라이브 렌더 1`이었다 — 라이브 게이트가 등록부 밖에 있어
// 화면이 그 카드 하나를 **손으로** 그렸기 때문이다. 이제 등록부 안으로 들어왔으므로 손편집
// 자리가 없고, 기대값도 그만큼 단순해진다. (§2-B ② — 전제가 바뀌면 로직을 되돌리지 말고
// 케이스를 뒤집는다. 그리고 뒤집는 김에 **더 조인다**: 아래 분류 검사가 새로 생긴 층이다.)
const mcBadgeN = parseInt((mcBadge ?? '').match(/(\d+)가지/)?.[1] ?? '0', 10);
const mcGates = await page.locator('.mc-gate').count();
check('기계화 검증 흐름도: 카드 개수 = 게이트 수(손 나열 0)', mcGates === mcBadgeN, `cards=${mcGates}, badge=${mcBadgeN}`);
// 분류가 **통째로 빠지는 것**을 잡는다. 카드 합만 재면 한 분류가 사라지고 다른 분류가 그만큼
// 늘어난 경우를 못 본다. 라이브 층은 특히 조용히 사라지기 쉽다 — 그게 이번 결함의 자리였다.
const mcCatNames = await page.$$eval('.mc-cat-head b', (ns) => ns.map((n) => n.textContent ?? ''));
check(
  '기계화 검증 흐름도: 라이브 분류가 화면에 있다(등록부의 분류가 자동으로 따라온다)',
  mcCatNames.some((n) => n.includes('라이브')),
  mcCatNames.join(' | '),
);
await page.keyboard.press('Escape');
await settle(page);
while ((await page.locator('.guide-overlay').count()) > 0) {
  await page.keyboard.press('Escape');
  await settle(page);
}

await page.getByLabel('편집기 검증 여행 여행 열기').first().click();
await page.waitForSelector('.moment-photo-input', { state: 'attached' });

// ── v2.35: 새 위치 지도는 **버튼을 누른 때의 현재 위치**로 제공자를 고른다.
// 현재 위치는 중심만 맞추고 선택으로 저장하지 않는다. 한국=Kakao, UZ=TomTom을 실제 클릭으로 잰다.
await page.locator('.moment-form .place-map').click();
await page.waitForSelector('.map-overlay');
await waitUntil(async () => (await page.locator('.map-canvas').getAttribute('data-map-provider')) !== null, 15000);
const seoulPicker = await page.locator('.map-canvas').getAttribute('data-map-provider');
check('새 위치 지도: 서울 현재 위치면 Kakao가 기본이다', seoulPicker === 'kakao', String(seoulPicker));
check(
  '새 위치 지도: 현재 위치는 중심일 뿐, 지도를 누르기 전에는 선택되지 않는다',
  await page.locator('.map-pick-confirm').isDisabled(),
);
// ── 🔴 모달 헤더 닫기 버튼의 터치 표적 (2026-08-15 · T-041) ────────────────────────
//    `.map-close`는 보이는 크기가 36px이라 44px에 못 미쳤다. 보이는 크기는 그대로 두고
//    히트 영역만 넓혔는데, **넓히기만 재면 반쪽이다** — M-0162에서 넓힌 영역이 이웃의
//    터치를 훔쳐 미달보다 나쁜 상태를 만들었다. 그래서 「44px」과 「덮는 것 0」을 함께 잰다.
await coverSweep('지도 오버레이', '.map-overlay'); // T-043
const mapCloseTarget = await closeButtonTarget('.map-close');
check('지도 닫기 버튼: 보이는 36px 그대로, **세로** 터치 표적 44px',
  mapCloseTarget?.visible === '36x36' && (mapCloseTarget?.hitH ?? 0) >= 44, JSON.stringify(mapCloseTarget));
check('지도 닫기 버튼: 넓힌 히트 영역이 이웃 버튼을 훔치지 않는다',
  (mapCloseTarget?.stolen.length ?? -1) === 0, JSON.stringify(mapCloseTarget?.stolen ?? null));

await page.locator('.map-close').click();
await page.waitForSelector('.map-overlay', { state: 'detached' });

await page.context().setGeolocation({ latitude: 41.2995, longitude: 69.2401, accuracy: 18 });
await page.evaluate(() => {
  const geo = navigator.geolocation;
  window.__mapPickerOriginalGetPosition = geo.getCurrentPosition.bind(geo);
  geo.getCurrentPosition = (ok) => ok({
    coords: { latitude: 41.2995, longitude: 69.2401, accuracy: 18 },
    timestamp: Date.now(),
  });
});
const uzReverseRoute = (route) => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({
    osm_type: 'node', osm_id: 35, lat: '41.2995', lon: '69.2401', name: 'Toshkent',
    display_name: 'Toshkent, Oʻzbekiston', place_rank: 16,
    address: { city: 'Toshkent', country: 'Oʻzbekiston', country_code: 'uz' },
  }),
});
await page.route('**/reverse**', uzReverseRoute);
const tomtomBefore = tomtomTileRequests;
await page.locator('.moment-form .place-map').click();
await page.waitForSelector('.map-overlay');
await waitUntil(async () => (await page.locator('.map-canvas').getAttribute('data-map-provider')) !== null, 15000);
const tashkentPicker = await page.locator('.map-canvas').getAttribute('data-map-provider');
check(
  '새 위치 지도: 타슈켄트 현재 위치면 TomTom이 기본이다',
  tashkentPicker === 'tomtom' && tomtomTileRequests > tomtomBefore,
  `provider=${tashkentPicker} · tile=${tomtomTileRequests - tomtomBefore}`,
);
check(
  '새 위치 지도: TomTom에서도 누르기 전에는 선택되지 않는다',
  await page.locator('.map-pick-confirm').isDisabled(),
);
await page.locator('.map-close').click();
await page.waitForSelector('.map-overlay', { state: 'detached' });
await page.unroute('**/reverse**', uzReverseRoute);
await page.evaluate(() => {
  if (window.__mapPickerOriginalGetPosition) {
    navigator.geolocation.getCurrentPosition = window.__mapPickerOriginalGetPosition;
    delete window.__mapPickerOriginalGetPosition;
  }
});
await page.context().setGeolocation({ latitude: 37.5665, longitude: 126.978, accuracy: 18 });

// 테스트 이미지 2장 생성(600x400 그라데이션 JPEG) — 배치 흐름 검증용
/**
 * **EXIF `DateTimeOriginal`을 실제로 품은 JPEG**을 만든다.
 *
 * 캔버스가 만든 JPEG에는 EXIF가 없다. 그래서 "사진에서 시각을 읽는다"를 라이브에서 잴 방법이
 * 없었고, 실제로 그 자리에 **옛 전제를 못박은 검사**가 하나 있었다(EXIF 없는 파일인데 사진
 * 근거가 나오길 기대했다 — 파일 수정시각으로 채우던 시절의 기대다). 전제가 바뀌었으니
 * 케이스를 뒤집고, 진짜 근거를 재려면 진짜 EXIF가 필요하다(§2-B ②).
 *
 * SOI 뒤에 APP1(Exif) 세그먼트를 끼워 넣는다. IFD0 → ExifIFD → 0x9003(DateTimeOriginal).
 */
function withExifDateTime(jpegBytes, dt /* 'YYYY:MM:DD HH:MM:SS' */) {
  const ascii = (s) => Buffer.from(s + '\0', 'latin1');
  const dtBuf = ascii(dt); // 20바이트
  // ── Exif 본문(TIFF 헤더 기준 오프셋) ──
  const tiff = [];
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  // TIFF 헤더(빅엔디안) + IFD0 오프셋 8
  tiff.push(Buffer.from('MM', 'latin1'), u16(42), u32(8));
  // IFD0: 항목 1개(ExifIFDPointer 0x8769) + next=0
  const ifd0Len = 2 + 12 + 4;
  const exifIfdOff = 8 + ifd0Len;
  tiff.push(u16(1), u16(0x8769), u16(4), u32(1), u32(exifIfdOff), u32(0));
  // ExifIFD: 항목 1개(DateTimeOriginal 0x9003, ASCII) + next=0, 값은 IFD 뒤에 붙인다
  const exifIfdLen = 2 + 12 + 4;
  const dtOff = exifIfdOff + exifIfdLen;
  tiff.push(u16(1), u16(0x9003), u16(2), u32(dtBuf.length), u32(dtOff), u32(0), dtBuf);
  const tiffBuf = Buffer.concat(tiff);
  const app1Body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiffBuf]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), u16(app1Body.length + 2), app1Body]);
  const src = Buffer.from(jpegBytes);
  return Buffer.concat([src.subarray(0, 2), app1, src.subarray(2)]); // SOI 뒤에 삽입
}

/**
 * **EXIF GPS를 품은 JPEG**을 만든다 (2026-07-30 · 사용자 제안 「사진에서 장소를 가져오자」).
 *
 * 왜 필요한가: 캔버스 JPEG에는 GPS가 없다. 픽스처 없이 이 기능을 라이브로 재려면 **DOM에
 * 값을 주입**해야 하는데, 그러면 재는 것이 *앱의 EXIF 파서*가 아니라 *내 주입*이 된다 —
 * 공허한 검사다(§4). 진짜 GPS를 심어 **앱이 스스로 읽게** 한다.
 *
 * IFD0에 GPSInfoIFDPointer(0x8825) 하나를 더 두고, GPS IFD에 Ref/좌표 넷을 쓴다.
 * 좌표는 RATIONAL 3쌍(도·분·초)이라 값이 IFD 밖에 붙는다 — `src/media/exif.ts`의 `readDMS`가
 * 그 형식을 읽는다(같은 계약을 양쪽에서 지킨다).
 */
function withExifGps(jpegBytes, dt /* 'YYYY:MM:DD HH:MM:SS' */, lat, lng) {
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const dtBuf = Buffer.from(dt + '\0', 'latin1');
  /** 도·분·초 RATIONAL 3쌍(24바이트). 초는 1/1000초 단위 분모로 적어 소수를 보존한다. */
  const dms = (v) => {
    const a = Math.abs(v);
    const d = Math.floor(a);
    const m = Math.floor((a - d) * 60);
    const sec = Math.round(((a - d) * 60 - m) * 60 * 1000);
    return Buffer.concat([u32(d), u32(1), u32(m), u32(1), u32(sec), u32(1000)]);
  };
  const entry = (tag, type, count, valueOrOffset) =>
    Buffer.concat([u16(tag), u16(type), u32(count), valueOrOffset]);
  /** ASCII 1글자는 값이 4바이트에 들어간다(왼쪽 정렬 + NUL). */
  const ascii1 = (ch) => Buffer.from(ch + '\0\0\0', 'latin1');

  const IFD0_LEN = 2 + 12 * 2 + 4;          // 항목 2개(ExifIFD·GPSIFD) + next
  const exifOff = 8 + IFD0_LEN;
  const EXIF_LEN = 2 + 12 + 4;              // 항목 1개(DateTimeOriginal) + next
  const dtOff = exifOff + EXIF_LEN;
  const gpsOff = dtOff + dtBuf.length;
  const GPS_LEN = 2 + 12 * 4 + 4;           // 항목 4개 + next
  const latValOff = gpsOff + GPS_LEN;
  const lngValOff = latValOff + 24;

  const tiff = Buffer.concat([
    Buffer.from('MM', 'latin1'), u16(42), u32(8),
    // IFD0
    u16(2),
    entry(0x8769, 4, 1, u32(exifOff)),
    entry(0x8825, 4, 1, u32(gpsOff)),
    u32(0),
    // ExifIFD
    u16(1), entry(0x9003, 2, dtBuf.length, u32(dtOff)), u32(0),
    dtBuf,
    // GPS IFD
    u16(4),
    entry(0x0001, 2, 2, ascii1(lat >= 0 ? 'N' : 'S')),
    entry(0x0002, 5, 3, u32(latValOff)),
    entry(0x0003, 2, 2, ascii1(lng >= 0 ? 'E' : 'W')),
    entry(0x0004, 5, 3, u32(lngValOff)),
    u32(0),
    dms(lat),
    dms(lng),
  ]);
  const app1Body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), u16(app1Body.length + 2), app1Body]);
  const src = Buffer.from(jpegBytes);
  return Buffer.concat([src.subarray(0, 2), app1, src.subarray(2)]);
}

const imgBuf = await page.evaluate(async () => {
  const c = document.createElement('canvas'); c.width = 600; c.height = 400;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 600, 400);
  g.addColorStop(0, '#e07b39'); g.addColorStop(1, '#3963e0');
  x.fillStyle = g; x.fillRect(0, 0, 600, 400);
  x.fillStyle = '#fff'; x.fillRect(280, 180, 40, 40);
  const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
  return Array.from(new Uint8Array(await b.arrayBuffer()));
});
const buf = Buffer.from(imgBuf);
await page.fill('input[placeholder^="이 순간을"]', '편집기 스모크');
await page.setInputFiles('.moment-photo-input', [
  { name: 'a.jpg', mimeType: 'image/jpeg', buffer: buf },
  { name: 'b.jpg', mimeType: 'image/jpeg', buffer: buf },
]);
await page.getByRole('button', { name: '순간 저장' }).click();

// ── 편집기 열림 ──
await page.waitForSelector('.pe-overlay', { timeout: 10000 });
check('편집기 모달 열림', true);
await coverSweep('사진 편집기', '.pe-overlay'); // T-043
// T-041 — 편집기 닫기 버튼(보이는 34px)의 터치 표적. 셋이 같은 함수를 지난다.
const peCloseTarget = await closeButtonTarget('.pe-close');
check('편집기 닫기 버튼: 보이는 34px 그대로, **세로** 터치 표적 44px',
  peCloseTarget?.visible === '34x34' && (peCloseTarget?.hitH ?? 0) >= 44, JSON.stringify(peCloseTarget));
check('편집기 닫기 버튼: 넓힌 히트 영역이 이웃 버튼을 훔치지 않는다',
  (peCloseTarget?.stolen.length ?? -1) === 0, JSON.stringify(peCloseTarget?.stolen ?? null));


// ── 🔴 v2.07: [초기화]가 **화면 표시 상태까지** 되돌리는가 (사용자 보고 2026-08-09) ──
// 사용자: *"버튼 누르면 원래 로딩되었던 사진으로 돌아가는 게 아니라 이상하게 확대된다."*
// 의심: `fitMode`(폭 채우기)와 `perspMode`는 **EditState 밖 클로저 변수**라
// `Object.assign(state, DEFAULT_EDIT)`가 못 건드린다. 눌러서 잰다(§13 4항).
{
  const fillBtn = page.getByRole('button', { name: '폭 채우기' });
  await fillBtn.click();
  await settle(page);
  const afterFill = await page.evaluate(() => ({
    stage: document.querySelector('.pe-stage')?.classList.contains('is-fill') ?? null,
    label: document.querySelector('.pe-geo button[aria-pressed]')?.textContent ?? '',
  }));
  check('폭 채우기를 누르면 실제로 채움 모드가 된다(전제 확인 — 아니면 아래 판정이 공허하다)', afterFill.stage === true, JSON.stringify(afterFill));

  await page.getByRole('button', { name: '초기화', exact: true }).click();
  await settle(page);
  const afterReset = await page.evaluate(() => {
    const st = document.querySelector('.pe-stage');
    const wrap = document.querySelector('.pe-canvas-wrap');
    const fit = [...document.querySelectorAll('button')].find((b) => /폭 채우기|높이 맞춤/.test(b.textContent || ''));
    return {
      stageFill: st?.classList.contains('is-fill') ?? null,
      wrapFill: wrap?.classList.contains('is-fill') ?? null,
      fitLabel: (fit?.textContent || '').trim(),
      fitPressed: fit?.getAttribute('aria-pressed') ?? null,
    };
  });
  check('🔴 초기화 뒤 채움 모드가 풀린다(원래 보이던 크기로 돌아온다)', afterReset.stageFill === false && afterReset.wrapFill === false, JSON.stringify(afterReset));
  check('🔴 초기화 뒤 버튼 라벨·눌림 표시도 원래대로다(화면과 상태가 어긋나지 않는다)', afterReset.fitLabel.includes('폭 채우기') && afterReset.fitPressed === 'false', JSON.stringify(afterReset));
}


// ── 🔴 v2.07: **핀치 줌 뒤 초기화**도 원래 화면으로 돌아오는가 (사용자 요청 2026-08-09) ──
// 앞 검사는 「폭 채우기 ↔ 초기화」만 쟀다. 확대는 `state.zoom`으로도 생기고 그건 EditState
// **안**이라 원래 되돌아가야 하지만, **되어야 하는 것과 되는 것은 다른 말**이다 — 눌러서 잰다.
// 판정은 내부 값이 아니라 **캔버스 픽셀**로 한다(WYSIWYG — 사용자가 보는 것이 진실이다).
{
  const sig = () =>
    page.evaluate(() => {
      const c = document.querySelector('.pe-canvas');
      if (!c) return null;
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, Math.min(64, c.width), Math.min(64, c.height)).data;
      let h = 0;
      for (let i = 0; i < d.length; i += 7) h = (h * 31 + d[i]) >>> 0;
      return `${c.width}x${c.height}:${h}`;
    });

  const before = await sig();
  // 두 손가락 핀치(포인터 두 개가 벌어짐) — 앱이 실제로 듣는 이벤트로 흉내 낸다.
  await page.evaluate(() => {
    const cv = document.querySelector('.pe-canvas');
    const r = cv.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const send = (type, id, x, y) =>
      cv.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true, pointerType: 'touch' }));
    send('pointerdown', 1, cx - 20, cy);
    send('pointerdown', 2, cx + 20, cy);
    for (let k = 1; k <= 6; k += 1) {
      send('pointermove', 1, cx - 20 - k * 12, cy);
      send('pointermove', 2, cx + 20 + k * 12, cy);
    }
    send('pointerup', 1, cx - 92, cy);
    send('pointerup', 2, cx + 92, cy);
  });
  // 슬라이더 값은 포인터 핸들러에서 먼저 바뀌고 canvas draw는 다음 프레임에 올 수 있다.
  // 내부 값만 기다리면 느린/바쁜 Chromium에서 확대 전 픽셀을 읽어 거짓 RED가 된다.
  await waitUntil(async () =>
    Number(await page.$eval('.pe-zoom', (i) => i.value)) > 1 && (await sig()) !== before,
  );
  const zoomed = await sig();
  const zoomVal = await page.evaluate(() => document.querySelector('.pe-zoom')?.value ?? null);
  // 전제 확인 — 확대가 실제로 걸리지 않았다면 아래 판정은 **공허하다**(§4).
  check('핀치로 실제 확대된다(전제 확인 — 아니면 아래 판정이 공허하다)', zoomed !== before && Number(zoomVal) > 1, JSON.stringify({ before, zoomed, zoomVal }));

  await page.getByRole('button', { name: '초기화', exact: true }).click();
  await waitUntil(async () => Number(await page.$eval('.pe-zoom', (i) => i.value)) === 1 && (await sig()) === before);
  const after = await sig();
  const zoomAfter = await page.evaluate(() => document.querySelector('.pe-zoom')?.value ?? null);
  check('🔴 핀치 줌 뒤 초기화하면 **원래 보이던 화면**으로 돌아온다(픽셀 대조)', after === before, JSON.stringify({ before, after }));
  check('🔴 확대 슬라이더 값도 1로 돌아온다(화면과 상태가 어긋나지 않는다)', Number(zoomAfter) === 1, String(zoomAfter));

  // 🔴 **검사는 뒤 형제의 전제를 건드리지 않고 물러난다.** 실측(2026-08-09): 이 probe를 넣자
  // 한참 뒤의 「이력 소진 → 실행취소 비활성」이 FAIL로 돌아섰다 — 핀치로 상태가 바뀐 뒤
  // [초기화]가 이력을 **하나 쌓기** 때문이다. 검사가 검사를 깨뜨리면 그 빨간불은 제품 결함이
  // 아니라 **내 흔적**이고, 그걸 못 가리면 다음 사람이 엉뚱한 데를 고친다.
  for (let k = 0; k < 20; k += 1) {
    const undo = page.locator('.pe-undo');
    if (await undo.isDisabled()) break;
    await undo.click();
    await settle(page);
  }
  check('핀치 probe가 이력을 남기지 않고 물러난다(뒤 검사의 전제 보존)', await page.locator('.pe-undo').isDisabled(), null);
}

// ── v0.72: 짧은 뷰포트(가로 태블릿)에서 모달이 잘리지 않는가 ──
// 실제 사고(2026-07-26, 사용자 실기기 가로 태블릿): 편집기 상하가 잘리고 여백이 없었다.
// 원인은 `.pe-overlay`가 `vh`(주소창 포함 높이)를 쓰고 오버레이가 스크롤하지 않은 것.
// 계약: 내용이 넘치면 **오버레이가 스크롤**해 전부 닿을 수 있어야 하고, 맨 위로 스크롤했을 때
// 모달 상단이 화면 밖(음수)이면 안 된다. 세 오버레이가 같은 규칙(.overlay-base)을 쓴다.
for (const [w, h, label] of [
  [1280, 620, '가로 태블릿(짧은 높이)'],
  [1024, 500, '가로 폰(아주 짧음)'],
  [412, 915, '세로 폰'],
]) {
  await page.setViewportSize({ width: w, height: h });
  await settle(page);
  const box = await page.evaluate(() => {
    const ov = document.querySelector('.pe-overlay');
    const sheet = document.querySelector('.pe-sheet');
    if (!ov || !sheet) return null;
    ov.scrollTop = 0;
    const s = sheet.getBoundingClientRect();
    const cs = getComputedStyle(ov);
    return {
      top: Math.round(s.top),
      scrollable: ov.scrollHeight > ov.clientHeight,
      overflowY: cs.overflowY,
      alignItems: cs.alignItems,
      padTop: parseFloat(cs.paddingTop),
      padBottom: parseFloat(cs.paddingBottom),
      reachBottom: Math.round(ov.scrollHeight - ov.clientHeight),
      overflowX: document.body.scrollWidth - document.body.clientWidth,
    };
  });
  // 계약을 **무조건** 만족해야 한다.
  //
  // ⚠️ 이 검사의 첫 판이 결함을 놓쳤다: `(!box.scrollable || overflowY === 'auto')` 로 썼더니
  // 헤드리스에서는 시트가 항상 들어맞아(scrollable=false) 조건이 단락되고 통과했다. 더 근본적으로
  // **헤드리스는 원인을 재현할 수 없다** — 실기기의 `vh`는 주소창이 보일 때 실제 화면보다 크지만
  // 헤드리스엔 그 차이가 없다. 그래서 기하가 아니라 **계약**(스크롤 가능·정렬·여백)을 본다.
  // 중앙정렬(place-items:center) + 넘침은 위아래로 똑같이 삐져나가 **스크롤로도 닿지 못한다** —
  // 사용자가 본 화면이 정확히 그것이다.
  const ok =
    box &&
    box.top >= 0 &&
    box.padTop >= 8 &&
    box.padBottom >= 8 &&
    box.overflowY === 'auto' &&
    box.alignItems !== 'center' &&
    box.overflowX <= 0;
  check(`편집기 ${label}: 상하 안 잘림 + 여백 + 스크롤 도달`, Boolean(ok), box ? JSON.stringify(box) : 'none');
}
await page.setViewportSize({ width: 412, height: 915 });
await settle(page);

// 슬라이더 값 표시
const valTexts = await page.$$eval('.pe-slider-val', (els) => els.map((e) => e.textContent));
check('슬라이더 값 표시(9개, 0/0.0°)', valTexts.length === 9 && valTexts.filter((t) => t === '0').length === 8 && valTexts.includes('0.0°'), JSON.stringify(valTexts));

// 프리셋 초기 활성 = 원본
const origPressed = await page.$eval('.pe-presets .pe-chip', (b) => b.getAttribute('aria-pressed'));
check('프리셋 "원본" 초기 활성', origPressed === 'true');

// 미리보기 sticky
const sticky = await page.$eval('.pe-stage', (s) => getComputedStyle(s).position);
check('미리보기 상단 고정(sticky)', sticky === 'sticky');
const actionsSticky = await page.$eval('.pe-actions', (s) => getComputedStyle(s).position);
check('액션바 하단 고정(sticky)', actionsSticky === 'sticky');

// 배치: "남은 2장 모두 원본" 버튼 존재
const skipAll = await page.getByRole('button', { name: /남은 2장 모두 원본/ }).count();
check('배치 스킵(⏭ 남은 2장 모두 원본) 노출', skipAll === 1);

// 슬라이더 조작 → 값 갱신 + 프리셋 해제 + 미리보기 픽셀 변화
const before = await page.$eval('.pe-canvas', (c) => c.getContext('2d').getImageData(0, 0, 1, 1).data.join(','));
const bright = page.locator('.pe-slider input[aria-label="밝기"]');
await bright.evaluate((i) => { i.value = '0.4'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); });
await settle(page);
const valAfter = await page.$eval('.pe-slider-val', (e) => e.textContent);
check('밝기 조작 → 값 "+40" 표시', valAfter === '+40', valAfter);
const origAfter = await page.$eval('.pe-presets .pe-chip', (b) => b.getAttribute('aria-pressed'));
check('수동 조정 → 프리셋 해제', origAfter === 'false');
const after = await page.$eval('.pe-canvas', (c) => c.getContext('2d').getImageData(0, 0, 1, 1).data.join(','));
check('미리보기 픽셀 실제 변화', before !== after, `${before} → ${after}`);

// 원본 비교(누르는 동안 보정 전) — pointerdown → 픽셀이 원래대로
await page.locator('.pe-compare').dispatchEvent('pointerdown', { pointerId: 1 });
await settle(page);
const cmp = await page.$eval('.pe-canvas', (c) => c.getContext('2d').getImageData(0, 0, 1, 1).data.join(','));
check('원본 비교(홀드) → 보정 전 픽셀', cmp === before, `${cmp} vs ${before}`);
await page.locator('.pe-compare').dispatchEvent('pointerup', { pointerId: 1 });
await settle(page);
const back = await page.$eval('.pe-canvas', (c) => c.getContext('2d').getImageData(0, 0, 1, 1).data.join(','));
check('비교 해제 → 보정 복귀', back === after);

// 전역 실행취소: 슬라이더 드래그 1회 = undo 1단계 → 값·픽셀이 원복
const undoEnabled = await page.$eval('.pe-undo', (b) => !b.disabled);
check('실행취소 버튼 활성(조작 후)', undoEnabled);
await page.locator('.pe-undo').click();
await settle(page);
const valUndo = await page.$eval('.pe-slider-val', (e) => e.textContent);
const pxUndo = await page.$eval('.pe-canvas', (c) => c.getContext('2d').getImageData(0, 0, 1, 1).data.join(','));
check('실행취소 → 밝기 0·픽셀 원복', valUndo === '0' && pxUndo === before, `val=${valUndo}`);
const undoDisabled = await page.$eval('.pe-undo', (b) => b.disabled);
check('이력 소진 → 실행취소 비활성', undoDisabled);
// 검증 후 다시 밝기 +40(이후 단계는 편집 존재를 전제)
await bright.evaluate((i) => { i.value = '0.4'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); });
await settle(page);

// 잡티 브러시: 크기 슬라이더 조작 → 반경 원 표시
await page.getByRole('button', { name: '🩹 잡티 제거' }).click();
await page.locator('input[aria-label="브러시 크기"]').evaluate((i) => { i.value = '6'; i.dispatchEvent(new Event('input', { bubbles: true })); });
const dotShown = await page.$eval('.pe-brush-dot', (d) => !d.hidden && parseFloat(d.style.width) > 0);
check('브러시 크기 원 표시', dotShown);
await page.getByRole('button', { name: '🩹 잡티 제거' }).click(); // 힐 모드 해제

// Esc 닫기 보호: 편집 중 Esc → confirm 뜸(취소 선택 → 유지)
let dialogSeen = null;
page.once('dialog', async (d) => { dialogSeen = d.message(); await d.dismiss(); });
await page.keyboard.press('Escape');
await settle(page);
const stillOpen = (await page.locator('.pe-overlay').count()) === 1;
check('편집 중 Esc → 확인 창 + 취소 시 유지', dialogSeen !== null && stillOpen, String(dialogSeen));

// 적용 → 두 번째 사진 편집기 → 남은 1장이므로 스킵올 없음 → 원본 사용
await page.getByRole('button', { name: '적용', exact: true }).click();
await page.waitForFunction(() => /2\/2/.test(document.querySelector('.pe-file')?.textContent ?? ''), null, { timeout: 20000 });
check('2번째 사진으로 진행(적용 후)', true);
await page.getByRole('button', { name: '원본 사용', exact: true }).click();

// 저장 완료 → 썸네일 2장
await page.waitForSelector('.pe-overlay', { state: 'detached' });
await page.waitForFunction(() => document.querySelectorAll('.moment-photo-grid img, .photo-grid img, img[alt="여행 사진"], .thumb img').length >= 2);
const thumbs = await page.evaluate(() => document.querySelectorAll('img').length);
check('저장 후 썸네일 렌더(이미지 ≥2)', thumbs >= 2, `imgs=${thumbs}`);

// 뷰어: 사진 탭 → 닫히지 않음, ◀▶·방향키 넘기기, Esc → 닫힘
// blob: URL은 fetch가 가능한 주소라는 보장이 없다. 뷰어가 실제로 createObjectURL에 건넨 Blob을
// 옆에서 기록해, 다운로드 파일과 같은 원본 바이트를 대조한다.
await observeViewerObjectUrls(page);
const firstThumb = page.locator('.photo-thumb').first();
await firstThumb.click();
await page.waitForSelector('.photo-viewer');
await page.locator('.photo-viewer img').click();
await settle(page);
check('뷰어: 사진 탭해도 유지', (await page.locator('.photo-viewer').count()) === 1);
const counterInit = await page.$eval('.photo-viewer-count', (e) => e.textContent);
check('뷰어: 위치 카운터(1 / 2)', counterInit === '1 / 2', counterInit);
await page.locator('.photo-viewer-next').click();
await settle(page);
const counterNext = await page.$eval('.photo-viewer-count', (e) => e.textContent);
check('뷰어: ▶ 다음 사진(2 / 2)', counterNext === '2 / 2', counterNext);

// v2.15: 지금 보고 있는 **두 번째** 사진의 앱 보관본을 실제 브라우저 다운로드로 받아 바이트를 대조한다.
const visiblePhotoBytes = Buffer.from(await page.locator('.photo-viewer img').evaluate(async (image) => {
  const blob = window.__liveObjectUrlBlobs.get(image.src);
  if (!blob) throw new Error(`사진 뷰어의 원본 Blob을 확보하지 못했습니다: ${image.src}`);
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}));
const photoDownloadStarted = page.waitForEvent('download');
await page.getByRole('button', { name: '이 사진 앱 보관본 저장' }).click();
const photoDownload = await photoDownloadStarted;
const photoDownloadPath = await photoDownload.path();
const savedPhotoBytes = photoDownloadPath ? await readFile(photoDownloadPath) : Buffer.alloc(0);
await page.waitForFunction(() => /사진 앱 보관본 다운로드를 요청했어요/.test(
  document.querySelector('.photo-viewer .media-viewer-save-status')?.textContent ?? '',
));
check('v2.15 사진 저장: 현재 두 번째 표시본의 이름·바이트를 그대로 다운로드한다',
  photoDownload.suggestedFilename().endsWith('.webp') && savedPhotoBytes.equals(visiblePhotoBytes),
  `${photoDownload.suggestedFilename()} bytes=${savedPhotoBytes.length}/${visiblePhotoBytes.length}`);

// 저장 실패도 완료로 반올림하지 않고, 관측된 사유를 말한 뒤 버튼과 뷰어를 되살린다.
await page.evaluate(() => {
  window.showSaveFilePicker = async () => { throw new Error('라이브 저장 실패'); };
});
await page.getByRole('button', { name: '이 사진 앱 보관본 저장' }).click();
await page.waitForFunction(() => /라이브 저장 실패/.test(
  document.querySelector('.photo-viewer .media-viewer-save-status')?.textContent ?? '',
));
check('v2.15 사진 저장: 실패 사유 표시 뒤 버튼 재활성·뷰어 유지',
  await page.getByRole('button', { name: '이 사진 앱 보관본 저장' }).isEnabled()
    && await page.locator('.photo-viewer').count() === 1);
await page.evaluate(() => { window.showSaveFilePicker = undefined; });

// 가장 좁은 폰에서도 편집·저장과 카운터가 겹치지 않고 터치 목표가 44px 이상이다.
const beforeViewerViewport = page.viewportSize();
await page.setViewportSize({ width: 344, height: 760 });
const narrowViewer = await page.locator('.photo-viewer').evaluate((overlay) => {
  const actions = overlay.querySelector('.media-viewer-actions').getBoundingClientRect();
  const count = overlay.querySelector('.photo-viewer-count').getBoundingClientRect();
  const buttons = [...overlay.querySelectorAll('.media-viewer-actions button')].map((button) => button.getBoundingClientRect().height);
  return { actionsBottom: actions.bottom, countTop: count.top, minButtonHeight: Math.min(...buttons) };
});
check('v2.15 사진 저장: 344px에서 액션·카운터 비겹침과 44px 터치 목표',
  narrowViewer.actionsBottom <= narrowViewer.countTop && narrowViewer.minButtonHeight >= 44,
  JSON.stringify(narrowViewer));
  await page.setViewportSize(beforeViewerViewport ?? { width: 1280, height: 900 });

await page.keyboard.press('ArrowRight'); // 순환 → 1/2
await settle(page);
const counterWrap = await page.$eval('.photo-viewer-count', (e) => e.textContent);
check('뷰어: 방향키 + 끝에서 순환(1 / 2)', counterWrap === '1 / 2', counterWrap);
check('뷰어: 넘겨도 열림 유지', (await page.locator('.photo-viewer').count()) === 1);

// v0.40: 뷰어 확대(휠) → is-zoomed + transform scale 상승, '0' 키로 원복
const vbox = await page.locator('.photo-viewer img').boundingBox();
await page.mouse.move(vbox.x + vbox.width / 2, vbox.y + vbox.height / 2);
await page.mouse.wheel(0, -400);
await settle(page);
const zoomedCls = await page.$eval('.photo-viewer img', (i) => i.classList.contains('is-zoomed'));
const zoomedScale = await page.$eval('.photo-viewer img', (i) => {
  const m = /scale\(([\d.]+)\)/.exec(i.style.transform);
  return m ? parseFloat(m[1]) : 1;
});
check('뷰어: 휠 확대 → 배율 상승·is-zoomed', zoomedCls && zoomedScale > 1.05, `scale=${zoomedScale}`);
await page.keyboard.press('0');
await settle(page);
const resetScale = await page.$eval('.photo-viewer img', (i) => {
  const m = /scale\(([\d.]+)\)/.exec(i.style.transform);
  return m ? parseFloat(m[1]) : 1;
});
check("뷰어: '0' 키 → 확대 원복(1x)", resetScale === 1, `scale=${resetScale}`);

await page.keyboard.press('Escape');
await settle(page);
check('뷰어: Esc로 닫힘', (await page.locator('.photo-viewer').count()) === 0);
await stopObservingViewerObjectUrls(page);

// ── v0.26: 세로 사진 잘림(M-flex-clip) + Ctrl+휠 줌 + 핀치 줌 ──
// 세로(500x1200) 사진 1장을 새 순간으로 → 편집기에서 스테이지가 캔버스를 짜부라뜨리지 않는지.
const tallBuf = Buffer.from(await page.evaluate(async () => {
  const c = document.createElement('canvas'); c.width = 500; c.height = 1200;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, 1200);
  g.addColorStop(0, '#39a0e0'); g.addColorStop(1, '#e0398f');
  x.fillStyle = g; x.fillRect(0, 0, 500, 1200);
  const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
  return Array.from(new Uint8Array(await b.arrayBuffer()));
}));
await page.fill('input[placeholder^="이 순간을"]', '세로 사진 검증');
await page.setInputFiles('.moment-photo-input', [{ name: 'tall.jpg', mimeType: 'image/jpeg', buffer: tallBuf }]);
await page.getByRole('button', { name: '순간 저장' }).click();
await page.waitForSelector('.pe-overlay', { timeout: 10000 });
await page.waitForFunction(() => {
  const st = document.querySelector('.pe-stage');
  const cv = document.querySelector('.pe-canvas');
  return !!st && !!cv && cv.clientHeight > 0 && st.clientHeight >= cv.clientHeight - 1;
});
const clip = await page.evaluate(() => {
  const st = document.querySelector('.pe-stage');
  const cv = document.querySelector('.pe-canvas');
  return { st: st.clientHeight, cv: cv.clientHeight };
});
check('세로 사진: 스테이지 무압착(캔버스 온전 표시)', clip.st >= clip.cv - 1, JSON.stringify(clip));

// Ctrl+휠 확대(실입력: Control 키 + 휠) → 줌 슬라이더 값 상승
const previewPixel = () => page.$eval('.pe-canvas', (c) => c.getContext('2d').getImageData(1, 1, 1, 1).data.join(','));
const zoomBefore = parseFloat(await page.$eval('.pe-zoom', (i) => i.value));
const pxBeforeWheel = await previewPixel();
const cbox = await page.locator('.pe-canvas').boundingBox();
await page.mouse.move(cbox.x + cbox.width / 2, cbox.y + cbox.height / 2);
await page.keyboard.down('Control');
await page.mouse.wheel(0, -300);
await page.keyboard.up('Control');
await waitUntil(async () =>
  Number(await page.$eval('.pe-zoom', (i) => i.value)) > zoomBefore && (await previewPixel()) !== pxBeforeWheel,
);
const zoomAfterWheel = parseFloat(await page.$eval('.pe-zoom', (i) => i.value));
check('Ctrl+휠 → 미리보기 확대(줌 상승)', zoomAfterWheel > zoomBefore, `${zoomBefore} → ${zoomAfterWheel}`);

// 핀치 줌(두 손가락, 합성 포인터) → 줌 추가 상승
const pxBeforePinch = await previewPixel();
await page.evaluate(() => {
  const cv = document.querySelector('.pe-canvas');
  const r = cv.getBoundingClientRect();
  const cx = r.left + r.width / 2; const cy = r.top + r.height / 2;
  const ev = (type, id, x, y) =>
    cv.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true, isPrimary: id === 21 }));
  ev('pointerdown', 21, cx - 20, cy);
  ev('pointerdown', 22, cx + 20, cy);
  ev('pointermove', 22, cx + 80, cy); // 벌리기 → 확대
  ev('pointerup', 21, cx - 20, cy);
  ev('pointerup', 22, cx + 80, cy);
});
await waitUntil(async () =>
  Number(await page.$eval('.pe-zoom', (i) => i.value)) > zoomAfterWheel && (await previewPixel()) !== pxBeforePinch,
);
const zoomAfterPinch = parseFloat(await page.$eval('.pe-zoom', (i) => i.value));
check('핀치(두 손가락 벌리기) → 확대', zoomAfterPinch > zoomAfterWheel, `${zoomAfterWheel} → ${zoomAfterPinch}`);

// ── v0.39: 원근 펴기(4점) — 모드 진입 → 핸들 드래그 → 적용 → 픽셀 변화 → undo 원복 ──
const pxPrePersp = await previewPixel();
await page.getByRole('button', { name: '📐 펴기' }).click();
await page.waitForFunction(() => {
  const box = document.querySelector('.pe-quad-box');
  return !!box && !box.hidden
    && document.querySelectorAll('.pe-quad-h').length === 4
    && document.querySelectorAll('.pe-quad-edge').length === 4;
});
const quadShown = await page.evaluate(() => {
  const box = document.querySelector('.pe-quad-box');
  return box && !box.hidden
    && document.querySelectorAll('.pe-quad-h').length === 4
    && document.querySelectorAll('.pe-quad-edge').length === 4;
});
check('펴기 모드: 모서리 4점 + 잡을 수 있는 점선 4개 표시', !!quadShown);
const perspBarShown = await page.evaluate(() => !document.querySelector('.pe-perspbar').hidden);
check('펴기 모드: 확정 바 노출', perspBarShown);
// TL 핸들을 아래로 드래그(세로 그라데이션이라 색이 달라지는 방향)
const polyBefore = await page.$eval('.pe-quad-svg polygon', (p) => p.getAttribute('points'));
await page.evaluate(() => {
  const box = document.querySelector('.pe-quad-box');
  const hnd = document.querySelector('.pe-quad-h[data-idx="0"]');
  const wrap = document.querySelector('.pe-canvas-wrap').getBoundingClientRect();
  const r = hnd.getBoundingClientRect();
  const sx = r.left + r.width / 2; const sy = r.top + r.height / 2;
  const ev = (type, x, y) =>
    (type === 'pointerdown' ? hnd : box).dispatchEvent(
      new PointerEvent(type, { pointerId: 31, clientX: x, clientY: y, bubbles: true, isPrimary: true }),
    );
  ev('pointerdown', sx, sy);
  ev('pointermove', sx, sy + wrap.height * 0.25);
  ev('pointerup', sx, sy + wrap.height * 0.25);
});
await settle(page);
const polyAfter = await page.$eval('.pe-quad-svg polygon', (p) => p.getAttribute('points'));
check('펴기: 핸들 드래그 → 사다리꼴 갱신', polyBefore !== polyAfter, `${polyBefore} → ${polyAfter}`);

// 사용자가 요청한 점선 자체 드래그를 **손가락 입력**으로 확인한다. 아래쪽 변을 위로 끌면
// 두 끝점이 같은 벡터로 움직이고 위쪽 두 점은 그대로여야 한다.
const edgeBefore = await page.$eval('.pe-quad-svg polygon', (p) =>
  p.getAttribute('points').split(' ').map((pair) => pair.split(',').map(Number)),
);
const edgeTouch = await page.evaluate(() => {
  const line = document.querySelector('.pe-quad-edge[data-edge="2"]');
  const svg = document.querySelector('.pe-quad-svg');
  const r = svg.getBoundingClientRect();
  const x1 = Number(line.getAttribute('x1')); const x2 = Number(line.getAttribute('x2'));
  const y1 = Number(line.getAttribute('y1')); const y2 = Number(line.getAttribute('y2'));
  return {
    x: r.left + ((x1 + x2) / 200) * r.width,
    y: r.top + ((y1 + y2) / 200) * r.height,
    dy: r.height * 0.12,
    stroke: parseFloat(getComputedStyle(line).strokeWidth),
  };
});
check('펴기 점선: 손가락용 투명 잡기 영역이 24px 이상', edgeTouch.stroke >= 24, `${edgeTouch.stroke}px`);
const quadCdp = await page.context().newCDPSession(page);
const quadTouch = (type, x, y) => quadCdp.send('Input.dispatchTouchEvent', {
  type,
  touchPoints: type === 'touchEnd' ? [] : [{ x, y, radiusX: 12, radiusY: 12, force: 1 }],
});
await quadTouch('touchStart', edgeTouch.x, edgeTouch.y);
for (let step = 1; step <= 4; step += 1) {
  await quadTouch('touchMove', edgeTouch.x, edgeTouch.y - (edgeTouch.dy * step) / 4);
}
await quadTouch('touchEnd', edgeTouch.x, edgeTouch.y - edgeTouch.dy);
await settle(page);
const edgeAfter = await page.$eval('.pe-quad-svg polygon', (p) =>
  p.getAttribute('points').split(' ').map((pair) => pair.split(',').map(Number)),
);
const close = (a, b, tolerance = 0.2) => Math.abs(a - b) <= tolerance;
const bottomDx2 = edgeAfter[2][0] - edgeBefore[2][0];
const bottomDy2 = edgeAfter[2][1] - edgeBefore[2][1];
const bottomDx3 = edgeAfter[3][0] - edgeBefore[3][0];
const bottomDy3 = edgeAfter[3][1] - edgeBefore[3][1];
const edgeMovedTogether =
  close(edgeAfter[0][0], edgeBefore[0][0]) && close(edgeAfter[0][1], edgeBefore[0][1])
  && close(edgeAfter[1][0], edgeBefore[1][0]) && close(edgeAfter[1][1], edgeBefore[1][1])
  && close(bottomDx2, bottomDx3) && close(bottomDy2, bottomDy3)
  && bottomDy2 < -2;
check('펴기: 아래 점선을 손가락으로 끌면 양 끝점이 함께 움직인다', edgeMovedTogether, JSON.stringify({ edgeBefore, edgeAfter }));
if (process.env.PHOTO_PERSPECTIVE_SCREENSHOT) {
  await page.screenshot({ path: resolve(process.env.PHOTO_PERSPECTIVE_SCREENSHOT), fullPage: false });
}
await page.getByRole('button', { name: '📐 반듯하게 펴기' }).click();
await waitUntil(async () => {
  const state = await page.$eval('.pe-quad-box', (b) => b.hidden);
  const px = await page.$eval('.pe-canvas', (c) => c.getContext('2d').getImageData(1, 1, 1, 1).data.join(','));
  return state && px !== pxPrePersp;
});
const quadGone = await page.$eval('.pe-quad-box', (b) => b.hidden);
const pxPersp = await page.$eval('.pe-canvas', (c) => c.getContext('2d').getImageData(1, 1, 1, 1).data.join(','));
check('펴기 적용: 오버레이 종료 + 픽셀 실제 변화', quadGone && pxPersp !== pxPrePersp, `${pxPrePersp} → ${pxPersp}`);
await page.locator('.pe-undo').click();
await waitUntil(async () => (await page.$eval('.pe-canvas', (c) => c.getContext('2d').getImageData(1, 1, 1, 1).data.join(','))) === pxPrePersp);
const pxUndoPersp = await page.$eval('.pe-canvas', (c) => c.getContext('2d').getImageData(1, 1, 1, 1).data.join(','));
check('펴기 undo → 픽셀 원복', pxUndoPersp === pxPrePersp, `${pxPersp} → ${pxUndoPersp}`);

await page.getByRole('button', { name: '원본 사용', exact: true }).click();
await page.waitForSelector('.pe-overlay', { state: 'detached' });

// ── v0.41: 가로 태블릿에서 가로 사진 전체보기 — 위아래 잘림 없이 전체가 뷰포트에 들어와야 함 ──
// (버그: grid+max-height:100%가 가로 화면에서 높이 제약 실패 → 폭만 맞고 상하 오버플로.)
await page.setViewportSize({ width: 1600, height: 1000 }); // 가로 태블릿
const wideBuf = Buffer.from(await page.evaluate(async () => {
  const c = document.createElement('canvas'); c.width = 1600; c.height = 1200; // 4:3 가로 사진
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 1600, 1200);
  g.addColorStop(0, '#2b8a3e'); g.addColorStop(1, '#e8590c');
  x.fillStyle = g; x.fillRect(0, 0, 1600, 1200);
  const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
  return Array.from(new Uint8Array(await b.arrayBuffer()));
}));
await page.fill('input[placeholder^="이 순간을"]', '가로 사진 태블릿 검증');
await page.setInputFiles('.moment-photo-input', [{ name: 'wide.jpg', mimeType: 'image/jpeg', buffer: wideBuf }]);
await page.getByRole('button', { name: '순간 저장' }).click();
await page.waitForSelector('.pe-overlay', { timeout: 10000 });
await page.getByRole('button', { name: '원본 사용', exact: true }).click();
await page.waitForSelector('.pe-overlay', { state: 'detached' });
await page.locator('.moment-card', { hasText: '가로 사진 태블릿 검증' }).locator('.photo-thumb').first().waitFor();
// ⚠️ **`.photo-thumb`의 last()가 방금 넣은 사진이라고 가정하지 않는다**(자기점검 2026-07-27).
//
// 이 검사는 흔들렸다 — 실측 4회 중 3회 실패. 처음엔 "레이아웃 대기가 짧아서"라고 **확인 없이
// 단정**했는데, 계측해 보니 실패할 때마다 값이 **똑같이 `600×400`**이었다. 지터라면 값이
// 달라야 한다. `naturalWidth`를 찍어 보니 답이 나왔다:
//
//   통과: nat=1600x1200 (방금 넣은 wide.jpg)   실패: nat=600x400 (**앞 단계의 다른 사진**)
//
// 크기 계산이 틀린 게 아니라 **다른 사진을 열고 있었다.** `.photo-thumb`는 여행 전체의
// 썸네일이고(이 시점 4장), 그 순서는 사진 정렬에 달렸다 — 같은 순간에 넣은 캔버스 사진들은
// 시각이 겹쳐 순서가 갈릴 수 있다. 셀렉터가 틀린 것을 집고 있었다(§4가 말하는 "셀렉터 불일치").
//
// 그래서 **방금 만든 순간의 카드 안**에서 고른다 — 전역 정렬과 무관해진다.
// 그리고 **위치가 아니라 정체로** 집는다. `.moment-card`의 last()도 못 믿는다 —
// v1.06부터 순간의 기본 발생 시각이 「사진의 EXIF → 직전 순간 → 여행 시작일」이라
// **방금 만든 순간이 목록의 끝에 오지 않는다.** 순서를 바꾸는 기능 변경이 검사의 숨은
// 전제("최신 = 마지막")를 무효로 만든 것이다. 제목으로 찾으면 정렬과 무관해진다.
await page.locator('.moment-card', { hasText: '가로 사진 태블릿 검증' }).locator('.photo-thumb').first().click();
await page.waitForSelector('.photo-viewer');
// 그리고 시간이 아니라 **조건**을 기다린다(고정 sleep은 조건이 아니라 희망이다).
await page.waitForFunction(() => {
  const im = document.querySelector('.photo-viewer img');
  return !!im && im.complete && im.naturalWidth > 0 && im.getBoundingClientRect().height > 0;
}, { timeout: 10000 });
const fit = await page.evaluate(() => {
  const im = document.querySelector('.photo-viewer img');
  const r = im.getBoundingClientRect();
  return { rw: Math.round(r.width), rh: Math.round(r.height), vw: window.innerWidth, vh: window.innerHeight };
});
check('가로 태블릿: 가로 사진 전체가 뷰포트에 들어옴(상하 안 잘림)',
  fit.rh <= fit.vh + 1 && fit.rw <= fit.vw + 1, JSON.stringify(fit));
// 가로 사진(4:3)이 가로 뷰포트(16:10)에서 높이 제약을 받는지: 렌더 높이가 뷰포트에 거의 꽉 참
check('가로 태블릿: 높이 기준 맞춤(꽉 채움)', fit.rh >= fit.vh - 60, JSON.stringify(fit));
await page.keyboard.press('Escape');

// ── v0.50: 환율 배지 탭 → 적용 환율일·기준환율 상세 ──
// 샌드박스가 환율 API를 차단하므로 **Dexie 캐시에 표를 직접 주입**해 UI 경로만 검증한다
// (네트워크 검증이 아님을 명시 — 실 응답은 실기기 몫).
const injected = await page.evaluate(async () => {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const row = {
    id: `${today}|KRW`,
    date: today,
    base: 'KRW',
    rates: { UZS: 9.2 }, // 1 KRW = 9.2 UZS
    source: 'test-injected',
    fetchedAt: new Date().toISOString(),
  };
  await new Promise((resolve, reject) => {
    const req = indexedDB.open('journey-archive');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('localFxRates', 'readwrite');
      tx.objectStore('localFxRates').put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
  return today;
});
check('환율 캐시 주입(테스트 픽스처)', Boolean(injected), String(injected));

await page.fill('input[placeholder^="이 순간을"]', '환율 배지 검증');
await page.fill('input[placeholder^="💰 비용"]', '50000');
await page.selectOption('.moment-currency', 'UZS');
await page.getByRole('button', { name: '순간 저장' }).click();
await page.waitForSelector('.chip-approx', { timeout: 10000 });
const approxText = await page.$eval('.chip-approx', (b) => b.textContent);
// 50,000 UZS ÷ 9.2 = 5,434.78 → KRW는 소수 없음 → ₩5,435
check('환율 배지 렌더(≈ 환산값)', /≈\s*₩5,43\d/.test(approxText ?? ''), approxText ?? '');

const expandedBefore = await page.$eval('.chip-approx', (b) => b.getAttribute('aria-expanded'));
check('환율 배지: 초기 접힘(aria-expanded=false)', expandedBefore === 'false', String(expandedBefore));

await page.locator('.chip-approx').first().click();
await page.waitForSelector('.fx-detail:not([hidden])', { timeout: 5000 });
const detail = await page.$eval('.fx-detail', (d) => d.textContent ?? '');
check('환율 상세: 적용 환율일 표시', detail.includes('적용 환율일') && detail.includes(injected), detail.slice(0, 60));
check('환율 상세: 단위 환율 양방향', /1 UZS = /.test(detail) && /1 KRW = 9\.2 UZS/.test(detail), detail.slice(0, 120));
check('환율 상세: 계산식(검산 가능)', /계산/.test(detail) && /×/.test(detail), '');
check('환율 상세: 출처 표기', detail.includes('test-injected'), '');
const expandedAfter = await page.$eval('.chip-approx', (b) => b.getAttribute('aria-expanded'));
check('환율 배지: 펼침 상태 반영(aria-expanded=true)', expandedAfter === 'true', String(expandedAfter));

// 같은 배지 다시 탭 → 접힘
await page.locator('.chip-approx').first().click();
await settle(page);
const hiddenAgain = await page.$eval('.fx-detail', (d) => d.hidden);
check('환율 배지: 다시 탭하면 접힘', hiddenAgain === true, String(hiddenAgain));

// ── 🔴 v1.28: 사진이 아는 것을 사람에게 다시 치게 하지 않는다 (사용자 제안 2026-07-30) ────
//
// *"장소도 사진 입력하면 사진정보에서 우선 가져오도록 하면 어떨까요?"*
// *"비용을 입력할 때 간단하게 어떤 비용인지 적게하면 어떨까요?"*
// *"여행시간대를 드롭다운해서 선택하게끔하고. 초기값은 사진찍은 장소로 셋팅..어때?"*
//
// 🔴 **진짜 EXIF GPS를 심어 앱이 스스로 읽게 한다.** DOM에 좌표를 주입하면 재는 것이
// *앱의 파서*가 아니라 *내 주입*이 된다 — 공허한 검사다(§4).
//
// §3-C: 이 블록은 장소·비용 칸을 채우고 순간을 하나 더 만든다. 뒤 검사가 「첫 순간」을 보지
// 않도록 **폼을 비우고** 끝낸다.
const clearBeforeGps = page.locator('.pick-clear-all');
if (await clearBeforeGps.count()) await clearBeforeGps.click();
await settle(page);
await page.setInputFiles('.moment-photo-input', [
  { name: 'gps.jpg', mimeType: 'image/jpeg', buffer: withExifGps(imgBuf, '2026:07:16 09:30:00', 16.0544, 108.2022) },
]);
await page.waitForFunction(() => {
  const note = document.querySelector('.place-photo-note');
  const badge = document.querySelector('.place-picked');
  return !!note && !note.hidden && (note.textContent ?? '').includes('16.05440') && !!badge && !badge.hidden;
});
const fromPhoto = await page.evaluate(() => {
  const n = document.querySelector('.place-photo-note');
  return {
    note: n && !n.hidden ? (n.textContent ?? '') : '',
    badge: document.querySelector('.place-picked')?.textContent ?? '',
    typed: document.querySelector('.place-input')?.value ?? '',
  };
});
check(
  '사진 장소: EXIF GPS가 있으면 **좌표를 대신 채운다**(§12 — 앱이 아는 것을 사람에게 묻지 않는다)',
  fromPhoto.note.includes('📷 사진 위치에서') && fromPhoto.note.includes('16.05440'),
  fromPhoto.note || '(근거 줄 없음)',
);
check('사진 장소: 무엇이 지정됐는지 배지로 말한다', fromPhoto.badge.length > 0, fromPhoto.badge || '(배지 없음)');

// **사용자가 손댄 것은 덮지 않는다** — 이름을 적은 뒤 다른 사진을 골라도 그대로다.
await page.fill('.place-input', '내가 적은 장소');
const firstGpsPreview = await page.locator('.pick-cell img').first().getAttribute('src');
await page.setInputFiles('.moment-photo-input', [
  { name: 'gps2.jpg', mimeType: 'image/jpeg', buffer: withExifGps(imgBuf, '2026:07:16 10:00:00', 21.0278, 105.8342) },
]);
await page.waitForFunction((previousSrc) => {
  const input = document.querySelector('.moment-photo-input');
  const src = document.querySelector('.pick-cell img')?.getAttribute('src') ?? '';
  return input?.files?.[0]?.name === 'gps2.jpg' && src.length > 0 && src !== previousSrc;
}, firstGpsPreview);
const keptPlace = await page.evaluate(() => document.querySelector('.place-input')?.value ?? '');
check('사진 장소: 사용자가 적은 이름을 사진이 덮지 않는다(앱이 사용자를 이기지 않는다)', keptPlace === '내가 적은 장소', keptPlace);

// 🔴 배지의 ✕로 **좌표까지** 해제한다. 이름만 지우면 좌표는 남는데(사진 좌표는 이름과
// 독립이라 그게 맞다) 그러면 「이미 손댔다」로 판정돼 제안이 안 돈다 — 실제 사용자 경로는 ✕다.
await page.fill('.place-input', '');

// ── T-035(2026-08-14): 위치 해제 ✕의 **실제 누를 수 있는 넓이**를, 「무엇을 덮는가」와 **함께** 잰다.
//    🔴 왜 함께인가 — `.chip-x`의 머리주석에 이미 적혀 있다: 예전에 히트 영역을 넓혔다가 아래
//    사진 격자를 덮었고, **보이지 않는 *삭제* 표적이 다른 것 위에 얹히는 것은 미달보다 나쁘다.**
//    여기서도 실측이 그 판단을 되풀이했다 — 44×44로 키우면 바로 옆 「좌표 복사」를 덮는다.
//    그래서 계약은 「44×44」가 아니라 **「세로 44px + 덮는 요소 0건」**이다(그 이유는 app.css에).
const t035 = await page.evaluate(() => {
  const btn = document.querySelector('.moment-form .place-picked .chip-clear');
  if (!btn) return null;
  const box = btn.getBoundingClientRect();
  const after = getComputedStyle(btn, '::after');
  const grow = (v) => Math.abs(parseFloat(v) || 0);
  // 실제 히트 영역 = 보이는 상자 + ::after가 넘긴 만큼.
  const hit = { w: box.width + grow(after.left) + grow(after.right), h: box.height + grow(after.top) + grow(after.bottom) };
  // 그 영역의 가장자리·중앙 9점에서 **다른 조작 요소**가 잡히는지 본다(덮음 = 오작동 위험).
  const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
  const covered = [];
  for (const dx of [-hit.w / 2 + 1, 0, hit.w / 2 - 1]) for (const dy of [-hit.h / 2 + 1, 0, hit.h / 2 - 1]) {
    const el = document.elementFromPoint(cx + dx, cy + dy)?.closest('button, a, input, select, textarea, [role="button"]');
    const cls = el && el !== btn ? (el.className || el.tagName) : null;
    if (cls && !covered.includes(cls)) covered.push(cls);
  }
  return { w: Math.round(hit.w), h: Math.round(hit.h), visible: Math.round(box.width), covered };
});
check('T-035 위치 해제 ✕: 세로 터치 표적 44px 이상 · 보이는 크기는 24px 유지',
  (t035?.h ?? 0) >= 44 && t035?.visible === 24, JSON.stringify(t035));
check('T-035 위치 해제 ✕: 넓힌 히트 영역이 다른 조작 요소를 덮지 않는다(복사하려다 해제되면 안 된다)',
  (t035?.covered.length ?? -1) === 0, JSON.stringify(t035?.covered ?? null));

await page.locator('.moment-form .place-picked .chip-clear').first().click(); // 생성 폼의 것(편집 폼들과 구분)
await settle(page);

// ─────────────────────────────────────────────────────────────────────────────
// ⌨️ v1.78 — **글자를 치면 바로 「내 장소」가 나오는가** (사용자 지적 2026-08-05)
//
// *"글자를 치면 바로 장소조회가 되야 하는데 그렇지 않네요?"* — 맞는 지적이었고 **형제
// 비대칭**이었다: 위치관리대장 화면은 치는 즉시 찾아 주는데 순간 편집의 같은 칸은
// [🔍 검색]을 눌러야 했다(§7 사용자 대면 대칭).
//
// 🔴 이 검사가 재는 **두 번째** 것이 더 중요하다: 치는 동안 **아무것도 기기 밖으로 안 나간다.**
// 키 하나마다 지오코더에 물으면 검색어가 곧 「어디에 갔는가」이므로 매 자모가 밖으로 나간다
// (map-place-dev §2 · 비타협 원칙 #3). 그 경계는 조용히 무너지기 쉬워서 기계로 잠근다.
//
// §4 주입 기록(2026-08-05) — **어떤 주입이 RED로 잡히는지 재봤다**:
//   ✅ 지오코더 호출을 치는 경로에 넣기(CSP 허용 호스트) → RED. 진짜 회귀의 모양이 이것이다.
//   ✅ 「2글자 이상만 조회」로 되돌리기 → RED(목록·출처 줄 둘 다).
//   ⚠️ CSP가 **막는** 호스트로 부르기 → 초록. 요청이 렌더러에서 죽어 여기까지 안 온다.
//      이 검사는 그 경우 CSP를 재고 있는 것이지 앱을 재는 게 아니다 — 다행히 진짜 지오코더는
//      `connect-src`에 있어야 동작하므로(index.html) 실제 회귀는 위 ✅ 경로로 잡힌다.
//   ⚠️ `wireNameEdit`이 상자를 다시 감추게 되돌리기 → 초록. 감추기는 동기, 그리기는 120ms
//      뒤라 타이밍이 이긴다. **그 정리는 설계 규율이고 기계가 못 본다**(코드 주석에 적어 뒀다).
// ─────────────────────────────────────────────────────────────────────────────
const lrSeed = await page.evaluate(async () => {
  const now = new Date().toISOString();
  const rows = [
    { id: 'lr-live-a', name: '시드니 오페라하우스', latitude: -33.8568, longitude: 151.2153 },
    { id: 'lr-live-b', name: '타슈켄트 의대', latitude: 41.3111, longitude: 69.2797 },
  ].map((r) => ({
    ...r, formattedAddress: null, provider: null, providerPlaceId: null,
    countryCode: null, country: null, region: null, city: null, district: null, postcode: null,
    category: null, memo: null, precision: null, spanMeters: null, mapPicked: false,
    version: 1, baseVersion: 0, createdAt: now, updatedAt: now, deletedAt: null,
    clientOperationId: `lr-live-${r.id}`,
  }));
  await new Promise((resolve, reject) => {
    const req = indexedDB.open('journey-archive');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('localPlaces', 'readwrite');
      for (const r of rows) tx.objectStore('localPlaces').put(r);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
  return rows.length;
});
check('치는 동안 조회: 픽스처 주입(장소 2건)', lrSeed === 2, String(lrSeed));

// 🔴 **밖으로 나간 요청을 센다.** 로컬 시험서버가 아닌 곳으로 간 것만 잡는다 —
// 「지오코더를 안 불렀다」를 앱 내부 플래그가 아니라 **실제 네트워크**로 판정한다(§3).
const offBox = [];
const offBoxWatch = (req) => {
  const u = req.url();
  if (!u.startsWith('http://localhost:4173') && !u.startsWith('data:') && !u.startsWith('blob:')) offBox.push(u);
};
page.on('request', offBoxWatch);

// 한 글자만 친다 — [🔍 검색]은 **누르지 않는다**. 그게 이 검사의 전부다.
await page.fill('.moment-form .place-input', '시');
await page.waitForFunction(() => {
  const r = document.querySelector('.moment-form .place-results');
  return !!r && !r.hidden && [...r.querySelectorAll('.place-result-name')].some((n) => (n.textContent ?? '').includes('시드니'));
});
const lrTyped = await page.evaluate(() => {
  const r = document.querySelector('.moment-form .place-results');
  return {
    hidden: r ? r.hidden : null,
    names: [...(r?.querySelectorAll('.place-result-name') ?? [])].map((b) => b.textContent ?? ''),
    source: r?.querySelector('.place-source')?.textContent ?? '',
  };
});
check(
  '🔴 치는 동안 조회: [🔍 검색]을 **안 눌러도** 내 장소가 나온다(사용자 지적 2026-08-05)',
  lrTyped.hidden === false && lrTyped.names.some((n) => n.includes('시드니')),
  `hidden=${lrTyped.hidden} · ${lrTyped.names.join(' | ') || '(없음)'}`,
);
check(
  '치는 동안 조회: 이 목록이 **무엇인지** 말한다(내 장소 — 지도 검색 결과가 아니다)',
  lrTyped.source.includes('내 장소'),
  lrTyped.source || '(출처 줄 없음)',
);
check(
  '🔴 치는 동안 조회: **아무것도 기기 밖으로 안 나갔다**(키마다 지오코더 호출 금지 · 원칙 #3)',
  offBox.length === 0,
  offBox.length ? offBox.slice(0, 3).join(' | ') : '외부 요청 0건',
);

// 못 찾았을 때 — 침묵은 「그런 곳은 없다」로 읽힌다. 대장이 아는 것은 **내가 담아 둔 곳뿐**이다.
await page.fill('.moment-form .place-input', '없는곳입니다');
await page.waitForFunction(() => {
  const r = document.querySelector('.moment-form .place-results');
  return !!r && !r.hidden && (r.textContent ?? '').includes('내 장소') && (r.textContent ?? '').includes('검색');
});
const lrMiss = await page.evaluate(() => {
  const r = document.querySelector('.moment-form .place-results');
  return { hidden: r ? r.hidden : null, text: r?.textContent ?? '' };
});
check(
  '🔴 치는 동안 조회: 못 찾으면 **시야의 경계**를 밝힌다(§7-C 한정 생략 — 「없다」가 아니라 「내 장소 중에 없다」)',
  lrMiss.hidden === false && lrMiss.text.includes('내 장소') && lrMiss.text.includes('검색'),
  lrMiss.text || '(빈 상자)',
);

// 🔴 **없어야 할 때 없는가** — 좌표를 붙여넣는 흐름에서는 대장 목록이 뜨면 안 된다.
// 그건 장소 이름이 아니므로 대장에서 찾을 것이 없고, [🔍 검색]이 좌표로 알아본다.
await page.fill('.moment-form .place-input', '41.3111, 69.2797');
await page.waitForFunction(() => {
  const r = document.querySelector('.moment-form .place-results');
  return !!r && r.hidden && r.querySelectorAll('.place-result').length === 0;
});
const lrCoord = await page.evaluate(() => {
  const r = document.querySelector('.moment-form .place-results');
  return { hidden: r ? r.hidden : null, n: r?.querySelectorAll('.place-result').length ?? 0 };
});
check(
  '🔴 치는 동안 조회: 좌표를 붙여넣으면 대장 목록이 **안 뜬다**(오탐 차단 · §4)',
  lrCoord.hidden === true && lrCoord.n === 0,
  `hidden=${lrCoord.hidden} · 행 ${lrCoord.n}개`,
);

// 눌러 본다 — 그리는 것과 도는 것은 다른 층이다(§13 4항).
await page.fill('.moment-form .place-input', '타슈');
await page.waitForFunction(() => {
  const r = document.querySelector('.moment-form .place-results');
  return !!r && !r.hidden && r.querySelectorAll('.place-result').length > 0;
});
await page.locator('.moment-form .place-results .place-result').first().click();
await settle(page);
const lrPicked = await page.evaluate(() => {
  const f = document.querySelector('.moment-form');
  return {
    typed: f?.querySelector('.place-input')?.value ?? '',
    badge: f?.querySelector('.place-picked')?.textContent ?? '',
    hidden: f?.querySelector('.place-results')?.hidden ?? null,
  };
});
check(
  '🔴 치는 동안 조회: 고르면 **실제로 칸에 앉는다**(자료구조에만 있으면 M-0022의 행동판)',
  lrPicked.typed === '타슈켄트 의대',
  lrPicked.typed || '(안 채워짐)',
);
check('치는 동안 조회: 무엇이 지정됐는지 배지로 말한다', lrPicked.badge.length > 0, lrPicked.badge || '(배지 없음)');
check('치는 동안 조회: 고른 뒤 목록이 닫힌다', lrPicked.hidden === true, `hidden=${lrPicked.hidden}`);

page.off('request', offBoxWatch);
// 뒷정리 — 심은 픽스처와 폼 상태를 되돌린다(§3-C, 내 상태를 남기지 않는다).
await page.locator('.moment-form .place-picked .chip-clear').first().click().catch(() => {});
await page.fill('.moment-form .place-input', '');
await settle(page);
await page.evaluate(async () => {
  await new Promise((resolve) => {
    const req = indexedDB.open('journey-archive');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('localPlaces', 'readwrite');
      for (const id of ['lr-live-a', 'lr-live-b']) tx.objectStore('localPlaces').delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    };
    req.onerror = () => resolve();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 좌표를 못 얻었을 때 **왜 못 얻었는지 말하는가** (사용자 2026-07-31: *"아직도 해결이 안되네"*)
//
// §11 ② — **여기 있던 검사가 옛 전제를 못박고 있었다.** *"좌표 없는 사진이면 침묵한다"*를
// 계약으로 잠가 뒀고, 그래서 사용자가 겪은 그 침묵이 게이트에서는 **정상으로 초록이었다.**
// 전제가 바뀌었으니 통과시키려 로직을 되돌리지 말고 **케이스를 뒤집는다.**
// §8의 「침묵이 정상」은 *기대와 일치하는 것*을 감추라는 뜻이지, **기대한 일이 안 일어난 것**을
// 감추라는 뜻이 아니다.
// ─────────────────────────────────────────────────────────────────────────────

// ① EXIF 자체가 없는 사진(스크린샷·메신저로 받은 것) — 원인이 사진 쪽에 있다고 말한다.
await page.setInputFiles('.moment-photo-input', [{ name: 'nogps.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(imgBuf) }]);
await page.waitForFunction(() => {
  const n = document.querySelector('.place-photo-note');
  return !!n && !n.hidden && (n.textContent ?? '').includes('촬영 정보가 없어요');
});
const noExif = await page.evaluate(() => {
  const n = document.querySelector('.place-photo-note');
  return { hidden: n ? n.hidden : null, text: n?.textContent ?? '' };
});
check(
  '🔴 생성 폼: EXIF 없는 사진이면 **왜 없는지 말한다**(v1.30은 「사진 추가」만 고쳤고 여기는 침묵했다 · §7)',
  noExif.hidden === false && noExif.text.includes('촬영 정보가 없어요') && noExif.text.includes('스크린샷'),
  JSON.stringify(noExif),
);
check(
  '🔴 생성 폼: 「안 된다」로 끝내지 않고 **탈출구**로 데려간다(§12)',
  noExif.text.includes('지도로 찍거나') && noExif.text.includes('좌표를'),
  noExif.text,
);
// v1.33 — 탈출구가 셋이 됐고 **가장 짧은 길이 맨 앞**이어야 한다. 사용자 요구는
// *"어떤 방식이든 결과"*였고, 여기서 결과가 가장 확실한 것은 [📍 내 위치] 한 번이다.
check(
  '🔴 생성 폼: **[📍 내 위치]를 가장 먼저** 가리킨다(한 번 눌러 끝나는 길)',
  noExif.text.indexOf('내 위치') >= 0 && noExif.text.indexOf('내 위치') < noExif.text.indexOf('지도로 찍거나'),
  noExif.text,
);

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 **[🖼️ 갤러리에서]를 실제로 눌러 본다** (v1.40 · §13 4항)
//
// 🔴 **이 블록의 계약이 뒤집혔다**(2026-08-01 · M-0064 · §11 ②).
//
// v1.34에는 기본이 갤러리 선택기(`image/*`)였고 [📁 원본에서]가 우회 버튼이었다. 그 배치의
// 대가를 사용자가 나흘 치렀다 — **기본 경로가 계속 위치를 잃는 동안** 나는 「앱이 받은
// 바이트 = 원본 바이트」를 전제로 파서·순서·게이트를 뒤졌다.
//
// 사용자가 실기기로 갈랐다: 📁 원본에서/직접 촬영 → 좌표 살아 있음, 📷 기본 선택기 → 없음.
// 그래서 **기본이 원본 보존 경로**가 되고, 갤러리는 명시적으로 고를 때만 쓴다.
// 통과시키려고 코드를 되돌리지 않는다 — **케이스를 뒤집는다.**
//
// 여기서 잴 수 있는 것과 없는 것을 나눈다(§13 3항):
//   · 잰다 — 기본 `accept`가 원본 보존 경로인가, 누르면 갤러리로 바뀌는가, **되돌아오는가**.
//   · 못 잰다 — 안드로이드가 그때 어떤 선택기를 띄우는가(실기기 몫이다).
// ─────────────────────────────────────────────────────────────────────────────
const acceptBefore = await page.evaluate(() => document.querySelector('.moment-form .moment-photo-input')?.accept ?? '');
const chooserOpened = await Promise.all([
  page.waitForEvent('filechooser', { timeout: 5000 }).then(
    async (fc) => {
      const acceptWhileOpen = await page.evaluate(
        () => document.querySelector('.moment-form .moment-photo-input')?.accept ?? '',
      );
      await fc.setFiles([]); // 취소와 같은 자리 — 고르지 않고 닫는다
      return acceptWhileOpen;
    },
    () => null,
  ),
  page.locator('.moment-form .pick-original').click(),
]).then(([a]) => a);
check(
  '🔴 **기본 경로가 원본 보존**이다 — 사진 선택기가 처리 못 하는 형식을 섞어 둔다 (M-0064)',
  acceptBefore.includes('application/octet-stream'),
  acceptBefore,
);
check(
  '🔴 [🖼️ 갤러리에서]: 누르면 **파일 대화상자가 실제로 열린다**(라벨만 읽지 않는다 — §13 4항)',
  chooserOpened !== null,
  String(chooserOpened),
);
check(
  '🔴 [🖼️ 갤러리에서]: 누르는 동안에만 **갤러리 선택기**로 내려간다(편의를 명시적으로 고른 것)',
  chooserOpened === 'image/*',
  String(chooserOpened),
);
await settle(page);
const acceptAfter = await page.evaluate(() => document.querySelector('.moment-form .moment-photo-input')?.accept ?? '');
check(
  '🔴 [🖼️ 갤러리에서]: 끝나면 **원본 보존 경로로 되돌린다**(다음 [사진 추가]가 위치를 잃지 않게)',
  acceptAfter === acceptBefore && acceptAfter.includes('application/octet-stream'),
  `${acceptBefore} → ${chooserOpened} → ${acceptAfter}`,
);
check(
  '[🖼️ 갤러리에서]: 편집 폼에도 **같은 버튼이 있다**(§7 — 한쪽만 고치지 않는다)',
  (await page.locator('.pick-original').count()) >= 1,
  String(await page.locator('.pick-original').count()),
);

// 🔴 **[📍 내 위치]를 실제로 눌러 본다** (§13 4항 — 그리는 것과 도는 것은 다른 층이다)
//
// 사용자 요구(2026-07-31): *"장소가 바로 입력되게 하고 싶은거야. 어떤 방식이든 결과가 중요함."*
// 그래서 재는 것은 **결과**다: 눌렀을 때 좌표가 실제로 들어가는가.
// 위성은 이 환경에 없으므로 브라우저에 결정적인 가짜 위치를 넣어 뒀다(맨 위 setGeolocation).
// 재는 것은 위성이 아니라 **배선**이다 — M-0038이 그 자리였다(유닛은 초록인데 배선이 끊겼다).
// ─────────────────────────────────────────────────────────────────────────────
await page.locator('.moment-form .place-here').click();
await page.waitForFunction(() => {
  const f = document.querySelector('.moment-form');
  const badge = f?.querySelector('.place-picked');
  const button = f?.querySelector('.place-here');
  return badge instanceof HTMLElement && !badge.hidden
    && (badge.textContent ?? '').includes('37.56650, 126.97800')
    && !button?.disabled;
});
const hereApplied = await page.evaluate(() => {
  const f = document.querySelector('.moment-form');
  const badge = f?.querySelector('.place-picked');
  const note = f?.querySelector('.place-photo-note');
  return {
    badge: badge instanceof HTMLElement && !badge.hidden ? (badge.textContent ?? '') : '',
    btnEnabled: !(f?.querySelector('.place-here')?.disabled ?? true),
    btnLabel: f?.querySelector('.place-here')?.textContent ?? '',
    noteHidden: note ? note.hidden : null,
  };
});
check(
  '🔴 [📍 내 위치]: 누르면 **좌표가 실제로 들어간다**(라벨만 읽지 않는다 — §13 4항)',
  hereApplied.badge.includes('37.56650, 126.97800'),
  JSON.stringify(hereApplied),
);
check(
  '🔴 [📍 내 위치]: **정확도를 함께 말한다**(실내 측위 2km를 「위치 지정됨」으로 뭉개지 않는다)',
  /±18m/.test(hereApplied.badge),
  hereApplied.badge,
);
// 🔴 사용자 요구(2026-07-31): *"좌표를 제공해주면 내가 직접 입력하면 되지 않아?"*
// 「위치 지정됨」만으로는 옮겨 적을 수도, 다른 지도앱에서 대조할 수도 없다.
check(
  '🔴 [📍 내 위치]: **숫자 좌표를 화면에 준다**(가져갈 수 있는 형태로 · §12)',
  hereApplied.badge.includes('37.56650') && hereApplied.badge.includes('126.97800'),
  hereApplied.badge,
);
check(
  '[📍 내 위치]: 성공하면 안내 줄은 **조용해진다**(할 일이 끝나면 침묵 · §8)',
  hereApplied.noteHidden === true,
  JSON.stringify(hereApplied),
);
check(
  '[📍 내 위치]: 버튼이 **잠긴 채 남지 않는다**(§13 4항 ④)',
  hereApplied.btnEnabled && hereApplied.btnLabel.includes('내 위치'),
  JSON.stringify(hereApplied),
);

// 🔴 **실패해도 말하는가** — 조용히 삼키면 M-0053(침묵이 「고장」으로 읽힌다)의 재발이다.
//
// 왜 권한을 빼앗지 않고 **브라우저 함수를 갈아 끼우나**: 헤드리스에서 권한을 지우면
// 브라우저가 콜백을 아예 안 주는 일이 있어 검사가 16초를 기다리다 빈손으로 지나갔다.
// 그리고 내가 재려는 것은 **브라우저의 권한 기계**가 아니라 **내 코드가 실패를 어떻게
// 다루는가**다. 그래서 그 경계에서 정확히 갈아 끼운다 — 주입은 `getCurrentPosition`
// 하나뿐이고, 그 뒤의 판정·문장·버튼 복구는 전부 **앱이 스스로 한다**(§4).
await page.locator('.moment-form .place-picked .chip-clear').first().click();
await settle(page);
await page.evaluate(() => {
  const g = navigator.geolocation;
  window.__realGetPos = g.getCurrentPosition.bind(g);
  g.getCurrentPosition = (_ok, err) => err && err({ code: 1, message: 'denied' });
});
await page.locator('.moment-form .place-here').click();
await page.waitForFunction(() => {
  const f = document.querySelector('.moment-form');
  const note = f?.querySelector('.place-photo-note');
  const button = f?.querySelector('.place-here');
  return note instanceof HTMLElement && !note.hidden && (note.textContent ?? '').includes('권한') && !button?.disabled;
});
const hereDenied = await page.evaluate(() => {
  const f = document.querySelector('.moment-form');
  const note = f?.querySelector('.place-photo-note');
  return {
    note: note instanceof HTMLElement && !note.hidden ? (note.textContent ?? '') : '',
    btnEnabled: !(f?.querySelector('.place-here')?.disabled ?? true),
    btnLabel: f?.querySelector('.place-here')?.textContent ?? '',
  };
});
check(
  '🔴 [📍 내 위치]: **실패를 삼키지 않는다**(권한이 없으면 그렇다고 말한다)',
  hereDenied.note.includes('권한'),
  JSON.stringify(hereDenied),
);
check(
  '🔴 [📍 내 위치]: 실패 문장이 **다음에 할 일**을 준다(§12 — 「안 됩니다」로 끝내지 않는다)',
  /허용/.test(hereDenied.note) && /지도/.test(hereDenied.note),
  hereDenied.note,
);
check(
  '[📍 내 위치]: 실패해도 버튼이 **잠긴 채 남지 않는다**(§13 4항 ④)',
  hereDenied.btnEnabled && hereDenied.btnLabel.includes('내 위치'),
  JSON.stringify(hereDenied),
);
// §3-C — 갈아 끼운 것을 내가 되돌린다. 안 되돌리면 뒤 검사가 「위치를 못 얻는 브라우저」에서
// 도는데, 그건 내가 만든 상태이지 앱의 상태가 아니다(fetch 스텁·뷰포트와 같은 부류).
await page.evaluate(() => {
  if (window.__realGetPos) navigator.geolocation.getCurrentPosition = window.__realGetPos;
});
await page.evaluate(() => {
  const n = document.querySelector('.moment-form .place-photo-note');
  if (n instanceof HTMLElement) { n.textContent = ''; n.hidden = true; }
});

// ② 촬영시각은 있는데 GPS만 없는 사진 — **안드로이드 사진 선택기가 지운 모양**이다.
//    앱의 파서는 멀쩡하다는 사실을 사용자에게 알려야 앱을 의심하지 않는다.
await page.setInputFiles('.moment-photo-input', [
  { name: 'timeonly.jpg', mimeType: 'image/jpeg', buffer: withExifDateTime(imgBuf, '2026:07:16 09:30:00') },
]);
await page.waitForFunction(() => (document.querySelector('.place-photo-note')?.textContent ?? '').includes('촬영시각은 읽었'));
const timeOnly = await page.evaluate(() => document.querySelector('.place-photo-note')?.textContent ?? '');

// ── 🔬 **앱이 받은 바이트를 앱이 말하는가** (2026-08-01 · M-0066 · §12) ──────────
// 나흘 동안 사용자가 스크린샷을 날랐고 나는 추측했다. 앱은 그 바이트를 손에 쥐고도
// 아무 말을 안 했다. 이 상자가 그 자리를 메운다 — **좌표를 못 얻었을 때만** 나온다.
// 사진 안내와 SHA-256 계산은 서로 다른 비동기 단계다. 안내만 기다리고 읽으면 빠른 로컬에서는
// 우연히 초록이지만 느린 CI에서는 빈 probe를 읽는다. 이 검사의 판정 대상 자체가 준비될 때까지
// 기다린다 — 고정 sleep이 아니라 내용 기반 완료 조건이다.
await page.waitForFunction(() => {
  const b = document.querySelector('.pick-probe');
  const line = b?.querySelector('.probe-line')?.textContent ?? '';
  const next = b?.querySelector('.probe-next')?.textContent ?? '';
  return !!b && !b.hidden && /바이트/.test(line) && /sha256/.test(line) && next.length > 10;
});
const probe = await page.evaluate(() => {
  const b = document.querySelector('.pick-probe');
  return {
    shown: !!b && !b.hidden,
    summary: b?.querySelector('summary')?.textContent ?? '',
    line: b?.querySelector('.probe-line')?.textContent ?? '',
    next: b?.querySelector('.probe-next')?.textContent ?? '',
  };
});
check('🔬 좌표를 못 얻으면 **앱이 받은 바이트**를 화면에 내놓는다(§12 — 사람이 나르지 않게)', probe.shown, JSON.stringify(probe).slice(0, 200));
check(
  '🔬 크기와 해시를 적는다 — 사용자가 **폰의 원본과 대조**할 수 있게',
  /바이트/.test(probe.line) && /sha256/.test(probe.line),
  probe.line,
);
check(
  '🔴 관측만 적고 **원인을 단정하지 않는다**(§8 — 이 건에서 네 번 틀렸다)',
  !/지웠어요|지웁니다|때문입니다/.test(`${probe.line} ${probe.next}`),
  `${probe.line} ${probe.next}`.slice(0, 160),
);
check(
  '🔬 다음에 무엇을 할지 말한다(관측만 던지고 끝내지 않는다)',
  probe.next.length > 10,
  probe.next,
);

check(
  '🔴 생성 폼: 시각은 읽고 위치만 없으면 **원인을 구분해** 말한다(파서 탓이 아니다)',
  timeOnly.includes('촬영시각은 읽었') && timeOnly.includes('위치 태그') && !/지웠어요|지웁니다/.test(timeOnly),
  timeOnly,
);
check(
  '생성 폼: 두 원인이 **같은 문장으로 뭉개지지 않는다**(처방이 다르므로)',
  timeOnly !== noExif.text,
  `${timeOnly} / ${noExif.text}`,
);

// 🔴 동의를 **수락**하면 이름까지 채운다. 위 검사들은 Playwright가 대화상자를 자동 거절하므로
// **거절 경로**를 재고 있었다 — 거절해도 좌표는 남는다는 것까지가 그 검사다. 여기서는 수락한다.
// 샌드박스는 Nominatim을 막는다. 스텁하지 않으면 **콘솔 네트워크 에러**가 남고(뒤의 「콘솔
// 에러 0」이 RED), 무엇보다 *이름이 채워지는지*를 못 잰다 — 스텁이 검사를 더 강하게 만든다.
await page.route('**/reverse**', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      lat: '16.0544',
      lon: '108.2022',
      display_name: '미케 비치, 다낭, 베트남',
      name: '미케 비치',
      address: { country: '베트남', country_code: 'vn', city: '다낭' },
    }),
  }),
);
page.once('dialog', (d) => void d.accept());
await page.setInputFiles('.moment-photo-input', [
  { name: 'gps3.jpg', mimeType: 'image/jpeg', buffer: withExifGps(imgBuf, '2026:07:16 11:00:00', 16.0544, 108.2022) },
]);
await page.waitForFunction(() => localStorage.getItem('bugeon:photoGeoOk') === '1' && document.querySelector('.place-input')?.value === '미케 비치');
const consented = await page.evaluate(() => ({
  ok: localStorage.getItem('bugeon:photoGeoOk'),
  note: document.querySelector('.place-photo-note')?.textContent ?? '',
}));
check(
  '사진 장소: 동의는 **처음 한 번만** 물어보고 기억한다(세 번째부터는 고지가 아니라 마찰이다)',
  consented.ok === '1' && !consented.note.includes('직접 적어'),
  JSON.stringify(consented),
);
const namedFromPhoto = await page.evaluate(() => document.querySelector('.place-input')?.value ?? '');
check(
  '사진 장소: 동의하면 **이름까지** 대신 채운다(§12 — 앱이 알아낼 수 있는 것을 타이핑시키지 않는다)',
  namedFromPhoto === '미케 비치',
  namedFromPhoto || '(빈 칸)',
);
await page.unroute('**/reverse**'); // §3-C — 내가 건 스텁을 내가 뗀다
await page.route('**/reverse**', defaultReverseRoute);

// ── 💰 비용 메모: 모델에 있던 note를 화면이 부르는가 ──
const noteField = await page.evaluate(() => {
  const i = document.querySelector('[data-expense-note]');
  return { exists: !!i, visible: !!i && i.getBoundingClientRect().height > 0, ph: i?.placeholder ?? '' };
});
check('비용 메모: 칸이 **펼쳐진 채로** 있다(선택이지만 숨기지 않는다)', noteField.exists && noteField.visible, JSON.stringify(noteField));
check('비용 메모: 무엇을 적는 자리인지 말한다', noteField.ph.includes('무엇에'), noteField.ph);

await page.locator('.pick-clear-all').click().catch(() => {});
await settle(page);
// 🔴 §3-C — **장소도 비운다.** 안 비우면 이 순간이 「미케 비치」를 달고 저장되고, 한참 뒤의
// 「바깥 지도 링크」 검사가 그 좌표를 집어 서울 기대값과 어긋난다(실제로 3건이 RED로 떴다).
// 내 블록이 만든 상태가 **다른 블록의 픽스처를 바꿔치기한** 것이다.
// 🔴 그리고 **되돌렸는지 되읽어 확인한다**(§8 *"고쳤다고 말하지 말고 다시 읽어라"*).
// 예전엔 `.click().catch(() => {})` 한 번이었다 — 배지가 아직 안 그려졌거나 재렌더로
// 노드가 떨어져 나가면 클릭이 **조용히 실패**하고, 그 실패는 **한참 뒤 남의 검사에서**
// 다낭 좌표로 나타났다(2회 중 1회 RED · 간헐이라 더 나빴다). §11 ③ — **오탐·간헐도 결함이다.**
let placeCleared = false;
for (let i = 0; i < 5 && !placeCleared; i += 1) {
  await page.locator('.moment-form .place-picked .chip-clear').first().click().catch(() => {});
  await page.evaluate(() => {
    const inp = document.querySelector('.moment-form .place-input');
    if (inp instanceof HTMLInputElement) { inp.value = ''; inp.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  await settle(page);
  // 🔴 배지는 **DOM에서 사라지지 않는다** — `hidden`으로만 감춘다(`buildPickedBadge`).
  // 처음엔 `!querySelector('.place-picked')`로 읽었고, 그건 **영원히 false**라 되읽기가
  // 공허했다(§4 — 되읽기 자신도 비공허해야 한다). 존재가 아니라 **보이는가**를 묻는다.
  placeCleared = await page.evaluate(() => {
    const f = document.querySelector('.moment-form');
    const badge = f?.querySelector('.place-picked');
    const inp = f?.querySelector('.place-input');
    return badge instanceof HTMLElement && badge.hidden && (inp instanceof HTMLInputElement ? inp.value : '') === '';
  });
}
check(
  '🔴 §3-C: 다음 블록에 넘기기 전에 장소를 비웠고, **비워졌는지 되읽어 확인했다**',
  placeCleared,
  `cleared=${placeCleared}`,
);
await page.fill('input[placeholder^="이 순간을"]', '비용 메모 검증');
await page.fill('input[placeholder^="💰 비용"]', '12000');
await page.fill('[data-expense-note]', '반미 샌드위치');
await page.getByRole('button', { name: '순간 저장' }).click();
await page.locator('.moment-card', { hasText: '비용 메모 검증' }).filter({ hasText: '반미 샌드위치' }).first().waitFor();
const moneyChip = await page.evaluate(() =>
  [...document.querySelectorAll('.chip.money')].map((c) => c.textContent ?? '').join(' | '),
);
check(
  '비용 메모: 저장하면 **금액과 함께** 보인다(숫자만 남은 비용은 한 달 뒤 의미를 잃는다)',
  moneyChip.includes('반미 샌드위치'),
  moneyChip.slice(0, 120),
);
const noteCleared = await page.evaluate(() => document.querySelector('[data-expense-note]')?.value ?? 'X');
check('비용 메모: 저장 후 비워진다(형제 칸들과 같은 어휘)', noteCleared === '', noteCleared);

// ── 🔴 🕒 사진이 찍힌 나라로 **여행 시간대를 제안**하는가, 그리고 **버튼이 도는가**(§13 4항) ──
//
// 이게 사용자 제안 3번의 본체다: *"초기값은 사진찍은 장소로 셋팅..어때?"*
// 좌표→시간대는 데이터셋이 필요해 하지 않는다. 나라까지만 알아내고 **나라의 시간대가 하나일 때만**
// 제안한다(베트남 1개 → 제안 / 미국 29개 → 침묵). 그리고 **자동으로 정하지 않는다** — 묻는다.
await page.route('**/reverse**', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      lat: '16.0544', lon: '108.2022',
      display_name: '미케 비치, 다낭, 베트남', name: '미케 비치',
      address: { country: '베트남', country_code: 'vn', city: '다낭' },
    }),
  }),
);
await page.setInputFiles('.moment-photo-input', [
  { name: 'gps4.jpg', mimeType: 'image/jpeg', buffer: withExifGps(imgBuf, '2026:07:16 12:00:00', 16.0544, 108.2022) },
]);
await page.waitForFunction(() => {
  const b = document.querySelector('.zone-suggest');
  return b instanceof HTMLElement && !b.hidden && (b.textContent ?? '').includes('베트남');
});
const zoneSug = await page.evaluate(() => {
  const b = document.querySelector('.zone-suggest');
  return {
    shown: b instanceof HTMLElement ? !b.hidden : false,
    msg: b?.querySelector('.zone-notice-msg')?.textContent ?? '',
    btn: b?.querySelector('[data-zone-suggest]')?.textContent ?? '',
  };
});
check(
  '시간대 제안: 사진이 찍힌 **나라를 말하고** 어느 시간대인지 제안한다',
  zoneSug.shown && zoneSug.msg.includes('베트남') && zoneSug.msg.includes('인도차이나'),
  JSON.stringify(zoneSug),
);
check('시간대 제안: **묻는다**(자동으로 정하지 않는다 — §8)', zoneSug.msg.includes('할까요'), zoneSug.msg);
check('시간대 제안: 받아들일 버튼이 있다', zoneSug.btn.includes('이 시간대로'), zoneSug.btn);

// 🔴 §13 4항 — **누른다.** 라벨만 읽는 것은 확인한 것이 아니다.
await page.locator('[data-zone-suggest]').first().click();
await page.waitForSelector('.tl-time', { timeout: 10000 });
await page.waitForFunction(() => document.querySelectorAll('.zone-suggest:not([hidden])').length === 0 && document.querySelectorAll('.zone-notice').length === 0);
const afterApply = await page.evaluate(() => ({
  notice: document.querySelectorAll('.zone-notice').length,
  suggest: document.querySelectorAll('.zone-suggest:not([hidden])').length,
  hint: document.querySelector('.when-clock')?.textContent ?? '',
}));
check('시간대 제안: 누르면 **실제로 적용된다**(미지정 고지가 사라진다)', afterApply.notice === 0, JSON.stringify(afterApply));
check('시간대 제안: 적용 후 제안도 사라진다(할 일이 끝나면 조용해진다 — §8)', afterApply.suggest === 0, JSON.stringify(afterApply));
check('시간대 제안: 입력 칸이 **그 시간대로** 적는다고 말한다', afterApply.hint.includes('인도차이나'), afterApply.hint);

// T-043 — 여행 상세(타임라인이 그려진 상태)를 커버 폭에서 잰다. 이 화면은 순간 카드·시각·
// 사진 격자가 한 줄에 겹치는 자리라 좁은 폭에서 가장 먼저 깨질 후보다.
await coverSweep('여행 상세 · 타임라인', null);

// §3-C 되돌리기 — 이 클릭은 **여행을 실제로 고쳤다.** 원래대로 돌려놓는다.
await page.unroute('**/reverse**');
await page.route('**/reverse**', defaultReverseRoute);
await page.locator('.hero-edit').first().click();
await settle(page);
await page.selectOption('[data-zone-input]', '');
await settle(page);
await page.locator('.edit-panel .btn-primary', { hasText: '저장' }).first().click();
await page.waitForSelector('.zone-notice', { timeout: 10000 });
check(
  '시간대 제안: 되돌렸다(내가 고친 여행을 뒤 검사에 남기지 않는다 — §3-C)',
  (await page.evaluate(() => document.querySelectorAll('.zone-notice').length)) === 1,
  'ok',
);

// ── 🔴 v1.29: **편집 폼**에서 사진을 추가해도 장소가 채워지는가 (사용자 지적 2026-07-31) ──
//
// 사용자가 스크린샷으로 짚었다 — 「기존 순간에 사진 추가」 흐름에서는 장소 칸이 비어 있었다.
// 생성 폼에만 붙였던 것이 §7 위반이었다(오히려 이쪽이 더 흔한 흐름이다).
//
// 그리고 **가장 이른 촬영시각**의 사진을 기준으로 한다: 시각(`guessOccurredAt`)이 이미 그
// 규칙을 쓰므로, 장소가 다른 자를 쓰면 **시각과 장소가 서로 다른 사진을 가리킨다.**
await page.route('**/reverse**', (route) =>
  route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ lat: '16.0544', lon: '108.2022', display_name: '미케 비치, 다낭, 베트남', name: '미케 비치', address: { country: '베트남', country_code: 'vn', city: '다낭' } }),
  }),
);
// 🔴 **장소가 없는 순간을 새로 만들어** 그것을 편집한다. 「첫 카드」를 쓰면 앞선 검사가
// 좌표를 넣어 둔 순간을 집을 수 있고, 그러면 `taken()`이 참이라 제안이 안 돈다 —
// 실제로 그렇게 짰다가 RED로 떴다(검사가 자기 전제를 세우지 않은 것이다).
await page.fill('input[placeholder^="이 순간을"]', '편집 폼 장소 검증');
await page.getByRole('button', { name: '순간 저장' }).click();
const editCard = page.locator('.moment-card', { hasText: '편집 폼 장소 검증' }).first();
await editCard.waitFor();
await page.setViewportSize({ width: 1600, height: 900 });
await editCard.locator('.icon-btn[aria-label="이 순간 편집"]').click();
await editCard.locator('.moment-edit').waitFor();
const addRowAlignment = await editCard.evaluate((c) => {
  const controls = [
    c.querySelector('.moment-addphoto-btn'),
    c.querySelector('.moment-addphoto .pick-original'),
    c.querySelector('.moment-addphoto .audio-rec'),
  ];
  if (controls.some((control) => !(control instanceof HTMLElement))) return null;
  const rects = controls.map((control) => control.getBoundingClientRect());
  const spread = (values) => Math.max(...values) - Math.min(...values);
  return {
    topSpread: spread(rects.map((rect) => rect.top)),
    bottomSpread: spread(rects.map((rect) => rect.bottom)),
    heights: rects.map((rect) => rect.height),
  };
});
check(
  '🔴 순간 추가 버튼 3종: 같은 행의 상단·하단이 맞는다',
  addRowAlignment !== null && addRowAlignment.topSpread <= 1 && addRowAlignment.bottomSpread <= 1,
  JSON.stringify(addRowAlignment),
);
await page.setViewportSize({ width: 390, height: 844 });
await settle(page);
const beforeEdit = await editCard.evaluate((c) => {
  const p = c.querySelector('.place-input');
  const badge = c.querySelector('.place-picked');
  return { name: p instanceof HTMLInputElement ? p.value : 'MISSING', badge: badge ? !badge.hidden : false };
});
check('편집 폼: 사진 넣기 전에는 장소가 비어 있다(검사가 자기 전제를 세운다)', beforeEdit.name === '' && !beforeEdit.badge, JSON.stringify(beforeEdit));

// 🔴 **역순으로 넣는다** — 늦게 찍힌 것을 먼저. 「고른 순서의 첫 장」 규칙이면 하노이가,
// 「가장 이른 사진」 규칙이면 다낭이 나온다. 두 규칙을 실제로 갈라 세우는 픽스처다.
await editCard.locator('.moment-photo-input').setInputFiles([
  { name: 'late.jpg', mimeType: 'image/jpeg', buffer: withExifGps(imgBuf, '2026:07:16 18:00:00', 21.0278, 105.8342) },
  { name: 'early.jpg', mimeType: 'image/jpeg', buffer: withExifGps(imgBuf, '2026:07:16 09:30:00', 16.0544, 108.2022) },
]);
// 사진을 한 장씩 굽는다(저메모리 규율) — 고정 대기는 **중간 상태를 재게 된다**(실제로
// 「사진 편집… (1/2)」을 잡았다). 끝났다는 신호를 기다린다.
// 「사진 추가」는 장당 **편집기를 연다**(굽기 전 배치 편집). 두 장이므로 두 번 [적용]한다.
// 고정 대기로는 못 지나간다 — 실제로 「사진 편집… (1/2)」에서 멈춘 채 30초를 기다렸다.
for (let i = 0; i < 2; i++) {
  await page.waitForSelector('.pe-overlay', { timeout: 20000 });
  await page.getByRole('button', { name: '적용', exact: true }).click();
  if (i === 0) {
    await page.waitForFunction(() => /2\/2/.test(document.querySelector('.pe-file')?.textContent ?? ''), null, { timeout: 20000 });
  } else {
    await page.waitForSelector('.pe-overlay', { state: 'detached', timeout: 30000 });
  }
}
await page.waitForSelector('.undo-toast', { timeout: 30000 });
await page.waitForFunction(() => {
  const card = [...document.querySelectorAll('.moment-card')].find((c) => c.textContent?.includes('편집 폼 장소 검증'));
  return (card?.querySelector('.chip.gps')?.textContent ?? '').includes('미케 비치');
});
// 🔴 재렌더가 끝난 **카드 자체**를 본다. 폼 칸이 아니라 **순간에 실제로 써 넣은 값**이라야
// 한다 — 사진 추가는 곧바로 저장·재렌더하므로 폼에만 채우면 그 즉시 사라진다.
const editFilled = await page.evaluate(() => {
  const card = [...document.querySelectorAll('.moment-card')].find((c) => c.textContent?.includes('편집 폼 장소 검증'));
  return {
    chip: card?.querySelector('.chip.gps')?.textContent ?? '',
    toast: document.querySelector('.undo-toast')?.textContent ?? '',
  };
});
check(
  '편집 폼: **사진 추가로도 장소가 들어간다**(생성 폼에만 있던 것이 §7 위반이었다)',
  editFilled.chip.includes('미케 비치'),
  JSON.stringify(editFilled),
);
check(
  '편집 폼: **한 일을 말하고 되돌릴 길을 준다**(앱이 데이터를 바꿨으면 §5가 걸린다)',
  editFilled.toast.includes('사진 위치로 장소를 넣었어요') && editFilled.toast.includes('실행취소'),
  editFilled.toast || '(토스트 없음)',
);
const coordCopy = page.locator('.moment-card', { hasText: '편집 폼 장소 검증' }).first().locator('.place-chip-copy');
const coordText = await coordCopy.textContent();
check('순간 장소는 상태 문구 대신 좌표와 복사 동작을 보인다', /-?\d+\.\d{5}, -?\d+\.\d{5}/.test(coordText ?? ''), coordText ?? '');
await coordCopy.click();
const copiedCoord = await page.evaluate(() => navigator.clipboard.readText());
check('순간 장소 좌표 복사 버튼이 실제 좌표를 복사한다', /^-?\d+\.\d{5}, -?\d+\.\d{5}$/.test(copiedCoord), copiedCoord);

// 🔴 이번엔 **이미 장소가 있는** 순간에 사진을 넣는다 — 손대면 안 된다.
await page.route('**/reverse**', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ lat: '21.0278', lon: '105.8342', display_name: '하노이', name: '하노이', address: { country: '베트남', country_code: 'vn' } }) }),
);
const keptCard = page.locator('.moment-card', { hasText: '편집 폼 장소 검증' }).first();
await keptCard.locator('.moment-photo-input').setInputFiles([
  { name: 'hanoi.jpg', mimeType: 'image/jpeg', buffer: withExifGps(imgBuf, '2026:07:16 07:00:00', 21.0278, 105.8342) },
]);
await page.waitForSelector('.pe-overlay', { timeout: 20000 });
await page.getByRole('button', { name: '적용', exact: true }).click();
await page.waitForSelector('.pe-overlay', { state: 'detached', timeout: 30000 });
await page.waitForSelector('.undo-toast', { timeout: 30000 });
const kept2 = await page.evaluate(() => {
  const card = [...document.querySelectorAll('.moment-card')].find((c) => c.textContent?.includes('편집 폼 장소 검증'));
  return card?.querySelector('.chip.gps')?.textContent ?? '';
});
check(
  '🔴 편집 폼: **이미 장소가 있으면 사진이 덮지 않는다**(앱이 사용자를 이기지 않는다)',
  kept2.includes('미케 비치') && !kept2.includes('하노이'),
  kept2,
);
await page.unroute('**/reverse**');
await page.route('**/reverse**', defaultReverseRoute);

// ── 🔴 v1.30: **위치 없는 사진**과 **이름 없는 좌표** (사용자 지적 2026-07-31 *"안되네요"*) ──
//
// 사용자가 사진을 넣었는데 장소가 비어 있었다. 원인이 둘 다 **침묵**이었다:
//  ① 사진에 GPS가 없으면 아무 말도 안 했다 → 고장인지 없는 건지 구분할 수 없다.
//  ② 좌표만 들어가고 이름이 없으면 칩을 안 그렸다 → **넣었는데 화면은 그대로**였다.
await page.fill('input[placeholder^="이 순간을"]', 'GPS 없는 사진 검증');
await page.getByRole('button', { name: '순간 저장' }).click();
const noGpsCard = page.locator('.moment-card', { hasText: 'GPS 없는 사진 검증' }).first();
await noGpsCard.waitFor();
await noGpsCard.locator('.icon-btn[aria-label="이 순간 편집"]').click();
await settle(page);
// 🔴 앞 블록의 토스트가 5초 남아 있다 — 지우지 않으면 **남의 토스트를 내 결과로 읽는다**
// (실제로 그렇게 RED가 떴다). 검사가 자기 전제를 세운다.
await page.evaluate(() => document.querySelector('.undo-toast')?.remove());
await noGpsCard.locator('.moment-photo-input').setInputFiles([
  { name: 'nogps2.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(imgBuf) },
]);
await page.waitForSelector('.pe-overlay', { timeout: 20000 });
await page.getByRole('button', { name: '적용', exact: true }).click();
await page.waitForSelector('.undo-toast', { timeout: 20000 });
const noGpsToast = await page.evaluate(() => document.querySelector('.undo-toast')?.textContent ?? '');
check(
  '🔴 위치 없는 사진: **그렇다고 말한다**(침묵은 「고장」으로 읽힌다 — §12)',
  noGpsToast.includes('촬영 정보가 없어요'),
  noGpsToast || '(토스트 없음)',
);
// v1.31 — 이 문장은 이제 생성 폼과 **같은 문**(`photoPlaceNotice`)에서 나온다. 같은 픽스처
// (EXIF 없는 JPEG)에 대해 두 화면이 **글자까지 같은 말**을 해야 한다. 다르면 한쪽이 손편집이다(§7).
check(
  '🔴 위치 없는 사진: 「사진 추가」와 「순간 만들기」가 **같은 말**을 한다(문장 SSOT)',
  noGpsToast.includes(noExif.text),
  `${noGpsToast} ||| ${noExif.text}`,
);
check(
  '위치 없는 사진: 토스트도 **탈출구**를 함께 준다(§12)',
  noGpsToast.includes('지도로 찍거나') && noGpsToast.includes('내 위치'),
  noGpsToast,
);
check(
  '위치 없는 사진: 되돌릴 것이 없으므로 **실행취소를 붙이지 않는다**(빈 버튼을 만들지 않는다)',
  !noGpsToast.includes('실행취소'),
  noGpsToast,
);

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 **문장이 화면에 다 들어오는가** (사용자 실기기 스크린샷 2026-07-31 · M-0055)
//
// 위 세 검사는 전부 PASS였는데 **실기기에서는 문장이 잘려 있었다** — 「🗺️ 지도로 찍거나, 다른」
// 에서 끊겨 *그래서 어떻게 하는지*가 안 보였다. 원인은 `.undo-msg { white-space: nowrap }`,
// 토스트가 「여행을 지웠어요」처럼 **짧은 말만 하던 시절의 전제**다.
//
// 왜 못 잡았나: 검사가 `textContent`만 읽었다. **자료구조에는 온전히 있고 화면에서만 잘린다**
// (§10 ③). 그래서 이제 **잰다** — 폰 폭에서 넘침·잘림·화면 밖 여부를.
// ─────────────────────────────────────────────────────────────────────────────
await page.setViewportSize({ width: 344, height: 800 }); // 폴드5 접은 폭
await settle(page);
const toastFit = await page.evaluate(() => {
  const t = document.querySelector('.undo-toast');
  const m = t?.querySelector('.undo-msg');
  if (!t || !m) return null;
  const tr = t.getBoundingClientRect();
  const mr = m.getBoundingClientRect();
  // 🔴 **재는 대상은 span이 아니라 토스트 상자다.**
  // 처음엔 `m.scrollWidth - m.clientWidth`로 물었는데, `nowrap`을 실제로 되돌려 보니
  // **0이 나왔다** — span 자신은 늘어나기만 하고 잘리는 곳은 **부모(max-width가 걸린 토스트)**다.
  // 즉 그 검사는 진짜 결함에 대해 **공허했다**(§4는 새로 만든 게이트에도 걸린다).
  const pr = parseFloat(getComputedStyle(t).paddingRight || '0');
  return {
    clipped: Math.round(Math.max(t.scrollWidth - t.clientWidth, mr.right - (tr.right - pr))),
    lines: Math.round(mr.height / parseFloat(getComputedStyle(m).lineHeight || '20')),
    inside: tr.left >= -0.5 && tr.right <= window.innerWidth + 0.5, // 토스트가 화면 안인가
    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
});
check(
  '🔴 토스트: 긴 안내 문장이 **잘리지 않는다**(자료구조에만 온전하면 M-0022의 재발)',
  toastFit !== null && toastFit.clipped <= 1,
  JSON.stringify(toastFit),
);
check(
  '🔴 토스트: 폰 폭에서 **여러 줄로 접힌다**(한 줄 고정이 잘림의 원인이었다)',
  toastFit !== null && toastFit.lines >= 2,
  JSON.stringify(toastFit),
);
check(
  '토스트: 화면 밖으로 밀려나지 않고 가로 넘침도 만들지 않는다',
  toastFit !== null && toastFit.inside && toastFit.pageOverflow === 0,
  JSON.stringify(toastFit),
);
await page.setViewportSize({ width: 390, height: 844 }); // §3-C — 내가 바꾼 뷰포트를 되돌린다
await settle(page);

// ② 이름 없이 좌표만 들어간 순간도 **칩으로 보인다**(동의 없이 좌표만 넣은 경우가 그것이다).
await noGpsCard.locator('.icon-btn[aria-label="이 순간 편집"]').click();
await settle(page);
await page.evaluate(() => localStorage.removeItem('bugeon:photoGeoOk')); // 동의 없는 상태 재현
await noGpsCard.locator('.icon-btn[aria-label="이 순간 편집"]').click();
await settle(page);
await page.evaluate(() => document.querySelector('.undo-toast')?.remove());
await noGpsCard.locator('.moment-photo-input').setInputFiles([
  { name: 'coordonly.jpg', mimeType: 'image/jpeg', buffer: withExifGps(imgBuf, '2026:07:16 05:00:00', 37.5665, 126.978) },
]);
await page.waitForSelector('.pe-overlay', { timeout: 20000 });
await page.getByRole('button', { name: '적용', exact: true }).click();
await page.waitForSelector('.undo-toast', { timeout: 20000 });
await page.waitForFunction(() => {
  const card = [...document.querySelectorAll('.moment-card')].find((c) => c.textContent?.includes('GPS 없는 사진 검증'));
  return (card?.querySelector('.chip.gps')?.textContent ?? '').includes('37.5665');
});
const coordOnly = await page.evaluate(() => {
  const c = [...document.querySelectorAll('.moment-card')].find((x) => x.textContent?.includes('GPS 없는 사진 검증'));
  return { chip: c?.querySelector('.chip.gps')?.textContent ?? '', toast: document.querySelector('.undo-toast')?.textContent ?? '' };
});
check(
  '🔴 이름 없는 좌표: **칩으로 보인다**(넣었는데 화면이 그대로면 사용자는 「안 된다」고 읽는다)',
  coordOnly.chip.includes('37.5665') && coordOnly.chip.includes('126.978'),
  JSON.stringify(coordOnly),
);
check(
  '이름 없는 좌표: 동의가 없으면 **좌표만 넣고 그렇게 말한다**(여기서 새로 묻지 않는다)',
  coordOnly.toast.includes('좌표') && coordOnly.toast.includes('실행취소'),
  coordOnly.toast,
);
await page.evaluate(() => localStorage.setItem('bugeon:photoGeoOk', '1')); // §3-C 되돌리기
await noGpsCard.locator('.icon-btn[aria-label="이 순간 편집"]').click();
await settle(page);
await page.unroute('**/reverse**');
await page.route('**/reverse**', defaultReverseRoute);
// §3-C — 편집 폼을 닫고 스크롤을 되돌린다(사진 2장은 이 순간에 실제로 붙었다 — 뒤 검사가
// 개수를 세지 않으므로 그대로 둔다. 세는 검사가 생기면 여기서 지워야 한다).
await editCard.locator('.icon-btn[aria-label="이 순간 편집"]').click();
await page.evaluate(() => window.scrollTo(0, 0));
await settle(page);

// ── 🕒 시간대: `<input list>`가 아니라 **진짜 드롭다운**인가 ──
// 사용자 제안: *"드롭다운해서 선택하게끔"*. 이건 취향이 아니라 **내가 이미 flag한 위험**이었다 —
// v1.27에서 「안드로이드 크롬에서 datalist 자동완성이 안 뜰 수 있다」를 실기기 확인 항목에 적었다.
const openEditPanel = async () => {
  // 🔴 토글을 부르지 않고 **열린 상태를 보장**한다. `.hero-edit`는 토글이라 앞선 검사가
  // 열어 뒀으면 내 클릭이 **닫는다** — 그 상태 의존이 이 블록을 한 번 타임아웃시켰다(§3-C).
  for (let i = 0; i < 2; i++) {
    const open = await page.evaluate(() => {
      const p = document.querySelector('[data-zone-input]')?.closest('.edit-panel');
      return p instanceof HTMLElement ? !p.hidden : false;
    });
    if (open) return;
    await page.locator('.hero-edit').first().click();
    await settle(page);
  }
};
await openEditPanel();
const zoneUi = await page.evaluate(() => {
  const t = document.querySelector('[data-zone-input]');
  const h = document.querySelector('[data-home-zone-input]');
  return {
    tripTag: t?.tagName ?? '',
    homeTag: h?.tagName ?? '',
    groups: t instanceof HTMLSelectElement ? t.querySelectorAll('optgroup').length : 0,
    options: t instanceof HTMLSelectElement ? t.options.length : 0,
    firstValue: t instanceof HTMLSelectElement ? t.options[0]?.value : null,
    firstText: t instanceof HTMLSelectElement ? t.options[0]?.textContent : null,
    datalists: document.querySelectorAll('datalist').length,
  };
});
check('시간대: 드롭다운(select)이다 — 폰에서 네이티브 선택기가 뜬다', zoneUi.tripTag === 'SELECT', JSON.stringify(zoneUi));
check('시간대: **집 시간대도 같은 모양**이다(§7 화면 대칭 — 한쪽만 낡지 않게)', zoneUi.homeTag === 'SELECT', zoneUi.homeTag);
check('시간대: 대륙별로 묶여 있다(418개를 한 줄로 늘어놓지 않는다)', zoneUi.groups >= 5 && zoneUi.options > 100, JSON.stringify(zoneUi));
check('시간대: 「미지정」이 맨 앞이고 빈 값이다(비우는 것은 사실이지 결함이 아니다)', zoneUi.firstValue === '' && (zoneUi.firstText ?? '').includes('미지정'), JSON.stringify(zoneUi));

// 골라 보면 미리보기가 재판정된다(§8 — 고쳤다고 말하지 말고 다시 읽어라).
//
// 🔴 `Asia/Bangkok`을 쓴다(+7). `Asia/Ho_Chi_Minh`으로 썼더니 **타임아웃**이 났다 —
// Chromium의 `supportedValuesOf`는 그 자리에 별칭 `Asia/Saigon`을 준다. 목록에 없는 값을
// 고르라고 하면 Playwright는 영원히 기다린다. **id는 브라우저가 정한다**는 것을 검사도
// 알아야 한다(그래서 `buildZoneSelect`에 `ensureOption`이 있다 — 저장된 별칭이 조용히
// 「미지정」으로 바뀌지 않게).
await page.selectOption('[data-zone-input]', 'Asia/Bangkok');
await settle(page);
const zonePick = await page.evaluate(() => document.querySelector('.zone-field .zone-preview')?.textContent ?? '');
check('시간대: 고르면 미리보기가 **다시 그려진다**', /UTC\+7/.test(zonePick), zonePick);

// §3-C 되돌리기 — 뒤 검사들이 보는 화면을 바꿔 놓지 않는다.
await page.selectOption('[data-zone-input]', '');
await settle(page);
await page.locator('.hero-edit').first().click(); // 패널을 닫아 원래 상태로
await settle(page);
const zoneRestored = await page.evaluate(() => {
  const t = document.querySelector('[data-zone-input]');
  return t instanceof HTMLSelectElement ? t.value : 'MISSING';
});
check('시간대: 되돌렸다(내 상태를 뒤 검사에 남기지 않는다 — §3-C)', zoneRestored === '', zoneRestored);
// 🔴 **스크롤도 상태다.** 이 블록이 `scrollIntoView`로 페이지를 내렸는데, 넓은 화면 2단 검사는
// `.detail-compose`(sticky)와 타임라인의 **top 차이**를 재므로 스크롤된 채로는 어긋난다.
// goto·fetch 스텁·뷰포트에 이어 **네 번째** 형태다 — 되돌릴 것의 목록은 내가 생각한 것보다 길다.
await page.evaluate(() => window.scrollTo(0, 0));
await settle(page);

// ── 🔴 v1.27 (M-0049 후반): 「그 자리의 시계」가 **화면에 실제로 나오는가** ────────────
// 사용자 지적(2026-07-29, 스크린샷): *"사진 찍은 나라 또는 지역의 시간으로 적용되게 고정하고,
// 사진에 장소정보가 없다면 사용자가 지정한 장소를 기준으로 하고, 적당한 위치에 한국시간으로
// 자동 환산해주면 좋을 거 같아요."*
//
// 유닛(`tripClock.test.ts` 29건)이 `momentWhen`의 값과 문장을 잰다. **그런데 그건 자료구조다.**
// M-0022·M-0046이 정확히 그 틈이었다 — 숫자는 다 맞고 화면 문장만 틀렸다(§10 ③). 여기서는
// 실제 DOM을 잰다: ①고지가 뜨는가 ②🔴 **고지의 버튼을 눌러** 고칠 자리로 데려가는가(§13 4항)
// ③시간대를 넣으면 미리보기가 재판정되는가(§8) ④저장 후 타임라인 시각이 **바뀌는가**
// ⑤환산 꼬리표가 붙는가 ⑥비우면 고지가 **되돌아오는가**.
//
// 🔴 §3-C — **이 블록은 여행의 시간대와 집 시간대를 바꾼다.** 뒤따르는 검사들이 타임라인
// 시각을 보므로, 끝에서 **둘 다 원래대로 되돌린다**(2026-07-29~30에 두 번 어겼던 그 자리다).
const homeZoneBefore = await page.evaluate(() => localStorage.getItem('bj.homeZone') ?? '');
check('시계: 집 시간대가 처음 읽힐 때 기록돼 있다(여행 중에 환산이 사라지지 않게)', homeZoneBefore.length > 0, homeZoneBefore || '(없음)');

const clock0 = await page.evaluate(() => {
  const n = document.querySelector('.zone-notice');
  return {
    times: [...document.querySelectorAll('.tl-time')].map((e) => e.textContent ?? ''),
    homes: document.querySelectorAll('.tl-time-home').length,
    notice: n ? (n.querySelector('.zone-notice-msg')?.textContent ?? '') : '',
    fixBtn: n ? (n.querySelector('[data-zone-fix]')?.textContent ?? '') : '',
  };
});
check('시계: 타임라인에 순간 시각이 그려져 있다', clock0.times.length > 0 && /^\d{2}:\d{2}$/.test(clock0.times[0] ?? ''), JSON.stringify(clock0.times));
check(
  '시계: 시간대 미지정이면 **추정임을 화면에서 말한다**(M-0049 근본형 = 조용히 기기 시계를 썼다)',
  clock0.notice.includes('이 기기 시간대'),
  clock0.notice || '(고지 없음)',
);
check('시계: 고지가 **갈 곳을 준다**(§12 — 말하고 끝내지 않는다)', clock0.fixBtn.includes('여행 시간대'), clock0.fixBtn || '(버튼 없음)');

// 🔴 §13 4항 — **누른다.** 라벨만 읽는 것은 확인한 것이 아니다(M-0046·M-0048이 둘 다 버튼 결함).
await page.locator('[data-zone-fix]').first().click();
await settle(page);
const afterFix = await page.evaluate(() => {
  const zi = document.querySelector('[data-zone-input]');
  const panel = zi?.closest('.edit-panel');
  return {
    panelOpen: panel instanceof HTMLElement ? !panel.hidden : false,
    focused: document.activeElement === zi,
    visible: zi ? zi.getBoundingClientRect().height > 0 : false,
    btnStillEnabled: !document.querySelector('[data-zone-fix]')?.disabled,
  };
});
check('시계: 고지 버튼을 누르면 편집 패널이 **열린다**', afterFix.panelOpen && afterFix.visible, JSON.stringify(afterFix));
check('시계: 그리고 시간대 칸에 **초점이 간다**(어디를 고쳐야 하는지 손으로 찾게 두지 않는다)', afterFix.focused, JSON.stringify(afterFix));
check('시계: 버튼이 잠긴 채 남지 않는다', afterFix.btnStillEnabled === true, JSON.stringify(afterFix));

// 집 시간대를 명시로 고정한다 — 이 컨테이너의 기기 시간대에 기대면 검사가 환경에 흔들린다.
await page.selectOption('[data-home-zone-input]', 'Asia/Seoul');
await settle(page);
const homePrev = await page.evaluate(() => {
  const i = document.querySelector('[data-home-zone-input]');
  return i?.parentElement?.querySelector('.zone-preview')?.textContent ?? '';
});
check('시계: 집 시간대 미리보기가 **이름 + 현재 시각**을 말한다', /UTC\+9/.test(homePrev) && !homePrev.includes('Asia/'), homePrev || '(미리보기 없음)');

// 🔴 **오타 경로가 사라졌다**(v1.28에서 `<select>`로 바꾸면서). 예전엔 「Asia/Seuol」을 칠 수
// 있어서 「알 수 없어요」를 재는 검사가 있었는데, 이제 목록에서 고르므로 **원리적으로 불가능**하다.
// 케이스를 지우지 않고 **뒤집는다**(§11 ②): 자유 입력이 없다는 것을 잰다.
const noFreeText = await page.evaluate(() => {
  const t = document.querySelector('[data-zone-input]');
  return { tag: t?.tagName ?? '', values: t instanceof HTMLSelectElement ? [...t.options].every((o) => o.value === '' || o.value.includes('/') || o.value === 'UTC') : false };
});
check('시계: 오타를 칠 자리가 **없다**(드롭다운이라 값이 목록 안에서만 나온다)', noFreeText.tag === 'SELECT' && noFreeText.values, JSON.stringify(noFreeText));

await page.selectOption('[data-zone-input]', 'Asia/Bangkok');
await settle(page);
const preview = await page.evaluate(() => document.querySelector('.zone-field .zone-preview')?.textContent ?? '');
check('시계: 고른 시간대를 **눈으로 확인**시킨다(id만 보고는 아무도 모른다 — §12)', /UTC\+7/.test(preview) && preview.includes('인도차이나'), preview);

await page.locator('.edit-panel .btn-primary', { hasText: '저장' }).first().click();
await page.waitForSelector('.tl-time', { timeout: 10000 });
await page.waitForFunction((oldTime) => {
  const time = document.querySelector('.tl-time')?.textContent ?? '';
  const home = document.querySelector('.tl-time-home')?.textContent ?? '';
  return document.querySelectorAll('.zone-notice').length === 0 &&
    /^\d{2}:\d{2}$/.test(time) && time !== oldTime && /\d{2}:\d{2}/.test(home);
}, clock0.times[0] ?? '');
const clock1 = await page.evaluate(() => ({
  time: document.querySelector('.tl-time')?.textContent ?? '',
  home: document.querySelector('.tl-time-home')?.textContent ?? '',
  notice: document.querySelectorAll('.zone-notice').length,
  hint: document.querySelector('.when-clock')?.textContent ?? '',
  overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
}));
check('시계: 시간대를 정하면 고지가 **사라진다**(고쳤으면 조용해져야 한다 — §8)', clock1.notice === 0, String(clock1.notice));
check('시계: 타임라인 시각이 **여행지 기준으로 바뀐다**', /^\d{2}:\d{2}$/.test(clock1.time) && clock1.time !== clock0.times[0], `${clock0.times[0] ?? '?'} → ${clock1.time}`);
check(
  '시계: 집 시간 환산이 **다를 때만** 함께 나온다(사용자 요청 — 한국시간 자동 환산)',
  /\d{2}:\d{2}/.test(clock1.home) && clock1.home !== clock1.time && !clock1.home.includes('Asia/'),
  clock1.home || '(환산 없음)',
);
check('시계: 입력 칸이 **어느 시계로 적는지** 말한다', clock1.hint.includes('인도차이나'), clock1.hint || '(안내 없음)');
check('시계: 환산 줄이 가로 넘침을 만들지 않는다(폴드5 접은 화면 대비)', clock1.overflow <= 0, String(clock1.overflow));

// ── 되돌리기(§3-C) — 뒤따르는 검사들이 보는 화면을 내가 바꿔 놓지 않는다 ──
await page.locator('.hero-edit').first().click();
await settle(page);
await page.selectOption('[data-zone-input]', '');
await page.selectOption('[data-home-zone-input]', homeZoneBefore);
await settle(page);
await page.locator('.edit-panel .btn-primary', { hasText: '저장' }).first().click();
await page.waitForSelector('.zone-notice', { timeout: 10000 });
const restored = await page.evaluate(() => ({
  notice: document.querySelectorAll('.zone-notice').length,
  homes: document.querySelectorAll('.tl-time-home').length,
  time: document.querySelector('.tl-time')?.textContent ?? '',
  homeZone: localStorage.getItem('bj.homeZone') ?? '',
}));
check(
  '시계: 시간대를 **비우면** 고지가 되돌아온다(미지정은 결함이 아니라 사실이다)',
  restored.notice === 1 && restored.homes === 0,
  JSON.stringify(restored),
);
check('시계: 되돌린 뒤 타임라인 시각이 원래대로', restored.time === clock0.times[0], `${clock0.times[0] ?? '?'} vs ${restored.time}`);
check('시계: 집 시간대도 원래대로 되돌렸다(뒤 검사에 내 상태를 남기지 않는다)', restored.homeZone === homeZoneBefore, restored.homeZone);

// ── v1.16: 소리 칩이 형제와 **같은 줄에 같은 높이로** 선다 ──
// 실제 사고(2026-07-27 사용자 실기기): *"칩 디자인이 조잡하네요."* `.chip`이 flex가 아니어서
// 소리 칩 안의 ✕가 **둘째 줄로 밀려났고**, 그 칩만 형제(장소)보다 두 배 높아 줄이 어긋났다.
// 이건 자료구조가 아니라 **화면에만 나타나는** 부류라(§10 ③) 유닛이 원리적으로 못 잡는다.
//
// 마크업을 손으로 세우지 않고 **Dexie에 행을 넣어 앱이 스스로 그리게** 한다 — 그래야
// 클래스 이름이 바뀌면 이 검사가 빨개진다(내가 쓴 마크업을 재면 그건 나 자신을 재는 것이다).
const audioSeed = await page.evaluate(async () => {
  const pick = await new Promise((resolve, reject) => {
    const req = indexedDB.open('journey-archive');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('localMoments', 'readonly');
      const all = tx.objectStore('localMoments').getAll();
      all.onsuccess = () => resolve(all.result.filter((m) => m.deletedAt === null).pop());
      all.onerror = () => reject(all.error);
    };
    req.onerror = () => reject(req.error);
  });
  if (!pick) return null;
  // **실제로 재생되는** 소리를 만든다(무음 WAV 1.5초). 예전엔 0바이트 더미를 넣었더니
  // 재생이 실패해 「재생 불가」 경로만 재고 있었다 — 픽스처가 틀리면 검사는 조용히 딴 것을 잰다.
  const sr = 8000, sec = 1.5, n = Math.floor(sr * sec);
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const put = (o, t) => { for (let i = 0; i < t.length; i++) dv.setUint8(o + i, t.charCodeAt(i)); };
  put(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); put(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true); put(36, 'data'); dv.setUint32(40, n * 2, true);
  const now = new Date().toISOString();
  const row = {
    id: crypto.randomUUID(), momentId: pick.id, tripId: pick.tripId,
    blob: new Blob([buf], { type: 'audio/wav' }),
    mime: 'audio/wav', durationSec: 3, recordedAt: now,
    createdAt: now, updatedAt: now, deletedAt: null, version: 1,
  };
  await new Promise((resolve, reject) => {
    const req = indexedDB.open('journey-archive');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('localAudio', 'readwrite');
      tx.objectStore('localAudio').put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
  return { momentId: pick.id, tripId: pick.tripId };
});
check('소리 칩: 픽스처 주입(순간에 녹음 1건)', Boolean(audioSeed), JSON.stringify(audioSeed));

await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.chip.audio', { timeout: 10000 });

// **화면 안으로 들여놓고** 잰다. `elementFromPoint`는 뷰포트 밖이면 null을 돌려주는데,
// 그걸 "안 눌린다"로 읽으면 멀쩡한 것을 결함이라 부른다(오탐은 틀린 게이트다 — §11 ③).
await page.evaluate(() => document.querySelector('.chip.audio')?.scrollIntoView({ block: 'center' }));
await settle(page);
const chipGeo = await page.evaluate(() => {
  const audio = document.querySelector('.chip.audio');
  const sibling = document.querySelector('.chip.gps') ?? document.querySelector('.chip:not(.audio)');
  const r = (e) => e.getBoundingClientRect();
  const a = r(audio);
  const play = audio.querySelector('.chip-audio-play');
  const x = audio.querySelector('.chip-x');
  const out = {
    h: +a.height.toFixed(1),
    siblingH: sibling ? +r(sibling).height.toFixed(1) : null,
    // ✕가 재생 버튼과 **같은 줄**인가 — 세로 중심이 겹치면 한 줄이다.
    oneLine: !!x && Math.abs((r(x).top + r(x).bottom) / 2 - (r(play).top + r(play).bottom) / 2) < 4,
    hasX: !!x,
    // 칩 높이가 내용 두 줄만큼 커지지 않았는가(둘째 줄로 밀리면 여기서 터진다).
    notStacked: a.height < 40,
  };
  if (x) {
    const b = r(x);
    out.xW = +b.width.toFixed(1);
    out.xH = +b.height.toFixed(1);
    out.xArea = Math.round(b.width * b.height);
    // 넓힌 목표가 **칩 밖으로 새지 않는가** — 새면 보이지 않는 삭제 버튼이 옆 것을 덮는다.
    out.insideChip = b.top >= a.top - 0.6 && b.bottom <= a.bottom + 0.6 && b.right <= a.right + 0.6;
    const at = (dx, dy) => document.elementFromPoint(b.left + b.width / 2 + dx, b.top + b.height / 2 + dy);
    const hit = (dx, dy) => { const e = at(dx, dy); return e === x || x.contains(e); };
    out.probes = { c: hit(0,0), l: hit(-8,0), r: hit(8,0), u: hit(0,-10), d: hit(0,10) };
    out.reachable = Object.values(out.probes).every(Boolean);
  }
  return out;
});
check('소리 칩: ✕가 재생과 **같은 줄**(둘째 줄로 밀리지 않는다)', chipGeo.oneLine === true, JSON.stringify(chipGeo));
check('소리 칩: 세로로 쌓이지 않는다', chipGeo.notStacked === true, `h=${chipGeo.h}`);
check(
  '소리 칩: 형제 칩과 **같은 높이**(줄이 어긋나지 않는다)',
  chipGeo.siblingH === null || Math.abs(chipGeo.h - chipGeo.siblingH) < 1.5,
  `audio=${chipGeo.h} sibling=${chipGeo.siblingH}`,
);
check(
  '소리 칩: ✕를 누를 수 있는 넓이가 칩 높이를 채운다(≥600px²)',
  chipGeo.xArea >= 600 && chipGeo.reachable === true,
  `${chipGeo.xW}×${chipGeo.xH}=${chipGeo.xArea}px² reachable=${chipGeo.reachable}`,
);
check(
  '소리 칩: ✕의 누름 영역이 **칩 밖으로 새지 않는다**(사진 위에 얹힌 삭제 목표를 만들지 않는다)',
  chipGeo.insideChip === true,
  String(chipGeo.insideChip),
);

// 재생을 눌렀을 때 **칩 폭이 흔들리지 않는가** — 글리프·숫자가 바뀌며 옆 칩을 밀면 그게 조잡함이다.
const widthBefore = await page.$eval('.chip.audio', (e) => e.getBoundingClientRect().width);
await page.locator('.chip-audio-play').first().click();
await settle(page);
const playState = await page.evaluate(() => {
  const c = document.querySelector('.chip.audio');
  return {
    w: c.getBoundingClientRect().width,
    pressed: c.querySelector('.chip-audio-play').getAttribute('aria-pressed'),
  };
});
check('소리 칩: 재생 상태가 aria-pressed로 전해진다', playState.pressed === 'true', String(playState.pressed));

// 🔴 **끝까지 재생한 뒤** 라벨을 본다(2026-07-28 사용자 실기기: *"재생불가가 아닌데
// 재생불가라고 안내하네요"*). 정리 과정이 `error`를 발화시켜, 정상 재생을 마친 **직후에만**
// 「🔇 재생 불가」로 덮이고 있었다. 재생 중만 재면 이 부류는 영원히 안 잡힌다 —
// 검사는 **끝난 뒤**를 봐야 한다.
// 픽스처의 미디어 시간은 1.5초지만, CI·저사양 기기에서는 실제 재생 시계가 벽시계보다
// 느리게 갈 수 있다. 고정 sleep은 아직 재생 중인 정상 상태를 실패로 읽는다. 시작 상태를
// 위에서 확인했으므로, 여기서는 앱이 종료/오류를 판정해 idle로 돌아올 때까지 기다린다.
// 오류도 idle로 돌아오지만 바로 아래 「재생 불가」 판정이 따로 잡는다.
await page
  .waitForFunction(
    () => document.querySelector('.chip.audio .chip-audio-play')?.getAttribute('aria-pressed') === 'false',
    null,
    { timeout: 15000 },
  )
  .catch(() => {});
const afterEnd = await page.evaluate(() => {
  const chip = document.querySelector('.chip.audio');
  const btn = chip.querySelector('.chip-audio-play');
  return {
    text: btn.textContent.trim(),
    pressed: btn.getAttribute('aria-pressed'),
    p: getComputedStyle(chip).getPropertyValue('--p').trim(),
  };
});
check(
  '🔴 소리 칩: 끝까지 재생해도 「재생 불가」라고 하지 않는다(정상을 실패라 말하지 않는다)',
  !afterEnd.text.includes('재생 불가') && !afterEnd.text.includes('🔇'),
  JSON.stringify(afterEnd),
);
check('소리 칩: 재생이 끝나면 멈춤 상태로 돌아온다', afterEnd.pressed === 'false', JSON.stringify(afterEnd));
check(
  '소리 칩: 재생해도 폭이 흔들리지 않는다(옆 칩을 밀지 않는다)',
  Math.abs(playState.w - widthBefore) < 1.5,
  `${widthBefore.toFixed(1)} → ${playState.w.toFixed(1)}`,
);

// ── v1.18: 위치 칩 → 앱 지도 → (선택) 구글 지도 ──
// 사용자 요청(2026-07-27): *"위치 칩을 클릭하면 지도가 뜨도록 하고 그 지도는 구글지도로 연동"*
// 결정: 칩은 **앱 지도**를 연다(비공개·오프라인). 구글은 그 안에서 한 번 더 눌러 간다.
// 여기서 재는 것은 **배선**이다 — 순수 함수(URL·문장)는 tests/unit/externalMap.test.ts가 잰다.
//
// 장소가 달린 순간을 Dexie에 직접 만들어 앱이 스스로 칩을 그리게 한다(오디오와 같은 규율).
const placeSeed = await page.evaluate(async () => {
  const put = (m) => new Promise((resolve, reject) => {
    const req = indexedDB.open('journey-archive');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('localMoments', 'readwrite');
      tx.objectStore('localMoments').put(m);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
  const pick = await new Promise((resolve, reject) => {
    const req = indexedDB.open('journey-archive');
    req.onsuccess = () => {
      const tx = req.result.transaction('localMoments', 'readonly');
      const all = tx.objectStore('localMoments').getAll();
      all.onsuccess = () => resolve(all.result.filter((m) => m.deletedAt === null).pop());
      all.onerror = () => reject(all.error);
    };
    req.onerror = () => reject(req.error);
  });
  if (!pick) return null;
  await put({ ...pick, placeName: '김포국제공항', placeLat: 37.5583, placeLng: 126.7906 });
  return { id: pick.id, title: pick.title ?? '' };
});
check('위치 칩: 픽스처 주입(좌표 있는 장소)', Boolean(placeSeed?.id), JSON.stringify(placeSeed));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.chip.gps', { timeout: 10000 });

// 🔴 **심은 순간의 칩을 누른다 — 화면의 첫 칩이 아니다.**
//
// 예전엔 `document.querySelector('.chip.gps')`로 **첫 칩**을 집었다. 그런데 픽스처는
// 저장소의 **마지막** 순간에 심는다(`.pop()`) — 둘이 같다는 보장이 어디에도 없었고, 실제로
// 앞 블록들이 다른 순간에 장소를 넣자 **다낭 좌표를 집어** 서울 기대값(`ll=126.…,37.…`)과
// 어긋났다. 로컬에서 2회 중 1회, CI에서 3건 RED.
//
// 근본형은 M-0052·v1.29와 같다: **검사가 자기 픽스처를 소유하지 않으면, 남이 만든 상태를
// 자기 것으로 읽는다.** 좌표가 든 순간이 하나뿐이던 시절의 전제가 화석으로 남아 있었다.
const seededCard = page.locator('.moment-card', { hasText: placeSeed?.title ?? '' }).first();
const seededChip = seededCard.locator('.chip.gps').first();
const seededMapButton = seededChip.locator('.place-chip-map');
await seededChip.scrollIntoViewIfNeeded();
await settle(page);
const chipIsButton = await seededMapButton.evaluate((c) => ({
  tag: c.tagName,
  tappable: c.classList.contains('place-chip-map'),
  label: c.getAttribute('aria-label'),
}));
check(
  '🔴 위치 칩: 검사가 **자기가 심은 순간**의 칩을 집는다(첫 칩이 아니라 — 남의 상태를 내 것으로 읽지 않는다)',
  /김포/.test(chipIsButton?.label ?? ''),
  String(chipIsButton?.label),
);
check(
  '위치 칩: 지도 영역은 누를 수 있는 버튼이다',
  chipIsButton?.tag === 'BUTTON' && chipIsButton.tappable === true,
  JSON.stringify(chipIsButton),
);
check('위치 칩: 무엇을 하는 버튼인지 이름이 있다(스크린리더)', /지도/.test(chipIsButton?.label ?? ''), String(chipIsButton?.label));

await seededMapButton.click();
await page.waitForSelector('.map-overlay', { timeout: 10000 });
check('위치 칩: 탭하면 앱 지도가 열린다', true, 'map-overlay');

// ── v1.19: 지도가 넷이 됐다(구글·얀덱스·네이버·카카오). 사용자 요청 2026-07-28.
// 유닛이 URL 문자열을 재는 것과, **버튼을 눌렀을 때 그 URL이 실제로 나가는 것**은 다른 층이다.
// 여기서는 후자를 잰다 — 배선이 끊기면 유닛은 초록인데 아무 일도 안 일어난다(M-0038).
const ext = await page.evaluate(() => {
  const wrap = document.querySelector('.map-ext');
  const cs = wrap ? getComputedStyle(wrap) : null;
  const btns = [...document.querySelectorAll('.map-ext-btn')];
  const r = (e) => e.getBoundingClientRect();
  const last = btns.length ? r(btns[btns.length - 1]) : null;
  return {
    labels: btns.map((b) => b.textContent.trim()),
    note: document.querySelector('.map-ext-note')?.textContent ?? null,
    padTop: cs?.paddingTop ?? null,
    padBottom: cs?.paddingBottom ?? null,
    // 버튼 아래와 wrap 바닥 사이가 실제로 벌어져 있는가(padding이 0이면 0에 가깝다).
    gapUnderButtons: last && wrap ? +(r(wrap).bottom - last.bottom).toFixed(1) : -1,
    sameRowTop: btns.length > 1 ? Math.abs(r(btns[0]).top - r(btns[1]).top) < 2 : false,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
});
check('지도 안에 바깥 지도 버튼이 있다(칩이 곧바로 밖으로 나가지 않는다)', ext.labels.length > 0, ext.labels.join(' · '));
check(
  '지도 링크: 구글·얀덱스·네이버·카카오 넷 다 있다',
  ['구글', '얀덱스', '네이버', '카카오'].every((l) => ext.labels.includes(l)),
  ext.labels.join(' · '),
);

// 실제 사고(2026-07-28 사용자 실기기): *"버튼 하단 여백이 없어서 답답해보여요."*
// `.map-ext`의 아래 padding이 **0**이라 버튼이 지도에 붙어 있었다. 위아래가 다르면
// 사람 눈에는 "덜 만든 것"으로 보인다 — 기계는 못 보고 화면에서만 드러나는 부류(§10 ③).
check(
  '🔴 지도 링크: 버튼 아래 여백이 있다(지도에 딱 붙지 않는다)',
  ext.padBottom !== '0px' && ext.gapUnderButtons >= 8,
  `padding ${ext.padTop} / ${ext.padBottom} · 아래 여백 ${ext.gapUnderButtons}px`,
);
check('지도 링크: 위아래 여백이 같다(한쪽만 비면 덜 만든 것으로 보인다)', ext.padTop === ext.padBottom, `${ext.padTop} vs ${ext.padBottom}`);
check('지도 링크: 버튼들이 한 줄에 선다(넓은 화면)', ext.sameRowTop === true, String(ext.sameRowTop));
check('지도 링크: 가로 넘침 0', ext.overflow === 0, `overflow=${ext.overflow}`);

// 좌표가 있는 장소이므로 「이름으로 찾았다」 단서는 **없어야** 한다(있으면 거짓 경보다).
check('좌표가 있으면 「이름으로 찾음」 단서를 달지 않는다', ext.note === null, String(ext.note));

// ── 🔴 v1.24 (M-0050): 지점이 **하나**일 때의 확대수준 ──
// 사용자 실기기 신고 2026-07-30: *"기본맵이 너무 부정확해요."* 스크린샷의 축척 기준점으로
// 핀을 역산하니 127.00E/37.587N — **대학로 위**였다. 좌표는 맞았다. 틀린 것은 확대수준이다.
// 예전 코드는 `points.length === 1`일 때 `setCenter`만 부르고 zoom을 **안 건드려** 초기값
// 10이 남았다. 형제(목록 행 클릭)는 `flyTo({zoom:14})`로 제대로 하고 있었다 — §7 비대칭.
//
// 지금 열려 있는 지도는 위치 칩에서 연 것이라 지점이 **하나**다. 그 상태에서 앱이 실제로
// 요청한 타일의 z를 잰다. 자료구조가 아니라 **앱이 한 일**이다.
// 🔴 **자지 않고 기다린다**(T-014). 예전엔 `waitForTimeout(1200)`이었는데, 느린 순간에
// 타일이 1.2초 안에 안 나가면 「타일 0건」이 찍혔다 — 그 0은 「안 나갔다」가 아니라
// **「아직 안 봤다」**였다. 못 채워도 던지지 않는다: 진짜 0이면 아래 판정이 그 사실을 말한다(§4).
await waitUntil(async () => (await page.locator('.map-canvas').getAttribute('data-map-provider')) !== null, 15000);
const mapProviderSeen = await page.locator('.map-canvas').evaluate((node) => ({
  provider: node.dataset.mapProvider ?? '',
  kakaoLevel: Number(node.dataset.kakaoLevel ?? '-1'),
}));
check(
  '지도: 한국 좌표가 Kakao SDK를 실제로 요청하고 Kakao 제공자로 준비된다',
  kakaoSdkRequests > 0 && mapProviderSeen.provider === 'kakao',
  `SDK ${kakaoSdkRequests}건 · provider=${mapProviderSeen.provider || '(없음)'}`,
);
check(
  '🔴 지도: Kakao에서도 지점이 하나면 그 지점까지 확대한다',
  mapProviderSeen.kakaoLevel === 5,
  `Kakao level=${mapProviderSeen.kakaoLevel} (기대: 5)`,
);
// 지도는 **닫지 않는다** — 바로 아래 바깥지도 버튼 검사가 이 오버레이 안의 버튼을 누른다.
// (처음에 여기서 닫았다가 그 4건을 통째로 죽였다. 검사끼리도 형제다 — 하나가 상태를 치우면
//  다음 형제가 조용히 빈손이 된다.)

// 클릭이 **새 창으로** 나가는지 — 같은 탭을 뺏으면 사용자가 앱을 잃는다.
// 실제 외부 접속은 하지 않는다(샌드박스·외부 네트워크). window.open을 가로채 인자만 잰다.
// 동의 키는 **제공자별**이다(구글 동의가 얀덱스 동의가 아니다) — 그래서 넷을 다 미리 넣는다.
const openedAll = await page.evaluate(async () => {
  const out = {};
  const real = window.open;
  window.open = (url, target, feat) => { out.__last = { url, target, feat }; return null; };
  try {
    for (const id of ['google', 'yandex', 'naver', 'kakao']) localStorage.setItem(`bugeon:externalMapOk:${id}`, '1');
    for (const b of document.querySelectorAll('.map-ext-btn')) {
      out.__last = null;
      b.click();
      await new Promise((r) => setTimeout(r, 60));
      out[b.textContent.trim()] = out.__last;
    }
  } finally { window.open = real; }
  delete out.__last;
  return out;
});
const g = openedAll['구글'], y = openedAll['얀덱스'], nv = openedAll['네이버'], kk = openedAll['카카오'];
check('구글 링크가 Maps URLs 형식이다(api=1 · 키 없음)', /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/.test(g?.url ?? ''), String(g?.url));
// 🔴 얀덱스만 **경도,위도** 순서다 — 뒤집으면 다른 나라가 열린다.
check('얀덱스 링크가 경도,위도 순서다(넷 중 여기만 반대)', /yandex\.com\/maps\/\?ll=126\.\d+,37\./.test(y?.url ?? ''), String(y?.url));
check('네이버 링크에 lat·lng가 그대로 든다', /map\.naver\.com\/p\?.*lat=37\..*lng=126\./.test(nv?.url ?? ''), String(nv?.url));
check('카카오 링크가 이름,위도,경도 형식이다', /map\.kakao\.com\/link\/map\/[^/]+,37\.\d+,126\.\d+$/.test(decodeURIComponent(kk?.url ?? '')), String(kk?.url));
check(
  '🔴 어느 지도에도 API 키가 붙지 않는다(넷 다 그냥 링크 — 그래서 무료다)',
  [g, y, nv, kk].every((o) => o && !/[?&](api_?key|apikey|key)=/i.test(o.url)),
  '',
);
check(
  '넷 다 **새 창**으로 연다(앱을 잃지 않게)',
  [g, y, nv, kk].every((o) => o?.target === '_blank'),
  [g, y, nv, kk].map((o) => o?.target).join(','),
);
check(
  'noreferrer로 앱 주소가 함께 새지 않는다(PRIVACY · 넷 다)',
  [g, y, nv, kk].every((o) => /noreferrer/.test(o?.feat ?? '')),
  [g, y, nv, kk].map((o) => o?.feat).join(' | '),
);

await page.locator('.map-close').click();
await settle(page);

// ── v2.38: 장소 칩도 연결된 장소의 국가코드를 잃지 않는다 ────────────────
// 여행 전체 지도는 LocalPlace.countryCode를 넘겼지만 장소 칩은 좌표·이름만 새 배열로 만들며
// 국가코드를 버렸다. 그래서 같은 타슈켄트 장소가 전체 지도에서는 TomTom, 칩에서는 OSM이었다.
const tomtomChipSeed = await page.evaluate(async (momentId) => {
  const now = new Date().toISOString();
  const place = {
    id: 'tomtom-chip-live', name: 'TSMU 라이브검사', latitude: 41.35045, longitude: 69.172,
    formattedAddress: null, provider: null, providerPlaceId: null, countryCode: 'uz',
    country: 'Uzbekistan', region: null, city: 'Tashkent', district: null, postcode: null,
    category: null, memo: null, precision: null, spanMeters: null, mapPicked: true,
    version: 1, baseVersion: 0, createdAt: now, updatedAt: now, deletedAt: null,
    clientOperationId: 'tomtom-chip-live-op',
  };
  return await new Promise((resolve, reject) => {
    const req = indexedDB.open('journey-archive');
    req.onsuccess = () => {
      const tx = req.result.transaction(['localPlaces', 'localMoments'], 'readwrite');
      tx.objectStore('localPlaces').put(place);
      const getMoment = tx.objectStore('localMoments').get(momentId);
      getMoment.onsuccess = () => {
        const moment = getMoment.result;
        if (!moment) return;
        tx.objectStore('localMoments').put({
          ...moment,
          placeId: place.id,
          placeName: place.name,
          placeLat: place.latitude,
          placeLng: place.longitude,
        });
      };
      tx.oncomplete = () => resolve({ momentId, placeId: place.id });
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}, placeSeed.id);
check('TomTom 장소 칩: 국가코드 연결 픽스처 주입', tomtomChipSeed?.placeId === 'tomtom-chip-live', JSON.stringify(tomtomChipSeed));
await page.reload({ waitUntil: 'networkidle' });
const tomtomSeededCard = page.locator('.moment-card', { hasText: placeSeed.title }).first();
const tomtomChipButton = tomtomSeededCard.locator('.place-chip-map');
const tomtomChipBefore = tomtomTileRequests;
await tomtomChipButton.click();
await page.waitForSelector('.map-overlay', { timeout: 10000 });
await waitUntil(async () => (await page.locator('.map-canvas').getAttribute('data-map-provider')) !== null, 15000);
const tomtomChipProvider = await page.locator('.map-canvas').getAttribute('data-map-provider');
check(
  '🔴 TomTom 장소 칩: 연결된 UZ 국가코드를 보존해 TomTom 타일을 실제 요청한다',
  tomtomChipProvider === 'tomtom' && tomtomTileRequests > tomtomChipBefore,
  `provider=${tomtomChipProvider || '(없음)'} · tile=${tomtomTileRequests - tomtomChipBefore}`,
);
await page.locator('.map-close').click();
await settle(page);

// ── v1.68 이후: 감정 선택 확장 + 여행 기간 요일 ─────────────────────────────
// 계약: 생성·편집이 공유하는 감정 줄은 10종을 모두 제공하고, 폰에서도 5×2로 넘침 없이 선다.
// 여행 기간은 시간대 없는 달력 날짜이므로 시작·종료일 각각의 요일을 같은 문장으로 보여 준다.
// 현재 라이브 여행에 날짜를 직접 넣어 **조건을 스스로 만든다**(§2-J). 이 브라우저 컨텍스트는
// 검사 전용이고 뒤 흐름도 날짜가 있는 여행에서 그대로 성립하므로 별도 원복은 필요 없다.
await page.evaluate(async () => {
  await new Promise((resolve, reject) => {
    const req = indexedDB.open('journey-archive');
    req.onsuccess = () => {
      const tx = req.result.transaction('localTrips', 'readwrite');
      const st = tx.objectStore('localTrips');
      const cursorReq = st.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        if (cursor.value.title === '편집기 검증 여행') {
          cursor.update({ ...cursor.value, startDate: '2026-07-20', endDate: '2026-07-31' });
          return;
        }
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
});
await page.reload();
await page.waitForSelector('.moment-form .emo-row', { timeout: 15000 }).catch(() => {});
await page.setViewportSize({ width: 412, height: 915 });
await settle(page);
if (process.env.FORM_DENSITY_SCREENSHOT) {
  await page.screenshot({ path: resolve(process.env.FORM_DENSITY_SCREENSHOT), fullPage: true });
}
const memoryFields = await page.evaluate(() => {
  const row = document.querySelector('.moment-form .emo-row');
  const buttons = row ? [...row.querySelectorAll('.emo')] : [];
  const rowRect = row?.getBoundingClientRect();
  const placeInput = document.querySelector('.moment-form .place-input');
  const placeActions = [...document.querySelectorAll('.moment-form .place-actions .btn-ghost')];
  const photoActions = [...document.querySelectorAll('.moment-form .photo-pick-actions > :is(label, button)')];
  const rects = (nodes) => nodes.map((node) => node.getBoundingClientRect());
  const placeRects = rects(placeActions);
  const photoRects = rects(photoActions);
  const inputRect = placeInput?.getBoundingClientRect();
  const tops = [...new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top)))];
  const lefts = [...new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().left)))];
  return {
    count: buttons.length,
    rows: tops.length,
    cols: lefts.length,
    labeled: buttons.filter((b) => Boolean(b.getAttribute('aria-label'))).length,
    overflow: row && rowRect ? Math.max(0, row.scrollWidth - Math.round(rowRect.width)) : -1,
    emotionHeights: buttons.map((b) => b.getBoundingClientRect().height),
    placeCount: placeRects.length,
    placeOneRow: placeRects.length === 3 && new Set(placeRects.map((r) => Math.round(r.top))).size === 1,
    placeWidthSpread: placeRects.length ? Math.max(...placeRects.map((r) => r.width)) - Math.min(...placeRects.map((r) => r.width)) : -1,
    placeBelowInput: Boolean(inputRect && placeRects.every((r) => r.top >= inputRect.bottom)),
    placeHeights: placeRects.map((r) => r.height),
    photoCount: photoRects.length,
    photoOneRow: photoRects.length === 3 && new Set(photoRects.map((r) => Math.round(r.top))).size === 1,
    photoWidthSpread: photoRects.length ? Math.max(...photoRects.map((r) => r.width)) - Math.min(...photoRects.map((r) => r.width)) : -1,
    photoHeights: photoRects.map((r) => r.height),
    // 🔴 사용자가 지적한 것은 **글자가 두 줄로 갈라지는 것**이다(M-0163). 버튼 높이는 44px로
    //    고정이라 높이로는 안 잡힌다 — 글자 자체가 몇 줄에 걸쳐 그려지는지를 재야 한다.
    //    줄바꿈되면 인라인 상자가 둘로 갈라져 `getClientRects()`가 2를 준다.
    photoTextLines: Math.max(0, ...photoActions.map((n) => n.querySelector('.moment-picker-text')?.getClientRects().length ?? 0)),
    photoOverflow: photoActions.length
      ? Math.max(...photoActions.map((n) => n.scrollWidth - Math.round(n.getBoundingClientRect().width)))
      : -1,
    period: document.querySelector('.detail-period')?.textContent ?? '',
  };
});
check('감정 선택: 10종을 접근 가능한 이름과 함께 제공',
  memoryFields.count === 10 && memoryFields.labeled === 10,
  `count=${memoryFields.count} labeled=${memoryFields.labeled}`);
check('감정 선택: 폰에서 5×2 배치 + 가로 넘침 0',
  memoryFields.rows === 2 && memoryFields.cols === 5 && memoryFields.overflow <= 0,
  `rows=${memoryFields.rows} cols=${memoryFields.cols} overflow=${memoryFields.overflow}`);
check('순간 폼 장소: 입력 아래 **검색·지도·내 위치가 같은 폭 한 줄**',
  memoryFields.placeCount === 3 && memoryFields.placeOneRow && memoryFields.placeBelowInput
    && memoryFields.placeWidthSpread <= 1,
  JSON.stringify(memoryFields));
// 🔴 계약이 바뀌었다(2026-08-15 · M-0163). 예전 계약은 **「무조건 한 줄」**이었는데, 좁은 화면에서
//    그것을 지키려면 칸이 글자보다 작아져 **글자가 두 줄로 어그러진다**(사용자 실기기 지적).
//    이제 재는 것은 「몇 줄인가」가 아니라 **「글자가 쪼개지지 않는가 · 폭과 높이가 같은가 ·
//    가로로 넘치지 않는가」**다. 열 수는 폭이 정한다(넓은 화면 한 줄은 아래 desktop 검사가 잰다).
check('순간 폼 미디어: **사진 추가·갤러리에서·영상 추가의 글자가 쪼개지지 않고 폭이 같다**',
  memoryFields.photoCount === 3 && memoryFields.photoWidthSpread <= 1
    // 넘침은 **양수일 때만** 넘친 것이다(반올림 때문에 음수가 정상이다 — 0으로 못박으면 오탐).
    && memoryFields.photoTextLines === 1 && memoryFields.photoOverflow <= 0,
  JSON.stringify(memoryFields));
// ── 🔴 폴드 커버 폭(344px)의 **생성 폼** — 사용자가 실제로 본 그 행이다 (2026-08-15 · M-0163)
//    사용자 스크린샷은 새 순간을 적는 화면의 [📷 사진 추가 · 🖼️ 갤러리에서 · 🎬 영상 추가]
//    세 버튼이었고, 거기서 글자가 두 줄로 갈라져 있었다. 412px에서는 이 결함이 **나지 않으므로**
//    그 폭에서만 재는 초록은 「없다」가 아니라 **「안 봤다」**이다(§17).
const coverViewport = page.viewportSize();
await page.setViewportSize({ width: 344, height: 800 });
await settle(page);
const coverCreateActions = await page.evaluate(() => {
  const actions = [...document.querySelectorAll('.moment-form .photo-pick-actions > :is(label, button)')];
  const rects = actions.map((a) => a.getBoundingClientRect());
  return {
    count: actions.length,
    textLines: Math.max(0, ...actions.map((a) => a.querySelector('.moment-picker-text')?.getClientRects().length ?? 0)),
    // 글자가 버튼 밖으로 삐져나오는 것은 `scrollWidth`로 안 보인다 — 실제 좌표로 잰다.
    textOutside: Math.max(0, ...actions.map((a) => {
      const t = a.querySelector('.moment-picker-text')?.getBoundingClientRect();
      const b = a.getBoundingClientRect();
      return t ? Math.max(0, Math.round(b.left - t.left), Math.round(t.right - b.right)) : 0;
    })),
    pageOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    widthSpread: rects.length ? Math.max(...rects.map((r) => r.width)) - Math.min(...rects.map((r) => r.width)) : -1,
    minHeight: rects.length ? Math.min(...rects.map((r) => r.height)) : -1,
    fonts: [...new Set(actions.map((a) => `${getComputedStyle(a).fontSize}/${getComputedStyle(a).fontWeight}`))],
  };
});
check('폴드 커버 344px 생성 폼: 세 첨부 버튼의 글자가 한 줄이고 버튼 밖으로 넘치지 않는다',
  coverCreateActions.count === 3 && coverCreateActions.textLines === 1
    && coverCreateActions.textOutside === 0 && coverCreateActions.pageOverflow === 0
    && coverCreateActions.widthSpread <= 1 && coverCreateActions.minHeight >= 44,
  JSON.stringify(coverCreateActions));
check('폴드 커버 344px 생성 폼: 세 버튼이 **같은 글꼴 크기·굵기**를 쓴다(사용자 요구: 디자인 동일)',
  coverCreateActions.fonts.length === 1, JSON.stringify(coverCreateActions.fonts));
if (coverViewport) await page.setViewportSize(coverViewport); // §3-C — 내가 바꾼 뷰포트를 되돌린다
await settle(page);

check('순간 폼 보조 버튼: 터치 44px을 지키며 **46px 이하 공용 밀도**',
  [...memoryFields.emotionHeights, ...memoryFields.placeHeights, ...memoryFields.photoHeights]
    .every((height) => height >= 44 && height <= 46),
  JSON.stringify(memoryFields));
check('상세 기간: 시작·종료일 각각 요일 표시',
  memoryFields.period === '2026-07-20 (월) ~ 2026-07-31 (금)', memoryFields.period);
const emotionButton = page.locator('.moment-form .emo').nth(5);
await emotionButton.click();
const emotionOn = await emotionButton.getAttribute('aria-pressed');
await emotionButton.click();
const emotionOff = await emotionButton.getAttribute('aria-pressed');
check('감정 선택: 같은 버튼을 다시 누르면 해제됨', emotionOn === 'true' && emotionOff === 'false',
  `${emotionOn}→${emotionOff}`);

// ── v0.53: 넓은 화면(태블릿 가로·데스크톱) 레이아웃 ──
// 문제였던 것: 본문이 780px 고정이라 2000px대 태블릿에서 가운데만 쓰고 양옆이 비었다.
// 계약: ①어느 폭에서도 가로 넘침 0 ②1100px 이상에서 [기록 폼 | 타임라인] 2단 ③그 미만은 세로.
async function layoutAt(w, h) {
  await page.setViewportSize({ width: w, height: h });
  await settle(page);
  return page.evaluate(() => {
    // 🔴 **재기 전에 맨 위로 올린다.** `.detail-compose`는 넓은 화면에서 `position: sticky`라
    // 스크롤된 상태에서는 타임라인과 top이 어긋나고, 그러면 2단인데도 「2단 아님」이 된다.
    //
    // 왜 여기서 고치나(§7 2층): 앞선 블록들이 `scrollIntoView`를 부른다 — 실제로 2026-07-30에
    // 그것 때문에 이 검사가 두 번 RED로 떴다. *"스크롤한 블록이 되돌려라"*로 두면 **다음
    // 블록이 또 잊는다.** 재는 쪽이 자기 전제를 스스로 세우면 그 뒤로는 아무도 기억할 필요가 없다.
    window.scrollTo(0, 0);
    const de = document.documentElement;
    const c = document.querySelector('.detail-compose')?.getBoundingClientRect();
    const t = document.querySelector('.timeline-wrap')?.getBoundingClientRect();
    return {
      overflow: de.scrollWidth - de.clientWidth,
      sideBySide: !!(c && t) && c.right <= t.left + 1 && Math.abs(c.top - t.top) < 80,
      bodyW: Math.round(document.querySelector('.screen-detail').getBoundingClientRect().width),
    };
  });
}
const wide = await layoutAt(1480, 920); // 사용자 기기(태블릿 울트라 가로)
check('넓은 화면: 가로 넘침 0', wide.overflow <= 0, `overflow=${wide.overflow}`);
check('넓은 화면: 기록 폼 | 타임라인 2단', wide.sideBySide, `bodyW=${wide.bodyW}`);
check('넓은 화면: 본문이 780px 기둥에 갇히지 않음', wide.bodyW > 1000, `bodyW=${wide.bodyW}`);
const edge = await layoutAt(1099, 900); // 분기 직전 — 세로로 유지되어야
check('경계 1099: 세로 배치 유지', !edge.sideBySide && edge.overflow <= 0, `sbs=${edge.sideBySide}`);
const on = await layoutAt(1100, 900); // 분기 시작
check('경계 1100: 2단 전환', on.sideBySide && on.overflow <= 0, `sbs=${on.sideBySide}`);
const narrow = await layoutAt(412, 915); // 폰 — 세로 + 넘침 0
check('폰 세로: 세로 배치 + 가로 넘침 0', !narrow.sideBySide && narrow.overflow <= 0, `overflow=${narrow.overflow}`);
// 히어로 상태 배지가 뒤로가기 버튼과 겹치지 않는지(짧은 여행에서 드러나던 결함)
const noOverlap = await page.evaluate(() => {
  const b = document.querySelector('.hero-back')?.getBoundingClientRect();
  const g = document.querySelector('.detail-badge')?.getBoundingClientRect();
  if (!b || !g) return true;
  return b.bottom <= g.top + 1 || b.right <= g.left + 1;
});
check('히어로: 상태 배지가 뒤로가기 버튼과 안 겹침', noOverlap);

// ── v0.54 후속: 상태 줄 위계 + 홈 카드 밀도 ──
// 계약: 정상 상태(동기화됨)는 내용 폭만 차지하고 헤더 우측 도구 묶음에 선다.
// 여행 카드는 기억 제목·기간을 잃지 않는 범위에서 높이를 줄여 한 화면에 더 많이 보인다.
await page.setViewportSize({ width: 1480, height: 920 });
await settle(page);
// `.sync-note`는 홈과 여행 상세 **양쪽에** 있다 — 어디를 보고 있는지 명시하지 않으면
// 엉뚱한 줄을 검사한다(실제로 그렇게 짰다가 이 검사가 잡았다). 홈으로 돌아가서 본다.
await page.goto(`http://localhost:4173${BASE}`);
await page.waitForSelector('.sync-note', { timeout: 15000 }).catch(() => {});
await page.waitForSelector('.trip-card', { timeout: 15000 });
const noteBox = await page.evaluate(() => {
  const n = document.querySelector('.sync-note');
  if (!n) return null;
  const r = n.getBoundingClientRect();
  const header = document.querySelector('.app-head-top')?.getBoundingClientRect();
  const card = document.querySelector('.trip-card')?.getBoundingClientRect();
  return {
    w: Math.round(r.width), vw: window.innerWidth, cls: n.className,
    besideVersion: n.previousElementSibling?.classList.contains('app-version') === true,
    cardH: card ? Math.round(card.height) : null,
  };
});
check('홈 밀도: 상태·여행 카드 측정 대상 확보', Boolean(noteBox && noteBox.cardH !== null),
  noteBox ? `cardH=${noteBox.cardH}` : 'status 없음');
check('상태 줄: 전폭 배너가 아님(내용 폭만)', Boolean(noteBox && noteBox.w < noteBox.vw * 0.5),
  noteBox ? `${noteBox.w}px / ${noteBox.vw}px` : 'none');
check('상태 줄: 버전 배지 바로 옆에 배치', Boolean(noteBox?.besideVersion),
  noteBox ? `besideVersion=${noteBox.besideVersion}` : 'none');
// 완료 결과는 상태상태가 아니라 사용자가 다음 행동을 정할 증거다. 412px에서도 잘리거나
// 가로 스크롤로 사라지지 않는지 실제 DOM 폭으로 확인한다.
await page.setViewportSize({ width: 412, height: 915 });
const mobileSyncFeedback = await page.evaluate(() => {
  const note = document.querySelector('.app-title-row > .sync-note');
  if (!(note instanceof HTMLElement)) return null;
  note.className = 'sync-note is-info';
  note.textContent = '✓ 동기화 완료 · 보냄 123건 · 받음 456건';
  const rect = note.getBoundingClientRect();
  return {
    fullyVisible: rect.left >= 0 && rect.right <= window.innerWidth,
    uncut: note.scrollWidth <= note.clientWidth,
    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    text: note.textContent,
  };
});
check('모바일 동기화 완료 결과: 말줄임·가로 잘림·화면 가로 스크롤 없이 전부 보임',
  Boolean(mobileSyncFeedback?.fullyVisible && mobileSyncFeedback.uncut && mobileSyncFeedback.pageOverflow === 0 &&
    mobileSyncFeedback.text?.includes('보냄 123건') && mobileSyncFeedback.text?.includes('받음 456건')),
  mobileSyncFeedback ? JSON.stringify(mobileSyncFeedback) : 'sync note 없음');
await page.setViewportSize({ width: 1480, height: 920 });
check('홈 카드: 높이 136px 이하로 축약', Boolean(noteBox?.cardH && noteBox.cardH <= 136),
  noteBox ? `height=${noteBox.cardH}px` : 'none');

// ── v1.66: 홈 기간 트리(연도▸월) — 2단 레이아웃 + 필터가 실제로 도는가 ──────────
// 계약: ①≥1100px에서 [트리 | 목록] 2단, 트리는 펼침·summary 숨김 ②그 미만은 1단, 접힌
// 필터(summary 보임) ③어느 폭에서도 가로 넘침 0 ④트리 버튼을 누르면 목록이 걸러지고
// 현재선택 줄(✕ 포함)이 나타나며, ✕를 누르면 원복된다(§13 4항 — 버튼은 눌러 봐야 확인).
// 지금 홈 화면(1480×920) 상태에서 시작하고, 끝나면 뷰포트·픽스처를 스스로 되돌린다(§3-C).
//
// 🔴 **픽스처를 먼저 만든다**(§2-J ①): 이 시점의 앱에는 시작일 있는 여행이 없어서 트리에
// 연·월 줄이 아예 안 생긴다. 그 상태로 재면 「개수 정렬」 같은 검사가 **대상 0~2개로 조용히
// 통과**한다. 실제로 처음 판이 그랬다 — 월 줄이 없으니 어긋날 것도 없었다.
const TREE_FIXTURE_IDS = ['live-tree-2607', 'live-tree-2608'];
async function seedTreeFixtures(targetPage) {
  await targetPage.evaluate(async (ids) => {
    const now = new Date().toISOString();
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('journey-archive');
      req.onsuccess = () => {
        const tx = req.result.transaction('localTrips', 'readwrite');
        const st = tx.objectStore('localTrips');
        // 같은 해의 서로 다른 두 달 — 연도 줄 1 + 월 줄 2가 생겨 들여쓰기 정렬을 잴 수 있다.
        st.put({ id: ids[0], title: '라이브 검사 7월', startDate: '2026-07-10', endDate: '2026-07-11',
          status: 'completed', createdAt: now, updatedAt: now, deletedAt: null, version: 1 });
        st.put({ id: ids[1], title: '라이브 검사 8월', startDate: '2026-08-10', endDate: '2026-08-11',
          status: 'completed', createdAt: now, updatedAt: now, deletedAt: null, version: 1 });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  }, TREE_FIXTURE_IDS);
}
await seedTreeFixtures(page);
await page.reload();
await page.waitForSelector('.home-tree button', { timeout: 15000 }).catch(() => {});

async function homeTreeAt(w, h, targetPage = page) {
  await targetPage.setViewportSize({ width: w, height: h });
  await settle(targetPage);
  return targetPage.evaluate(() => {
    window.scrollTo(0, 0);
    const de = document.documentElement;
    const fold = document.querySelector('.tree-fold');
    const main = document.querySelector('.home-main');
    const sum = fold?.querySelector('summary');
    const f = fold?.getBoundingClientRect();
    const m = main?.getBoundingClientRect();
    return {
      overflow: de.scrollWidth - de.clientWidth,
      exists: Boolean(fold && main),
      sideBySide: !!(f && m) && f.right <= m.left + 1 && Math.abs(f.top - m.top) < 80,
      open: fold instanceof HTMLDetailsElement ? fold.open : false,
      summaryShown: Boolean(sum) && sum.offsetHeight > 0,
      buttons: document.querySelectorAll('.home-tree button').length,
    };
  });
}
const treeWide = await homeTreeAt(1480, 920);
// §2-J: 대상 확보를 먼저 판정한다 — 트리가 아예 없으면 나머지 판정은 공허하다.
if (!treeWide.exists) {
  check('홈 트리: 대상 확보 — 재지 못함(공허 통과 방지)', false, '.tree-fold/.home-main 없음');
} else {
  check('홈 트리: 넓은 화면(1480)에서 [트리 | 목록] 2단 + 넘침 0',
    treeWide.sideBySide && treeWide.overflow <= 0, `sbs=${treeWide.sideBySide} overflow=${treeWide.overflow}`);
  check('홈 트리: 넓은 화면에서 펼쳐져 있고 summary는 숨김',
    treeWide.open && !treeWide.summaryShown, `open=${treeWide.open} summary=${treeWide.summaryShown}`);
  // 픽스처가 연 1 + 월 2를 만들었으므로 최소 4(전체 포함). 이보다 적으면 픽스처가 안 먹은 것이다.
  check('홈 트리: 항목이 그려짐(전체 + 연 + 월 2)', treeWide.buttons >= 4, `buttons=${treeWide.buttons}`);
  // 🔴 터치 컨텍스트에서 CDP로 touch를 꺼도 Linux Chromium은 pointer:none에 머문다(M-0126).
  // 실제 데스크톱 입력은 별도 non-touch 컨텍스트에서 앱과 픽스처를 다시 렌더해 잰다.
  const desktopContext = await browser.newContext({
    viewport: { width: 1480, height: 920 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36',
  });
  const desktopPage = await desktopContext.newPage();
  try {
    await desktopPage.goto(`http://localhost:4173${BASE}`);
    await desktopPage.waitForSelector('.home-tree button', { timeout: 15000 });
    await seedTreeFixtures(desktopPage);
    await desktopPage.reload();
    await desktopPage.waitForSelector('.home-tree button', { timeout: 15000 });
    await homeTreeAt(1480, 920, desktopPage);
    const treeDensity = await desktopPage.evaluate(() => {
      const all = document.querySelector('.home-tree .tree-all')?.getBoundingClientRect();
      const dates = [...document.querySelectorAll('.home-tree button:not(.tree-all)')]
        .map((node) => node.getBoundingClientRect());
      const gaps = dates.slice(1).map((rect, index) => rect.top - dates[index].bottom);
      return {
        finePointer: matchMedia('(hover: hover) and (pointer: fine)').matches,
        allHeight: all?.height ?? 0,
        dateMin: dates.length ? Math.min(...dates.map((rect) => rect.height)) : 0,
        dateMax: dates.length ? Math.max(...dates.map((rect) => rect.height)) : 0,
        gapMax: gaps.length ? Math.max(...gaps) : 0,
      };
    });
    check('홈 트리 밀도: 넓은 정밀 포인터 화면은 전체 선택을 유지하고 날짜 행만 36px로 압축',
      treeDensity.finePointer && treeDensity.allHeight >= 44 && treeDensity.dateMin >= 35 && treeDensity.dateMax <= 37,
      JSON.stringify(treeDensity));
    check('홈 트리 밀도: 날짜 행 사이 추가 간격 0px', treeDensity.gapMax <= 0.5, JSON.stringify(treeDensity));
    if (process.env.HOME_CARD_SCREENSHOT) {
      await desktopPage.screenshot({ path: resolve(process.env.HOME_CARD_SCREENSHOT), fullPage: false });
    }
  } finally {
    await desktopContext.close();
  }
  const datedCardPeriods = await page.$$eval('.trip-meta', (nodes) => nodes.map((n) => n.textContent ?? ''));
  check('홈 카드 기간: 날짜가 있는 카드에 시작·종료 요일 표시',
    datedCardPeriods.some((t) => t.startsWith('2026-07-10 (금) ~ 2026-07-11 (토)')) &&
      datedCardPeriods.some((t) => t.startsWith('2026-08-10 (월) ~ 2026-08-11 (화)')),
    datedCardPeriods.filter((t) => t.includes('2026-')).join(' | '));
  const treeFixtureOrder = await page.$$eval('.trip-title', (nodes) => nodes.map((n) => n.textContent ?? ''));
  const julyIndex = treeFixtureOrder.indexOf('라이브 검사 7월');
  const augustIndex = treeFixtureOrder.indexOf('라이브 검사 8월');
  check('홈 전체기간: 입력 순서와 무관하게 여행 시작일 최신순',
    julyIndex >= 0 && augustIndex >= 0 && augustIndex < julyIndex,
    `8월=${augustIndex} 7월=${julyIndex}`);
  // 🔴 개수가 **한 열로** 선다(사용자 지적 2026-08-03). 들여쓴 월 항목을 margin으로 밀면
  // 버튼 오른쪽 끝이 함께 밀려 숫자 열이 어긋난다 — 오른쪽 경계를 실측해서 잡는다.
  const countCol = await page.evaluate(() => {
    const rights = [...document.querySelectorAll('.home-tree .tree-count')].map((n) =>
      Math.round(n.getBoundingClientRect().right),
    );
    return { n: rights.length, spread: rights.length ? Math.max(...rights) - Math.min(...rights) : -1 };
  });
  check('홈 트리: 개수가 한 열로 정렬됨(들여쓴 월도 오른쪽 끝이 같다)',
    countCol.n >= 2 && countCol.spread <= 1, `n=${countCol.n} spread=${countCol.spread}px`);
  const treeEdge = await homeTreeAt(1099, 900);
  check('홈 트리: 경계 1099에서 1단 + 넘침 0', !treeEdge.sideBySide && treeEdge.overflow <= 0,
    `sbs=${treeEdge.sideBySide} overflow=${treeEdge.overflow}`);
  const treePhone = await homeTreeAt(412, 915);
  check('홈 트리: 폰(412)에서 1단 + 접힌 필터(summary 보임) + 넘침 0',
    !treePhone.sideBySide && treePhone.summaryShown && treePhone.overflow <= 0,
    `sbs=${treePhone.sideBySide} summary=${treePhone.summaryShown} overflow=${treePhone.overflow}`);
  const phoneTreeTarget = await page.evaluate(() => {
    const heights = [...document.querySelectorAll('.home-tree button')].map((node) => node.getBoundingClientRect().height);
    return heights.length ? Math.min(...heights) : 0;
  });
  check('홈 트리 밀도: 좁은 화면은 44px 터치 표적 유지', phoneTreeTarget >= 44, `${phoneTreeTarget}px`);
  // 되돌리기 + 상호작용: 넓은 화면에서 트리 버튼을 실제로 누른다.
  await page.setViewportSize({ width: 1480, height: 920 });
  await settle(page);
  const before = await page.evaluate(() => document.querySelectorAll('.trip-list > *').length);
  // '전체'가 아닌 첫 항목(연도/월/기간 미정)을 누른다 — 없으면 대상 미확보로 실패.
  const clicked = await page.evaluate(() => {
    const b = document.querySelector('.home-tree button.tree-year, .home-tree button.tree-undated');
    if (!(b instanceof HTMLElement)) return false;
    b.click();
    return true;
  });
  await settle(page);
  const filtered = await page.evaluate(() => ({
    nowShown: !document.querySelector('.filter-now')?.hidden,
    nowText: document.querySelector('.filter-now')?.textContent ?? '',
    pressed: document.querySelectorAll('.home-tree button[aria-pressed="true"]').length,
    cards: document.querySelectorAll('.trip-list > *').length,
  }));
  check('홈 트리: 항목을 누르면 현재선택 줄이 나타나고(개수 포함) 눌림 상태가 표시됨',
    clicked && filtered.nowShown && /개/.test(filtered.nowText) && filtered.pressed >= 1,
    `clicked=${clicked} now="${filtered.nowText}" pressed=${filtered.pressed}`);
  await page.evaluate(() => { const x = document.querySelector('.filter-clear'); if (x instanceof HTMLElement) x.click(); });
  // 🔴 `settle`은 **프레임 두 장**을 기다릴 뿐 「끝났다」를 기다리지 않는다(T-042 · M-0119).
  //    목록 원복은 저장소 조회를 거치므로 두 프레임 뒤에 재면 이를 수 있다 — 실제로 이 검사가
  //    같은 코드에서 한 번 FAIL하고 다음 실행에서 PASS했다. **시간이 아니라 내용을 기다린다.**
  await waitUntil(async () => await page.evaluate(() => {
    const now = document.querySelector('.filter-now');
    return Boolean(now?.hidden);
  }), 5000);
  const cleared = await page.evaluate(() => ({
    nowHidden: Boolean(document.querySelector('.filter-now')?.hidden),
    cards: document.querySelectorAll('.trip-list > *').length,
  }));
  check('홈 트리: ✕로 해제하면 현재선택 줄이 사라지고 목록이 원복됨(§13 4항 — 재판정까지)',
    cleared.nowHidden && cleared.cards === before, `hidden=${cleared.nowHidden} cards=${cleared.cards}/${before}`);
}
// 픽스처 되돌리기(§3-C) — 내가 넣은 것만 지운다. 뒤따르는 검사가 보는 화면을 바꾸지 않는다.
await page.evaluate(async (ids) => {
  await new Promise((resolve, reject) => {
    const req = indexedDB.open('journey-archive');
    req.onsuccess = () => {
      const tx = req.result.transaction('localTrips', 'readwrite');
      for (const id of ids) tx.objectStore('localTrips').delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}, TREE_FIXTURE_IDS);
await page.reload();
await page.waitForSelector('.sync-note', { timeout: 15000 }).catch(() => {});

// ── v0.94: 상태 줄이 **갈 곳을 준다**(사용자 제안 2026-07-26) ──────────────
// 계약: 조치할 것이 있는 상태(info/error)는 눌러서 조치할 화면으로 데려간다. 정상(ok)은
// 갈 곳을 만들지 않는다 — 아무 할 일 없는 상태가 화면에서 제일 시끄러워지면 안 된다(§5.1).
// 이 층이 최종 판정층인 이유: 타입은 "인자를 넘겼는가"까지만 보고, **눌러서 열리는가**는
// 실제 DOM 이벤트만 답한다.
const noteAct = await page.evaluate(() => {
  const n = document.querySelector('.sync-note');
  if (!n) return null;
  const r = n.getBoundingClientRect();
  return {
    cls: n.className,
    role: n.getAttribute('role') ?? '',
    tabindex: n.getAttribute('tabindex') ?? '',
    aria: n.getAttribute('aria-label') ?? '',
    chev: Boolean(n.querySelector('.sync-note-chev')),
    h: Math.round(r.height),
    txt: n.textContent ?? '',
  };
});
// 계약: ok면 갈 곳이 없어야 한다. ok가 아니면 이 검사는 해당 없음(아래 주입 검사가 본론이다).
check('상태 줄: 정상(ok)에는 갈 곳을 만들지 않는다(침묵이 정상)',
  Boolean(noteAct) && (!noteAct.cls.includes('is-ok') || !noteAct.cls.includes('is-actionable')),
  noteAct ? noteAct.cls : 'none');

// 여기서 멈추면 **공허한 검사**가 된다(§4): 지금 화면은 대기 0건이라 정작 눌러야 할 상태가
// 렌더되지 않는다. 그래서 대기 작업을 **직접 주입**해 그 상태를 실제로 만든다.
// (환율 표 주입과 같은 수법 — 네트워크가 아니라 UI 경로를 검증하는 것이 목적이다.)
await page.evaluate(async () => {
  await new Promise((resolve, reject) => {
    const req = indexedDB.open('journey-archive');
    req.onsuccess = () => {
      const tx = req.result.transaction('syncQueue', 'readwrite');
      tx.objectStore('syncQueue').put({
        operationId: 'live-check-pending-0001',
        entityType: 'trip',
        entityId: 'live-check-0001',
        operationType: 'update',
        state: 'local_only',
        attempts: 0,
        createdAt: new Date().toISOString(),
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
});
await page.reload();
// 고정 대기가 아니라 **상태가 실제로 나타날 때까지** 기다린다(인증 확인이 늦게 올 수 있다).
await page.waitForSelector('.sync-note.is-actionable', { timeout: 15000 }).catch(() => {});
const noteAct2 = await page.evaluate(() => {
  const n = document.querySelector('.sync-note');
  if (!n) return null;
  const r = n.getBoundingClientRect();
  return {
    cls: n.className,
    role: n.getAttribute('role') ?? '',
    tabindex: n.getAttribute('tabindex') ?? '',
    aria: n.getAttribute('aria-label') ?? '',
    chev: Boolean(n.querySelector('.sync-note-go')),
    // 역할을 덮어쓰지 않았는가 — 이 줄은 라이브 영역이라 글이 바뀌면 읽어 줘야 한다.
    liveRegion: n.getAttribute('role') === 'status',
    goLabel: n.querySelector('.sync-note-go')?.getAttribute('aria-label') ?? '',
    h: Math.round(r.height),
    txt: n.textContent ?? '',
  };
});
check('상태 줄: 대기가 생기면 누를 수 있게 바뀐다(주입 픽스처)',
  Boolean(noteAct2) && noteAct2.cls.includes('is-actionable') && noteAct2.txt.includes('대기'),
  noteAct2 ? `${noteAct2.cls} · "${noteAct2.txt}"` : 'none');
check('상태 줄: 누를 수 있어도 라이브 영역(role=status)을 뺏지 않는다',
  noteAct2?.liveRegion === true, `role=${noteAct2?.role}`);
check('상태 줄: 진짜 버튼이 화면읽기 라벨을 갖는다',
  (noteAct2?.goLabel.length ?? 0) > 0, `aria-label="${noteAct2?.goLabel}"`);
check('상태 줄: 갈 곳이 있다는 신호가 글리프로 보인다(색만으로 인코딩하지 않는다)',
  Boolean(noteAct2?.chev), `chev=${noteAct2?.chev}`);
check('상태 줄: 손가락 표적 44px 이상', (noteAct2?.h ?? 0) >= 44, `${noteAct2?.h}px`);

await page.click('.sync-note');
await page.waitForFunction(() => {
  const ov = document.querySelector('.guide-overlay');
  return Boolean(ov?.querySelector('.guide-detail-title'))
    && Boolean(ov?.querySelector('.guide-back'))
    && ov.querySelectorAll('.guide-card').length === 0;
});
const jumped = await page.evaluate(() => {
  const ov = document.querySelector('.guide-overlay');
  return {
    open: Boolean(ov),
    // 허브 홈이 아니라 **지목된 도구**로 바로 들어갔는가(카드 격자가 없어야 한다).
    title: ov?.querySelector('.guide-detail-title')?.textContent ?? '',
    hasBack: Boolean(ov?.querySelector('.guide-back')),
    cards: ov?.querySelectorAll('.guide-card').length ?? 0,
  };
});
// 어떤 도구로 가야 하는지는 **칩이 말한 상태**가 정한다. 아무 데나 열면 갈 곳을 준 게 아니다.
const expectTool = (noteAct2?.txt ?? '').includes('로컬 저장 모드') ? '환경' : '동기화';
check('상태 줄: 누르면 **그 상태에 맞는** 조치 화면으로 바로 간다(허브 홈을 거치지 않는다)',
  jumped.open && jumped.title.includes(expectTool) && jumped.cards === 0,
  `${JSON.stringify(jumped)} · 기대="${expectTool}"`);
check('상태 줄: 거기서 허브 홈으로 되돌아올 길이 있다', jumped.hasBack, `back=${jumped.hasBack}`);

// 뒷정리 — 주입한 픽스처를 남기면 뒤따르는 검사가 오염된다.
await page.keyboard.press('Escape');
await settle(page);
await page.evaluate(async () => {
  await new Promise((resolve) => {
    const req = indexedDB.open('journey-archive');
    req.onsuccess = () => {
      const tx = req.result.transaction('syncQueue', 'readwrite');
      tx.objectStore('syncQueue').delete('live-check-pending-0001');
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    };
    req.onerror = () => resolve();
  });
});
await page.reload();
await page.waitForSelector('.sync-note');

// ── v0.69: 진단 도구가 **판정**을 하는가(정적 게이트가 못 보는 층) ──
// 계약(CLAUDE.md §8): ① 총괄 판정이 계산되어 '확인 중…'을 벗어난다 ② 정상 지표는 카드가 아니라
// 접힌 한 줄이다 ③ 이상 지표만 카드로 남는다 ④ 지표에 기대값('정상')이 화면에 실제로 보인다.
await page.setViewportSize({ width: 412, height: 915 });
await page.goto(`http://localhost:4173${BASE}`);
await page.getByRole('button', { name: /데이터 관리/ }).first().waitFor();
// [데이터 관리] → [진단 도구] 경로로 실제 사용자처럼 진입한다(번들을 직접 import하지 않는다 —
// 해시가 바뀌기도 하고, 무엇보다 사용자가 실제로 걷는 길을 걸어야 의미가 있다).
await page.getByRole('button', { name: /데이터 관리/ }).first().click().catch(() => {});
await page.locator('[data-card="진단 도구"], .guide-card:has-text("진단 도구")').first().waitFor();
await page.locator('[data-card="진단 도구"], .guide-card:has-text("진단 도구")').first().click().catch(() => {});
await page.waitForFunction(() => {
  const roll = document.querySelector('[data-rollup]');
  const line = roll?.querySelector('.vd-rollup-line')?.textContent ?? '';
  return line.length > 0 && !line.includes('확인 중') && !roll?.classList.contains('pending');
});

const hub = await page.evaluate(() => {
  const roll = document.querySelector('[data-rollup]');
  if (!roll) return null;
  const line = roll.querySelector('.vd-rollup-line')?.textContent ?? '';
  return { line, cls: roll.className, cards: document.querySelectorAll('.guide-card-diag').length };
});
// v0.75: 새 도구가 허브·롤업에 자동으로 따라왔는가(등록부 하나만 고치면 되는 구조인지 확인)
const toolIds = await page.evaluate(() => [...document.querySelectorAll('[data-tool]')].map((n) => n.getAttribute('data-tool')));
check('진단 허브: 저장 상태 도구가 등록부에서 자동으로 따라옴', toolIds.some((t) => t && t.includes('저장 상태')), toolIds.join(' | '));

check('진단 허브: 총괄 판정이 계산됨(확인 중… 벗어남)',
  Boolean(hub) && hub.line.length > 0 && !hub.line.includes('확인 중') && !hub.cls.includes('pending'),
  hub ? `"${hub.line}" · 카드 ${hub.cards}` : 'hub 열기 실패');

// 도구 하나를 열어 판정 레이아웃을 실제로 확인한다(동기화 상태 — 지표 3개 중 정상이 접히는가).
await page.locator('[data-tool="동기화 상태"]').first().click().catch(() => {});
await page.waitForFunction(() => {
  const head = document.querySelector('[data-verdict-tool] .vd-headline')?.textContent ?? '';
  return head.length > 0 && !head.includes('확인 중');
});
const tool = await page.evaluate(() => {
  const w = document.querySelector('[data-verdict-tool]');
  if (!w) return null;
  const head = w.querySelector('.vd-headline')?.textContent ?? '';
  const quiet = w.querySelector('.vd-quiet');
  const quietOpen = quiet ? quiet.open : null;
  const compares = [...w.querySelectorAll('.vd-compare-k')].map((n) => n.textContent);
  const body = document.body;
  return {
    head,
    cards: w.querySelectorAll('.vd-metric').length,
    quietTxt: quiet?.querySelector('.vd-quiet-txt')?.textContent ?? '',
    quietOpen,
    hasExpected: compares.includes('정상'),
    recheck: Boolean(w.querySelector('[data-verdict-recheck]')),
    overflow: body.scrollWidth - body.clientWidth,
  };
});
check('진단 도구: 판정 한 문장이 먼저 온다', Boolean(tool) && tool.head.length > 0 && !tool.head.includes('확인 중'), tool ? `"${tool.head}"` : 'none');
check('진단 도구: 정상 지표는 카드가 아니라 접힌 한 줄', Boolean(tool) && tool.quietOpen === false && tool.quietTxt.includes('정상'),
  tool ? `"${tool.quietTxt}" open=${tool.quietOpen} · 이상카드 ${tool.cards}` : 'none');
check('진단 도구: 지표에 기대값(정상)이 화면에 보인다', Boolean(tool) && (tool.hasExpected || tool.cards === 0),
  tool ? `이상카드 ${tool.cards} · 기대값표시 ${tool.hasExpected}` : 'none');
check('진단 도구: [다시 확인]이 항상 있다', Boolean(tool) && tool.recheck);
check('진단 도구: 폰 세로 가로 넘침 0', Boolean(tool) && tool.overflow <= 0, tool ? `overflow=${tool.overflow}` : 'none');

// v0.75: 저장 상태 도구 — 로그인 전에는 '확인 불가'로 정직하게 말하는가(실패로 겁주지 않는다)
// 앞 검사가 상세 화면을 열어 둔 상태다 — 허브로 돌아가야 카드가 존재한다.
await page.locator('.guide-back').first().click().catch(() => {});
await page.locator('[data-tool="진단 요약 복사"]').first().waitFor();
// ── v0.97: 진단 요약이 **지표까지** 담는가(스크린샷 대신 붙여넣을 수 있는가) ────────
// 왜 이 층인가(2026-07-26 사용자 "수백 장은 찍은 거 같아"): 요약에 판정 한 줄만 있으면
// 복사해 봐야 숫자가 없어 결국 다시 사진을 찍게 된다. 실제로 만들어진 문자열을 본다.
await page.locator('[data-tool="진단 요약 복사"]').first().click();
await page.waitForFunction(() => [...document.querySelectorAll('.vd-evidence-sum')]
  .some((node) => (node.textContent ?? '').includes('원문')));
// 요약은 클립보드로만 나가고 화면엔 안 보인다 → 접힌 「원문 보기」를 펼쳐 실제 문자열을 읽는다.
// (복사가 막힌 브라우저에서 사용자가 쓰는 경로도 이것이라, 이 경로가 곧 사용자의 경로다.)
await page.evaluate(() => {
  for (const d of document.querySelectorAll('.vd-evidence')) {
    if ((d.querySelector('.vd-evidence-sum')?.textContent || '').includes('원문')) d.open = true;
  }
});
await page.waitForFunction(() => {
  const text = document.querySelector('.vd-pre')?.textContent ?? '';
  return text.length > 0 && !text.includes('만드는 중');
});
const summaryTxt = await page.evaluate(() => document.querySelector('.vd-pre')?.textContent ?? '');
check('진단 요약: 지표의 「지금 / 정상」이 글로 들어간다(사진 대신 붙여넣기)',
  /지금 .{1,40} \/ 정상 /.test(summaryTxt), summaryTxt.slice(0, 140));
await page.locator('.guide-back').first().click().catch(() => {});
await page.locator('[data-tool="저장 상태 · 기기별 현황"]').first().waitFor();

await page.locator('[data-tool="저장 상태 · 기기별 현황"]').first().click();
await page.waitForFunction(() => {
  const w = document.querySelector('[data-verdict-tool]');
  const head = w?.querySelector('.vd-headline')?.textContent ?? '';
  const badge = w?.querySelector('.vd-badge-txt')?.textContent ?? '';
  return head.length > 0 && badge.length > 0 && !head.includes('확인 중');
});
const store = await page.evaluate(() => {
  const w = document.querySelector('[data-verdict-tool]');
  return w ? { head: w.querySelector('.vd-headline')?.textContent ?? '', badge: w.querySelector('.vd-badge-txt')?.textContent ?? '' } : null;
});
check('저장 상태: 로그인 전엔 확인 불가로 정직하게(오류 아님)',
  Boolean(store) && store.badge === '확인 불가' && store.head.includes('로그인'), store ? JSON.stringify(store) : 'none');

// ── v0.93: 「이 기기 이름 바꾸기」 ──────────────────────────────────────────
// 왜 이 층인가(§10 ③ 전달 결함): 유닛은 정규화·구분자·되돌리기를 다 검사하지만
// **입력칸이 실제로 화면에 그려지는지**는 못 본다. M-0022가 정확히 그 자리였다 —
// 숫자는 다 맞았고 화면에 안 나갔다. 그래서 렌더된 DOM에 직접 묻는다.
const rename = await page.evaluate(() => {
  const input = document.querySelector('[data-rename-device-input]');
  const btn = document.querySelector('[data-rename-device]');
  return {
    hasInput: input instanceof HTMLInputElement,
    hasBtn: Boolean(btn),
    placeholder: input?.getAttribute('placeholder') ?? '',
    aria: input?.getAttribute('aria-label') ?? '',
    // 값을 받는 행동이 primary를 뺏으면 안 된다(진단 §5.4 — 주행동은 하나).
    primary: btn?.className.includes('vd-btn-primary') ?? false,
  };
});
check('저장 상태: [이 기기 이름 바꾸기]에 입력칸이 실제로 그려진다',
  rename.hasInput && rename.hasBtn, JSON.stringify(rename));
check('저장 상태: 입력칸에 화면읽기 라벨이 있다(placeholder만으로는 안 된다)',
  rename.aria.length > 0, `aria-label="${rename.aria}"`);
check('저장 상태: 이름 바꾸기는 주행동이 아니다(§5.4)', rename.primary === false, `primary=${rename.primary}`);

// 실제로 쳐 넣고 눌러서 **화면이 바뀌는지** 본다 — 저장했다는 말이 아니라 결과를 읽는다.
await page.fill('[data-rename-device-input]', '갤럭시 탭');
await page.click('[data-rename-device]');
await page.waitForFunction(() => {
  const ctx = document.querySelector('.vd-context')?.textContent ?? '';
  const kept = document.querySelector('[data-rename-device-input]')?.value ?? '';
  return ctx.includes('갤럭시 탭') && kept === '갤럭시 탭';
});
const renamed = await page.evaluate(() => ({
  msg: document.querySelector('.vd-msg')?.textContent ?? '',
  ctx: document.querySelector('.vd-context')?.textContent ?? '',
  kept: document.querySelector('[data-rename-device-input]')?.value ?? '',
}));
check('저장 상태: 이름을 바꾸면 맥락 줄의 「이 기기」가 바로 그 이름이 된다',
  renamed.ctx.includes('갤럭시 탭'), JSON.stringify(renamed));
check('저장 상태: 재판정 후에도 입력칸이 방금 지은 이름을 물고 있다',
  renamed.kept === '갤럭시 탭', `값="${renamed.kept}"`);

// 되돌릴 길이 있는가 — 비우고 누르면 자동 감지로 돌아가야 한다.
await page.fill('[data-rename-device-input]', '');
await page.click('[data-rename-device]');
await page.waitForFunction(() => {
  const ctx = document.querySelector('.vd-context')?.textContent ?? '';
  const msg = document.querySelector('.vd-msg')?.textContent ?? '';
  return !ctx.includes('갤럭시 탭') && msg.includes('자동 감지');
});
const reverted = await page.evaluate(() => ({
  ctx: document.querySelector('.vd-context')?.textContent ?? '',
  msg: document.querySelector('.vd-msg')?.textContent ?? '',
}));
check('저장 상태: 이름을 비우면 자동 감지로 되돌아간다(되돌릴 길 없는 설정을 만들지 않는다)',
  !reverted.ctx.includes('갤럭시 탭') && reverted.msg.includes('자동 감지'), JSON.stringify(reverted));

// ── v0.70: 화면 어디에도 마크다운 별표가 보이지 않는가(M-0012) ──
// 이 검사가 결함의 **최종 판정층**이다. 정적 게이트는 "우회 경로가 없다"까지만 보고,
// 유닛은 파싱 규칙만 본다. "사용자 눈에 별표가 보이는가"는 실제 렌더만 답할 수 있다.
// 원래 결함은 [데이터 관리 › 휴지통]의 영구삭제 설명에서 사용자가 발견했다 — 그 화면을 연다.
await page.goto(`http://localhost:4173${BASE}`);
await page.getByRole('button', { name: /데이터 관리/ }).first().waitFor();
await page.getByRole('button', { name: /데이터 관리/ }).first().click().catch(() => {});
await page.locator('.guide-card:has-text("휴지통")').first().waitFor();
await page.locator('.guide-card:has-text("휴지통")').first().click().catch(() => {});
await page.getByRole('button', { name: '휴지통 모두 영구삭제' }).waitFor();
const bulkTrashPurge = page.getByRole('button', { name: '휴지통 모두 영구삭제' });
check('휴지통 일괄삭제: 현재 보이는 항목을 비우는 버튼이 실제로 있다', await bulkTrashPurge.count() === 1);
await bulkTrashPurge.click();
const bulkTrashConfirm = page.locator('.dm-trash-bulk button.btn-danger:not([hidden])').last();
// 🔴 `isVisible()`은 **즉시 판정**이라 자동 대기가 없다(T-042 · M-0119). 확인 버튼이 펼쳐지기
//    전에 재면 false가 되고, 더 나쁜 것은 **그 다음 클릭이 30초 timeout으로 죽어** 뒤따르는
//    검사가 통째로 사라진다는 점이다 — 실제로 한 번 그렇게 죽었다. 펼쳐짐을 먼저 기다린다.
await bulkTrashConfirm.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
check('휴지통 일괄삭제: 첫 클릭은 지우지 않고 정확한 수의 두 번째 확인을 펼친다',
  await bulkTrashConfirm.isVisible() && /정말 \d+개 모두 지움/.test(await bulkTrashConfirm.textContent() ?? ''),
  await bulkTrashConfirm.textContent() ?? '');
await page.locator('.dm-trash-bulk button.btn-ghost').click();
const trashText = await page.evaluate(() => {
  const modal = document.querySelector('.guide-modal');
  return { txt: modal?.textContent ?? '', strongs: modal?.querySelectorAll('strong').length ?? 0 };
});
// ── v0.94: 휴지통의 상태 줄이 **다른 화면의 레이아웃을 빌려오지 않는가** ──────────
// 원래 결함(2026-07-26 사용자 실기기 "디자인이 조잡해요"): 이 줄이 R2 설정 화면용 클래스
// (`r2-probe-note`, `flex: 1 1 240px`)를 쓰고 있었다. 이 패널은 **세로 flex**라 그 240px이
// **높이**가 되어 화면 절반을 먹는 분홍 덩어리가 됐다. 타입도 유닛도 못 보는 자리다 —
// 클래스가 어느 부모 안에 놓이는지는 **실제 레이아웃만** 안다.
await page.locator('.dm-trash-row button:has-text("영구삭제")').first().click().catch(() => {});
await settle(page);
await page.locator('.dm-trash-row button:has-text("정말 지움")').first().click().catch(() => {});
await page.waitForFunction(() => [...document.querySelectorAll('.guide-overlay .sync-note')]
  .some((node) => !node.hidden
    && (node.querySelector('.sync-note-go')?.getAttribute('aria-label') ?? '').length > 0));
const trashNote = await page.evaluate(() => {
  const n = [...document.querySelectorAll('.guide-overlay .sync-note')]
    .find((node) => node instanceof HTMLElement
      && !node.hidden
      && (node.querySelector('.sync-note-go')?.getAttribute('aria-label') ?? '').length > 0);
  if (!(n instanceof HTMLElement)) return null;
  const r = n.getBoundingClientRect();
  const panel = n.closest('.guide-detail-body')?.getBoundingClientRect();
  return {
    cls: n.className,
    h: Math.round(r.height),
    w: Math.round(r.width),
    panelW: Math.round(panel?.width ?? 0),
    go: n.querySelector('.sync-note-go')?.getAttribute('aria-label') ?? '',
    txt: (n.textContent ?? '').slice(0, 40),
  };
});
check('휴지통: 실패 안내가 덩어리가 아니라 한 줄 알약이다(빌려온 레이아웃 회귀)',
  Boolean(trashNote) && trashNote.h <= 80, trashNote ? `${trashNote.w}×${trashNote.h}px` : '상태 줄이 안 뜸');
// 폭은 '패널보다 작다'로 잠그지 않는다 — 좁은 화면에서 긴 한글 문장이 줄바꿈되어 패널 폭을
// 채우는 것은 **정상**이다. 잠글 것은 **넘침**이다(가로 스크롤을 만드는 것이 결함이다).
check('휴지통: 실패 안내가 패널 밖으로 넘치지 않는다',
  Boolean(trashNote) && trashNote.w <= trashNote.panelW + 1, trashNote ? `${trashNote.w}px / ${trashNote.panelW}px` : 'none');
check('휴지통: 실패 안내가 조치할 곳으로 가는 길을 준다(사용자 요청)',
  (trashNote?.go.length ?? 0) > 0, `aria-label="${trashNote?.go}"`);

check('휴지통: 화면에 마크다운 별표가 안 보인다(M-0012)', !trashText.txt.includes('**'),
  trashText.txt.includes('**') ? `노출: ${trashText.txt.slice(trashText.txt.indexOf('**') - 20, trashText.txt.indexOf('**') + 40)}` : `strong ${trashText.strongs}개로 렌더`);
check('휴지통: 강조가 <strong>으로 실제 렌더된다', trashText.strongs > 0, `strong ${trashText.strongs}개`);

// 앱 정보(변경 이력) — 내가 v0.69 노트에 새 `**`를 넣었던 자리.
await page.goto(`http://localhost:4173${BASE}`);
await page.getByRole('button', { name: /앱 정보|정보/ }).first().waitFor();
await page.getByRole('button', { name: /앱 정보|정보/ }).first().click().catch(() => {});
await page.locator('.guide-modal, .about-modal').first().waitFor();
const aboutTxt = await page.evaluate(() => document.querySelector('.guide-modal, .about-modal, body')?.textContent ?? '');
check('변경 이력: 화면에 마크다운 별표가 안 보인다', !aboutTxt.includes('**'),
  aboutTxt.includes('**') ? `노출: ${aboutTxt.slice(aboutTxt.indexOf('**') - 20, aboutTxt.indexOf('**') + 40)}` : 'clean');

// ── v0.73: 선택한 것은 해제할 수 있는가(§7 사용자 대면 대칭) ──
// 사용자 지적(2026-07-26): "선택한 사진을 해제하는 기능이 없네요." 저장된 사진에는 ✕가 있는데
// 저장 전 선택분에만 없어서, 같은 화면 안에서 어휘가 갈렸다. 형제 감사에서 장소(지도 지정)도
// 같은 결함이 드러났다 — 좌표를 찍고 나면 되돌릴 길이 없었다.
await page.setViewportSize({ width: 412, height: 915 });
await page.goto(`http://localhost:4173${BASE}`);
await page.locator('.trip-card').first().waitFor();
await page.locator('.trip-card').first().click();
await page.waitForSelector('.moment-form', { timeout: 8000 });

// ── v1.06: 발생 시각 칸이 **보이고**, 앱이 그 값의 근거를 말하는가 ──
// 사용자 지적(2026-07-27): "입력단계에서 날짜와 시간을 지정하는 필드가 없네요."
// 진짜 문제는 칸이 없는 게 아니라 값이 조용히 `now`로 찍히는 것이었다 — 소급 입력에서
// 거의 항상 틀린 값이다. 그래서 ①칸이 접히지 않고 보이는지 ②근거 줄이 값과 함께 뜨는지 잰다.
const when0 = await page.evaluate(() => {
  const i = document.querySelector('.when-input');
  const n = document.querySelector('.when-note');
  return {
    exists: !!i,
    visible: !!i && i.getBoundingClientRect().height > 0,
    value: i?.value ?? '',
    note: n && !n.hidden ? (n.textContent ?? '') : '',
  };
});
check('발생 시각: 생성 폼에 칸이 **펼쳐진 채로** 있다', when0.exists && when0.visible, JSON.stringify(when0));
check('발생 시각: 값이 비어 있지 않다(소급 입력에 바로 쓸 수 있게)', /^\d{4}-\d{2}-\d{2}T/.test(when0.value), when0.value || '(빈 값)');
check(
  '발생 시각: **근거**를 값과 함께 말한다(추측을 사실처럼 두지 않는다)',
  when0.note.length > 0 && when0.note.includes(when0.value.slice(0, 10)),
  when0.note || '(근거 줄 없음)',
);

await page.setInputFiles('.moment-photo-input', [
  { name: 'p1.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(imgBuf) },
  { name: 'p2.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(imgBuf) },
  { name: 'p3.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(imgBuf) },
]);
await page.waitForFunction(() => document.querySelectorAll('.pick-cell').length === 3
  && document.querySelector('.moment-photo-input')?.files?.length === 3);
const pick0 = await page.evaluate(() => ({
  cells: document.querySelectorAll('.pick-cell').length,
  count: document.querySelector('.moment-photo-count')?.textContent ?? '',
  files: document.querySelector('.moment-photo-input')?.files?.length ?? -1,
}));
check('사진 선택: 고른 만큼 미리보기 + 개수', pick0.cells === 3 && pick0.files === 3 && pick0.count.includes('3장'), JSON.stringify(pick0));

// 방금 고른 3장은 **캔버스 JPEG이라 EXIF가 없다.** 그러면 사진을 근거로 대면 안 된다 —
// 예전엔 파일 수정시각으로 채워 「📷 사진에서」라고 말했고, 그건 *앱에 넣은 시각*이었다.
const whenNoExif = await page.evaluate(() => {
  const n = document.querySelector('.when-note');
  return n && !n.hidden ? (n.textContent ?? '') : '';
});
check(
  '발생 시각: 촬영 시각 없는 사진은 **사진을 근거로 대지 않는다**(거짓 근거 금지)',
  !whenNoExif.includes('사진에서'),
  whenNoExif || '(근거 줄 없음)',
);

// EXIF가 **있는** 사진이면 그때는 사진이 근거다 — 진짜 EXIF를 심어 확인한다.
await page.setInputFiles('.moment-photo-input', [
  { name: 'exif.jpg', mimeType: 'image/jpeg', buffer: withExifDateTime(imgBuf, '2026:07:16 09:30:00') },
]);
await page.waitForFunction(() => {
  const note = document.querySelector('.when-note')?.textContent ?? '';
  const value = document.querySelector('.when-input')?.value ?? '';
  return note.includes('사진에서') && value.startsWith('2026-07-16T09:30');
});
const whenExif = await page.evaluate(() => ({
  note: document.querySelector('.when-note')?.textContent ?? '',
  value: document.querySelector('.when-input')?.value ?? '',
}));
check(
  '발생 시각: EXIF가 있으면 **그 시각**을 사진에서 읽는다',
  whenExif.note.includes('사진에서') && whenExif.value.startsWith('2026-07-16T09:30'),
  JSON.stringify(whenExif),
);

// 사용자가 직접 고친 값은 **사진을 더 골라도 덮이지 않는다**(앱이 사용자를 이기지 않는다).
await page.fill('.when-input', '2026-07-16T09:30');
await page.setInputFiles('.moment-photo-input', [{ name: 'p9.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(imgBuf) }]);
await page.waitForFunction(() => document.querySelectorAll('.pick-cell').length === 1
  && document.querySelector('.moment-photo-input')?.files?.length === 1);
const kept = await page.evaluate(() => document.querySelector('.when-input')?.value ?? '');
check('발생 시각: 사용자가 고친 값을 추측이 덮지 않는다', kept === '2026-07-16T09:30', kept);
await page.setInputFiles('.moment-photo-input', [
  { name: 'p1.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(imgBuf) },
  { name: 'p2.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(imgBuf) },
  { name: 'p3.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(imgBuf) },
]);
await page.waitForFunction(() => document.querySelectorAll('.pick-cell').length === 3
  && document.querySelector('.moment-photo-input')?.files?.length === 3);

await page.locator('.pick-x').first().click();
await settle(page);
const pick1 = await page.evaluate(() => ({
  cells: document.querySelectorAll('.pick-cell').length,
  files: document.querySelector('.moment-photo-input')?.files?.length ?? -1,
  count: document.querySelector('.moment-photo-count')?.textContent ?? '',
}));
check('사진 선택: ✕ 하나로 한 장만 해제(실제 FileList까지)', pick1.cells === 2 && pick1.files === 2 && pick1.count.includes('2장'), JSON.stringify(pick1));

await page.locator('.pick-clear-all').click();
await settle(page);
const pick2 = await page.evaluate(() => ({
  hidden: document.querySelector('.pick-preview')?.hidden ?? null,
  files: document.querySelector('.moment-photo-input')?.files?.length ?? -1,
  count: document.querySelector('.moment-photo-count')?.textContent ?? '',
}));
check('사진 선택: 전체 해제 → 선택 0장 + 미리보기 숨김', pick2.files === 0 && pick2.hidden === true && pick2.count === '', JSON.stringify(pick2));

// 장소(지도 지정) 해제 — 배지의 ✕가 좌표까지 지우는가.
const placeClear = await page.evaluate(() => {
  const btn = document.querySelector('.place-picked .chip-clear');
  return { exists: Boolean(btn), label: btn?.getAttribute('aria-label') ?? '' };
});
check('장소: 지정 해제 버튼이 존재한다', placeClear.exists, JSON.stringify(placeClear));


// ── 🔴 v1.24 (M-0050): 검색 결과가 **얼마나 정밀한지 말하는가** ─────────────────────
// 헌법 §13 4항: *"버튼은 눌러 봐야 확인한 것이다."* 유닛은 `precisionLabel()`이 옳은 문자열을
// 만드는지 잰다. 그런데 M-0022·M-0046이 정확히 그 틈이었다 — **자료구조는 옳고 화면 문장만
// 틀린** 결함은 유닛이 전부 초록인 채로 배포된다. 그래서 여기서 재는 것은 세 가지다:
//   ① 🔍 검색 버튼을 **실제로 눌렀을 때** 결과가 그려지는가
//   ② 길(대학로)과 건물(경복궁)이 **화면에서 구별되는가**  ← 신고의 본체
//   ③ 넓은 결과를 고르면 배지 아래에 **한정 문장**이 뜨는가
//
// 샌드박스는 nominatim 호스트를 막으므로 응답을 주입한다. 주입값은 **실제 Nominatim이 주는
// 모양**이다(우리가 만든 문자열을 되읽는 왕복 검사는 M-0034에서 이미 한 번 뚫렸다).
await page.evaluate(() => {
  const rows = [
    {
      osm_type: 'way', osm_id: 520463101, lat: '37.5870', lon: '127.0016',
      name: '대학로', display_name: '대학로, 종로구, 서울특별시, 대한민국',
      category: 'highway', type: 'secondary', place_rank: 26,
      boundingbox: ['37.5745', '37.5878', '126.9985', '127.0015'],
      address: { road: '대학로', borough: '종로구', state: '서울특별시', country_code: 'kr' },
    },
    {
      osm_type: 'node', osm_id: 1, lat: '37.5796', lon: '126.9770',
      name: '경복궁', display_name: '경복궁, 종로구, 서울특별시, 대한민국',
      category: 'tourism', type: 'attraction', place_rank: 30,
      boundingbox: ['37.5794', '37.5798', '126.9768', '126.9772'],
      address: { borough: '종로구', state: '서울특별시', country_code: 'kr' },
    },
  ];
  window.__placeRowsForLive = rows; // 아래 「검색 실패」 블록이 상태를 되돌릴 때 다시 쓴다(§1)
  const real = window.fetch;
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (new URL(url, window.location.href).hostname === 'nominatim.openstreetmap.org') {
      return Promise.resolve(new Response(JSON.stringify(rows), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    }
    return real(input, init);
  };
});
await page.fill('.place-input', '대학로');
await page.locator('.place-search').first().click();
await page.waitForSelector('.place-result', { timeout: 5000 });
const grades = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.place-result')];
  return rows.map((r) => ({
    name: r.querySelector('.place-result-name')?.textContent ?? '',
    grade: r.querySelector('.place-result-grade')?.textContent ?? '',
    coarse: r.querySelector('.place-result-grade')?.classList.contains('is-coarse') ?? false,
  }));
});
check('🔍 검색 버튼을 누르면 결과가 실제로 그려진다', grades.length === 2, JSON.stringify(grades));
// 어느 지오코더가 답했는지 밝히는가(§8 출처). 국내 제공자를 붙이면 이 줄이 바뀌어야 한다.
const source = await page.evaluate(() => document.querySelector('.place-source')?.textContent ?? null);
check(
  '장소 검색: 어디서 온 답인지 밝힌다(제공자가 늘어나도 사용자가 출처를 안다)',
  typeof source === 'string' && source.includes('OpenStreetMap'),
  String(source),
);
const road = grades.find((g) => g.name === '대학로');
const bldg = grades.find((g) => g.name === '경복궁');
check(
  '🔴 장소 검색: 길은 「길 전체를 가리켜요」로 한정된다(신고의 본체)',
  Boolean(road) && road.grade.includes('길 전체') && road.coarse === true,
  JSON.stringify(road),
);
check(
  '장소 검색: 길에는 거리 범위가 함께 나온다(얼마나 넓은지 숫자로)',
  Boolean(road) && /약 1\.\d?km/.test(road.grade),
  JSON.stringify(road),
);
check(
  '장소 검색: 건물은 점으로 표시되고 경고를 달지 않는다(정상은 조용하다 §8)',
  Boolean(bldg) && bldg.grade.includes('건물·지점') && bldg.coarse === false,
  JSON.stringify(bldg),
);
check(
  '🔴 장소 검색: 색만으로 구분하지 않는다 — 글리프가 함께 나간다(§7 사용자 대면 대칭)',
  Boolean(road) && road.grade.includes('⚠') && Boolean(bldg) && bldg.grade.includes('📍'),
  `${road?.grade} / ${bldg?.grade}`,
);
// ── 🔴 v1.26: 검색이 **실패했을 때** 막다른 길이 아닌가 (사용자 제안 2026-07-30) ────────
// *"카카오 네이버 구글 좌표를 얻기 위한 링크를 칩 형태로 제공해주는게 어때요?"*
// 예전엔 「네이버·카카오·구글에서 찾아 붙여넣으세요」라고 **말만** 했다 — 앱이 검색어를 이미
// 쥐고 있으면서 사용자에게 *다른 앱을 열고 같은 말을 다시 치게* 시킨 것이다(§12).
// 여기서 재는 것: ①빈 결과에 칩이 뜨는가 ②넷 다 있는가(§7 — 얀덱스만 빠지지 않는가)
// ③**눌렀을 때 그 검색어로 열리는가**(§13 4항 — 라벨만 읽지 않는다).
await page.evaluate(() => {
  const real = window.fetch;
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    // 이번엔 **빈 배열** — 「결과가 없어요」 경로를 만든다.
    if (new URL(url, window.location.href).hostname === 'nominatim.openstreetmap.org') {
      return Promise.resolve(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return real(input, init);
  };
  // 바깥으로 실제로 나가지 않게 가로챈다. **인자는 기록한다** — 샌드박스가 외부 접속을
  // 막으므로 「무엇을 열려 했는가」까지가 내가 잴 수 있는 층이다(정직한 경계).
  window.__extOpened = [];
  window.open = (u) => { window.__extOpened.push(String(u)); return null; };
  window.confirm = () => true; // 제공자별 동의는 유닛이 따로 잰다
});
await page.fill('.place-input', '없을만한가게이름ZZ');
await page.locator('.place-search').first().click();
await page.waitForSelector('.place-none', { timeout: 5000 });
const noneChips = await page.evaluate(() => ({
  text: document.querySelector('.place-none')?.innerText ?? '',
  ids: [...document.querySelectorAll('.place-none [data-ext-map]')].map((b) => b.getAttribute('data-ext-map')),
  labels: [...document.querySelectorAll('.place-none [data-ext-map]')].map((b) => b.textContent?.trim()),
  overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
}));
check(
  '🔴 검색 실패: 막다른 길이 아니다 — 바깥 지도 칩이 뜬다(사용자 제안)',
  noneChips.ids.length > 0,
  JSON.stringify(noneChips.labels),
);
check(
  '🔴 검색 실패: 제공자 **넷 다** 있다(§7 — 하나만 조용히 빠지지 않는다)',
  ['google', 'naver', 'kakao', 'yandex'].every((id) => noneChips.ids.includes(id)),
  JSON.stringify(noneChips.ids),
);
check(
  '검색 실패: 이름으로 찾는다는 사실을 말한다(좌표로 집은 것처럼 굴지 않는다 §8)',
  /이름/.test(noneChips.text),
  noneChips.text.replace(/\s+/g, ' ').slice(0, 120),
);
check('검색 실패: 칩 줄이 가로 넘침을 만들지 않는다(412px)', noneChips.overflow <= 0, `overflow=${noneChips.overflow}`);
// 🔴 **눌러 본다.** 파괴적 행동이 아니고(바깥 링크 열기), 실제로 나가지도 않는다(가로챘다).
await page.locator('.place-none [data-ext-map="kakao"]').click();
await settle(page);
const opened = await page.evaluate(() => window.__extOpened ?? []);
check(
  '🔴 칩을 누르면 **그 검색어로** 열린다(라벨만 읽지 않는다 — §13 4항)',
  opened.length === 1 && /kakao/.test(opened[0]) && opened[0].includes(encodeURIComponent('없을만한가게이름ZZ')),
  JSON.stringify(opened),
);

// 🔴 **자기가 바꾼 상태를 자기가 되돌린다**(`ui-responsive-dev` §3-C). 이 블록은 빈 결과를
// 만들려고 fetch를 갈아 끼웠는데, 아래 ③은 **앞선 검색 결과가 화면에 남아 있다고 가정**한다.
// 되돌리지 않으면 뒤따르는 검사가 화면을 잃는다 — 실제로 그렇게 한 번 깨뜨렸다.
await page.evaluate(() => {
  const rows = window.__placeRowsForLive;
  const real = window.fetch;
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (new URL(url, window.location.href).hostname === 'nominatim.openstreetmap.org') {
      return Promise.resolve(new Response(JSON.stringify(rows), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    }
    return real(input, init);
  };
});
await page.fill('.place-input', '대학로');
await page.locator('.place-search').first().click();
await page.waitForSelector('.place-result', { timeout: 5000 });

// ③ 넓은 결과를 **고르면** 그 사실이 배지 아래에 남는가(고르고 나서 조용해지면 M-0022 재발).
await page.locator('.place-result').first().click();
await settle(page);
const afterPick = await page.evaluate(() => {
  const hint = document.querySelector('.place-picked-hint');
  return {
    badge: document.querySelector('.place-picked-text')?.textContent ?? '',
    hintHidden: hint?.hidden ?? null,
    hint: hint?.textContent ?? '',
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
});
check('장소 선택: 상태 문구 대신 고른 장소를 직접 보여 준다', afterPick.badge.startsWith('📍 ') && !afterPick.badge.includes('위치 지정됨'), afterPick.badge);
check(
  '🔴 장소 선택: 넓은 대상을 고르면 **한정 문장이 화면에 남는다**(자료구조에만 있으면 M-0022)',
  afterPick.hintHidden === false && afterPick.hint.includes('길 전체') && afterPick.hint.includes('지도'),
  JSON.stringify(afterPick),
);
check('장소 선택: 정밀도 안내가 가로 넘침을 만들지 않는다', afterPick.overflow === 0, `overflow=${afterPick.overflow}`);
// 점을 고르면 **조용해야** 한다(정상은 침묵 — 늘 뜨면 경고가 벽지가 된다).
// 🔴 **이름으로 고른다(인덱스 금지).** 처음엔 nth(1)로 골랐는데, 장소 라이브러리가 생기면서
// 목록 맨 위에 「내 장소」가 끼어들어 nth(1)이 다른 줄을 가리켰다 — 검사가 조용히 엉뚱한
// 것을 재기 시작한 것이다(팝업을 배열 인덱스로 식별하지 말라는 map-place-dev §3과 같은 형태).
await page.locator('.place-search').first().click();
await page.waitForSelector('.place-result', { timeout: 5000 });
await page.locator('.place-result', { hasText: '경복궁' }).first().click();
await settle(page);
const afterPoint = await page.evaluate(() => ({
  hintHidden: document.querySelector('.place-picked-hint')?.hidden ?? null,
  hint: document.querySelector('.place-picked-hint')?.textContent ?? '',
}));
check(
  '장소 선택: 건물(점)을 고르면 한정 문장이 **사라진다**(정상은 침묵 §8)',
  afterPoint.hintHidden === true && afterPoint.hint === '',
  JSON.stringify(afterPoint),
);

// ── 🔴 v1.24: 「내 장소」에서 **다시** 고를 때도 같은 말을 하는가 ──────────────────
// 라이브 검사가 잡은 실제 결함(2026-07-30): 라이브러리에서 다시 고르면 등급을 **알고 있는데도**
// 화면이 조용해졌다. 처음엔 「길 전체를 가리켜요」라 해놓고 두 번째엔 아무 말도 안 한 것이다 —
// 같은 사실에 대해 앱이 두 번 다르게 말하면 사용자는 어느 쪽을 믿을지 판단해야 한다(§7·§8).
await page.fill('.place-input', '대학로');
await page.locator('.place-search').first().click();
await page.waitForSelector('.place-result', { timeout: 5000 });
const savedRow = await page.evaluate(() => {
  const head = document.querySelector('.place-source');
  const first = document.querySelector('.place-result.is-saved .place-result-name');
  return { head: head?.textContent ?? null, name: first?.textContent ?? null };
});
check(
  '내 장소: 한 번 고른 장소가 다음 검색에서 목록 맨 위에 뜬다(오프라인에서도 답이 나온다)',
  savedRow.head === '내 장소' && (savedRow.name ?? '').includes('대학로'),
  JSON.stringify(savedRow),
);
await page.locator('.place-result.is-saved').first().click();
await settle(page);
const afterSaved = await page.evaluate(() => ({
  hintHidden: document.querySelector('.place-picked-hint')?.hidden ?? null,
  hint: document.querySelector('.place-picked-hint')?.textContent ?? '',
}));
check(
  '🔴 내 장소: 다시 골라도 **같은 한정 문장**을 말한다(등급을 저장해 뒀으면 그대로 말한다)',
  afterSaved.hintHidden === false && afterSaved.hint.includes('길 전체'),
  JSON.stringify(afterSaved),
);


// ── 🔴 v1.25: 붙여넣은 좌표로 핀 찍기 + 역지오코딩 (사용자 제안 2026-07-30) ──────────
// *"정 찾기 어려우면 네이버·카카오·구글에서 위치를 클릭해 좌표를 확인하고, 그 좌표를 장소
//   입력 필드에 붙여넣어 핀을 찍게 하면 어때?"*
//
// 여기서 재는 것은 **배선**이다: 순수 파서는 tests/unit/coordInput.test.ts가 재고, 그 결과가
// 실제로 화면에 그려지고 좌표가 폼에 들어가는지는 이 층만 볼 수 있다(M-0022의 자리).
await page.fill('.place-input', '37.587, 127.0016');
await page.locator('.place-search').first().click();
await page.waitForSelector('.place-coord', { timeout: 5000 });
const coordSeen = await page.evaluate(() => ({
  text: document.querySelector('.place-coord-text')?.textContent ?? '',
  ambiguous: document.querySelector('.place-coord')?.classList.contains('is-ambiguous') ?? null,
  swapBtn: Boolean(document.querySelector('.place-coord-swap')),
  badge: document.querySelector('.place-picked-text')?.textContent ?? '',
  inputCleared: (document.querySelector('.place-input')?.value ?? 'x') === '',
  overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
}));
check(
  '🔴 좌표 붙여넣기: 검색을 누르면 좌표로 인식하고 읽은 값을 화면에 적는다',
  coordSeen.text.includes('위도 37.58700') && coordSeen.text.includes('경도 127.00160'),
  JSON.stringify(coordSeen),
);
check(
  '좌표 붙여넣기: 한국 좌표는 순서가 확실하므로 되묻지 않는다(정상은 침묵 §8)',
  coordSeen.ambiguous === false && coordSeen.swapBtn === false,
  `ambiguous=${coordSeen.ambiguous} swap=${coordSeen.swapBtn}`,
);
check(
  '좌표 붙여넣기: 배지가 읽은 좌표를 직접 보여 준다',
  coordSeen.badge.includes('37.58700') && coordSeen.badge.includes('127.00160'),
  coordSeen.badge,
);
check(
  '좌표 붙여넣기: 좌표 문자열이 장소 이름 칸에 남지 않는다(이름이 아니다)',
  coordSeen.inputCleared === true,
  String(coordSeen.inputCleared),
);
check('좌표 붙여넣기: 가로 넘침 0', coordSeen.overflow === 0, `overflow=${coordSeen.overflow}`);

// 🔴 모호한 좌표(둘 다 ±90 안)는 **되묻고, 바꿀 수 있어야 한다.**
await page.fill('.place-input', '41.9, 12.5'); // 로마 — 12.5도 위도일 수 있다
await page.locator('.place-search').first().click();
await page.waitForSelector('.place-coord.is-ambiguous', { timeout: 5000 });
const coordBefore = await page.evaluate(() => document.querySelector('.place-coord-text')?.textContent ?? '');
check(
  '🔴 좌표 붙여넣기: 순서가 모호하면 **되묻는다**(조용히 추측하지 않는다 §8)',
  coordBefore.includes('순서가 맞나요?') && coordBefore.includes('위도 41.90000'),
  coordBefore,
);
const swapExists = await page.locator('.place-coord-swap').count();
check('좌표 붙여넣기: 모호할 때 [바꾸기] 버튼이 있다', swapExists === 1, String(swapExists));
// 버튼은 **눌러 봐야 확인한 것이다**(§13 4항).
await page.locator('.place-coord-swap').first().click();
await settle(page);
const coordAfter = await page.evaluate(() => ({
  text: document.querySelector('.place-coord-text')?.textContent ?? '',
  stillAmbiguous: document.querySelector('.place-coord')?.classList.contains('is-ambiguous') ?? null,
}));
check(
  '🔴 [바꾸기]를 누르면 위·경도가 실제로 뒤바뀐다',
  coordAfter.text.includes('위도 12.50000') && coordAfter.text.includes('경도 41.90000'),
  JSON.stringify(coordAfter),
);
check(
  '[바꾸기] 뒤에는 더 이상 되묻지 않는다(사용자가 정했으므로)',
  coordAfter.stillAmbiguous === false && !coordAfter.text.includes('순서가 맞나요?'),
  JSON.stringify(coordAfter),
);

// 지도 링크를 통째로 붙여넣어도 읽는가(앱이 내보낸 카카오 링크 형식).
await page.fill('.place-input', 'https://map.kakao.com/link/map/%EB%8C%80%ED%95%99%EB%A1%9C,37.587,127.0016');
await page.locator('.place-search').first().click();
await page.waitForSelector('.place-coord', { timeout: 5000 });
const linkSeen = await page.evaluate(() => document.querySelector('.place-coord-text')?.textContent ?? '');
check(
  '🔴 좌표 붙여넣기: 지도 **링크**를 통째로 붙여넣어도 읽고, 어디서 왔는지 밝힌다',
  linkSeen.includes('카카오맵 링크') && linkSeen.includes('위도 37.58700'),
  linkSeen,
);

// 검색이 못 찾았을 때 **막다른 길이 아니어야** 한다 — 두 탈출구를 안내하는가.
await page.evaluate(() => {
  const real = window.fetch;
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (new URL(url, window.location.href).hostname === 'nominatim.openstreetmap.org') {
      return Promise.resolve(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return real(input, init);
  };
});
await page.fill('.place-input', '있을리없는장소이름1234');
await page.locator('.place-search').first().click();
await page.waitForSelector('.place-none', { timeout: 5000 });
const noneText = await page.evaluate(() => document.querySelector('.place-none')?.textContent ?? '');
check(
  '🔴 결과 없음: 막다른 길이 아니라 **두 탈출구**를 알려 준다(지도 찍기 · 좌표 붙여넣기)',
  noneText.includes('지도') && noneText.includes('좌표'),
  noneText,
);


// ── 🔴 v1.25: 역지오코딩 — 좌표를 넣으면 **그 자리의 이름을 대신 물어봐 준다** ──────────
// 예전엔 지도로 찍으면 좌표만 남고 이름은 사용자가 전부 타이핑해야 했다. 앱이 알 수 있는
// 것을 사람에게 시키던 자리다(§12). 응답 모양은 **객체 하나**다(검색은 배열) — 그 차이를
// 파서가 실제로 구분하는지까지 여기서 잰다.
await page.evaluate(() => {
  const one = {
    osm_type: 'way', osm_id: 999, lat: '37.5796', lon: '126.9770',
    name: '경복궁', display_name: '경복궁, 사직로, 종로구, 서울특별시, 대한민국',
    category: 'tourism', type: 'attraction', place_rank: 30,
    boundingbox: ['37.5794', '37.5798', '126.9768', '126.9772'],
    address: { borough: '종로구', state: '서울특별시', country_code: 'kr' },
  };
  const delayed = {
    ...one,
    name: '창덕궁',
    display_name: '창덕궁, 율곡로, 종로구, 서울특별시, 대한민국',
  };
  let reverseCount = 0;
  const real = window.fetch;
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (new URL(url, window.location.href).hostname === 'nominatim.openstreetmap.org' && new URL(url, window.location.href).pathname === '/reverse') {
      reverseCount += 1;
      if (reverseCount === 2) {
        return new Promise((resolve) => {
          window.__releaseReverse = () => {
            const response = new Response(JSON.stringify(delayed), {
              status: 200, headers: { 'Content-Type': 'application/json' },
            });
            const readJson = response.json.bind(response);
            response.json = async () => {
              const value = await readJson();
              window.__secondReverseConsumed = true;
              return value;
            };
            resolve(response);
          };
        });
      }
      return Promise.resolve(new Response(JSON.stringify(one), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    }
    if (new URL(url, window.location.href).hostname === 'nominatim.openstreetmap.org') {
      return Promise.resolve(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return real(input, init);
  };
});
await page.fill('.place-input', '37.5796, 126.9770');
await page.locator('.place-search').first().click();
await page.waitForFunction(() => (document.querySelector('.place-input')?.value ?? '') === '경복궁', { timeout: 5000 })
  .then(() => check('🔴 역지오코딩: 좌표만 넣어도 그 자리의 이름이 채워진다(사람이 타이핑하지 않는다 §12)', true, '경복궁'))
  .catch(async () => {
    const v = await page.evaluate(() => document.querySelector('.place-input')?.value ?? '');
    check('🔴 역지오코딩: 좌표만 넣어도 그 자리의 이름이 채워진다(사람이 타이핑하지 않는다 §12)', false, `입력칸="${v}"`);
  });
const revBadge = await page.evaluate(() => document.querySelector('.place-picked-text')?.textContent ?? '');
check(
  '역지오코딩: 배지가 좌표와 행정구역을 함께 보여 준다(어디인지 확인할 수 있게)',
  revBadge.includes('37.57960, 126.97700') && revBadge.includes('서울특별시'),
  revBadge,
);

// 🔴 사용자가 이미 이름을 적었으면 **덮어쓰지 않는다**(앱이 사용자를 이기지 않는다).
await page.evaluate(() => {
  const inp = document.querySelector('.place-input');
  if (inp) inp.value = '';
});
await page.fill('.place-input', '37.5796, 126.9770');
await page.locator('.place-search').first().click();
await settle(page);
await page.fill('.place-input', '내가 적은 이름'); // 역지오코딩이 돌아오기 전에 사용자가 적는다
await page.evaluate(() => window.__releaseReverse?.());
await page.waitForFunction(() => window.__secondReverseConsumed === true);
await settle(page);
const keptName = await page.evaluate(() => document.querySelector('.place-input')?.value ?? '');
check(
  '🔴 역지오코딩: 사용자가 그 사이에 적었으면 **덮지 않는다**',
  keptName === '내가 적은 이름',
  keptName,
);

// ── v0.89: 플랫폼 지도(무엇이 어디서 도나) — **생성물이 실제로 그려지는가** ──────────
// 정적 게이트는 platformMap.gen.ts가 코드와 맞는지만 본다. 그게 **화면에 실제로 나오는지**는
// 렌더해야만 안다 — 생성은 됐는데 카드가 안 열리면 사용자에겐 없는 기능이다.
// 🔴 Windows 타임라인 다중 사진 드롭. input을 직접 채우지 않고
// File Explorer와 같은 DataTransfer/DragEvent를 실제 드롭존에 보낸다.
const dropCard = page.locator('.moment-card', { hasText: 'GPS 없는 사진 검증' }).first();
const dropBefore = await dropCard.locator('.photo-thumb').count();
const dropUi = await page.evaluate(({ b64 }) => {
  const zone = document.querySelector('.timeline-wrap');
  const card = [...document.querySelectorAll('.moment-card')]
    .find((node) => node.textContent?.includes('GPS 없는 사진 검증'));
  if (!(zone instanceof HTMLElement) || !(card instanceof HTMLElement)) return { wired: false };
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  const transfer = new DataTransfer();
  transfer.items.add(new File([bytes], 'windows-drop-1.png', { type: 'image/png' }));
  transfer.items.add(new File([bytes], 'windows-drop-2.png', { type: 'image/png' }));
  window.__windowsDropTransfer = transfer;
  const rect = card.getBoundingClientRect();
  const clientY = rect.top + rect.height / 2;
  zone.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, clientY, dataTransfer: transfer }));
  zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientY, dataTransfer: transfer }));
  return {
    wired: zone.classList.contains('windows-photo-drop'),
    help: zone.querySelector('.timeline-drop-help')?.textContent ?? '',
    overlay: !(zone.querySelector('.timeline-drop-overlay')?.hidden ?? true),
    targeted: card.classList.contains('is-drop-target'),
  };
}, { b64: Buffer.from(imgBuf).toString('base64') });
if (process.env.WINDOWS_DROP_SCREENSHOT && dropUi.wired === true) {
  const previousViewport = page.viewportSize();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await dropCard.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(process.env.WINDOWS_DROP_SCREENSHOT), fullPage: false });
  if (previousViewport) await page.setViewportSize(previousViewport);
}
check(
  'Windows 드롭: 다중 사진 안내와 드롭존이 **Windows에서만 활성화**된다',
  dropUi.wired === true && dropUi.help.includes('여러 장'),
  JSON.stringify(dropUi),
);
check(
  'Windows 드롭: 놓기 전에 **가장 가까운 순간**을 보여 준다',
  dropUi.overlay === true && dropUi.targeted === true,
  JSON.stringify(dropUi),
);
if (dropUi.wired === true) {
  await page.evaluate(() => {
    const zone = document.querySelector('.timeline-wrap');
    const card = [...document.querySelectorAll('.moment-card')]
      .find((node) => node.textContent?.includes('GPS 없는 사진 검증'));
    const transfer = window.__windowsDropTransfer;
    if (!(zone instanceof HTMLElement) || !(card instanceof HTMLElement) || !(transfer instanceof DataTransfer)) return;
    const rect = card.getBoundingClientRect();
    zone.dispatchEvent(new DragEvent('drop', {
      bubbles: true, cancelable: true, clientY: rect.top + rect.height / 2, dataTransfer: transfer,
    }));
  });
  await page.waitForSelector('.pe-overlay', { timeout: 20000 });
  await page.getByRole('button', { name: /남은 2장 모두 원본/ }).click();
  await page.waitForFunction(({ title, count }) => {
    const card = [...document.querySelectorAll('.moment-card')].find((node) => node.textContent?.includes(title));
    return (card?.querySelectorAll('.photo-thumb').length ?? 0) === count + 2;
  }, { title: 'GPS 없는 사진 검증', count: dropBefore }, { timeout: 30000 });
}
const dropAfter = await page.locator('.moment-card', { hasText: 'GPS 없는 사진 검증' })
  .first().locator('.photo-thumb').count();
check(
  'Windows 드롭: 두 장이 공용 편집·저장 경로를 거쳐 **같은 순간에 모두 추가**된다',
  dropAfter === dropBefore + 2,
  `${dropBefore}→${dropAfter}`,
);

// 한 장을 카드가 아닌 빈 타임라인에 놓으면 기존 순간을 임의로 고르지 않고
// 사진의 EXIF를 먼저 읽은 새 순간 작성 창을 연다.
const singleDropMomentBefore = await page.locator('.moment-card').count();
await page.evaluate(({ b64 }) => {
  const zone = document.querySelector('.timeline-wrap');
  if (!(zone instanceof HTMLElement)) return;
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  const transfer = new DataTransfer();
  transfer.items.add(new File([bytes], 'single-new-moment.jpg', { type: 'image/jpeg' }));
  const rect = zone.getBoundingClientRect();
  const clientX = rect.right - 8;
  const clientY = rect.top + 8;
  zone.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, clientX, clientY, dataTransfer: transfer }));
  zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX, clientY, dataTransfer: transfer }));
  zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX, clientY, dataTransfer: transfer }));
}, { b64: withExifGps(imgBuf, '2026:07:16 09:30:00', 16.0544, 108.2022).toString('base64') });
await page.locator('.single-photo-moment-overlay').waitFor();
// T-041 — 단일 사진 순간 창의 닫기 버튼(보이는 38px). 셋째이자 마지막 닫기 버튼이다.
const singleCloseTarget = await closeButtonTarget('.single-photo-moment-close');
check('한 장 작성 창 닫기 버튼: 보이는 38px 그대로, **세로** 터치 표적 44px',
  singleCloseTarget?.visible === '38x38' && (singleCloseTarget?.hitH ?? 0) >= 44, JSON.stringify(singleCloseTarget));
check('한 장 작성 창 닫기 버튼: 넓힌 히트 영역이 이웃 버튼을 훔치지 않는다',
  (singleCloseTarget?.stolen.length ?? -1) === 0, JSON.stringify(singleCloseTarget?.stolen ?? null));
const singleComposerOpened = await page.locator('.single-photo-moment-overlay').count() === 1;
check(
  'Windows 한 장 드롭: 빈 타임라인이면 **사진으로 새 순간 작성 창**을 연다',
  singleComposerOpened,
);
if (singleComposerOpened) {
  await page.waitForSelector('.single-photo-moment-form', { timeout: 20000 });
  const singleHints = await page.locator('.single-photo-moment-form').evaluate((form) => ({
    when: form.querySelector('.when-note')?.textContent ?? '',
    place: form.querySelector('.place-picked-text')?.textContent ?? '',
    placeSource: form.querySelector('.place-photo-note')?.textContent ?? '',
    preview: form.querySelectorAll('.single-photo-preview').length,
  }));
  if (process.env.SINGLE_PHOTO_MOMENT_SCREENSHOT) {
    const previousViewport = page.viewportSize();
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.screenshot({ path: resolve(process.env.SINGLE_PHOTO_MOMENT_SCREENSHOT), fullPage: false });
    if (previousViewport) await page.setViewportSize(previousViewport);
  }
  check(
    'Windows 한 장 드롭: EXIF 시각·위치를 **저장 전에 자동 입력**한다',
    singleHints.when.includes('사진에서')
      && singleHints.place.startsWith('📍 ')
      && !singleHints.place.includes('위치 지정됨')
      && singleHints.placeSource.includes('16.0544')
      && singleHints.preview === 1,
    JSON.stringify(singleHints),
  );
  const previousViewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  const singleComposerGeometry = await page.locator('.single-photo-moment-overlay').evaluate((overlay) => {
    const modal = overlay.querySelector('.single-photo-moment-modal');
    const body = overlay.querySelector('.single-photo-moment-body');
    const save = overlay.querySelector('button[type="submit"]');
    if (!(modal instanceof HTMLElement) || !(body instanceof HTMLElement) || !(save instanceof HTMLElement)) return null;
    body.scrollTop = body.scrollHeight;
    const modalRect = modal.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    const saveRect = save.getBoundingClientRect();
    return {
      top: modalRect.top,
      bottom: modalRect.bottom,
      saveReachable: saveRect.bottom <= bodyRect.bottom + 1,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  check(
    'Windows 한 장 드롭: 좁은 화면에서도 **잘리지 않고 저장 버튼까지 도달**한다',
    singleComposerGeometry !== null
      && singleComposerGeometry.top >= 12
      && singleComposerGeometry.bottom <= 832
      && singleComposerGeometry.saveReachable
      && singleComposerGeometry.overflowX === 0,
    JSON.stringify(singleComposerGeometry),
  );
  if (previousViewport) await page.setViewportSize(previousViewport);
  await page.fill('.single-photo-moment-title', '한 장 드롭 새 순간');
  await page.getByRole('button', { name: '사진 편집' }).click();
  await page.waitForSelector('.pe-overlay', { timeout: 20000 });
  await page.getByRole('button', { name: '원본 사용', exact: true }).click();
  await page.getByRole('button', { name: '새 순간 저장' }).click();
  await page.waitForFunction(({ title, count }) => (
    [...document.querySelectorAll('.moment-card')].some((card) => card.textContent?.includes(title))
    && document.querySelectorAll('.moment-card').length === count + 1
  ), { title: '한 장 드롭 새 순간', count: singleDropMomentBefore }, { timeout: 30000 });
}
const singleDropSaved = await page.locator('.moment-card', { hasText: '한 장 드롭 새 순간' }).count();
check(
  'Windows 한 장 드롭: 검토·편집 뒤 **사진과 새 순간을 함께 저장**한다',
  singleDropSaved === 1,
  `saved=${singleDropSaved}`,
);

await page.evaluate(() => {
  document.querySelectorAll('.overlay-base').forEach((o) => o.remove());
});
/**
 * 🔴 가이드 카드 하나를 **실제로 열고, 열린 것을 확인한 뒤** 돌려준다 (T-014 · 2026-08-06).
 *
 * ── 왜 이 함수가 생겼나 ─────────────────────────────────────────────────────
 * 같은 커밋에서 348/348과 341/348이 번갈아 나왔다. 원인은 「측정이 이르다」가 **아니었다**:
 *
 *     document.querySelector('.data-open')?.click()      // ← 없으면 **조용히 아무 일도 없다**
 *     await page.waitForTimeout(200)                     // ← 그러고 200ms 자고
 *     ... 빈 화면을 재서 rows=0 · dom=0 으로 보고
 *
 * **누르지 않았는데 아무도 그 사실을 말하지 않았다.** 놓친 행동이 측정값으로 반올림된 것이라,
 * 화면은 「그려지지 않았다」가 아니라 **「열지도 못했다」**였다(§8 — 모르는 것을 반올림 금지 ·
 * M-0106 「검사가 초록」과 「검사가 살아 있다」는 다른 말).
 *
 * 실증(2026-08-06): 첫 클릭 하나만 무산시키자 harness가 냈던 **그 7건이 같은 값으로** 재현됐다.
 *
 * ── 그래서 두 가지를 바꾼다 ─────────────────────────────────────────────────
 *  ① **조용한 무산을 없앤다.** `?.click()`을 쓰지 않는다 — 대상이 없으면 기다리고, 끝내
 *     없으면 **이름을 대며 크게 실패한다.**
 *  ② **시간이 아니라 내용을 기다린다.** 「300ms 잤다」는 느린 순간에 거짓이 되지만
 *     「본문에 자식이 생겼다」는 언제나 참이다.
 *
 * 🔴 그리고 **두 곳이 이 절차를 손으로 따로 적고 있었다**(플랫폼 지도 · 가이드 3종).
 * 갈라질 수 있는 것은 갈라진다(§7 2층) — 그래서 여는 길은 여기 하나뿐이다.
 */
const clickGuideCard = async (needle) => {
  const found = await page
    .waitForFunction(
      (t) => [...document.querySelectorAll('.guide-card')].some((c) => c.textContent?.includes(t)),
      needle,
      { timeout: 10000 },
    )
    .then(() => true)
    .catch(() => false);
  if (!found) throw new Error(`가이드 카드를 찾지 못했습니다: 「${needle}」 — 조용히 넘어가지 않는다(T-014)`);
  await page.evaluate((t) => {
    const el = [...document.querySelectorAll('.guide-card')].find((c) => c.textContent?.includes(t));
    if (!el) throw new Error(`가이드 카드가 사라졌습니다: ${t}`); // `?.`를 쓰지 않는 이유가 이것이다
    el.click();
  }, needle);
};

const openGuideCard = async (label) => {
  await page.goto(`http://localhost:4173${BASE}`);
  await page.click('.data-open', { timeout: 10000 }); // Playwright의 click은 없으면 **스스로 실패한다**
  await clickGuideCard('가이드');
  await clickGuideCard(label);
  // 🔴 자는 게 아니라 **본문에 내용이 생기는 것**을 기다린다. 이 조건이 이 검사의 전제다.
  const drawn = await page
    .waitForFunction(
      () => (document.querySelector('.guide-detail-body')?.childElementCount ?? 0) > 0,
      null,
      { timeout: 10000 },
    )
    .then(() => true)
    .catch(() => false);
  check(`가이드 「${label}」 화면이 실제로 열렸다(전제 — 못 열면 아래 판정은 공허하다 · §4)`, drawn, drawn ? '' : '본문이 비어 있음');
};

await openGuideCard('설치파일 다운로드');
const installerGuide = await page.evaluate(() => ({
  text: document.querySelector('.guide-detail-body')?.textContent ?? '',
  platforms: [...document.querySelectorAll('.guide-installer-title')].map((node) => node.textContent ?? ''),
  links: [...document.querySelectorAll('.guide-installer a')].map((a) => ({ text: a.textContent ?? '', href: a.href })),
  firstRecommended: document.querySelector('.guide-installer:first-of-type .guide-installer-badge')?.textContent ?? '',
}));
check(
  '통합 설치 가이드: Android·Windows 두 형제를 같은 화면에 그린다',
  installerGuide.platforms.length === 2
    && installerGuide.text.includes('안드로이드')
    && installerGuide.text.includes('Windows'),
  JSON.stringify(installerGuide),
);
check(
  '통합 설치 가이드: 두 버튼이 각 고정 릴리스 주소를 쓴다',
  installerGuide.links.length === 2
    && installerGuide.links.some((link) => link.href.includes('/releases/download/apk-latest/app-debug.apk'))
    && installerGuide.links.some((link) => link.href.includes('/releases/download/windows-latest/Bugeon-Journey-Windows-x64-setup.exe')),
  JSON.stringify(installerGuide.links),
);
check(
  '통합 설치 가이드: 현재 기기 추천 표시와 쉬운 Windows 경고 설명이 보인다',
  installerGuide.firstRecommended === '이 기기에 추천'
    && installerGuide.text.includes('추가 정보')
    && installerGuide.text.includes('실행'),
  installerGuide.text,
);

await openGuideCard('한국·중앙아시아 지도 설정');
const mapGuide = await page.evaluate(() => ({
  text: document.querySelector('.guide-detail-body')?.textContent ?? '',
  links: [...document.querySelectorAll('.guide-detail-body a')].map((a) => ({
    text: a.textContent ?? '', href: a.href, rel: a.rel, target: a.target,
  })),
}));
check(
  '지도 설정 가이드: Kakao·정부지도·TomTom·기존 지도와 정확한 GitHub 변수 이름을 쉬운 순서로 말한다',
  [
    '한국', '우즈베키스탄', 'TomTom', 'OpenStreetMap', 'My First API key',
    'Domain whitelist', 'Off', 'On', 'ID를 복사하면 안 됩니다', 'VITE_TOMTOM_API_KEY',
    '주소 입력칸', '휴지통 모양', 'Edit key',
    '지도제공 검색 API', '도로명주소 검색 키는 지도 키가 아닙니다', 'VITE_JUSO_MAP_KEY',
    '도로명주소 검색 API', 'JUSO_ROAD_KEY', 'Supabase 비밀키 넣는 곳',
    'Supabase에는 TomTom 키를 넣지 않습니다', 'TomTom 변수 등록 완료',
  ].every((word) => mapGuide.text.includes(word)),
  mapGuide.text,
);
check(
  '지도 설정 가이드: 공식 정부지도·Kakao·TomTom 링크를 새 창·noreferrer로 연다',
  mapGuide.links.length === 7
    && mapGuide.links.every((link) => link.target === '_blank' && /noreferrer/.test(link.rel))
    && mapGuide.links.some((link) => link.href === 'https://business.juso.go.kr/jsm/jsmApiList')
    && mapGuide.links.some((link) => link.href.includes('/project/ihxiywffzmvrwmqvatzt/functions/secrets'))
    && mapGuide.links.some((link) => link.href === 'https://business.juso.go.kr/jst/jstMapApiSearch')
    && mapGuide.links.filter((link) => link.href.startsWith('https://developer.tomtom.com/')).length === 3,
  JSON.stringify(mapGuide.links),
);

await openGuideCard('Windows 앱 로그인 설정');
const windowsAuthGuide = await page.evaluate(() => ({
  text: document.querySelector('.guide-detail-body')?.textContent ?? '',
  links: [...document.querySelectorAll('.guide-detail-body a')].map((a) => ({
    text: a.textContent ?? '', href: a.href, rel: a.rel, target: a.target,
  })),
}));
check(
  'Windows 로그인 가이드: 초보자 순서·정확한 콜백·두 지도 오리진을 말한다',
  [
    'Redirect URLs', 'Add URL', 'app.bugeon.journey://auth-callback', 'Save',
    'Google 로그인', 'https://tauri.localhost', 'tauri.localhost',
  ].every((word) => windowsAuthGuide.text.includes(word)),
  windowsAuthGuide.text,
);
check(
  'Windows 로그인 가이드: Supabase 대시보드·공식 문서를 새 창·noreferrer로 연다',
  windowsAuthGuide.links.length === 2
    && windowsAuthGuide.links.every((link) => link.target === '_blank' && /noreferrer/.test(link.rel))
    && windowsAuthGuide.links.some((link) => link.href.includes('/auth/url-configuration'))
    && windowsAuthGuide.links.some((link) => link.href === 'https://supabase.com/docs/guides/auth/redirect-urls'),
  JSON.stringify(windowsAuthGuide.links),
);

await openGuideCard('무엇이 어디서 도나');

const plat = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.guide-plat-row')];
  const groups = [...document.querySelectorAll('.guide-plat-group')];
  const body = document.querySelector('.guide-detail-body');
  return {
    rows: rows.length,
    groups: groups.map((g) => g.querySelector('.guide-plat-where')?.textContent ?? ''),
    parts: rows.map((r) => r.querySelector('.guide-plat-part')?.textContent ?? ''),
    text: body?.textContent ?? '',
    overflow: body ? body.scrollWidth - body.clientWidth : 0,
  };
});
check('플랫폼 지도: 행이 그려진다', plat.rows >= 5, `rows=${plat.rows}`);
check('플랫폼 지도: 서비스별로 묶인다', plat.groups.includes('Supabase') && plat.groups.includes('Cloudflare'), plat.groups.join('|'));
// 오늘 옮긴 것이 화면에 반영됐는가 — 손으로 적었다면 여기서 옛말이 나왔을 자리다.
check('플랫폼 지도: 사진 파일이 R2로 표시된다', plat.parts.includes('R2'), plat.parts.join('|'));
check('플랫폼 지도: 옛 저장소(Storage)가 안 보인다', !plat.parts.includes('Storage'), plat.parts.join('|'));
check('플랫폼 지도: 가로 넘침 0', plat.overflow <= 1, `overflow=${plat.overflow}`);
check('플랫폼 지도: 화면에 마크다운 별표가 안 보인다', !plat.text.includes('**'), '');

// ── v1.68: 가이드의 「손으로 적던 것」이 실제로 SSOT에서 그려지는가 ─────────────────
// 정적 게이트(check-registry-gen·check-constitution-gen)는 **파일이 SSOT와 같은지**만 본다.
// 그 파일이 실제로 화면에 닿는지는 렌더해야만 안다 — 생성은 맞는데 목록이 안 그려지면
// 사용자에겐 없는 내용이고, 자료구조는 옳으니 유닛은 전부 초록이다(§10 ③이 정확히 그 부류).
{
  const reg = collectRegistry();
  const con = collectConstitution();
  // 🔴 여는 길은 위 `openGuideCard` 하나뿐이다 — 여기서 다시 적지 않는다(§7 2층).
  //    예전엔 이 절차가 **두 벌 손으로** 적혀 있었고, 둘 다 조용히 무산되는 클릭을 갖고 있었다.
  const readGuideCard = async (label) => {
    await openGuideCard(label);
    return page.evaluate(() => {
      const body = document.querySelector('.guide-detail-body');
      return {
        keys: [...document.querySelectorAll('.guide-def-k')].map((n) => n.textContent ?? ''),
        vals: [...document.querySelectorAll('.guide-def-v')].map((n) => n.textContent ?? ''),
        lis: [...document.querySelectorAll('.guide-ul li')].map((n) => n.textContent ?? ''),
        heads: [...document.querySelectorAll('.guide-h')].map((n) => n.textContent ?? ''),
        text: body?.textContent ?? '',
        overflow: body ? body.scrollWidth - body.clientWidth : 0,
      };
    });
  };

  const ag = await readGuideCard('개발 에이전트 목록');
  check('가이드 에이전트: 정의 파일 수만큼 행이 그려진다', ag.keys.length === reg.agentCount, `dom=${ag.keys.length} ssot=${reg.agentCount}`);
  // 예전에 손으로 나열해 **빠져 있던** 형제가 화면에 실제로 나오는지(이게 이 기계화의 이유다).
  check('가이드 에이전트: 독립 감사 에이전트가 목록에 있다', ag.keys.includes('disaster-recovery-guardian'), '');
  check('가이드 에이전트: 설명이 빠진 항목 없음', !ag.vals.includes('(설명 미등록)'), '');
  check('가이드 에이전트: 분류 묶음 머리글이 그려진다', ag.heads.filter((h) => h.includes('—')).length >= 3, ag.heads.join('|'));
  check('가이드 에이전트: 논리 역할 수를 손으로 적지 않는다', ag.text.includes(`${reg.logicalRoleCount}개 논리 역할`), '');

  const di = await readGuideCard('개발 규율 모음');
  check('가이드 규율: 헌법의 실행 규율 수만큼 그려진다', di.keys.length === con.discipline.length, `dom=${di.keys.length} ssot=${con.discipline.length}`);
  check('가이드 규율: 헌법 문장이 그대로 나온다', di.vals.some((v) => v.includes('손편집 중복 자체가 결함이다')), '');
  check('가이드 규율: 마크다운 별표가 안 보인다', !di.text.includes('**'), '');

  const gv = await readGuideCard('AI 개발 거버넌스');
  check('가이드 거버넌스: 비타협 원칙이 전부 그려진다', gv.keys.length === con.principles.length, `dom=${gv.keys.length} ssot=${con.principles.length}`);
  // 예전엔 §0 아홉 중 **넷만** 옮겨 적혀 있었다 — 발췌를 전부인 것처럼 보여주던 자리다.
  check('가이드 거버넌스: §0 금지가 전부 그려진다(발췌 아님)', gv.lis.length === con.neverDo.length, `dom=${gv.lis.length} ssot=${con.neverDo.length}`);
  check('가이드 거버넌스: 마크다운 별표가 안 보인다', !gv.text.includes('**'), '');
  check('가이드 거버넌스: 가로 넘침 0', gv.overflow <= 1, `overflow=${gv.overflow}`);
}

// ── 제목 웹폰트 조각화(unicode-range) 계약 ────────────────────────────────────
// 정적 게이트로는 원리적으로 못 잡는다: "브라우저가 어느 조각을 실제로 받는가"는
// CSS 캐스케이드와 화면에 뜬 글자에 달렸다(§10 ②에 가까운 부류 — 런타임이 답을 쥔다).
// 계약은 둘이고 **양쪽 다** 확인해야 한다.
//   ① 흔한 한글만 있는 화면은 희귀/기호 조각을 받지 않는다(안 그러면 쪼갠 의미가 없다)
//   ② 희귀 받침이 나오면 그때 받아서 **제대로 그린다**(커버리지 100% 유지 — 사용자가 쓴
//      여행 제목이 폴백으로 갈라지지 않아야 한다. 폰트를 번들한 이유가 그것이었다)
{
  const seen = new Set();
  page.on('response', (r) => {
    const u = r.url();
    if (u.includes('.woff2')) seen.add(u.split('/').pop().replace(/-[A-Za-z0-9_-]{8}\.woff2$/, '.woff2'));
  });
  await page.goto(`http://localhost:4173${BASE}`);
  await page.evaluate(() => document.fonts.ready);
  await waitUntil(() => seen.has('pretendard-core.woff2') && seen.has('pretendard-ko.woff2'), 15000);

  const width = (text, fam) =>
    page.evaluate(
      ([t, f]) => {
        const s = document.createElement('span');
        s.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font-size:64px;font-weight:800;font-family:${f}`;
        s.textContent = t;
        document.body.appendChild(s);
        const w = s.getBoundingClientRect().width;
        s.remove();
        return w;
      },
      [text, fam],
    );

  const common = [...seen].sort();
  check(
    '폰트 조각: 흔한 한글 화면은 core+ko만 받는다',
    common.includes('pretendard-core.woff2') &&
      common.includes('pretendard-ko.woff2') &&
      !common.includes('pretendard-ko-ext.woff2') &&
      !common.includes('pretendard-sym.woff2'),
    common.join(', '),
  );

  const koPre = await width('여행의 기억을 되찾다', "'Pretendard', monospace");
  const koFall = await width('여행의 기억을 되찾다', 'monospace');
  check('폰트 조각: 흔한 한글이 폴백이 아니라 Pretendard로 그려진다', koPre !== koFall, `${koPre.toFixed(0)} vs 폴백 ${koFall.toFixed(0)}`);

  // 사용자가 희귀 받침이 든 제목을 쓴 상황(넋·값·곬·훑·뷁·앉 = ㄳㅄㄽㄾㄺㄵ)
  const RARE = '넋 값 곬 훑 뷁 앉';
  await page.evaluate((t) => {
    const h = document.createElement('h1');
    h.className = 'app-title';
    h.id = 'rare-probe';
    h.textContent = t;
    document.body.appendChild(h);
  }, RARE);
  await page.evaluate(() => document.fonts.ready);
  await waitUntil(() => seen.has('pretendard-ko-ext.woff2'), 15000);
  check('폰트 조각: 희귀 받침이 나오면 그때 ko-ext를 받는다', seen.has('pretendard-ko-ext.woff2'), [...seen].sort().join(', '));
  const rarePre = await width(RARE, "'Pretendard', monospace");
  const rareFall = await width(RARE, 'monospace');
  check('폰트 조각: 희귀 받침도 Pretendard로 그려진다(커버리지 유지)', rarePre !== rareFall, `${rarePre.toFixed(0)} vs 폴백 ${rareFall.toFixed(0)}`);
  await page.evaluate(() => document.getElementById('rare-probe')?.remove());
}

// ── 서비스워커: 껍데기 캐시 + 오프라인 ────────────────────────────────────────
// 정적 게이트(`check-sw`)는 "위험한 짓을 안 하는가"만 본다 — 실제로 캐시가 도는지,
// 오프라인에서 앱이 뜨는지는 **브라우저만 답할 수 있다**(§10 ②).
//
// ⚠️ `response.fromServiceWorker()`를 "캐시에서 왔다"로 읽으면 안 된다. 워커가 **처리**했다는
// 뜻일 뿐이고, 워커가 그 안에서 네트워크로 갔을 수도 있다. 실제로 이 함정에 걸려 "재방문은
// 캐시"라고 잘못 읽을 뻔했다 — 그래서 여기서는 **서버가 실제로 파일을 내줬는지**를 센다.
//
// ⚠️⚠️ 그리고 **브라우저 자체 HTTP 캐시를 반드시 꺼야 한다.** 처음엔 안 껐는데, 워커의 캐시를
// 통째로 무력화해도 검사가 그대로 통과했다 — 서버 요청을 막고 있던 건 워커가 아니라 브라우저
// 캐시였다. 즉 **워커가 없어도 통과하는 검사**였다(§4 공허한 게이트). CDP로 HTTP 캐시를 끄면
// 서버 요청이 줄어든 것은 오직 워커 덕분이 된다.
{
  const swCtx = await browser.newContext({ viewport: { width: 412, height: 915 } });
  const swPage = await swCtx.newPage();
  const noHttpCache = async (p) => {
    const cdp = await swCtx.newCDPSession(p);
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  };
  await noHttpCache(swPage);
  const url = `http://localhost:4173${BASE}`;

  await swPage.goto(url, { waitUntil: 'networkidle' });
  const registered = await swPage
    .evaluate(async () => {
      await navigator.serviceWorker.ready;
      return navigator.serviceWorker.controller !== null;
    })
    .catch(() => false);
  check('서비스워커: 등록되고 페이지를 제어한다', registered === true, `controller=${registered}`);

  // 워커는 두 번째 방문에서 캐시를 채운다(미리받기 목록이 없으므로). 세 번째부터가 정상 상태.
  await swPage.reload({ waitUntil: 'networkidle' });
  served.length = 0; // 서버가 내준 파일 기록을 비우고 정상 상태만 잰다
  await swPage.reload({ waitUntil: 'networkidle' });
  // 서버는 BASE를 떼고 기록하므로 경로가 `assets/…`다(선행 슬래시 없음).
  // `/assets/`로 찾다가 **아무것도 매칭되지 않아 늘 0건으로 통과**했다 — 셀렉터 불일치로
  // 조용히 통과하는 §4의 그 형태였고, 주입시험에서만 드러났다.
  const assetHits = served.filter((p) => p.startsWith('assets/'));
  if (served.length === 0) throw new Error('verify: 서버 요청 기록이 비었다 — 검사가 아무것도 안 재고 있다.');
  check(
    '서비스워커: 정상 상태 재방문에 자산을 서버에서 다시 받지 않는다',
    assetHits.length === 0,
    assetHits.length === 0 ? '자산 서버 요청 0건' : assetHits.slice(0, 4).join(', '),
  );

  // 오프라인 — 이 앱은 여행 중에 쓰인다. 비행기·지하·로밍 끊김에서 껍데기가 떠야 한다.
  // **오프라인은 서버를 내려서 만든다.** `context.setOffline(true)`로는 안 된다 —
  // 그 설정은 페이지의 네트워크만 막고 **서비스워커가 보내는 요청은 그대로 나간다.**
  // 실제로 "오프라인" 중에 서버가 요청 5건을 받았고, 그래서 워커를 무력화해도 이 검사가
  // 통과했다(원리적으로 실패할 수 없는 검사였다). 서버를 닫으면 누구도 못 나간다.
  const offLog = [];
  const offServer = makeServer(offLog);
  await new Promise((r) => offServer.listen(4174, r));
  const offUrl = `http://localhost:4174${BASE}`;
  const offCtx = await browser.newContext();
  const offPage = await offCtx.newPage();
  await offPage.goto(offUrl, { waitUntil: 'networkidle' });
  await offPage.evaluate(() => navigator.serviceWorker.ready);
  await offPage.reload({ waitUntil: 'networkidle' });
  const offlineReady = await offPage.evaluate(async () => {
    if (!navigator.serviceWorker.controller) return { shell: false, missing: ['controller'] };
    const cache = await caches.open('journey-shell-v2');
    const shell = Boolean(await cache.match(location.href));
    const urls = [...document.querySelectorAll('script[src], link[href]')]
      .map((node) => node.getAttribute('src') ?? node.getAttribute('href'))
      .filter((href) => Boolean(href && href.includes('/assets/')))
      .map((href) => new URL(href, location.href).href);
    const missing = (await Promise.all(urls.map(async (href) => (await cache.match(href)) ? '' : href))).filter(Boolean);
    return { shell, missing };
  });
  check(
    '서비스워커: 오프라인 시작에 필요한 셸과 현재 런타임 자산이 캐시에 있다',
    offlineReady.shell && offlineReady.missing.length === 0,
    `shell=${offlineReady.shell} · 누락 자산 ${offlineReady.missing.length}개`,
  );
  await new Promise((r) => offServer.close(r));
  await offCtx.close();
  await swCtx.close();
}

// ── v1.02: 계정 영역이 **제목 줄 오른쪽**에 오는가(사용자 요청 2026-07-26) ──────────
// 왜 이 층인가: 배치는 CSS flex와 내용 폭이 함께 정한다 — 타입도 유닛도 못 본다.
// 넓은 화면에서 같은 줄인지, 오른쪽에 붙는지, 넘치지 않는지를 **실측**한다.
await page.setViewportSize({ width: 900, height: 900 });
await page.goto(`http://localhost:4173${BASE}`);
await page.waitForSelector('.app-title-row');
await page.waitForSelector('.auth-area');
// 로그인 상태를 이 환경에서 만들 수 없으므로 계정 영역에 실제와 같은 내용을 주입해 폭만 잰다.
await page.evaluate(() => {
  const a = document.querySelector('.auth-area');
  if (!a) return;
  a.innerHTML = '';
  const who = document.createElement('span');
  who.className = 'muted small auth-who';
  who.textContent = 'someone@example.com';
  for (const label of ['↻ 동기화', '로그아웃']) {
    const b = document.createElement('button');
    b.className = 'btn-ghost';
    b.textContent = label;
    a.appendChild(b);
  }
  a.insertBefore(who, a.firstChild);
});
await settle(page);
const headM = await page.evaluate(() => {
  const t = document.querySelector('.app-title-row')?.getBoundingClientRect();
  const a = document.querySelector('.auth-area')?.getBoundingClientRect();
  const head = document.querySelector('.app-head-top')?.getBoundingClientRect();
  return {
    sameLine: t && a ? Math.abs(t.top - a.top) < 8 : false,
    // 오른쪽에 붙었는가 — 제목 오른쪽 끝보다 뒤에 있고, 헤더 오른쪽 가장자리에 닿는가.
    afterTitle: t && a ? a.left >= t.right - 1 : false,
    flushRight: head && a ? head.right - a.right < 2 : false,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
});
check('헤더: 계정 영역이 제목과 **같은 줄**에 온다(넓은 화면)', headM.sameLine, JSON.stringify(headM));
check('헤더: 계정 영역이 **오른쪽 끝**에 붙는다', headM.afterTitle && headM.flushRight, JSON.stringify(headM));
check('헤더: 가로 넘침 0', headM.overflow === 0, `overflow=${headM.overflow}`);

// ── R① ~ R⑥ 🔴 **사진 썸네일: 정사각 + 꾹 눌러 순서 바꾸기** (사용자 지시 2026-08-06) ──
//
// 두 지시를 한 자리에서 잰다:
//   ①*"썸네일 사진의 가로 세로 크기가 제각각이라 보기 불편함"* → 칸이 **같은 크기**인가
//   ②*"손가락으로 꾹 눌러서 순서를 변경할 수 있도록"* → 실제로 **눌러 끌어** 순서가 바뀌는가
//
// 🔴 유닛은 `dropIndex`·`moveItem`·`orderPhotos`를 이미 전수로 잰다. 여기서 재는 것은
// **배선**이다 — 길게 누르기가 실제로 걸리는가, 끌면 저장되는가, 다시 그려도 유지되는가.
// 그 층이 없으면 순수 함수는 초록인데 화면은 안 움직이는 상태가 조용히 나간다(§10 ③).
{
  // 비율이 서로 다른 사진 3장을 심는다 — **가로·세로·정사각**. 같은 크기로만 심으면
  // ①번 검사가 통과해도 아무것도 증명하지 못한다(픽스처가 갈래를 드러내야 한다 · E⑫의 교훈).
  const seeded = await page.evaluate(async () => {
    const blob = async (w, h, color) => {
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, w, h);
      return await new Promise((r) => cv.toBlob(r, 'image/webp'));
    };
    const pick = await new Promise((resolve, reject) => {
      const req = indexedDB.open('journey-archive');
      req.onsuccess = () => {
        const tx = req.result.transaction('localMoments', 'readonly');
        const all = tx.objectStore('localMoments').getAll();
        all.onsuccess = () => resolve(all.result.filter((m) => m.deletedAt === null).pop());
        all.onerror = () => reject(all.error);
      };
      req.onerror = () => reject(req.error);
    });
    if (!pick) return null;
    const shapes = [
      ['ro-wide', 160, 60, '#c33', '2026-08-06T03:00:00.000Z'],
      ['ro-tall', 60, 160, '#3c3', '2026-08-06T02:00:00.000Z'],
      ['ro-square', 100, 100, '#33c', '2026-08-06T01:00:00.000Z'],
    ];
    const rows = [];
    for (const [id, w, h, color, takenAt] of shapes) {
      const b = await blob(w, h, color);
      rows.push({
        id, momentId: pick.id, tripId: pick.tripId, mime: 'image/webp',
        displayBlob: b, thumbBlob: b, width: w, height: h,
        takenAt, gpsLat: null, gpsLng: null, sortOrder: null,
        bytesOriginal: b.size, bytesDisplay: b.size,
        version: 1, baseVersion: 0, createdAt: takenAt, updatedAt: takenAt,
        deletedAt: null, clientOperationId: `ro-${id}`,
      });
    }
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('journey-archive');
      req.onsuccess = () => {
        const tx = req.result.transaction('localMedia', 'readwrite');
        for (const r of rows) tx.objectStore('localMedia').put(r);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
    const trip = await new Promise((resolve) => {
      const req = indexedDB.open('journey-archive');
      req.onsuccess = () => {
        const tx = req.result.transaction('localTrips', 'readonly');
        const g = tx.objectStore('localTrips').get(pick.tripId);
        g.onsuccess = () => resolve(g.result ?? null);
        g.onerror = () => resolve(null);
      };
      req.onerror = () => resolve(null);
    });
    return { momentId: pick.id, title: pick.title ?? '', tripName: trip?.title ?? '' };
  });
  check('R⓪ 픽스처 주입(가로·세로·정사각 3장 — 비율이 서로 다르다)', Boolean(seeded?.momentId), JSON.stringify(seeded));

  if (seeded?.momentId) {
    // 🔴 **심은 순간이 있는 여행으로 들어간다.** 앞 블록이 홈으로 옮겨 뒀으므로 그냥 새로고침하면
    // 썸네일이 없다 — 검사가 자기 화면을 확보하지 않으면 남이 남긴 화면을 자기 것으로 읽는다
    // (이 파일이 M-0052 때 배운 그 규율이다).
    const goToSeededTrip = async () => {
      await page.goto(`http://localhost:4173${BASE}`, { waitUntil: 'networkidle' });
      await page.getByLabel(`${seeded.tripName} 여행 열기`).first().click();
      await page.waitForSelector('.moment-card', { timeout: 15000 });
      await page.waitForSelector('.photo-thumbs .photo-thumb-wrap', { timeout: 15000 });
    };
    await goToSeededTrip();
    // 🔴 화면의 **첫 격자**가 아니라 **심은 순간의 격자**를 본다. 첫 격자를 집으면 사진 1장짜리
    // 다른 순간을 재게 되고, 그때 초록/빨강은 앱이 아니라 픽스처를 가리킨다(§3-E).
    const seededCard = page.locator('.moment-card', { hasText: seeded.title }).first();
    const grid = seededCard.locator('.photo-thumbs').first();

    // ① 칸이 같은 크기인가 — 원본 비율이 제각각인데도.
    const sizes = await grid.evaluate((g) =>
      Array.from(g.querySelectorAll('.photo-thumb-wrap')).map((e) => {
        const r = e.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      }),
    );
    const allSame = sizes.length > 1 && sizes.every((s) => s.w === sizes[0].w && s.h === sizes[0].h);
    check(
      '🔴 R① 썸네일 칸이 **전부 같은 크기**다(원본 비율이 달라도 · 사용자 지적 2026-08-06)',
      allSame,
      JSON.stringify(sizes),
    );

    // ② 아무도 손대지 않았으면 **촬영시각 순**이다(square → tall → wide).
    const orderBefore = await grid.evaluate((g) =>
      Array.from(g.querySelectorAll('.photo-thumb')).map((i) => i.src.slice(-10)),
    );
    // 심은 셋이 **촬영시각 순**(square 01:00 → tall 02:00 → wide 03:00)으로 놓였는가.
    // 🔴 개수만 세면 아무것도 증명하지 못한다 — 칸의 `data-media-id`로 **실제 순서**를 읽는다.
    const beforeMine = await grid.evaluate((g) =>
      Array.from(g.querySelectorAll('.photo-thumb-wrap'))
        .map((e) => e.dataset.mediaId)
        .filter((id) => id && id.startsWith('ro-')),
    );
    check(
      '🔴 R② 손대기 전에는 **촬영시각 순**으로 놓인다(정렬이 아예 없던 자리 · 2026-08-06)',
      beforeMine.join(',') === 'ro-square,ro-tall,ro-wide',
      beforeMine.join(' → '),
    );

    // ③ 🔴 **실제로 꾹 눌러 끈다** — 내가 심은 첫 사진을 내가 심은 마지막 사진 자리로.
    //
    // 🔴 **인덱스로 집지 않는다.** 같은 순간에 다른 블록이 남긴 사진이 쌓일 수 있고, 실제로
    // 그래서 이 검사가 헛디뎠다(첫 칸이 내 것이 아니었다). 검사는 **자기 픽스처만 소유**한다(§3-E).
    // 먼저 화면 안으로 올린다: `getBoundingClientRect`는 뷰포트 기준이라, 격자가 아래에 있으면
    // 좌표가 화면 밖을 가리키고 마우스가 엉뚱한 곳을 누른다(처음에 그렇게 헛돌았다).
    await grid.scrollIntoViewIfNeeded();
    await settle(page);
    const boxOf = async (mediaId) =>
      await grid.evaluate((g, id) => {
        const e = g.querySelector(`.photo-thumb-wrap[data-media-id="${id}"]`);
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, mediaId);
    const fromBox = await boxOf('ro-square');
    const toBox = await boxOf('ro-wide');
    check('R③-0 내가 심은 두 칸의 자리를 찾았다', Boolean(fromBox && toBox), JSON.stringify({ fromBox, toBox }));
    // 🔴 **손가락으로 잰다 — 마우스가 아니다** (2026-08-06 · 사용자 실기기가 잡았다).
    //
    // 처음엔 `page.mouse`로 쟀고 초록이었다. 그런데 사용자의 태블릿에서는 안 됐다:
    // 터치에는 **브라우저가 제스처를 스크롤로 가져가는 경로**가 있고 마우스에는 없다.
    // 즉 검사가 **문제가 날 수 없는 입력**으로 돌고 있었다 — 헌법 §17이 말하는 그 자리다.
    // (그 조항을 이 세션에 쓰고 같은 세션에 어겼다.)
    //
    // CDP `Input.dispatchTouchEvent`를 쓰는 이유: `page.touchscreen`은 탭만 되고, JS로 만든
    // `TouchEvent`는 **브라우저의 스크롤 판정을 재현하지 못한다**(내가 만든 이벤트를 내가
    // 재는 셈 — §3-E). 이건 브라우저 입력 파이프라인에 진짜로 넣는 길이다.
    const cdp = await page.context().newCDPSession(page);
    const touch = (type, x, y) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: type === 'touchEnd' ? [] : [{ x, y, radiusX: 12, radiusY: 12, force: 1 }],
      });
    await touch('touchStart', fromBox.x, fromBox.y);
    await grid.locator('.drag-lift').waitFor();
    const lifted = await grid.locator('.drag-lift').count();
    check('🔴 R③ **손가락으로** 꾹 누르면 칸이 들린다(마우스가 아니다 · 사용자 실기기 2026-08-06)', lifted === 1, `들린 칸 ${lifted}개`);
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      await touch('touchMove', fromBox.x + ((toBox.x - fromBox.x) * i) / steps, fromBox.y + ((toBox.y - fromBox.y) * i) / steps);
      await settle(page);
    }
    // 🔴 끄는 도중에 **드래그가 살아 있는가** — 브라우저가 스크롤로 가져가면 여기서 죽는다.
    const aliveMid = await grid.locator('.drag-lift').count();
    check('🔴 R③-B 끄는 **도중에도 드래그가 살아 있다**(브라우저가 스크롤로 가져가지 않는다)', aliveMid === 1, `들린 칸 ${aliveMid}개`);

    // 🔴 R③-C·D — **「이동하는 느낌」**(사용자 요청 2026-08-06: *"이동하는 느낌이 나게 해줄 순 있나요?"*).
    //
    // 이건 유닛이 원리적으로 못 보는 층이다: `shiftOffsets`가 옳은 숫자를 내도 그 값이 화면에
    // 안 걸리면 사용자는 아무 느낌도 못 받는다 — 계산은 맞고 화면만 틀린 그 부류다(§10 ③).
    // 그래서 **실제로 그려진 `transform` 행렬**을 읽는다. 클래스 이름이 아니라 픽셀이 근거다.
    const moved = await grid.evaluate((g) => {
      const shift = (e) => {
        const t = getComputedStyle(e).transform;
        if (!t || t === 'none') return null;
        const m = new DOMMatrixReadOnly(t);
        return { x: Math.round(m.m41), y: Math.round(m.m42), scale: Number(m.a.toFixed(2)) };
      };
      const wraps = Array.from(g.querySelectorAll('.photo-thumb-wrap'));
      const lift = wraps.find((e) => e.classList.contains('drag-lift'));
      return {
        lifted: lift ? shift(lift) : null,
        others: wraps.filter((e) => e !== lift).map(shift).filter((s) => s && (s.x !== 0 || s.y !== 0)).length,
      };
    });
    check(
      '🔴 R③-C 끄는 칸이 **손가락을 따라 움직인다**(테두리만 바뀌는 게 아니다)',
      Boolean(moved.lifted) && (Math.abs(moved.lifted.x) > 8 || Math.abs(moved.lifted.y) > 8),
      JSON.stringify(moved.lifted),
    );
    check(
      '🔴 R③-D **다른 칸들이 실제로 비켜선다** — 자리가 열리는 것이 보인다',
      moved.others >= 1,
      `비켜선 칸 ${moved.others}개`,
    );
    await touch('touchEnd', toBox.x, toBox.y);
    await grid.locator('.drag-lift').waitFor({ state: 'detached' });
    await waitUntil(
      () => page.evaluate(
        (momentId) => new Promise((resolve) => {
          const req = indexedDB.open('journey-archive');
          req.onsuccess = () => {
            const tx = req.result.transaction('localMedia', 'readonly');
            const all = tx.objectStore('localMedia').getAll();
            all.onsuccess = () => {
              const mine = all.result
                .filter((m) => m.momentId === momentId && m.deletedAt === null && m.id.startsWith('ro-'))
                .sort((a, b) => (a.sortOrder ?? 99) - (b.sortOrder ?? 99))
                .map((m) => m.id);
              resolve(mine.join(',') === 'ro-tall,ro-wide,ro-square');
            };
            all.onerror = () => resolve(false);
          };
          req.onerror = () => resolve(false);
        }),
        seeded.momentId,
      ),
      15000,
    );

    // ④ 순서가 실제로 **저장**됐는가 — 화면이 아니라 저장소에 물어본다.
    const saved = await page.evaluate(
      (momentId) =>
        new Promise((resolve, reject) => {
          const req = indexedDB.open('journey-archive');
          req.onsuccess = () => {
            const tx = req.result.transaction('localMedia', 'readonly');
            const all = tx.objectStore('localMedia').getAll();
            all.onsuccess = () =>
              resolve(
                all.result
                  .filter((m) => m.momentId === momentId && m.deletedAt === null)
                  .map((m) => ({ id: m.id, sortOrder: m.sortOrder }))
                  .sort((a, b) => (a.sortOrder ?? 99) - (b.sortOrder ?? 99)),
              );
            all.onerror = () => reject(all.error);
          };
          req.onerror = () => reject(req.error);
        }),
      seeded.momentId,
    );
    const numbered = saved.filter((r) => typeof r.sortOrder === 'number');
    // 🔴 **그 순간에 사진이 몇 장인지 가정하지 않는다.** 앞 블록들이 같은 순간에 사진을 남길 수
    // 있고, 실제로 그래서 이 검사가 한 번 헛디뎠다 — 검사가 자기 픽스처만 소유해야 한다(§3-E).
    check(
      '🔴 R④ 끌어 놓으면 **그 순간 사진 전부에** 번호가 매겨진다(일부만 매기면 규칙이 섞인다)',
      saved.length >= 3 && numbered.length === saved.length,
      JSON.stringify(saved),
    );
    const mine = saved.filter((r) => r.id.startsWith('ro-')).map((r) => r.id);
    check(
      '🔴 R⑤ 첫 칸이 **뒤로** 갔다 — 끌어간 자리대로 저장된다',
      mine.join(',') === 'ro-tall,ro-wide,ro-square',
      saved.map((r) => `${r.id.slice(0, 8)}:${r.sortOrder}`).join(' '),
    );

    // ⑤ 다시 그려도 유지되는가 — 새로고침 뒤에도 같은 순서인가.
    await goToSeededTrip();
    const after = await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const req = indexedDB.open('journey-archive');
          req.onsuccess = () => {
            const tx = req.result.transaction('localMedia', 'readonly');
            const all = tx.objectStore('localMedia').getAll();
            all.onsuccess = () =>
              resolve(
                all.result
                  .filter((m) => m.id.startsWith('ro-'))
                  .sort((a, b) => (a.sortOrder ?? 99) - (b.sortOrder ?? 99))
                  .map((m) => m.id),
              );
            all.onerror = () => reject(all.error);
          };
          req.onerror = () => reject(req.error);
        }),
    );
    check('R⑥ 새로고침해도 순서가 유지된다', after.join(',') === 'ro-tall,ro-wide,ro-square', after.join(' → '));

    // Windows mouse path: a real reorder must consume the synthetic click emitted on button release.
    await grid.scrollIntoViewIfNeeded();
    const mouseFrom = await boxOf('ro-tall');
    const mouseTo = await boxOf('ro-square');
    if (mouseFrom && mouseTo) {
      await page.mouse.move(mouseFrom.x, mouseFrom.y);
      await page.mouse.down();
      await grid.locator('.drag-lift').waitFor();
      await page.mouse.move(mouseTo.x, mouseTo.y, { steps: 10 });
      await page.mouse.up();
      await settle(page);
      check('R⑦ Windows 마우스 재배열 완료 때 사진 뷰어가 열리지 않는다', await page.locator('.photo-viewer').count() === 0);
      const nextClick = await boxOf('ro-wide');
      if (nextClick) {
        await page.mouse.click(nextClick.x, nextClick.y);
        // 🔴 뷰어는 사진 바이트를 불러온 뒤 열리므로 **프레임 두 장으로는 이르다**(T-042 · M-0119).
        //    같은 코드에서 한 번 FAIL하고 다음 실행에서 PASS했다 — 「열렸다」는 사실을 기다린다.
        const viewerOpened = await waitUntil(async () => await page.locator('.photo-viewer').count() === 1, 5000);
        check('R⑧ 재배열 직후 다른 사진을 누르면 정상적으로 뷰어가 열린다', viewerOpened);
        await page.keyboard.press('Escape');
      } else {
        check('R⑧ 후속 정상 클릭 좌표를 찾는다', false);
      }
    } else {
      check('R⑦ Windows 마우스 재배열 좌표를 찾는다', false, JSON.stringify({ mouseFrom, mouseTo }));
    }

    // 뒷정리 — 심은 픽스처를 지운다(§3-C, 내 상태를 남기지 않는다).
    await page.evaluate(() =>
      new Promise((resolve) => {
        const req = indexedDB.open('journey-archive');
        req.onsuccess = () => {
          const tx = req.result.transaction('localMedia', 'readwrite');
          for (const id of ['ro-wide', 'ro-tall', 'ro-square']) tx.objectStore('localMedia').delete(id);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        };
        req.onerror = () => resolve();
      }),
    );
  }
}

// ── v1.94: 위치관리대장 → 기록 모달 → 정확한 순간/사진 뷰어 ───────────────────
// 긴 시나리오의 뒤쪽에 둔다. 이 블록은 URL·Dexie·오버레이 상태를 바꾸므로 앞 단계의 전제를
// 흔들지 않고, 자기가 심은 세 store 행도 끝에서 전부 지운다(§3-C).
const PLACE_RECORD_IDS = { place: 'pr-nav-place', unusedPlace: 'pr-nav-place-unused', trips: ['pr-nav-trip-direct', 'pr-nav-trip-name'], moments: ['pr-nav-moment-direct', 'pr-nav-moment-name'], media: ['pr-nav-media-first', 'pr-nav-media-second'] };
const placeRecordSeed = await page.evaluate(async (ids) => {
  const now = new Date().toISOString();
  const makeThumb = async (color) => {
    const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 12;
    const ctx = canvas.getContext('2d'); if (!ctx) return null;
    ctx.fillStyle = color; ctx.fillRect(0, 0, 16, 12);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp'));
  };
  const thumbs = await Promise.all(['#268', '#862'].map(makeThumb));
  if (thumbs.some((thumb) => !thumb)) return false;
  const place = { id: ids.place, name: '라이브 기록 장소', latitude: 41.3111, longitude: 69.2797,
    formattedAddress: null, provider: null, providerPlaceId: null, countryCode: null, country: null, region: null, city: null, district: null, postcode: null,
    category: null, memo: null, precision: null, spanMeters: null, mapPicked: false, version: 1, baseVersion: 0, createdAt: now, updatedAt: now, deletedAt: null, clientOperationId: 'pr-nav-place-op' };
  const unusedPlace = { ...place, id: ids.unusedPlace, name: '라이브 미연결 장소', latitude: 37.5656422, longitude: 126.8009320, clientOperationId: 'pr-nav-place-unused-op' };
  const trips = ids.trips.map((id, index) => ({ id, title: index ? '이름 일치 여행' : '직접 연결 여행', startDate: '2026-08-07', endDate: '2026-08-07', status: 'completed', timeZone: 'Asia/Tashkent', version: 1, baseVersion: 0, createdAt: now, updatedAt: now, deletedAt: null, clientOperationId: `${id}-op` }));
  const moments = [
    { id: ids.moments[0], tripId: ids.trips[0], occurredAt: now, title: '대표 사진이 있는 순간', note: '', emotion: '', placeName: place.name, placeLat: 41.3111, placeLng: 69.2797, placeId: place.id, version: 1, baseVersion: 0, createdAt: now, updatedAt: now, deletedAt: null, clientOperationId: 'pr-nav-moment-direct-op' },
    { id: ids.moments[1], tripId: ids.trips[1], occurredAt: now, title: '사진 없는 이름 일치 순간', note: '', emotion: '', placeName: place.name, placeLat: null, placeLng: null, placeId: null, version: 1, baseVersion: 0, createdAt: now, updatedAt: now, deletedAt: null, clientOperationId: 'pr-nav-moment-name-op' },
  ];
  const media = thumbs.map((thumb, index) => ({ id: ids.media[index], momentId: ids.moments[0], tripId: ids.trips[0], mime: 'image/webp', displayBlob: thumb, thumbBlob: thumb, width: 16, height: 12, takenAt: now, gpsLat: null, gpsLng: null, sortOrder: index, bytesOriginal: thumb.size, bytesDisplay: thumb.size, version: 1, baseVersion: 0, createdAt: now, updatedAt: now, deletedAt: null, clientOperationId: `pr-nav-media-${index}-op` }));
  await new Promise((resolve, reject) => {
    const req = indexedDB.open('journey-archive');
    req.onsuccess = () => {
      const tx = req.result.transaction(['localPlaces', 'localTrips', 'localMoments', 'localMedia'], 'readwrite');
      tx.objectStore('localPlaces').put(place); tx.objectStore('localPlaces').put(unusedPlace); trips.forEach((row) => tx.objectStore('localTrips').put(row));
      moments.forEach((row) => tx.objectStore('localMoments').put(row)); media.forEach((row) => tx.objectStore('localMedia').put(row));
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    }; req.onerror = () => reject(req.error);
  });
  return true;
}, PLACE_RECORD_IDS);
check('v1.96 위치 기록: Dexie 픽스처(직접·이름 일치·미연결·사진)를 함께 심는다', placeRecordSeed === true, String(placeRecordSeed));

await page.goto(`http://localhost:4173${BASE}`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /데이터 관리/ }).first().click();
await page.waitForSelector('.guide-overlay');
await page.getByRole('button', { name: /위치관리대장/ }).click();
await page.waitForSelector('.pr-unlinked');
const unlinkedText = await page.locator('.pr-unlinked').textContent();
check('v1.97 고아 장소: placeId가 끊긴 순간을 대장에서 숨기지 않고 재연결 경로를 준다',
  /사진 없는 이름 일치 순간/.test(unlinkedText ?? '') && await page.getByRole('button', { name: /라이브 기록 장소 순간에서 장소 다시 연결/ }).count() === 1,
  unlinkedText ?? '(연결 필요 목록 없음)');
await page.getByRole('button', { name: /라이브 기록 장소 순간에서 장소 다시 연결/ }).click();
const orphanMomentCard = page.locator(`.moment-card[data-moment-id="${PLACE_RECORD_IDS.moments[1]}"]`);
await orphanMomentCard.locator('.moment-edit .place-input').waitFor({ state: 'visible' });
await orphanMomentCard.locator('.moment-edit .place-results .place-result.is-saved').waitFor({ state: 'visible' });
check('고아 장소: 장소 고르기는 정확한 순간의 장소 입력을 열고 화면 이동을 유지한다',
  /moment=pr-nav-moment-name/.test(await page.url()) && /place=edit/.test(await page.url())
    && await orphanMomentCard.locator('.moment-edit').isVisible()
    && /라이브 기록 장소/.test(await orphanMomentCard.locator('.moment-edit .place-results').textContent() ?? ''),
  await page.url());
// 다음 위치관리대장 검사들은 같은 출발 화면을 필요로 한다. URL만으로 재진입해 모달 상태를 복원하지 않는다.
await page.goto(`http://localhost:4173${BASE}`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /데이터 관리/ }).first().click();
await page.waitForSelector('.guide-overlay');
await page.getByRole('button', { name: /위치관리대장/ }).click();
await page.waitForSelector('.pr-unlinked');
const bulkAddressButton = page.locator('.pr-bulk-button').filter({ hasText: /주소/ });
const emptyPlaceButton = page.locator('.pr-bulk-button').filter({ hasText: /사진/ });
check('v2.00 place registry: bulk address and empty-place controls render',
  await bulkAddressButton.count() === 1 && await emptyPlaceButton.count() === 1 && !(await bulkAddressButton.isDisabled()),
  `${await bulkAddressButton.textContent()} | ${await emptyPlaceButton.textContent()}`);
await emptyPlaceButton.click();
await page.waitForSelector('.pr-unused-modal');
const unusedSelectAll = page.locator('.pr-unused-select-all input');
await unusedSelectAll.check();
check('v2.00 place registry: empty-place dialog supports select all',
  await page.locator('.pr-unused-modal').count() === 1 && await unusedSelectAll.isChecked()
    && await page.locator('.pr-unused-row input:checked').count() === await page.locator('.pr-unused-row input').count(),
  await page.locator('.pr-unused-modal').textContent() ?? '');
await page.locator('.pr-unused-modal .guide-close').click();
if (process.env.PLACE_ORPHAN_SCREENSHOT) {
  await page.screenshot({ path: resolve(process.env.PLACE_ORPHAN_SCREENSHOT), fullPage: false });
}
await page.getByRole('button', { name: /라이브 기록 장소 기록 보기/ }).click();
await page.waitForSelector('.pr-records-overlay');
await page.waitForSelector('.pr-record-photo[data-media-id="pr-nav-media-second"]');
const recordModalText = await page.locator('.pr-records-modal').textContent();
check('v1.94 위치 기록: 직접 연결·이름만 같은 순간을 문구로 분리한다',
  /직접 연결된 순간/.test(recordModalText ?? '') && /이름만 같은 순간/.test(recordModalText ?? ''), recordModalText ?? '');
const modalMediaOrder = await page.locator('.pr-record-photo').evaluateAll((nodes) => nodes.map((node) => node.dataset.mediaId));
check('v1.94 위치 기록: 여행 제목·순간 제목·사진 수·모든 썸네일을 기존 순서로 실제로 그린다',
  /직접 연결 여행/.test(recordModalText ?? '') && /대표 사진이 있는 순간/.test(recordModalText ?? '') && /사진 2장/.test(recordModalText ?? '') && await page.locator('.pr-record-thumb').count() === 2 && modalMediaOrder.join(',') === PLACE_RECORD_IDS.media.join(','),
  `${recordModalText ?? ''} | ${modalMediaOrder.join(',')}`);
check('v1.96 미연결 장소: 직접 연결된 순간이 있으면 삭제 버튼이 없다',
  await page.locator('.pr-record-delete').count() === 0, `삭제영역 ${await page.locator('.pr-record-delete').count()}개`);
for (const viewport of [{ width: 375, height: 812, label: '세로 폰' }, { width: 812, height: 375, label: '가로 폰' }]) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  const metrics = await page.locator('.pr-records-modal').evaluate((modal) => {
    const rect = modal.getBoundingClientRect();
    const body = modal.querySelector('.pr-records-body');
    const bodyStyle = body ? getComputedStyle(body) : null;
    return {
      top: Math.round(rect.top), bottom: Math.round(rect.bottom), viewportHeight: innerHeight,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      bodyScrollable: body instanceof HTMLElement && body.scrollHeight > body.clientHeight,
      bodyOverflowY: bodyStyle?.overflowY ?? '',
    };
  });
  check(`v1.94 위치 기록: ${viewport.label}에서 잘림·가로 넘침 없이 끝까지 스크롤 가능`,
    metrics.top >= 11 && metrics.bottom <= metrics.viewportHeight - 11 && metrics.overflowX === 0 && (!metrics.bodyScrollable || metrics.bodyOverflowY === 'auto'),
    JSON.stringify(metrics));
}
await page.setViewportSize({ width: 412, height: 915 });
if (process.env.PLACE_RECORD_SCREENSHOT) {
  await page.screenshot({ path: resolve(process.env.PLACE_RECORD_SCREENSHOT), fullPage: false });
}
await page.keyboard.press('Escape');
check('v1.94 위치 기록: Esc는 기록 창만 닫고 데이터 관리는 그대로 둔다',
  await page.locator('.pr-records-overlay').count() === 0 && await page.locator('.guide-overlay').count() === 1,
  `기록=${await page.locator('.pr-records-overlay').count()} · 데이터관리=${await page.locator('.guide-overlay').count()}`);
await page.getByRole('button', { name: /라이브 미연결 장소 기록 보기/ }).click();
await page.waitForSelector('.pr-records-overlay');
const unusedDelete = page.getByRole('button', { name: /라이브 미연결 장소 미연결 장소 삭제/ });
check('v1.96 미연결 장소: 직접 연결이 없을 때만 삭제 버튼과 복구 설명이 보인다',
  await unusedDelete.count() === 1 && /휴지통/.test(await page.locator('.pr-records-modal').textContent() ?? ''),
  await page.locator('.pr-records-modal').textContent() ?? '');
if (process.env.PLACE_UNUSED_SCREENSHOT) {
  await page.screenshot({ path: resolve(process.env.PLACE_UNUSED_SCREENSHOT), fullPage: false });
}
page.once('dialog', (dialog) => dialog.dismiss());
await unusedDelete.click();
await settle(page);
check('v1.96 미연결 장소: 확인을 취소하면 장소와 모달이 그대로 남는다',
  await page.locator('.pr-records-overlay').count() === 1 && await page.getByRole('button', { name: /라이브 미연결 장소 기록 보기/ }).count() === 1);
await page.keyboard.press('Escape');
await page.getByRole('button', { name: /라이브 기록 장소 기록 보기/ }).click();
await page.waitForSelector('.pr-record-photo[data-media-id="pr-nav-media-second"]');
await page.locator(`.pr-record-photo[data-media-id="${PLACE_RECORD_IDS.media[1]}"]`).click();
await page.waitForSelector(`.moment-card[data-moment-id="${PLACE_RECORD_IDS.moments[0]}"]`);
await page.waitForSelector('.photo-viewer');
const targetCard = page.locator(`.moment-card[data-moment-id="${PLACE_RECORD_IDS.moments[0]}"]`);
check('v1.94 위치 기록: 데이터 관리가 닫히고 정확한 순간을 강조한다',
  await page.locator('.guide-overlay').count() === 0 && await targetCard.evaluate((node) => node.classList.contains('is-navigation-target')),
  await page.url());
check('v1.94 위치 기록: URL target으로 사진 뷰어까지 자동으로 연다',
  /moment=pr-nav-moment-direct/.test(await page.url()) && /media=pr-nav-media-second/.test(await page.url()) && await page.locator('.photo-viewer').count() === 1,
  await page.url());
await page.keyboard.press('Escape');
await targetCard.locator('.icon-btn[aria-label="이 순간 편집"]').click();
await targetCard.locator('.moment-edit .place-input').fill('라이브 이름 동기화 장소');
await targetCard.locator('.moment-edit').getByRole('button', { name: '저장', exact: true }).click();
await page.waitForSelector(`.moment-card[data-moment-id="${PLACE_RECORD_IDS.moments[0]}"] .moment-edit`, { state: 'hidden' });
// 폼이 닫힌 것은 재렌더 사실일 뿐, 별도 IndexedDB 읽기 트랜잭션이 같은 커밋을 관측했다는
// 증거는 아니다. 고정 시간 대신 장소·순간의 실제 read-back이 함께 새 이름이 된 사실을 기다린다.
const linkedNameReadBack = await page.waitForFunction(async (ids) => await new Promise((resolve) => {
  const req = indexedDB.open('journey-archive');
  req.onsuccess = () => {
    const tx = req.result.transaction(['localPlaces', 'localMoments'], 'readonly');
    const placeReq = tx.objectStore('localPlaces').get(ids.place);
    const momentReq = tx.objectStore('localMoments').get(ids.moments[0]);
    tx.oncomplete = () => {
      const readBack = { place: placeReq.result, moment: momentReq.result };
      resolve(
        readBack.place?.name === '라이브 이름 동기화 장소'
          && readBack.moment?.placeName === '라이브 이름 동기화 장소'
          ? readBack
          : null,
      );
    };
    tx.onerror = () => resolve(null);
  };
  req.onerror = () => resolve(null);
}), PLACE_RECORD_IDS).then((handle) => handle.jsonValue());
check('v1.97 연결 이름: 순간 편집이 placeId·당시 좌표를 보존하고 대장 이름까지 함께 바꾼다',
  linkedNameReadBack?.place?.name === '라이브 이름 동기화 장소'
    && linkedNameReadBack?.moment?.placeName === '라이브 이름 동기화 장소'
    && linkedNameReadBack?.moment?.placeId === PLACE_RECORD_IDS.place
    && linkedNameReadBack?.moment?.placeLat === 41.3111
    && linkedNameReadBack?.moment?.placeLng === 69.2797,
  JSON.stringify(linkedNameReadBack));

// ── v2.11 영상: 실제 브라우저 생성 파일 → 변환 → Dexie → 재생 ──────────────
// 정적 픽스처를 저장소에 넣지 않고 Chromium의 MediaRecorder로 1초 WebM을 만든다. 이 파일을
// 실제 <input type=file>에 넣어 Mediabunny/WebCodecs 경계를 통과시키므로, 행만 심는 미러 검사가 아니다.
const tinyVideoDataUrl = await page.evaluate(async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 96; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const stream = canvas.captureStream(12);
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm';
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 180_000 });
  const chunks = [];
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
  const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
  recorder.start(100);
  for (let frame = 0; frame < 12; frame += 1) {
    ctx.fillStyle = frame % 2 ? '#2367d1' : '#e8792d';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#fff'; ctx.font = '20px sans-serif'; ctx.fillText(`V${frame}`, 30, 38);
    await new Promise((resolve) => setTimeout(resolve, 85));
  }
  recorder.stop();
  await stopped;
  stream.getTracks().forEach((track) => track.stop());
  const blob = new Blob(chunks, { type: 'video/webm' });
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(blob);
  });
});
const tinyVideoBuffer = Buffer.from(tinyVideoDataUrl.split(',')[1], 'base64');
await page.locator('.moment-form .moment-input').fill('라이브 영상 순간');
await page.locator('.moment-form .moment-video-input').setInputFiles({
  name: 'live-video.webm', mimeType: 'video/webm', buffer: tinyVideoBuffer,
});
await page.locator('.moment-form button[type="submit"]').click();
const videoCard = page.locator('.moment-card').filter({ hasText: '라이브 영상 순간' }).first();
await videoCard.locator('.video-thumb-button').waitFor({ state: 'visible', timeout: 60_000 });
await videoCard.getByRole('button', { name: '이 순간 편집' }).click();
const phoneAttachmentActions = await videoCard.locator('.moment-addphoto').evaluate((row) => {
  const actions = [...row.querySelectorAll('.form-utility')];
  const rects = actions.map((action) => action.getBoundingClientRect());
  const hiddenInputs = [...row.querySelectorAll('input[type="file"]')]
    .every((input) => input.getClientRects().length === 0);
  return {
    count: actions.length,
    rows: new Set(rects.map((rect) => Math.round(rect.top))).size,
    cols: new Set(rects.map((rect) => Math.round(rect.left))).size,
    widthSpread: Math.max(...rects.map((rect) => rect.width)) - Math.min(...rects.map((rect) => rect.width)),
    hiddenInputs,
    text: row.textContent ?? '',
  };
});
check('영상 추가 UI: 폰에서 네 첨부 행동이 같은 폭 2×2이고 네이티브 파일 입력은 숨긴다',
  phoneAttachmentActions.count === 4 && phoneAttachmentActions.rows === 2 && phoneAttachmentActions.cols === 2
    && phoneAttachmentActions.widthSpread <= 1 && phoneAttachmentActions.hiddenInputs
    && !phoneAttachmentActions.text.includes('선택된 파일 없음'),
  JSON.stringify(phoneAttachmentActions));
// ── 🔴 폴드 커버 폭(344px)에서 **글자가 쪼개지지 않는가** (2026-08-15 · M-0163) ──────────
//    사용자 실기기 지적: *"버튼 글자 어그러져있으니 깔끔히 맞춰주세요."* 412px에서는 칸이
//    충분해 이 결함이 **나지 않는다** — 즉 412px에서만 재는 검사의 초록은 「없다」가 아니라
//    **「안 봤다」**이다(§17). 그래서 이 저장소가 이미 쓰는 가장 좁은 폭에서 한 번 더 잰다.
await page.setViewportSize({ width: 344, height: 800 });
await settle(page);
const coverAttachmentActions = await videoCard.locator('.moment-addphoto').evaluate((row) => {
  const actions = [...row.querySelectorAll('.form-utility')];
  const rects = actions.map((a) => a.getBoundingClientRect());
  return {
    count: actions.length,
    // 글자가 줄바꿈되면 인라인 상자가 갈라져 rect가 2개가 된다.
    textLines: Math.max(0, ...actions.map((a) => a.querySelector('.moment-picker-text')?.getClientRects().length ?? 0)),
    // 🔴 `scrollWidth`로는 **글자가 버튼 밖으로 삐져나오는 것을 못 본다**(overflow가 visible이면
    //    scrollWidth는 padding box를 넘지 않는다 — 주입해 보고 알았다). 실제 좌표로 잰다.
    textOutside: Math.max(0, ...actions.map((a) => {
      const t = a.querySelector('.moment-picker-text')?.getBoundingClientRect();
      const b = a.getBoundingClientRect();
      return t ? Math.max(0, Math.round(b.left - t.left), Math.round(t.right - b.right)) : 0;
    })),
    overflow: Math.max(...actions.map((a) => a.scrollWidth - Math.round(a.getBoundingClientRect().width))),
    rowOverflow: row.scrollWidth - Math.round(row.getBoundingClientRect().width),
    widthSpread: Math.max(...rects.map((r) => r.width)) - Math.min(...rects.map((r) => r.width)),
    minHeight: Math.min(...rects.map((r) => r.height)),
  };
});
check('폴드 커버 344px: 첨부 버튼 글자가 한 줄로 서고 버튼 밖으로 넘치지 않는다',
  coverAttachmentActions.count === 4 && coverAttachmentActions.textLines === 1
    && coverAttachmentActions.textOutside === 0
    && coverAttachmentActions.overflow <= 0 && coverAttachmentActions.rowOverflow <= 0
    && coverAttachmentActions.widthSpread <= 1 && coverAttachmentActions.minHeight >= 44,
  JSON.stringify(coverAttachmentActions));

await page.setViewportSize({ width: 1440, height: 900 });
await settle(page);
const desktopAttachmentActions = await videoCard.locator('.moment-addphoto').evaluate((row) => {
  const rects = [...row.querySelectorAll('.form-utility')].map((action) => action.getBoundingClientRect());
  return {
    count: rects.length,
    rows: new Set(rects.map((rect) => Math.round(rect.top))).size,
    widthSpread: Math.max(...rects.map((rect) => rect.width)) - Math.min(...rects.map((rect) => rect.width)),
  };
});
check('영상 추가 UI: 넓은 화면에서 네 첨부 행동이 같은 폭 한 줄이다',
  desktopAttachmentActions.count === 4 && desktopAttachmentActions.rows === 1
    && desktopAttachmentActions.widthSpread <= 1,
  JSON.stringify(desktopAttachmentActions));
const videoReadBack = await page.evaluate(async () => await new Promise((resolve) => {
  const req = indexedDB.open('journey-archive');
  req.onsuccess = () => {
    const tx = req.result.transaction('localVideos', 'readonly');
    const all = tx.objectStore('localVideos').getAll();
    all.onsuccess = () => {
      const row = all.result.find((item) => item.tripId === 'pr-nav-trip-direct');
      resolve(row ? {
        mime: row.mime, durationSec: row.durationSec, width: row.width, height: row.height,
        bytesOriginal: row.bytesOriginal, bytesVideo: row.bytesVideo,
        blobSize: row.blob?.size ?? 0, posterSize: row.posterBlob?.size ?? 0,
      } : null);
    };
    all.onerror = () => resolve(null);
  };
  req.onerror = () => resolve(null);
}));
check('v2.11 영상: 실제 File 입력이 압축·포스터 생성 뒤 localVideos에 내구성 저장된다',
  videoReadBack?.blobSize > 0 && videoReadBack?.posterSize > 0 && videoReadBack?.bytesVideo === videoReadBack?.blobSize
    && videoReadBack?.bytesOriginal === tinyVideoBuffer.length && videoReadBack?.durationSec > 0
    && videoReadBack?.durationSec <= 60.1 && videoReadBack?.width <= 1280 && videoReadBack?.height <= 1280
    && videoReadBack?.blobSize <= 25 * 1024 * 1024,
  JSON.stringify(videoReadBack));
await observeViewerObjectUrls(page);
await videoCard.locator('.video-thumb-button').click();
await page.waitForSelector('.video-viewer .video-viewer-player');
await page.waitForFunction(() => {
  const player = document.querySelector('.video-viewer-player');
  return player instanceof HTMLVideoElement && player.played.length > 0;
});
const videoViewer = await page.locator('.video-viewer').evaluate((overlay) => ({
  role: overlay.getAttribute('role'), modal: overlay.getAttribute('aria-modal'),
  controls: overlay.querySelector('video')?.controls, autoplay: overlay.querySelector('video')?.autoplay,
  played: (overlay.querySelector('video')?.played.length ?? 0) > 0,
  src: overlay.querySelector('video')?.src.startsWith('blob:'),
  width: overlay.querySelector('video')?.getBoundingClientRect().width ?? 0,
}));
check('v2.11 영상: 포스터를 누르면 접근 가능한 blob 재생기가 열린다',
  videoViewer.role === 'dialog' && videoViewer.modal === 'true' && videoViewer.controls === true
    && videoViewer.autoplay === true && videoViewer.played === true && videoViewer.src === true && videoViewer.width >= 300,
  JSON.stringify(videoViewer));
  const visibleVideoBytes = Buffer.from(await page.locator('.video-viewer-player').evaluate(async (player) => {
    const blob = window.__liveObjectUrlBlobs.get(player.src);
    if (!blob) throw new Error(`영상 뷰어의 원본 Blob을 확보하지 못했습니다: ${player.src}`);
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }));
const videoDownloadStarted = page.waitForEvent('download');
await page.getByRole('button', { name: '이 영상 앱 보관본 저장' }).click();
const videoDownload = await videoDownloadStarted;
const videoDownloadPath = await videoDownload.path();
const savedVideoBytes = videoDownloadPath ? await readFile(videoDownloadPath) : Buffer.alloc(0);
await page.waitForFunction(() => /영상 앱 보관본 다운로드를 요청했어요/.test(
  document.querySelector('.video-viewer .media-viewer-save-status')?.textContent ?? '',
));
check('v2.15 영상 저장: 재생 중인 앱 보관본의 형식·바이트를 그대로 다운로드한다',
  /\.(mp4|webm)$/.test(videoDownload.suggestedFilename()) && savedVideoBytes.equals(visibleVideoBytes),
  `${videoDownload.suggestedFilename()} bytes=${savedVideoBytes.length}/${visibleVideoBytes.length}`);
  await page.keyboard.press('Escape');
  check('v2.11 영상: Esc로 재생기를 닫아 object URL 생명주기를 끝낸다', await page.locator('.video-viewer').count() === 0);
  await stopObservingViewerObjectUrls(page);

await page.evaluate(async (ids) => {
  await new Promise((resolve) => {
    const req = indexedDB.open('journey-archive');
    req.onsuccess = () => {
      const tx = req.result.transaction(['localPlaces', 'localTrips', 'localMoments', 'localMedia'], 'readwrite');
      tx.objectStore('localPlaces').delete(ids.place); tx.objectStore('localPlaces').delete(ids.unusedPlace); ids.trips.forEach((id) => tx.objectStore('localTrips').delete(id));
      ids.moments.forEach((id) => tx.objectStore('localMoments').delete(id)); ids.media.forEach((id) => tx.objectStore('localMedia').delete(id));
      tx.oncomplete = () => resolve(); tx.onerror = () => resolve();
    }; req.onerror = () => resolve();
  });
}, PLACE_RECORD_IDS);

// ── 🔴 좁은 폭 헤더 배치 + 터치 표적 (2026-08-15 · 사용자 실기기 · T-041 · HANDOFF-0202) ──
//    사용자 지적: *"제목 버전배지 동기화됨 그리고 이메일 배치를 이쁘게 안 될까?"* 그때 헤더는
//    다섯 줄이었다 — 제목이 「Bugeon / Journey」로 갈라지고 이메일은 잘려 있었다.
//
//    🔴 **이 검사는 맨 뒤에 있다**(§3-C): 뷰포트를 바꾸고 홈으로 이동하므로 앞선 시나리오의
//    전제를 깨뜨리지 않게 마지막에 둔다.
//
//    🔴 **로그인 화면을 재현한다** — 계정 영역은 로그인해야 채워지는데 이 검사는 로그인이
//    없다. 그래서 기존 `.auth-area`의 **내용을 교체**한다(덧붙이면 「로컬 모드」 줄과 겹쳐
//    **실기기에 없는 줄**을 재게 된다 · §3-E). 교체에 실패하면 판정하지 않고 실패로 적는다.
await page.setViewportSize({ width: 344, height: 820 });
await page.goto(`http://localhost:4173${BASE}`);
await page.waitForFunction(() => (document.getElementById('app')?.innerText ?? '').trim().length > 0, { timeout: 15000 });
const headerSeeded = await page.evaluate(() => {
  const area = document.querySelector('.auth-area');
  if (!area) return false;
  area.replaceChildren();
  const who = document.createElement('span');
  who.className = 'muted small auth-who';
  who.textContent = 'hanwha27@gmail.com';
  const out = document.createElement('button');
  out.className = 'btn-ghost';
  out.type = 'button';
  out.textContent = '로그아웃';
  area.append(who, out);
  return true;
});
check('좁은 헤더: 계정 영역 픽스처를 심었다(모집단 확보 — 못 심으면 아래는 공허하다)', headerSeeded);
if (headerSeeded) {
  await settle(page);
  const header = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const title = q('.app-title-home'); const ver = q('.app-version'); const who = q('.auth-who');
    const lineH = title ? parseFloat(getComputedStyle(title).fontSize) * 1.35 : 0; // line-height가 normal이라 폰트 크기로 환산
    const hit = (n) => {
      if (!n) return null;
      const r = n.getBoundingClientRect();
      const a = getComputedStyle(n, '::after');
      const g = (v) => Math.abs(parseFloat(v) || 0);
      const has = a.content !== 'none' && a.position === 'absolute';
      return { w: r.width + (has ? g(a.left) + g(a.right) : 0), h: r.height + (has ? g(a.top) + g(a.bottom) : 0), r };
    };
    const th = hit(title); const vh = hit(ver);
    // 넓힌 히트 영역이 다른 조작 요소를 덮는가 — 9점
    const stolen = [];
    for (const [n, m] of [[title, th], [ver, vh]]) {
      if (!n || !m) continue;
      const cx = m.r.left + m.r.width / 2, cy = m.r.top + m.r.height / 2;
      for (const dx of [-m.w / 2 + 1, 0, m.w / 2 - 1]) for (const dy of [-m.h / 2 + 1, 0, m.h / 2 - 1]) {
        const el = document.elementFromPoint(cx + dx, cy + dy)?.closest('button, a[href], input, [role="button"]');
        if (el && el !== n && !n.contains(el) && !el.contains(n)) stolen.push(el.className || el.tagName);
      }
    }
    return {
      // 🔴 버튼은 블록이라 줄이 갈라져도 rect가 1개다 — 높이로 잰다(앞선 판이 이걸로 틀렸다).
      titleLines: title && lineH ? Math.round(title.getBoundingClientRect().height / lineH) : -1,
      titleTop: title ? Math.round(title.getBoundingClientRect().top) : -1,
      verTop: ver ? Math.round(ver.getBoundingClientRect().top) : -1,
      emailClipped: who ? who.scrollWidth > who.clientWidth + 1 : null,
      titleHit: th ? `${Math.round(th.w)}x${Math.round(th.h)}` : null,
      verHit: vh ? `${Math.round(vh.w)}x${Math.round(vh.h)}` : null,
      minHit: Math.min(th?.h ?? 0, vh?.h ?? 0),
      stolen: [...new Set(stolen)],
      pageOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    };
  });
  check('좁은 헤더 344px: 앱 이름이 한 줄로 서고 버전 배지가 **같은 줄**에 붙는다',
    header.titleLines === 1 && Math.abs(header.titleTop - header.verTop) <= 12, JSON.stringify(header));
  check('좁은 헤더 344px: 이메일이 잘리지 않는다(전폭 한 줄이므로 자를 이유가 없다)',
    header.emailClipped === false, JSON.stringify(header));
  check('좁은 헤더 344px: 제목·배지의 터치 표적 44px, 그리고 **아무것도 덮지 않는다**',
    header.minHit >= 44 && header.stolen.length === 0, JSON.stringify(header));
  check('좁은 헤더 344px: 가로로 넘치지 않는다', header.pageOverflow === 0, String(header.pageOverflow));
}

// ── 🔴 터치 표적 **전수 검사** (2026-08-15 · T-041) ─────────────────────────────────
//    지금까지 이 저장소는 표적 미달을 **한 자리씩** 고쳤다(`.chip-x` → `.chip-clear` →
//    헤더 둘 → 닫기 셋). 그때마다 사용자가 먼저 발견했다는 뜻이기도 하다. 그래서 이제
//    **화면에 있는 조작 요소를 전부 훑어** 미달을 이름과 함께 잡는다 — 다음 버튼은
//    사람이 기억하지 않아도 걸린다(§7 3층).
//
//    🔴 **오탐을 두 가지 걷어낸다.** ①부모가 클릭을 받는 자식(`.sync-note-go`는 클릭이
//    부모 줄로 가고 그 줄이 44px이다) ②`::after`로 넓힌 히트 영역(보이는 상자만 재면
//    고쳐 놓은 것을 결함이라 부른다). 오탐이 많은 게이트는 사람이 무시해서 죽는다(§11 ③).
//
//    **예외 목록은 이 파일 위쪽 `TOUCH_TARGET_EXCEPTIONS` 한 곳에 있다**(§2 — 손편집 중복
//    자체가 결함이다). `coverSweep`이 화면마다 같은 목록을 쓰므로 두 벌을 두면 갈라진다.
await page.setViewportSize({ width: 344, height: 820 });
await page.goto(`http://localhost:4173${BASE}`);
await page.waitForFunction(() => (document.getElementById('app')?.innerText ?? '').trim().length > 0, { timeout: 15000 });
// T-043 — 홈은 표적만 재고 **넘침·갈라짐은 안 재고 있었다.** 같은 잣대를 여기에도 댄다(§7).
await coverSweep('홈(여행 카드 있음)', null);
const targetSweep = await page.evaluate((exceptions) => {
  const vis = (n) => n.getClientRects().length > 0 && getComputedStyle(n).visibility !== 'hidden';
  const hit = (n) => {
    const r = n.getBoundingClientRect();
    const a = getComputedStyle(n, '::after');
    const g = (v) => Math.abs(parseFloat(v) || 0);
    const has = a.content !== 'none' && a.position === 'absolute';
    return { w: r.width + (has ? g(a.left) + g(a.right) : 0), h: r.height + (has ? g(a.top) + g(a.bottom) : 0) };
  };
  const all = [...document.querySelectorAll('button, a[href], [role="button"]')].filter(vis);
  const small = [];
  for (const b of all) {
    const cls = typeof b.className === 'string' ? b.className : '';
    if (exceptions.some((e) => cls.split(/\s+/).includes(e))) continue;
    const anc = b.parentElement?.closest('.is-actionable, button, a[href], [role="button"]');
    if (anc) { const ah = hit(anc); if (Math.min(ah.w, ah.h) >= 44) continue; } // 부모가 표적이다
    const { w, h } = hit(b);
    if (Math.min(w, h) < 44) small.push(`${cls.split(/\s+/)[0] || b.tagName}(${Math.round(w)}x${Math.round(h)})`);
  }
  return { total: all.length, small: [...new Set(small)] };
}, TOUCH_TARGET_EXCEPTIONS);
check('터치 표적 전수(344px 홈): 모집단을 확보했다 — 0개면 아무것도 안 본 것이다',
  targetSweep.total >= 8, JSON.stringify({ total: targetSweep.total }));
check('터치 표적 전수(344px 홈): 44px 미달이 없다(예외는 이유와 함께 코드에 등록)',
  targetSweep.small.length === 0, JSON.stringify(targetSweep));

check('콘솔 에러 0', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();
const fails = results.filter((r) => !r.ok);
console.log(`\n${results.length - fails.length}/${results.length} PASS`);
process.exit(fails.length ? 1 : 0);
