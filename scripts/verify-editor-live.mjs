// scripts/verify-editor-live.mjs — 사진 편집기 라이브 렌더 검증(선택 게이트, 브라우저 필요).
// dist를 /Travel-Memories/ 경로로 서빙하고 실제 Chromium으로 편집기 전체 흐름을 확인한다:
// 열기 → 값 표시 → 프리셋 → 슬라이더(픽셀 read-back) → 원본 비교 홀드 → 실행취소 →
// 브러시 표시 → Esc confirm → 배치 2장 → 저장 → 뷰어 탐색. 콘솔 에러 0까지 확인.
// 사용: npm run build && node scripts/verify-editor-live.mjs
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

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
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
// 카테고리별 게이트 카드 개수 합 = 배지의 개수(손 나열이 아니라 REGISTRY 파생) + 라이브 렌더 1
const mcBadgeN = parseInt((mcBadge ?? '').match(/(\d+)가지/)?.[1] ?? '0', 10);
const mcGates = await page.locator('.mc-gate').count();
check('기계화 검증 흐름도: 카드 개수 = 게이트 수 + 라이브 1', mcGates === mcBadgeN + 1, `cards=${mcGates}, badge=${mcBadgeN}`);
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
await page.locator('.photo-thumb').last().click();
await page.waitForSelector('.photo-viewer');
await page.waitForTimeout(300);
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

// ── v0.53: 넓은 화면(태블릿 가로·데스크톱) 레이아웃 ──
// 문제였던 것: 본문이 780px 고정이라 2000px대 태블릿에서 가운데만 쓰고 양옆이 비었다.
// 계약: ①어느 폭에서도 가로 넘침 0 ②1100px 이상에서 [기록 폼 | 타임라인] 2단 ③그 미만은 세로.
async function layoutAt(w, h) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(220);
  return page.evaluate(() => {
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
