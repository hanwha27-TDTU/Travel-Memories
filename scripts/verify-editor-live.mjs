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
await page.getByLabel('여행 제목').fill('편집기 검증 여행');
await page.getByRole('button', { name: '+ 새 여행' }).click();
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
await page.getByRole('button', { name: '원본 사용', exact: true }).click();
await page.waitForSelector('.pe-overlay', { state: 'detached' });

check('콘솔 에러 0', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();
const fails = results.filter((r) => !r.ok);
console.log(`\n${results.length - fails.length}/${results.length} PASS`);
process.exit(fails.length ? 1 : 0);
