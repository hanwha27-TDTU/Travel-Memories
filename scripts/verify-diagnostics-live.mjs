// scripts/verify-diagnostics-live.mjs — **진단 화면의 라이브 렌더 검증**(선택 게이트, 브라우저 필요).
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 이 게이트가 생겼나 (2026-07-28, M-0046)
// ─────────────────────────────────────────────────────────────────────────────
// 소리 서버 동기화를 배포한 지 **30분 만에** 사용자가 실기기 스크린샷으로 결함을 잡았다.
// 그때 통과하고 있던 것들: 게이트 31종 · 유닛 686건 · 라이브 165건. **전부 초록이었다.**
//
// 왜 못 잡았나 — §10 ③(전달 결함)의 교과서적 형태다. **자료구조는 옳았다.** 어긋남을 정확히
// 세고 정확히 분류했다. 틀린 것은 **그 다음에 사용자에게 나가는 문장과 버튼**뿐이었다:
// *"소리 자체는 없습니다 — [정리]로 치울 수 있어요"*. 로컬에 사본이 있는데도.
//
// 유닛은 이제 그 판정 함수를 직접 잰다(순수 함수로 뽑았다). 그런데 유닛이 **구조적으로 못 보는**
// 층이 하나 남는다 — *그 문장이 실제로 화면에 그려지는가, 어느 자리에, 무엇과 함께.*
// `verify-editor-live`는 사진 편집기만 본다. 진단 화면에는 그 층이 **아예 없었다.**
//
// ─────────────────────────────────────────────────────────────────────────────
// 두 층으로 잰다 — 하나로는 못 잰다
// ─────────────────────────────────────────────────────────────────────────────
//  · **A. 실제 앱** — 진단 허브를 실제로 열어 **등록부의 모든 도구**가 판정까지 그려지는지 본다.
//    새 도구가 생기면 자동으로 이 검사에 들어온다(§7 2층). 여기서만 잡히는 것: 도구가 던져서
//    카드가 「확인 중…」에 멈추는 것, 가로 넘침, 콘솔 에러.
//  · **B. 주입 판정** — 실제 앱에서는 만들 수 없는 **위험한 상태**를 판정 함수에 직접 먹이고
//    실제 렌더러로 그린다. M-0046이 정확히 이 층이었다: 서버 상태는 같은데
//    「이 기기에 사본이 있는가」만 달라지면 화면이 정반대를 말해야 한다.
//    (샌드박스는 `*.supabase.co`를 막아 A에서는 로그인 상태를 만들 수 없다 — B가 그 구멍을 메운다.)
//
// 사용: npm run build && node scripts/verify-diagnostics-live.mjs
//
// @live-covers: screens/diagnosticsHub.ts, panels/diagnostics.ts, panels/verdict.ts
// 종료코드: 0=통과 · 1=위반 · 2=전제 미충족(SKIP — harness가 가른다, §2-G)

import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const BASE = '/Travel-Memories/';
/** 주입 층이 쓰는 임시 산출물. 점으로 시작해 어느 게이트의 스캔에도 걸리지 않는다. */
const TMP = join(ROOT, '.diaglive');

let chromium;
for (const spec of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs']) {
  try { ({ chromium } = await import(spec)); break; } catch { /* 다음 후보 */ }
}
if (!chromium) {
  console.error('verify-diagnostics-live: playwright를 찾을 수 없습니다 — 이 실행은 라이브 층을 재지 않았습니다.');
  process.exit(2);
}

/**
 * 🔴 `dist`가 소스보다 낡았으면 멈춘다 — `verify-editor-live`와 **같은 이유, 같은 규율**.
 * 빌드가 실패해도 옛 dist는 남으므로 "빌드했겠지"가 조용히 성립한다. 낡은 번들을 재는 검사는
 * 공허한 게이트다(§4). 규칙을 두 파일에 손으로 구현한 셈이지만, 그 규칙이 **막는 사고**가
 * 파일마다 따로 나기 때문에 각자 지킨다 — 어긋나면 둘 다 SKIP이 되어 조용히 통과하지 않는다.
 */
function newestMs(dir) {
  let t = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newestMs(full) : statSync(full).mtimeMs);
  }
  return t;
}
if (!existsSync(join(DIST, 'index.html'))) {
  console.error('verify-diagnostics-live: dist가 없습니다 — `npm run build` 먼저.');
  process.exit(2);
}
{
  const built = statSync(join(DIST, 'index.html')).mtimeMs;
  const src = Math.max(newestMs(join(ROOT, 'src')), newestMs(join(ROOT, 'public')));
  if (src > built) {
    console.error(
      `verify-diagnostics-live: **dist가 소스보다 ${Math.round((src - built) / 1000)}초 낡았습니다.**\n` +
        '  → 낡은 번들을 재면 검사가 공허해집니다. `npm run build`가 성공했는지 확인하세요.',
    );
    process.exit(2);
  }
}

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.map': 'application/json', '.woff2': 'font/woff2' };
function serveDir(dir, base, port) {
  const srv = createServer(async (req, res) => {
    let p = new URL(req.url, 'http://x').pathname;
    if (!p.startsWith(base)) { res.writeHead(404).end(); return; }
    p = p.slice(base.length) || 'index.html';
    try {
      const buf = await readFile(join(dir, p));
      res.writeHead(200, { 'cache-control': 'no-store', 'content-type': MIME[extname(p)] ?? 'application/octet-stream' }).end(buf);
    } catch {
      res.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'text/html' }).end(await readFile(join(dir, 'index.html')));
    }
  });
  return new Promise((r) => srv.listen(port, () => r(srv)));
}

// ═══════════════════════════════════════════════════════════════════════════
// B층 준비 — 주입 판정 페이지를 **게이트가 직접 빌드한다**
// ═══════════════════════════════════════════════════════════════════════════
// 왜 제품 코드에 시험용 훅을 심지 않는가: 그 훅은 배포본에 실려 나가고, 언젠가 누군가
// 그것으로 판정을 우회한다. 대신 게이트가 자기 진입점을 만들어 **실제 판정 함수와 실제
// 렌더러를 import**한다 — 검사 대상은 진짜이고, 가짜는 입력값(서버 응답)뿐이다.
const FIXTURE = `
import '../../src/ui/styles/tokens.css';
import '../../src/ui/styles/app.css';
import { renderTool, levelFromMetrics } from '../../src/ui/panels/verdict';
import { fileAuditMetrics } from '../../src/ui/panels/diagnostics';

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const audit = { files: 0, rows: 1, orphans: [], missing: [A], foreign: 0, truncated: false };
const base = { noun: '소리', fa: audit, note: null, serverPurged: [], serverTombstoned: [A], restorePending: new Set() };

/** 같은 서버 상태 · 사본 유무만 다르다 — M-0046이 갈라지는 바로 그 지점. */
function panel(id, localBytes, extraMetrics) {
  const r = fileAuditMetrics({ ...base, localBytes });
  const metrics = [...r.metrics, ...(extraMetrics || [])];
  const actions = r.recoverable.length
    ? [{ label: '서버에 없는 자료 다시 올리기', primary: true, run: async () => 'x' }]
    : [{ label: '지운 소리 기록 정리', primary: true, run: async () => 'x' }];
  const host = document.createElement('section');
  host.setAttribute('data-panel', id);
  host.appendChild(
    renderTool({
      title: '저장 상태 ' + id,
      lead: '주입 판정',
      probe: async () => ({
        level: levelFromMetrics(metrics),
        headline: '클라우드와 대조했어요',
        because: '근거 한 줄',
        metrics,
        actions,
        evidence: [],
        context: [{ label: '이 기기', value: 'test' }],
      }),
    }),
  );
  document.body.appendChild(host);
}

/** 판정 불가를 '정상'으로 반올림하지 않는지 보려고 섞어 넣는다. */
const UNKNOWN = { label: '확인 못 한 지표', actual: '확인 못 함', expected: '0개', level: 'unknown', meaning: '물어보지 못했어요' };

panel('nocopy', new Set());          // 사본 없음 → 정리해도 되는 상태
panel('hascopy', new Set([A]), [UNKNOWN]); // 사본 있음 → 다시 올려야 하는 상태
`;

await rm(TMP, { recursive: true, force: true });
await mkdir(join(TMP, 'src'), { recursive: true });
await writeFile(join(TMP, 'src', 'index.html'), '<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>t</title></head><body><script type="module" src="./main.ts"></script></body></html>');
await writeFile(join(TMP, 'src', 'main.ts'), FIXTURE);
await writeFile(
  join(TMP, 'vite.config.mjs'),
  `import { defineConfig } from 'vite';\nexport default defineConfig({ root: '${join(TMP, 'src').replace(/\\/g, '/')}', base: './', build: { outDir: '${join(TMP, 'out').replace(/\\/g, '/')}', emptyOutDir: true } });\n`,
);
try {
  execFileSync('npx', ['vite', 'build', '--config', join(TMP, 'vite.config.mjs')], { cwd: ROOT, stdio: 'pipe' });
} catch (e) {
  console.error(`verify-diagnostics-live: 주입 페이지 빌드 실패 — ${String(e.stderr ?? e).slice(0, 400)}`);
  await rm(TMP, { recursive: true, force: true });
  process.exit(2);
}

const appServer = await serveDir(DIST, BASE, 4174);
const fixServer = await serveDir(join(TMP, 'out'), '/', 4175);

let browser;
try {
  browser = await chromium.launch();
} catch (e) {
  console.error(
    `verify-diagnostics-live: 브라우저를 띄우지 못했습니다 — ${String(e).split('\n')[0]}\n` +
      '  → 이 실행은 라이브 층을 재지 않았습니다(통과가 아닙니다).',
  );
  appServer.close(); fixServer.close();
  await rm(TMP, { recursive: true, force: true });
  process.exit(2);
}

const errors = [];
const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });

// ═══════════════════════════════════════════════════════════════════════════
// A층 — 실제 앱에서 진단 허브를 열고 **등록부의 모든 도구**를 그린다
// ═══════════════════════════════════════════════════════════════════════════
await page.goto(`http://127.0.0.1:4174${BASE}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

// 데이터 관리 → 진단 도구. 라벨로 찾는다(카드에 hook이 없어 텍스트가 유일한 손잡이다).
await page.getByRole('button', { name: /데이터 관리/ }).first().click();
await page.waitForTimeout(400);
await page.getByRole('button', { name: /진단 도구/ }).first().click();
await page.waitForSelector('[data-rollup]', { timeout: 10000 });

// **등록부를 손으로 세지 않는다** — 허브가 그린 카드가 곧 도구 목록이다(`data-tool`).
// 새 도구가 생기면 이 검사에 자동으로 들어온다(§7 2층: 다음 형제가 따라오는가).
const toolNames = await page.locator('.guide-card-diag[data-tool]').evaluateAll((ns) => ns.map((n) => n.getAttribute('data-tool')));

// 🔴 **대상이 0이면 아래 검사는 전부 공허하게 통과한다**(`every`는 빈 배열에 true다).
//    실제로 첫 판에서 그렇게 통과했다 — 허브를 못 열었는데 A②·A④가 PASS로 찍혔다.
//    그래서 목록 확보 자체를 **먼저 판정하고, 실패면 나머지를 재지 않는다**(§4 비공허).
check('A① 진단 허브가 도구 목록을 그린다(등록부 기반 — 새 도구는 자동으로 들어온다)', toolNames.length >= 5, `도구 ${toolNames.length}개: ${toolNames.join(', ')}`);

if (toolNames.length === 0) {
  check('A② 이하 — 대상이 없어 재지 못함(공허 통과 방지)', false, '허브를 열지 못했다');
} else {
  const stuck = [];
  const noGlyph = [];
  const headlineBelow = [];
  const overflowed = [];
  for (const name of toolNames) {
    await page.locator(`.guide-card-diag[data-tool="${name}"]`).click();
    await page.waitForSelector('[data-verdict-tool]', { timeout: 10000 });
    // 판정까지 갔는가 — 「확인 중…」에 멈춘 카드는 **도구가 던진 것**이고 화면은 아무 말도 못 한다.
    // 유닛은 이걸 볼 수 없다(probe가 실제로 던지는지는 돌려봐야 안다).
    const ok = await page
      .waitForFunction(() => !(document.querySelector('.vd-headline')?.textContent ?? '').includes('확인 중'), null, { timeout: 12000 })
      .then(() => true)
      .catch(() => false);
    if (!ok) stuck.push(name);
    const m = await page.evaluate(() => {
      const tool = document.querySelector('[data-verdict-tool]');
      const badges = [...tool.querySelectorAll('.vd-badge')];
      const h = tool.querySelector('.vd-headline');
      const first = tool.querySelector('.vd-metric, .vd-quiet');
      return {
        glyphless: badges.filter((b) => !(b.querySelector('.vd-glyph')?.textContent ?? '').trim()).length,
        badges: badges.length,
        headlineAbove: !h || !first || h.getBoundingClientRect().top <= first.getBoundingClientRect().top,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    if (m.badges === 0 || m.glyphless > 0) noGlyph.push(name);
    if (!m.headlineAbove) headlineBelow.push(name);
    if (m.overflow !== 0) overflowed.push(`${name}(${m.overflow})`);
    await page.locator('.guide-back').click();
    await page.waitForSelector('[data-rollup]', { timeout: 10000 });
  }
  check(`A② 도구 ${toolNames.length}개가 모두 판정까지 그린다(「확인 중…」에 멈추지 않는다)`, stuck.length === 0, stuck.join(', '));
  check('A③ 판정 뱃지가 **글리프와 함께** 나온다(색만으로 말하지 않는다)', noGlyph.length === 0, noGlyph.join(', '));
  check('A④ 판정 문장이 지표보다 **위**에 있다(§7 사용자 대면 대칭)', headlineBelow.length === 0, headlineBelow.join(', '));
  check('A⑤ 가로 넘침 0 (375px)', overflowed.length === 0, overflowed.join(', '));
}

// ═══════════════════════════════════════════════════════════════════════════
// B층 — 주입 판정: **사용자에게 나가는 문장**이 사본 유무에 따라 갈리는가 (M-0046)
// ═══════════════════════════════════════════════════════════════════════════
await page.goto('http://127.0.0.1:4175/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => !document.body.textContent.includes('확인 중…'), null, { timeout: 15000 });

const b = await page.evaluate(() => {
  const panel = (id) => document.querySelector(`[data-panel="${id}"]`);
  const txt = (id) => panel(id).innerText;
  const primary = (id) => panel(id).querySelector('.vd-btn-primary')?.textContent?.trim() ?? '';
  const shown = (id) => [...panel(id).querySelectorAll('.vd-metric')].map((m) => m.querySelector('.vd-metric-label')?.textContent?.trim());
  const quiet = (id) => panel(id).querySelector('.vd-quiet-txt')?.textContent?.trim() ?? '';
  return {
    noCopyText: txt('nocopy'),
    hasCopyText: txt('hascopy'),
    noCopyPrimary: primary('nocopy'),
    hasCopyPrimary: primary('hascopy'),
    hasCopyShown: shown('hascopy'),
    noCopyQuiet: quiet('nocopy'),
    hasCopyQuiet: quiet('hascopy'),
    // 지표 설명(meaning)이 실제로 DOM에 나오는가 — 자료구조에만 있고 화면에 없으면 M-0022다.
    whyCount: panel('hascopy').querySelectorAll('.vd-metric-why').length,
  };
});

check(
  'B① 🔴 사본이 있으면 「자료가 없다」고 말하지 않는다 (M-0046 회귀)',
  b.hasCopyText.includes('이 기기에는 그대로 있어요') && !b.hasCopyText.includes('소리 자체는 없습니다'),
  b.hasCopyText.slice(0, 120).replace(/\n/g, ' '),
);
check(
  'B② 🔴 사본이 있으면 주버튼이 **다시 올리기**다(정리가 아니다)',
  b.hasCopyPrimary.includes('다시 올리기'),
  `primary="${b.hasCopyPrimary}"`,
);
check(
  'B③ 사본이 없을 때만 정리를 권하고, **찾아봤다는 사실**을 함께 말한다',
  b.noCopyPrimary.includes('정리') && b.noCopyText.includes('이 기기에도 사본이 없습니다'),
  `primary="${b.noCopyPrimary}"`,
);
check('B④ 지표 설명이 실제로 화면에 그려진다(자료구조에만 있으면 M-0022)', b.whyCount > 0, `설명 ${b.whyCount}개`);
check(
  'B⑤ 정상 지표는 **접혀서** 한 줄로만 집계된다(§8 침묵이 정상)',
  b.hasCopyQuiet.startsWith('정상 ') && !b.hasCopyShown.includes('영구삭제 후 남은 소리 파일'),
  `quiet="${b.hasCopyQuiet}" · 펼쳐진 지표=${JSON.stringify(b.hasCopyShown)}`,
);
check(
  'B⑥ 「확인 못 함」을 정상으로 반올림하지 않는다(원칙 #4)',
  b.hasCopyShown.includes('확인 못 한 지표') && b.hasCopyText.includes('확인 못 함'),
  JSON.stringify(b.hasCopyShown),
);

check('콘솔 에러 0', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
appServer.close();
fixServer.close();
await rm(TMP, { recursive: true, force: true });

const fails = results.filter((r) => !r.ok);
console.log(`\n${results.length - fails.length}/${results.length} PASS`);
process.exit(fails.length ? 1 : 0);
