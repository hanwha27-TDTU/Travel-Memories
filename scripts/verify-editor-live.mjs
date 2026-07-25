// scripts/verify-editor-live.mjs — 사진 편집기 라이브 렌더 검증(선택 게이트, 브라우저 필요).
// dist를 /Travel-Memories/ 경로로 서빙하고 실제 Chromium으로 편집기 전체 흐름을 확인한다:
// 열기 → 값 표시 → 프리셋 → 슬라이더(픽셀 read-back) → 원본 비교 홀드 → 실행취소 →
// 브러시 표시 → Esc confirm → 배치 2장 → 저장 → 뷰어 탐색. 콘솔 에러 0까지 확인.
// 사용: npm run build && node scripts/verify-editor-live.mjs
// (Playwright는 devDependency가 아니므로 전역 설치본을 폴백으로 찾는다.)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
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
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.map': 'application/json' };

const server = createServer(async (req, res) => {
  let p = new URL(req.url, 'http://x').pathname;
  if (!p.startsWith(BASE)) { res.writeHead(404).end(); return; }
  p = p.slice(BASE.length) || 'index.html';
  try {
    const buf = await readFile(join(DIST, p));
    res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' }).end(buf);
  } catch {
    const buf = await readFile(join(DIST, 'index.html'));
    res.writeHead(200, { 'content-type': 'text/html' }).end(buf);
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

check('콘솔 에러 0', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();
const fails = results.filter((r) => !r.ok);
console.log(`\n${results.length - fails.length}/${results.length} PASS`);
process.exit(fails.length ? 1 : 0);
