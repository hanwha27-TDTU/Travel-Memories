// scripts/verify-editor-live.mjs — 사진 편집기 라이브 렌더 검증(선택 게이트, 브라우저 필요).
// dist를 /Travel-Memories/ 경로로 서빙하고 실제 Chromium으로 편집기 전체 흐름을 확인한다:
// 열기 → 값 표시 → 프리셋 → 슬라이더(픽셀 read-back) → 원본 비교 홀드 → 실행취소 →
// 브러시 표시 → Esc confirm → 배치 2장 → 저장 → 뷰어 탐색. 콘솔 에러 0까지 확인.
// 사용: npm run build && node scripts/verify-editor-live.mjs
//
// @live-covers: screens/home.ts, screens/tripDetail.ts, screens/mapView.ts, screens/dataManager.ts,
// @live-covers: screens/guide.ts, screens/mechChecks.ts, screens/designOverview.ts
// ↑ `check-live-coverage`가 읽는다. **여기 적은 화면은 이 스크립트가 실제로 연다** — 선언과
//   실제가 어긋나면 게이트는 못 잡는다(정직한 한계). 화면을 더 열면 여기도 늘려라.
// (Playwright는 devDependency가 아니므로 전역 설치본을 폴백으로 찾는다.)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// 브라우저를 **띄우지 못하는 것**은 앱의 결함이 아니라 전제 미충족이다(브라우저 바이너리
// 없음·판 불일치·샌드박스 제약). harness가 SKIP과 FAIL을 가르므로 여기서 그 신호를 정확히
// 준다 — 크래시로 죽으면 harness는 이걸 "위반을 찾음(FAIL)"으로 읽고, 그건 **오탐**이다(§2-B ③).
let browser;
try {
  browser = await chromium.launch();
} catch (e) {
  console.error(
    `verify-editor-live: 브라우저를 띄우지 못했습니다 — ${String(e).split('\n')[0]}\n` +
      '  → 이 실행은 라이브 층을 재지 않았습니다(통과가 아닙니다). `npx playwright install chromium` 후 재실행.',
  );
  server.close();
  process.exit(2);
}
const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
// 📍 「내 위치」를 **실제로 눌러** 재려면 브라우저가 위치를 줘야 한다(§13 4항 — 라벨만 읽는
// 것과 눌러 보는 것은 다른 층이다). 실제 GPS는 이 환경에 없으므로 **결정적인 가짜 위치**를
// 넣는다. 재는 대상은 위성이 아니라 **배선**이다: 눌렀을 때 좌표가 필드에 들어가는가,
// 정확도가 배지 문장이 되는가, 실패 사유가 화면에 나오는가, 버튼이 잠긴 채 남지 않는가.
await page.context().grantPermissions(['geolocation'], { origin: 'http://localhost:4173' });
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
await page.route('**://tile.openstreetmap.org/**', (route) => {
  const m = /\/(\d+)\/\d+\/\d+\.png/.exec(route.request().url());
  if (m) tileZooms.push(Number(m[1]));
  return route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1X1 });
});
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(`http://localhost:4173${BASE}`);

// v0.43: 홈 목록에서 여행 삭제(확인 → 카드 제거) + 실행취소 복원
await page.getByLabel('여행 제목').fill('삭제 테스트 여행');
await page.getByRole('button', { name: '+ 새 여행' }).click();
await page.waitForTimeout(500);
const delN0 = await page.locator('.trip-card').count();
page.once('dialog', (d) => d.accept()); // 삭제 확인 창 수락
await page.locator('.trip-delete').first().click();
await page.waitForTimeout(500);
const delN1 = await page.locator('.trip-card').count();
check('홈 목록 삭제(확인) → 카드 제거', delN1 === delN0 - 1, `${delN0}→${delN1}`);
await page.locator('.undo-toast .undo-btn').click();
await page.waitForTimeout(600);
const delN2 = await page.locator('.trip-card').count();
check('삭제 실행취소 → 여행 복원', delN2 === delN0, `${delN1}→${delN2}`);
page.once('dialog', (d) => d.accept()); // 정리: 테스트 여행 다시 삭제(본 흐름과 분리)
await page.locator('.trip-delete').first().click();
await page.waitForTimeout(500);

await page.getByLabel('여행 제목').fill('편집기 검증 여행');
await page.getByRole('button', { name: '+ 새 여행' }).click();
await page.waitForTimeout(400);

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
await page.waitForTimeout(250);
while ((await page.locator('.guide-overlay').count()) > 0) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
}

// v0.49: 환율 기준통화 설정 — 데이터 관리 → 카드 → 통화 선택기(UZS 포함) 렌더·저장
await page.locator('.data-open').click();
await page.waitForSelector('.guide-overlay');
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
await page.waitForTimeout(150);
const fxSaved = await page.evaluate(() => localStorage.getItem('bj.fxBase'));
check('환율 설정: 선택이 실제로 저장됨(read-back)', fxSaved === 'USD', String(fxSaved));
await page.selectOption('.dm-row select', 'KRW'); // 이후 테스트 영향 없도록 원복
await page.waitForTimeout(150);
await page.keyboard.press('Escape');
await page.waitForTimeout(250);
while ((await page.locator('.guide-overlay').count()) > 0) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
}

// v1.60: canonical 최종본은 일반 병합과 다른 위험 작업 — 경고와 2단계 확인까지만 누른다.
// 실제 두 번째 버튼은 클라우드 전체 교체이므로 라이브 픽스처에서 실행하지 않는다.
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
await page.waitForTimeout(250);
while ((await page.locator('.guide-overlay').count()) > 0) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
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
await page.waitForTimeout(250);
while ((await page.locator('.guide-overlay').count()) > 0) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
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
await page.waitForTimeout(250);
while ((await page.locator('.guide-overlay').count()) > 0) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
}

await page.getByLabel('편집기 검증 여행 여행 열기').first().click();
await page.waitForSelector('.moment-photo-input', { state: 'attached' });

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
  await page.waitForTimeout(250);
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
await page.waitForTimeout(200);

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
await page.waitForTimeout(300);
const valAfter = await page.$eval('.pe-slider-val', (e) => e.textContent);
check('밝기 조작 → 값 "+40" 표시', valAfter === '+40', valAfter);
const origAfter = await page.$eval('.pe-presets .pe-chip', (b) => b.getAttribute('aria-pressed'));
check('수동 조정 → 프리셋 해제', origAfter === 'false');
const after = await page.$eval('.pe-canvas', (c) => c.getContext('2d').getImageData(0, 0, 1, 1).data.join(','));
check('미리보기 픽셀 실제 변화', before !== after, `${before} → ${after}`);

// 원본 비교(누르는 동안 보정 전) — pointerdown → 픽셀이 원래대로
await page.locator('.pe-compare').dispatchEvent('pointerdown', { pointerId: 1 });
await page.waitForTimeout(120);
const cmp = await page.$eval('.pe-canvas', (c) => c.getContext('2d').getImageData(0, 0, 1, 1).data.join(','));
check('원본 비교(홀드) → 보정 전 픽셀', cmp === before, `${cmp} vs ${before}`);
await page.locator('.pe-compare').dispatchEvent('pointerup', { pointerId: 1 });
await page.waitForTimeout(300);
const back = await page.$eval('.pe-canvas', (c) => c.getContext('2d').getImageData(0, 0, 1, 1).data.join(','));
check('비교 해제 → 보정 복귀', back === after);

// 전역 실행취소: 슬라이더 드래그 1회 = undo 1단계 → 값·픽셀이 원복
const undoEnabled = await page.$eval('.pe-undo', (b) => !b.disabled);
check('실행취소 버튼 활성(조작 후)', undoEnabled);
await page.locator('.pe-undo').click();
await page.waitForTimeout(300);
const valUndo = await page.$eval('.pe-slider-val', (e) => e.textContent);
const pxUndo = await page.$eval('.pe-canvas', (c) => c.getContext('2d').getImageData(0, 0, 1, 1).data.join(','));
check('실행취소 → 밝기 0·픽셀 원복', valUndo === '0' && pxUndo === before, `val=${valUndo}`);
const undoDisabled = await page.$eval('.pe-undo', (b) => b.disabled);
check('이력 소진 → 실행취소 비활성', undoDisabled);
// 검증 후 다시 밝기 +40(이후 단계는 편집 존재를 전제)
await bright.evaluate((i) => { i.value = '0.4'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); });
await page.waitForTimeout(300);

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
await page.waitForTimeout(200);
const stillOpen = (await page.locator('.pe-overlay').count()) === 1;
check('편집 중 Esc → 확인 창 + 취소 시 유지', dialogSeen !== null && stillOpen, String(dialogSeen));

// 적용 → 두 번째 사진 편집기 → 남은 1장이므로 스킵올 없음 → 원본 사용
await page.getByRole('button', { name: '적용', exact: true }).click();
await page.waitForFunction(() => /2\/2/.test(document.querySelector('.pe-file')?.textContent ?? ''), null, { timeout: 20000 });
check('2번째 사진으로 진행(적용 후)', true);
await page.getByRole('button', { name: '원본 사용', exact: true }).click();

// 저장 완료 → 썸네일 2장
await page.waitForSelector('.pe-overlay', { state: 'detached' });
await page.waitForFunction(() => document.querySelectorAll('.moment-photo-grid img, .photo-grid img, img[alt="여행 사진"], .thumb img').length >= 0);
await page.waitForTimeout(1200);
const thumbs = await page.evaluate(() => document.querySelectorAll('img').length);
check('저장 후 썸네일 렌더(이미지 ≥2)', thumbs >= 2, `imgs=${thumbs}`);

// 뷰어: 사진 탭 → 닫히지 않음, ◀▶·방향키 넘기기, Esc → 닫힘
const firstThumb = page.locator('.photo-thumb').first();
await firstThumb.click();
await page.waitForSelector('.photo-viewer');
await page.locator('.photo-viewer img').click();
await page.waitForTimeout(150);
check('뷰어: 사진 탭해도 유지', (await page.locator('.photo-viewer').count()) === 1);
const counterInit = await page.$eval('.photo-viewer-count', (e) => e.textContent);
check('뷰어: 위치 카운터(1 / 2)', counterInit === '1 / 2', counterInit);
await page.locator('.photo-viewer-next').click();
await page.waitForTimeout(150);
const counterNext = await page.$eval('.photo-viewer-count', (e) => e.textContent);
check('뷰어: ▶ 다음 사진(2 / 2)', counterNext === '2 / 2', counterNext);
await page.keyboard.press('ArrowRight'); // 순환 → 1/2
await page.waitForTimeout(150);
const counterWrap = await page.$eval('.photo-viewer-count', (e) => e.textContent);
check('뷰어: 방향키 + 끝에서 순환(1 / 2)', counterWrap === '1 / 2', counterWrap);
check('뷰어: 넘겨도 열림 유지', (await page.locator('.photo-viewer').count()) === 1);

// v0.40: 뷰어 확대(휠) → is-zoomed + transform scale 상승, '0' 키로 원복
const vbox = await page.locator('.photo-viewer img').boundingBox();
await page.mouse.move(vbox.x + vbox.width / 2, vbox.y + vbox.height / 2);
await page.mouse.wheel(0, -400);
await page.waitForTimeout(150);
const zoomedCls = await page.$eval('.photo-viewer img', (i) => i.classList.contains('is-zoomed'));
const zoomedScale = await page.$eval('.photo-viewer img', (i) => {
  const m = /scale\(([\d.]+)\)/.exec(i.style.transform);
  return m ? parseFloat(m[1]) : 1;
});
check('뷰어: 휠 확대 → 배율 상승·is-zoomed', zoomedCls && zoomedScale > 1.05, `scale=${zoomedScale}`);
await page.keyboard.press('0');
await page.waitForTimeout(150);
const resetScale = await page.$eval('.photo-viewer img', (i) => {
  const m = /scale\(([\d.]+)\)/.exec(i.style.transform);
  return m ? parseFloat(m[1]) : 1;
});
check("뷰어: '0' 키 → 확대 원복(1x)", resetScale === 1, `scale=${resetScale}`);

await page.keyboard.press('Escape');
await page.waitForTimeout(150);
check('뷰어: Esc로 닫힘', (await page.locator('.photo-viewer').count()) === 0);

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
await page.waitForTimeout(500);
const clip = await page.evaluate(() => {
  const st = document.querySelector('.pe-stage');
  const cv = document.querySelector('.pe-canvas');
  return { st: st.clientHeight, cv: cv.clientHeight };
});
check('세로 사진: 스테이지 무압착(캔버스 온전 표시)', clip.st >= clip.cv - 1, JSON.stringify(clip));

// Ctrl+휠 확대(실입력: Control 키 + 휠) → 줌 슬라이더 값 상승
const zoomBefore = parseFloat(await page.$eval('.pe-zoom', (i) => i.value));
const cbox = await page.locator('.pe-canvas').boundingBox();
await page.mouse.move(cbox.x + cbox.width / 2, cbox.y + cbox.height / 2);
await page.keyboard.down('Control');
await page.mouse.wheel(0, -300);
await page.keyboard.up('Control');
await page.waitForTimeout(600);
const zoomAfterWheel = parseFloat(await page.$eval('.pe-zoom', (i) => i.value));
check('Ctrl+휠 → 미리보기 확대(줌 상승)', zoomAfterWheel > zoomBefore, `${zoomBefore} → ${zoomAfterWheel}`);

// 핀치 줌(두 손가락, 합성 포인터) → 줌 추가 상승
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
await page.waitForTimeout(500);
const zoomAfterPinch = parseFloat(await page.$eval('.pe-zoom', (i) => i.value));
check('핀치(두 손가락 벌리기) → 확대', zoomAfterPinch > zoomAfterWheel, `${zoomAfterWheel} → ${zoomAfterPinch}`);

// ── v0.39: 원근 펴기(4점) — 모드 진입 → 핸들 드래그 → 적용 → 픽셀 변화 → undo 원복 ──
const pxPrePersp = await page.$eval('.pe-canvas', (c) => c.getContext('2d').getImageData(1, 1, 1, 1).data.join(','));
await page.getByRole('button', { name: '📐 펴기' }).click();
await page.waitForTimeout(400);
const quadShown = await page.evaluate(() => {
  const box = document.querySelector('.pe-quad-box');
  return box && !box.hidden && document.querySelectorAll('.pe-quad-h').length === 4;
});
check('펴기 모드: 4점 오버레이 표시', !!quadShown);
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
await page.waitForTimeout(200);
const polyAfter = await page.$eval('.pe-quad-svg polygon', (p) => p.getAttribute('points'));
check('펴기: 핸들 드래그 → 사다리꼴 갱신', polyBefore !== polyAfter, `${polyBefore} → ${polyAfter}`);
await page.getByRole('button', { name: '📐 반듯하게 펴기' }).click();
await page.waitForTimeout(600);
const quadGone = await page.$eval('.pe-quad-box', (b) => b.hidden);
const pxPersp = await page.$eval('.pe-canvas', (c) => c.getContext('2d').getImageData(1, 1, 1, 1).data.join(','));
check('펴기 적용: 오버레이 종료 + 픽셀 실제 변화', quadGone && pxPersp !== pxPrePersp, `${pxPrePersp} → ${pxPersp}`);
await page.locator('.pe-undo').click();
await page.waitForTimeout(600);
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
await page.waitForTimeout(600);
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
await page.waitForTimeout(200);
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
await page.locator('.pick-clear-all').click().catch(() => {});
await page.waitForTimeout(200);
await page.setInputFiles('.moment-photo-input', [
  { name: 'gps.jpg', mimeType: 'image/jpeg', buffer: withExifGps(imgBuf, '2026:07:16 09:30:00', 16.0544, 108.2022) },
]);
await page.waitForTimeout(700);
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
await page.setInputFiles('.moment-photo-input', [
  { name: 'gps2.jpg', mimeType: 'image/jpeg', buffer: withExifGps(imgBuf, '2026:07:16 10:00:00', 21.0278, 105.8342) },
]);
await page.waitForTimeout(600);
const keptPlace = await page.evaluate(() => document.querySelector('.place-input')?.value ?? '');
check('사진 장소: 사용자가 적은 이름을 사진이 덮지 않는다(앱이 사용자를 이기지 않는다)', keptPlace === '내가 적은 장소', keptPlace);

// 🔴 배지의 ✕로 **좌표까지** 해제한다. 이름만 지우면 좌표는 남는데(사진 좌표는 이름과
// 독립이라 그게 맞다) 그러면 「이미 손댔다」로 판정돼 제안이 안 돈다 — 실제 사용자 경로는 ✕다.
await page.fill('.place-input', '');
await page.locator('.moment-form .place-picked .chip-clear').first().click(); // 생성 폼의 것(편집 폼들과 구분)
await page.waitForTimeout(200);

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
await page.waitForTimeout(600);
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
await page.waitForTimeout(300);
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
await page.waitForTimeout(700);
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
  hereApplied.badge.includes('지금 내 위치'),
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
await page.waitForTimeout(150);
await page.evaluate(() => {
  const g = navigator.geolocation;
  window.__realGetPos = g.getCurrentPosition.bind(g);
  g.getCurrentPosition = (_ok, err) => err && err({ code: 1, message: 'denied' });
});
await page.locator('.moment-form .place-here').click();
await page.waitForTimeout(400);
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
await page.waitForTimeout(600);
const timeOnly = await page.evaluate(() => document.querySelector('.place-photo-note')?.textContent ?? '');

// ── 🔬 **앱이 받은 바이트를 앱이 말하는가** (2026-08-01 · M-0066 · §12) ──────────
// 나흘 동안 사용자가 스크린샷을 날랐고 나는 추측했다. 앱은 그 바이트를 손에 쥐고도
// 아무 말을 안 했다. 이 상자가 그 자리를 메운다 — **좌표를 못 얻었을 때만** 나온다.
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
await page.waitForTimeout(900);
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

// ── 💰 비용 메모: 모델에 있던 note를 화면이 부르는가 ──
const noteField = await page.evaluate(() => {
  const i = document.querySelector('[data-expense-note]');
  return { exists: !!i, visible: !!i && i.getBoundingClientRect().height > 0, ph: i?.placeholder ?? '' };
});
check('비용 메모: 칸이 **펼쳐진 채로** 있다(선택이지만 숨기지 않는다)', noteField.exists && noteField.visible, JSON.stringify(noteField));
check('비용 메모: 무엇을 적는 자리인지 말한다', noteField.ph.includes('무엇에'), noteField.ph);

await page.locator('.pick-clear-all').click().catch(() => {});
await page.waitForTimeout(200);
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
  await page.waitForTimeout(150);
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
await page.waitForTimeout(1200);
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
await page.waitForTimeout(900);
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
await page.waitForTimeout(700);
const afterApply = await page.evaluate(() => ({
  notice: document.querySelectorAll('.zone-notice').length,
  suggest: document.querySelectorAll('.zone-suggest:not([hidden])').length,
  hint: document.querySelector('.when-clock')?.textContent ?? '',
}));
check('시간대 제안: 누르면 **실제로 적용된다**(미지정 고지가 사라진다)', afterApply.notice === 0, JSON.stringify(afterApply));
check('시간대 제안: 적용 후 제안도 사라진다(할 일이 끝나면 조용해진다 — §8)', afterApply.suggest === 0, JSON.stringify(afterApply));
check('시간대 제안: 입력 칸이 **그 시간대로** 적는다고 말한다', afterApply.hint.includes('인도차이나'), afterApply.hint);

// §3-C 되돌리기 — 이 클릭은 **여행을 실제로 고쳤다.** 원래대로 돌려놓는다.
await page.unroute('**/reverse**');
await page.locator('.hero-edit').first().click();
await page.waitForTimeout(300);
await page.selectOption('[data-zone-input]', '');
await page.waitForTimeout(150);
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
await page.waitForTimeout(1200);
const editCard = page.locator('.moment-card', { hasText: '편집 폼 장소 검증' }).first();
await editCard.locator('.icon-btn[aria-label="이 순간 편집"]').click();
await page.waitForTimeout(400);
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
  await page.waitForTimeout(500);
}
await page.waitForSelector('.undo-toast', { timeout: 30000 });
await page.waitForTimeout(400);
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
await page.waitForTimeout(1500);
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

// ── 🔴 v1.30: **위치 없는 사진**과 **이름 없는 좌표** (사용자 지적 2026-07-31 *"안되네요"*) ──
//
// 사용자가 사진을 넣었는데 장소가 비어 있었다. 원인이 둘 다 **침묵**이었다:
//  ① 사진에 GPS가 없으면 아무 말도 안 했다 → 고장인지 없는 건지 구분할 수 없다.
//  ② 좌표만 들어가고 이름이 없으면 칩을 안 그렸다 → **넣었는데 화면은 그대로**였다.
await page.fill('input[placeholder^="이 순간을"]', 'GPS 없는 사진 검증');
await page.getByRole('button', { name: '순간 저장' }).click();
await page.waitForTimeout(1200);
const noGpsCard = page.locator('.moment-card', { hasText: 'GPS 없는 사진 검증' }).first();
await noGpsCard.locator('.icon-btn[aria-label="이 순간 편집"]').click();
await page.waitForTimeout(300);
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
await page.waitForTimeout(200);
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
await page.waitForTimeout(150);

// ② 이름 없이 좌표만 들어간 순간도 **칩으로 보인다**(동의 없이 좌표만 넣은 경우가 그것이다).
await noGpsCard.locator('.icon-btn[aria-label="이 순간 편집"]').click();
await page.waitForTimeout(200);
await page.evaluate(() => localStorage.removeItem('bugeon:photoGeoOk')); // 동의 없는 상태 재현
await noGpsCard.locator('.icon-btn[aria-label="이 순간 편집"]').click();
await page.waitForTimeout(300);
await page.evaluate(() => document.querySelector('.undo-toast')?.remove());
await noGpsCard.locator('.moment-photo-input').setInputFiles([
  { name: 'coordonly.jpg', mimeType: 'image/jpeg', buffer: withExifGps(imgBuf, '2026:07:16 05:00:00', 37.5665, 126.978) },
]);
await page.waitForSelector('.pe-overlay', { timeout: 20000 });
await page.getByRole('button', { name: '적용', exact: true }).click();
await page.waitForSelector('.undo-toast', { timeout: 20000 });
await page.waitForTimeout(600);
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
await page.waitForTimeout(200);
await page.unroute('**/reverse**');
// §3-C — 편집 폼을 닫고 스크롤을 되돌린다(사진 2장은 이 순간에 실제로 붙었다 — 뒤 검사가
// 개수를 세지 않으므로 그대로 둔다. 세는 검사가 생기면 여기서 지워야 한다).
await editCard.locator('.icon-btn[aria-label="이 순간 편집"]').click();
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(300);

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
    await page.waitForTimeout(300);
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
await page.waitForTimeout(250);
const zonePick = await page.evaluate(() => document.querySelector('.zone-field .zone-preview')?.textContent ?? '');
check('시간대: 고르면 미리보기가 **다시 그려진다**', /UTC\+7/.test(zonePick), zonePick);

// §3-C 되돌리기 — 뒤 검사들이 보는 화면을 바꿔 놓지 않는다.
await page.selectOption('[data-zone-input]', '');
await page.waitForTimeout(150);
await page.locator('.hero-edit').first().click(); // 패널을 닫아 원래 상태로
await page.waitForTimeout(250);
const zoneRestored = await page.evaluate(() => {
  const t = document.querySelector('[data-zone-input]');
  return t instanceof HTMLSelectElement ? t.value : 'MISSING';
});
check('시간대: 되돌렸다(내 상태를 뒤 검사에 남기지 않는다 — §3-C)', zoneRestored === '', zoneRestored);
// 🔴 **스크롤도 상태다.** 이 블록이 `scrollIntoView`로 페이지를 내렸는데, 넓은 화면 2단 검사는
// `.detail-compose`(sticky)와 타임라인의 **top 차이**를 재므로 스크롤된 채로는 어긋난다.
// goto·fetch 스텁·뷰포트에 이어 **네 번째** 형태다 — 되돌릴 것의 목록은 내가 생각한 것보다 길다.
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(150);

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
await page.waitForTimeout(300);
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
await page.waitForTimeout(200);
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
await page.waitForTimeout(200);
const preview = await page.evaluate(() => document.querySelector('.zone-field .zone-preview')?.textContent ?? '');
check('시계: 고른 시간대를 **눈으로 확인**시킨다(id만 보고는 아무도 모른다 — §12)', /UTC\+7/.test(preview) && preview.includes('인도차이나'), preview);

await page.locator('.edit-panel .btn-primary', { hasText: '저장' }).first().click();
await page.waitForSelector('.tl-time', { timeout: 10000 });
await page.waitForTimeout(500);
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
await page.waitForTimeout(200);
await page.selectOption('[data-zone-input]', '');
await page.selectOption('[data-home-zone-input]', homeZoneBefore);
await page.waitForTimeout(150);
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
await page.waitForTimeout(150);
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
await page.waitForTimeout(250);
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
const afterEnd = await page.evaluate(async () => {
  const chip = document.querySelector('.chip.audio');
  const btn = chip.querySelector('.chip-audio-play');
  // 픽스처는 1.5초짜리 무음 WAV다. 넉넉히 기다려 자연 종료(ended)를 지난다.
  await new Promise((r) => setTimeout(r, 2600));
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
await seededChip.scrollIntoViewIfNeeded();
await page.waitForTimeout(150);
const chipIsButton = await seededChip.evaluate((c) => ({
  tag: c.tagName,
  tappable: c.classList.contains('chip-tap'),
  label: c.getAttribute('aria-label'),
}));
check(
  '🔴 위치 칩: 검사가 **자기가 심은 순간**의 칩을 집는다(첫 칩이 아니라 — 남의 상태를 내 것으로 읽지 않는다)',
  /김포/.test(chipIsButton?.label ?? ''),
  String(chipIsButton?.label),
);
check(
  '위치 칩: 누를 수 있는 버튼이다(span이면 아무 일도 안 일어난다)',
  chipIsButton?.tag === 'BUTTON' && chipIsButton.tappable === true,
  JSON.stringify(chipIsButton),
);
check('위치 칩: 무엇을 하는 버튼인지 이름이 있다(스크린리더)', /지도/.test(chipIsButton?.label ?? ''), String(chipIsButton?.label));

await seededChip.click();
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
await page.waitForTimeout(1200); // 타일 요청이 나갈 시간
const zoomSeen = { max: tileZooms.length ? Math.max(...tileZooms) : -1, n: tileZooms.length };
check(
  '지도: 타일을 실제로 요청했다(0건이면 아래 판정이 공허하다 — §4)',
  zoomSeen.n > 0,
  `타일 ${zoomSeen.n}건 · z=${[...new Set(tileZooms)].sort((a, b) => a - b).join(',')}`,
);
check(
  '🔴 지도: 지점이 하나면 그 지점까지 확대한다(옛 결함은 z=10에 머물렀다)',
  zoomSeen.max >= 15,
  `요청된 최대 z=${zoomSeen.max} (기대: ≥15 · 옛 결함값: 10)`,
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
await page.waitForTimeout(200);

// ── v0.53: 넓은 화면(태블릿 가로·데스크톱) 레이아웃 ──
// 문제였던 것: 본문이 780px 고정이라 2000px대 태블릿에서 가운데만 쓰고 양옆이 비었다.
// 계약: ①어느 폭에서도 가로 넘침 0 ②1100px 이상에서 [기록 폼 | 타임라인] 2단 ③그 미만은 세로.
async function layoutAt(w, h) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(220);
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

// ── v0.54: 상태 줄이 화면을 과하게 쓰지 않는지 ──
// 계약: 정상 상태(동기화됨)는 내용 폭만 차지한다 — 전폭 배너 금지.
await page.setViewportSize({ width: 1480, height: 920 });
await page.waitForTimeout(200);
// `.sync-note`는 홈과 여행 상세 **양쪽에** 있다 — 어디를 보고 있는지 명시하지 않으면
// 엉뚱한 줄을 검사한다(실제로 그렇게 짰다가 이 검사가 잡았다). 홈으로 돌아가서 본다.
await page.goto(`http://localhost:4173${BASE}`);
await page.waitForSelector('.sync-note', { timeout: 15000 }).catch(() => {});
const noteBox = await page.evaluate(() => {
  const n = document.querySelector('.sync-note');
  if (!n) return null;
  const r = n.getBoundingClientRect();
  return { w: Math.round(r.width), vw: window.innerWidth, cls: n.className };
});
check('상태 줄: 전폭 배너가 아님(내용 폭만)', !noteBox || noteBox.w < noteBox.vw * 0.5,
  noteBox ? `${noteBox.w}px / ${noteBox.vw}px` : 'none');

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
await page.waitForTimeout(1200);
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
await page.waitForTimeout(300);
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
await page.waitForTimeout(900);

// ── v0.69: 진단 도구가 **판정**을 하는가(정적 게이트가 못 보는 층) ──
// 계약(CLAUDE.md §8): ① 총괄 판정이 계산되어 '확인 중…'을 벗어난다 ② 정상 지표는 카드가 아니라
// 접힌 한 줄이다 ③ 이상 지표만 카드로 남는다 ④ 지표에 기대값('정상')이 화면에 실제로 보인다.
await page.setViewportSize({ width: 412, height: 915 });
await page.goto(`http://localhost:4173${BASE}`);
await page.waitForTimeout(400);
// [데이터 관리] → [진단 도구] 경로로 실제 사용자처럼 진입한다(번들을 직접 import하지 않는다 —
// 해시가 바뀌기도 하고, 무엇보다 사용자가 실제로 걷는 길을 걸어야 의미가 있다).
await page.getByRole('button', { name: /데이터 관리/ }).first().click().catch(() => {});
await page.waitForTimeout(400);
await page.locator('[data-card="진단 도구"], .guide-card:has-text("진단 도구")').first().click().catch(() => {});
await page.waitForTimeout(1200);

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
await page.waitForTimeout(1200);
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
await page.waitForTimeout(500);
// ── v0.97: 진단 요약이 **지표까지** 담는가(스크린샷 대신 붙여넣을 수 있는가) ────────
// 왜 이 층인가(2026-07-26 사용자 "수백 장은 찍은 거 같아"): 요약에 판정 한 줄만 있으면
// 복사해 봐야 숫자가 없어 결국 다시 사진을 찍게 된다. 실제로 만들어진 문자열을 본다.
await page.locator('[data-tool="진단 요약 복사"]').first().click();
await page.waitForTimeout(2000);
// 요약은 클립보드로만 나가고 화면엔 안 보인다 → 접힌 「원문 보기」를 펼쳐 실제 문자열을 읽는다.
// (복사가 막힌 브라우저에서 사용자가 쓰는 경로도 이것이라, 이 경로가 곧 사용자의 경로다.)
await page.evaluate(() => {
  for (const d of document.querySelectorAll('.vd-evidence')) {
    if ((d.querySelector('.vd-evidence-sum')?.textContent || '').includes('원문')) d.open = true;
  }
});
await page.waitForTimeout(1500);
const summaryTxt = await page.evaluate(() => document.querySelector('.vd-pre')?.textContent ?? '');
check('진단 요약: 지표의 「지금 / 정상」이 글로 들어간다(사진 대신 붙여넣기)',
  /지금 .{1,40} \/ 정상 /.test(summaryTxt), summaryTxt.slice(0, 140));
await page.locator('.guide-back').first().click().catch(() => {});
await page.waitForTimeout(500);

await page.locator('[data-tool="저장 상태 · 기기별 현황"]').first().click();
await page.waitForTimeout(900);
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
await page.waitForTimeout(700);
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
await page.waitForTimeout(700);
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
await page.waitForTimeout(400);
await page.getByRole('button', { name: /데이터 관리/ }).first().click().catch(() => {});
await page.waitForTimeout(400);
await page.locator('.guide-card:has-text("휴지통")').first().click().catch(() => {});
await page.waitForTimeout(600);
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
await page.waitForTimeout(200);
await page.locator('.dm-trash-row button:has-text("정말 지움")').first().click().catch(() => {});
await page.waitForTimeout(1000);
const trashNote = await page.evaluate(() => {
  const n = document.querySelector('.guide-overlay .sync-note');
  if (!n || n.hidden) return null;
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
await page.waitForTimeout(400);
await page.getByRole('button', { name: /앱 정보|정보/ }).first().click().catch(() => {});
await page.waitForTimeout(600);
const aboutTxt = await page.evaluate(() => document.querySelector('.guide-modal, .about-modal, body')?.textContent ?? '');
check('변경 이력: 화면에 마크다운 별표가 안 보인다', !aboutTxt.includes('**'),
  aboutTxt.includes('**') ? `노출: ${aboutTxt.slice(aboutTxt.indexOf('**') - 20, aboutTxt.indexOf('**') + 40)}` : 'clean');

// ── v0.73: 선택한 것은 해제할 수 있는가(§7 사용자 대면 대칭) ──
// 사용자 지적(2026-07-26): "선택한 사진을 해제하는 기능이 없네요." 저장된 사진에는 ✕가 있는데
// 저장 전 선택분에만 없어서, 같은 화면 안에서 어휘가 갈렸다. 형제 감사에서 장소(지도 지정)도
// 같은 결함이 드러났다 — 좌표를 찍고 나면 되돌릴 길이 없었다.
await page.setViewportSize({ width: 412, height: 915 });
await page.goto(`http://localhost:4173${BASE}`);
await page.waitForTimeout(500);
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
await page.waitForTimeout(400);
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
await page.waitForTimeout(500);
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
await page.waitForTimeout(400);
const kept = await page.evaluate(() => document.querySelector('.when-input')?.value ?? '');
check('발생 시각: 사용자가 고친 값을 추측이 덮지 않는다', kept === '2026-07-16T09:30', kept);
await page.setInputFiles('.moment-photo-input', [
  { name: 'p1.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(imgBuf) },
  { name: 'p2.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(imgBuf) },
  { name: 'p3.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(imgBuf) },
]);
await page.waitForTimeout(400);

await page.locator('.pick-x').first().click();
await page.waitForTimeout(300);
const pick1 = await page.evaluate(() => ({
  cells: document.querySelectorAll('.pick-cell').length,
  files: document.querySelector('.moment-photo-input')?.files?.length ?? -1,
  count: document.querySelector('.moment-photo-count')?.textContent ?? '',
}));
check('사진 선택: ✕ 하나로 한 장만 해제(실제 FileList까지)', pick1.cells === 2 && pick1.files === 2 && pick1.count.includes('2장'), JSON.stringify(pick1));

await page.locator('.pick-clear-all').click();
await page.waitForTimeout(300);
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
    if (url.includes('nominatim.openstreetmap.org')) {
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
    if (url.includes('nominatim.openstreetmap.org')) {
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
await page.waitForTimeout(200);
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
    if (url.includes('nominatim.openstreetmap.org')) {
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
await page.waitForTimeout(200);
const afterPick = await page.evaluate(() => {
  const hint = document.querySelector('.place-picked-hint');
  return {
    badge: document.querySelector('.place-picked-text')?.textContent ?? '',
    hintHidden: hint?.hidden ?? null,
    hint: hint?.textContent ?? '',
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
});
check('장소 선택: 배지가 위치 지정을 확인해 준다', afterPick.badge.includes('위치 지정됨'), afterPick.badge);
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
await page.waitForTimeout(200);
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
await page.waitForTimeout(200);
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
check('좌표 붙여넣기: 배지가 위치 지정을 확인해 준다', coordSeen.badge.includes('지정'), coordSeen.badge);
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
await page.waitForTimeout(200);
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
    if (url.includes('nominatim.openstreetmap.org')) {
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
  const real = window.fetch;
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('nominatim.openstreetmap.org/reverse')) {
      return Promise.resolve(new Response(JSON.stringify(one), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    }
    if (url.includes('nominatim.openstreetmap.org')) {
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
  '역지오코딩: 배지가 전체 주소를 보여 준다(어디인지 확인할 수 있게)',
  revBadge.includes('종로구'),
  revBadge,
);

// 🔴 사용자가 이미 이름을 적었으면 **덮어쓰지 않는다**(앱이 사용자를 이기지 않는다).
await page.evaluate(() => {
  const inp = document.querySelector('.place-input');
  if (inp) inp.value = '';
});
await page.fill('.place-input', '37.5796, 126.9770');
await page.locator('.place-search').first().click();
await page.waitForTimeout(50);
await page.fill('.place-input', '내가 적은 이름'); // 역지오코딩이 돌아오기 전에 사용자가 적는다
await page.waitForTimeout(800);
const keptName = await page.evaluate(() => document.querySelector('.place-input')?.value ?? '');
check(
  '🔴 역지오코딩: 사용자가 그 사이에 적었으면 **덮지 않는다**',
  keptName === '내가 적은 이름',
  keptName,
);

// ── v0.89: 플랫폼 지도(무엇이 어디서 도나) — **생성물이 실제로 그려지는가** ──────────
// 정적 게이트는 platformMap.gen.ts가 코드와 맞는지만 본다. 그게 **화면에 실제로 나오는지**는
// 렌더해야만 안다 — 생성은 됐는데 카드가 안 열리면 사용자에겐 없는 기능이다.
await page.evaluate(() => {
  document.querySelectorAll('.overlay-base').forEach((o) => o.remove());
});
await page.goto(`http://localhost:4173${BASE}`);
await page.evaluate(() => document.querySelector('.data-open')?.click());
await page.waitForTimeout(200);
await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.guide-card')];
  cards.find((c) => c.textContent?.includes('가이드'))?.click();
});
await page.waitForTimeout(300);
await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.guide-card')];
  cards.find((c) => c.textContent?.includes('무엇이 어디서 도나'))?.click();
});
await page.waitForTimeout(300);

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
  await page.waitForTimeout(600);

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
  await page.waitForTimeout(900);
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
  await swPage.waitForTimeout(700);
  served.length = 0; // 서버가 내준 파일 기록을 비우고 정상 상태만 잰다
  await swPage.reload({ waitUntil: 'networkidle' });
  await swPage.waitForTimeout(700);
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
  await offPage.goto(offUrl, { waitUntil: 'networkidle' }); // 워커 설치
  await offPage.evaluate(() => navigator.serviceWorker.ready);
  await offPage.reload({ waitUntil: 'networkidle' }); // 두 번째 방문에서 캐시가 채워진다
  await offPage.waitForTimeout(800);

  await new Promise((r) => offServer.close(r)); // ← 여기서부터 진짜로 아무 데도 못 간다
  offLog.length = 0;

  const coldPage = await offCtx.newPage(); // 새 탭 — 워커·Cache Storage만 공유
  let offlineTitle = '';
  try {
    await coldPage.goto(offUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await coldPage.waitForTimeout(1500);
    offlineTitle = await coldPage.evaluate(() => document.querySelector('.app-title')?.textContent ?? '');
  } catch (e) {
    offlineTitle = `(로드 실패: ${String(e).slice(0, 60)})`;
  }
  check('서비스워커: 네트워크가 끊겨도 앱 껍데기가 뜬다', offlineTitle.includes('Bugeon'), offlineTitle || '(빈 화면)');
  check('서비스워커: 오프라인 검사가 진짜 오프라인이었다', offLog.length === 0, `서버가 받은 요청 ${offLog.length}건`);
  await offCtx.close();
  await swCtx.close();
}

// ── v1.02: 계정 영역이 **제목 줄 오른쪽**에 오는가(사용자 요청 2026-07-26) ──────────
// 왜 이 층인가: 배치는 CSS flex와 내용 폭이 함께 정한다 — 타입도 유닛도 못 본다.
// 넓은 화면에서 같은 줄인지, 오른쪽에 붙는지, 넘치지 않는지를 **실측**한다.
await page.setViewportSize({ width: 900, height: 900 });
await page.goto(`http://localhost:4173${BASE}`);
await page.waitForTimeout(800);
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
await page.waitForTimeout(300);
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

check('콘솔 에러 0', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();
const fails = results.filter((r) => !r.ok);
console.log(`\n${results.length - fails.length}/${results.length} PASS`);
process.exit(fails.length ? 1 : 0);
