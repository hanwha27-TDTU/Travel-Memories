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
/**
 * `npx`/`npx.cmd`는 셸 shim이라 `execFileSync`의 네이티브 실행 파일 계약이 아니다.
 * Windows Node 24에서 실제로 `spawnSync npx ENOENT`가 나 진단 층 전체가 SKIP됐다(M-0091).
 * `npm run build`가 쓰는 같은 Vite JS 진입점을 현재 Node로 직접 실행한다(M-0089와 같은 처방).
 */
const VITE = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

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
import { fileAuditMetrics, storeHeadline, stuckMeaning } from '../../src/ui/panels/diagnostics';

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const audit = { files: 0, rows: 1, orphans: [], missing: [A], foreign: 0, truncated: false };
const base = { noun: '소리', fa: audit, note: null, serverPurged: [], serverTombstoned: [A], restorePending: new Set() };

/**
 * 같은 서버 상태 · **사본 유무와 기기 수만** 다르다 — M-0046과 M-0048이 갈라지는 두 지점.
 * 판정이 실제로 갈라지는지를 앱 밖에서 만들 수 없으므로 판정 함수에 직접 먹인다.
 */
function panel(id, localBytes, extraMetrics, otherDevices = 0) {
  const r = fileAuditMetrics({ ...base, localBytes, otherDevices });
  const metrics = [...r.metrics, ...(extraMetrics || [])];
  // 🔴 버튼을 **손으로 고르지 않는다.** 앱의 계약은 *"그 목록이 비면 그 행동은 아예 없다"*이고
  // (storeCleanupActions), 여기서 임의로 고르면 M-0038형 — 내가 쓴 마크업을 재게 된다.
  // 실제로 첫 판이 그랬다: recoverable만 보고 else로 「정리」를 붙여서, 기기 축을 넣은 뒤에도
  // 파괴적 버튼이 계속 떴다. 판정이 낸 목록에서 **파생**시킨다.
  const actions = [
    ...(r.recoverable.length ? [{ label: '서버에 없는 자료 다시 올리기', primary: true, run: async () => 'x' }] : []),
    ...(r.clearable.length ? [{ label: '지운 소리 기록 정리', primary: true, run: async () => 'x' }] : []),
  ];
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

/**
 * 🔴 **버튼을 실제로 누르는 판**(2026-07-28 사용자 지적: *"앞으로 버튼을 만들게 된다면
 * 니가 직접 눌러봐서 확인할 수 있지 않아?"*).
 *
 * 맞다. 그동안 이 검사는 버튼의 **라벨만 읽고** 한 번도 안 눌러 봤다 — M-0046도 M-0048도
 * 버튼이 문제였는데. 누른 뒤 무슨 일이 일어나야 하는지는 헌법 §8에 적혀 있다:
 * *"고쳤다고 말하지 말고 **다시 읽어라**"*. 그런데 그 재판정을 아무도 재고 있지 않았다.
 *
 * 여기서 재는 것(전부 실제 renderTool의 배선이다):
 *   ① 결과 문장이 **화면에 나오는가**(자료구조에만 있으면 M-0022의 행동판)
 *   ② 누른 뒤 **재판정이 도는가**(§8 — probe 호출 수로 관측한다)
 *   ③ 실패하면 **조용히 삼키지 않는가**
 */
/**
 * 🔴 **요약 문장이 어느 종류를 가리키는가**(M-0048 곁가지). 사진은 9:9로 멀쩡한데 배너가
 * 「**사진** 파일에 확인할 것이 1가지 있어요」였다 — 유닛은 문자열을 재지만 *그 문장이 화면
 * 맨 위에 실제로 그려지는지*는 못 본다(§10 ③).
 */
function headlinePanel(id, fileBad) {
  const host = document.createElement('section');
  host.setAttribute('data-panel', id);
  host.appendChild(
    renderTool({
      title: '요약 ' + id,
      lead: '주입 판정',
      probe: async () => ({
        level: 'todo',
        headline: storeHeadline({ level: 'todo', countBad: 0, fileBad, stranded: 0, blocked: 0, alive: 12, trashed: 0 }),
        because: '근거 한 줄',
        metrics: [{ label: '지표', actual: '1개', expected: '0개', level: 'todo', meaning: '설명' }],
        actions: [],
        evidence: [],
        context: [],
      }),
    }),
  );
  document.body.appendChild(host);
}

/**
 * 🔴 **「막힌 작업」이 왜 막혔는지 화면에서 말하는가**(M-0107).
 *
 * 사용자 기기에 13건이 박혀 있었는데 화면은 개수만 말하고 *"[실패 재시도]를 눌러 주세요"*라며
 * **눌러도 안 되는 일을 시켰다.** 사유는 이제 큐가 들고 있다 — 그것이 실제로 **DOM에 나오는지**,
 * 그리고 문장이 길어져 **가로로 넘치지 않는지**를 잰다(자료구조에만 있으면 M-0022).
 */
function stuckPanel() {
  const reasons = [
    { reason: 'insert or update on table "media" violates foreign key constraint "media_moment_fk"', count: 13 },
    { reason: '서버가 권한을 거절했어요(403) — 로그인을 확인해 주세요', count: 2 },
  ];
  const host = document.createElement('section');
  host.setAttribute('data-panel', 'stuck');
  host.appendChild(
    renderTool({
      title: '동기화 상태(주입)',
      lead: '주입 판정',
      probe: async () => ({
        level: 'problem',
        headline: '보내지 못하고 멈춘 작업이 15건 있어요',
        because: '근거 한 줄',
        metrics: [{ label: '막힌 작업', actual: '15건', expected: '없음', level: 'problem', meaning: stuckMeaning(reasons) }],
        actions: [],
        evidence: [],
        context: [],
      }),
    }),
  );
  document.body.appendChild(host);
}

window.__probes = 0;
function actionPanel() {
  const host = document.createElement('section');
  host.setAttribute('data-panel', 'act');
  host.appendChild(
    renderTool({
      title: '행동 배선',
      lead: '주입 판정',
      probe: async () => {
        window.__probes += 1;
        return {
          level: 'ok',
          headline: '대조했어요',
          because: '근거',
          metrics: [{ label: '지표', actual: '0개', expected: '0개', level: 'ok' }],
          actions: [
            { label: '고치기', primary: true, hook: 'data-act-ok', run: async () => '3건을 고쳤어요. 다시 대조합니다.' },
            { label: '터지는 버튼', hook: 'data-act-boom', run: async () => { throw new Error('서버가 거절했어요'); } },
          ],
          evidence: [],
          context: [],
        };
      },
    }),
  );
  document.body.appendChild(host);
}

/** 판정 불가를 '정상'으로 반올림하지 않는지 보려고 섞어 넣는다. */
const UNKNOWN = { label: '확인 못 한 지표', actual: '확인 못 함', expected: '0개', level: 'unknown', meaning: '물어보지 못했어요' };

panel('nocopy', new Set());                    // 사본 없음 · 기기 1대 → 정리해도 되는 상태
panel('hascopy', new Set([A]), [UNKNOWN]);     // 사본 있음 → 다시 올려야 하는 상태
// 🔴 M-0048: 사본이 없지만 **다른 기기가 있다.** 폴드5에서 실제로 나온 상태이고,
// 그때 화면은 [지운 소리 기록 정리]를 주버튼으로 권했다 — 따랐으면 태블릿의 사본까지 잃었다.
panel('otherdev', new Set(), null, 1);
actionPanel();
stuckPanel();
headlinePanel('hl-sound', [{ noun: '사진', n: 0 }, { noun: '소리', n: 1 }]);
headlinePanel('hl-both', [{ noun: '사진', n: 1 }, { noun: '소리', n: 2 }]);
`;

await rm(TMP, { recursive: true, force: true });
await mkdir(join(TMP, 'src'), { recursive: true });
await writeFile(join(TMP, 'src', 'index.html'), '<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>t</title></head><body><script type="module" src="./main.ts"></script></body></html>');
await writeFile(join(TMP, 'src', 'main.ts'), FIXTURE);
await writeFile(
  join(TMP, 'vite.config.mjs'),
  `import { defineConfig } from 'vite';\nexport default defineConfig({ root: '${join(TMP, 'src').replace(/\\/g, '/')}', base: './', build: { outDir: '${join(TMP, 'out').replace(/\\/g, '/')}', emptyOutDir: true } });\n`,
);
if (!existsSync(VITE)) {
  console.error(
    'verify-diagnostics-live: Vite 진입점을 찾을 수 없습니다 — 의존성이 설치되지 않아 주입 페이지를 빌드하지 못했습니다.\n' +
      '  → 이 실행은 라이브 층을 재지 않았습니다(통과가 아닙니다). `npm ci` 후 재실행하세요.',
  );
  await rm(TMP, { recursive: true, force: true });
  process.exit(2);
}
try {
  execFileSync(process.execPath, [VITE, 'build', '--config', join(TMP, 'vite.config.mjs')], {
    cwd: ROOT,
    stdio: 'pipe',
    windowsHide: true,
  });
} catch (e) {
  console.error(`verify-diagnostics-live: 주입 페이지 빌드 실패 — ${String(e.stderr ?? e).slice(0, 400)}`);
  await rm(TMP, { recursive: true, force: true });
  process.exit(1);
}

// 🔴 포트는 **라이브 게이트마다 갈라 쓴다**(2026-07-29 · 속도 측정 중에 발견).
// `verify-editor-live`가 4173(앱)과 **4174**(오프라인 재현용)를 쓰는데 이 게이트도 4174를
// 쓰고 있었다. 지금은 직렬이라 안 터지지만 **앞 게이트가 죽어 포트를 남기면 뒤가 실패**하고,
// 병렬로 돌리면 반드시 부딪힌다. 겹침은 「아직 안 터진 결함」이지 「안전」이 아니다.
const appServer = await serveDir(DIST, BASE, 4184);
const fixServer = await serveDir(join(TMP, 'out'), '/', 4185);

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
/**
 * 앱을 열고 **데이터 관리 → 진단 도구**까지 간다. 라벨로 찾는다(카드에 hook이 없어 텍스트가
 * 유일한 손잡이다). C층도 같은 경로를 쓰므로 **한 곳에만 구현한다**(§7 2층) — 두 곳에 손으로
 * 적으면 허브 진입이 바뀌는 날 한쪽만 고쳐진다.
 */
async function openDiagnosticsHub(pg) {
  await pg.goto(`http://127.0.0.1:4184${BASE}`, { waitUntil: 'networkidle' });
  await pg.waitForTimeout(400);
  await pg.getByRole('button', { name: /데이터 관리/ }).first().click();
  await pg.waitForTimeout(400);
  await pg.getByRole('button', { name: /진단 도구/ }).first().click();
  await pg.waitForSelector('[data-rollup]', { timeout: 10000 });
}
await openDiagnosticsHub(page);

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

  // ── A⑥~A⑧ v1.79: **경로축 분류가 화면까지 닿았는가** ──────────────────────
  //
  // 🔴 이 검사가 생긴 이유: v1.76이 경로축 8단계를 만들고 인계에 「재분류했다」고 적었는데
  // **도구에는 안 걸려 있었다.** `DIAG_GROUPS`를 src 전체에서 찾으면 자기 파일 밖에서 쓰는
  // 곳이 하나도 없었고, 허브는 도구를 평평하게 나열하고 있었다 — M-0015의 재발이다.
  // 게이트가 「도구마다 group이 있는가」를 묻지만, **화면에 그려지는가는 게이트가 못 본다.**
  // 위 반복이 마지막에 [‹ 뒤로]를 눌러 **이미 허브 홈**이다 — 새로고침하면 허브가 닫혀
  // 아무것도 못 잰다(첫 판에서 그렇게 헛디뎠다). 열려 있는 화면을 그대로 잰다.
  await page.waitForSelector('[data-diag-group]', { timeout: 15000 });
  const grouping = await page.evaluate(() => {
    const heads = [...document.querySelectorAll('[data-diag-group]')];
    return {
      groups: heads.map((h) => h.getAttribute('data-diag-group')),
      titles: heads.map((h) => h.querySelector('.diag-group-title')?.textContent ?? ''),
      asks: heads.filter((h) => (h.querySelector('.diag-group-asks')?.textContent ?? '').length > 0).length,
      // 비어 있는 단계가 **왜** 비었는지 말하는가(§8 — 빈 자리를 조용히 지우지 않는다)
      empty: [...document.querySelectorAll('.diag-group-empty')].map((p) => p.textContent ?? ''),
    };
  });
  check(
    '🔴 A⑥ 도구가 **경로축 단계로 묶여** 그려진다(v1.76은 분류를 만들고 화면에 안 걸었다 · M-0015)',
    grouping.groups.length >= 8 && grouping.titles.every((t) => t.length > 0),
    `단계 ${grouping.groups.length}개: ${grouping.groups.join(' → ')}`,
  );
  check(
    'A⑦ 단계마다 **무엇을 묻는 단계인지** 한 줄로 말한다(이정표가 장식이 아니다)',
    grouping.asks === grouping.groups.length,
    `설명 ${grouping.asks}/${grouping.groups.length}`,
  );
  // 🔴 **이 케이스는 뒤집혔다**(v1.81 · §11 ②). 처음엔 *"빈 단계가 하나 이상 있고 설명이 붙는다"*를
  // 잠갔는데, 그건 **「파일 실물」이 비어 있던 그때의 사실**이었다. T-010·T-011로 그 구멍을 메우자
  // 빈 단계가 0이 되어 검사가 RED로 떴다 — 앱은 옳고 검사가 옛 전제를 들고 있었다.
  // **통과시키려고 코드를 되돌리지 않는다. 케이스를 뒤집는다.**
  //
  // 지금 잠그는 것은 **불변식**이다: *모든 단계는 도구 카드를 갖거나, 왜 비었는지 말한다.*
  // 빈 단계가 다시 생겨도(새 단계 추가·도구 제거) 이 문장은 그대로 참이고, 그때 설명이 없으면
  // 잡힌다. 단계 0개면 공허하므로 그것도 함께 막는다(§4 — 검사는 대상 확보를 먼저 판정한다).
  const stageShape = await page.evaluate(() =>
    [...document.querySelectorAll('[data-diag-group]')].map((h) => {
      let cards = 0;
      let note = '';
      for (let el = h.nextElementSibling; el && !el.hasAttribute('data-diag-group'); el = el.nextElementSibling) {
        cards += el.querySelectorAll('.guide-card-diag').length;
        if (el.classList.contains('diag-group-empty')) note = el.textContent ?? '';
      }
      return { group: h.getAttribute('data-diag-group'), cards, note };
    }),
  );
  const silentHoles = stageShape.filter((s) => s.cards === 0 && !s.note.includes('도구가 없어요'));
  check(
    '🔴 A⑧ 모든 단계가 **도구를 갖거나, 왜 비었는지 말한다**(§8 — 빈 자리를 조용히 지우지 않는다)',
    stageShape.length >= 8 && silentHoles.length === 0,
    silentHoles.length
      ? `설명 없는 빈 단계: ${silentHoles.map((s) => s.group).join(', ')}`
      : `단계 ${stageShape.length}개 · 빈 단계 ${stageShape.filter((s) => s.cards === 0).length}개(전부 이유 있음)`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// B층 — 주입 판정: **사용자에게 나가는 문장**이 사본 유무에 따라 갈리는가 (M-0046)
// ═══════════════════════════════════════════════════════════════════════════
await page.goto('http://127.0.0.1:4185/', { waitUntil: 'networkidle' });
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
    otherDevText: txt('otherdev'),
    otherDevPrimary: primary('otherdev'),
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
  b.noCopyPrimary.includes('정리') && b.noCopyText.includes('사본이 어디에도 없습니다'),
  `primary="${b.noCopyPrimary}"`,
);
check(
  'B③-2 🔴 다른 기기가 있으면 **정리를 권하지 않는다**(M-0048 회귀 — 두 기기가 정반대 판정)',
  !b.otherDevPrimary.includes('정리') && !b.otherDevText.includes('치울 수 있어요'),
  `primary="${b.otherDevPrimary}"`,
);
check(
  'B③-3 대신 **다른 기기를 보라고** 말한다(막다른 문장으로 끝내지 않는다)',
  b.otherDevText.includes('다른 기기') && b.otherDevText.includes('서버에 없는 자료 다시 올리기'),
  b.otherDevText.replace(/\s+/g, ' ').slice(0, 160),
);
check('B④ 지표 설명이 실제로 화면에 그려진다(자료구조에만 있으면 M-0022)', b.whyCount > 0, `설명 ${b.whyCount}개`);

// ── B⑦ 🔴 「막힌 작업」이 **왜** 막혔는지 화면에서 말하는가 (M-0107) ─────────
const stuckView = await page.evaluate(() => {
  const el = document.querySelector('[data-panel="stuck"]');
  const why = el.querySelector('.vd-metric-why');
  return {
    text: el.innerText,
    // 설명 상자가 가로로 넘치면 긴 서버 메시지가 잘려 **읽을 수 없는 사유**가 된다.
    overflowPx: why ? why.scrollWidth - why.clientWidth : -1,
    pageOverflowPx: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
});
check(
  'B⑦ 🔴 막힌 작업이 **서버가 말한 이유**를 화면에 그린다(개수만 말하지 않는다 — M-0107)',
  stuckView.text.includes('서버가 말한 이유') && stuckView.text.includes('media_moment_fk') && stuckView.text.includes('13건'),
  stuckView.text.replace(/\s+/g, ' ').slice(0, 200),
);
check(
  'B⑦-2 긴 서버 메시지가 가로로 넘치지 않는다(잘리면 읽을 수 없는 사유가 된다)',
  stuckView.overflowPx >= 0 && stuckView.overflowPx <= 1 && stuckView.pageOverflowPx <= 1,
  `설명상자 넘침=${stuckView.overflowPx}px · 페이지 넘침=${stuckView.pageOverflowPx}px`,
);
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

// ── D. 요약 문장이 **어느 종류를 가리키는가** (M-0048 곁가지) ──────────────
const d = await page.evaluate(() => {
  const head = (id) => document.querySelector(`[data-panel="${id}"] .vd-headline`)?.textContent?.trim() ?? '';
  return { sound: head('hl-sound'), both: head('hl-both') };
});
check(
  'D① 🔴 소리만 어긋나면 배너가 **소리**라고 말한다(사진이라 하지 않는다 — M-0048)',
  d.sound.includes('소리 파일') && !d.sound.includes('사진'),
  `"${d.sound}"`,
);
check(
  'D② 둘 다면 둘 다 이름을 부르고 합을 말한다',
  d.both.includes('사진·소리 파일') && d.both.includes('3가지'),
  `"${d.both}"`,
);

// ── C. 🔴 **버튼을 실제로 누른다** (2026-07-28) ─────────────────────────────
// 지금까지 이 검사는 버튼의 **라벨만 읽었다.** M-0046도 M-0048도 버튼이 문제였는데,
// 정작 눌러본 적이 없다. 누르는 순간의 계약은 실제 `renderTool`이 갖고 있으므로 여기서 잰다.
await page.waitForSelector('[data-panel="act"] [data-act-ok]');
const beforeProbes = await page.evaluate(() => window.__probes);
await page.click('[data-panel="act"] [data-act-ok]');
await page.waitForFunction(() => window.__probes > 1, null, { timeout: 5000 }).catch(() => {});
const c1 = await page.evaluate(() => ({
  probes: window.__probes,
  msg: document.querySelector('[data-panel="act"] .vd-msg')?.textContent?.trim() ?? '',
  msgHidden: document.querySelector('[data-panel="act"] .vd-msg')?.hidden !== false,
  enabled: !document.querySelector('[data-panel="act"] [data-act-ok]')?.disabled,
}));
check(
  'C① 버튼을 누르면 결과 문장이 **화면에 나온다**(자료구조에만 있으면 M-0022의 행동판)',
  !c1.msgHidden && c1.msg.includes('3건을 고쳤어요'),
  `msg="${c1.msg}" hidden=${c1.msgHidden}`,
);
check(
  'C② 🔴 고친 뒤 **다시 읽는다**(§8 — 고쳤다고 말하지 말고 재판정하라)',
  c1.probes > beforeProbes,
  `probe 호출 ${beforeProbes} → ${c1.probes}`,
);
check('C③ 누른 뒤 버튼이 다시 눌린다(비활성으로 잠기지 않는다)', c1.enabled, `enabled=${c1.enabled}`);

await page.click('[data-panel="act"] [data-act-boom]');
await page.waitForTimeout(300);
const c2 = await page.evaluate(() => ({
  msg: document.querySelector('[data-panel="act"] .vd-msg')?.textContent?.trim() ?? '',
  enabled: !document.querySelector('[data-panel="act"] [data-act-boom]')?.disabled,
}));
check(
  'C④ 🔴 실패하면 **조용히 삼키지 않는다**(사유가 화면에 나온다)',
  c2.msg.includes('실행 실패') && c2.msg.includes('서버가 거절했어요'),
  `msg="${c2.msg}"`,
);
check('C⑤ 실패해도 버튼이 잠기지 않는다(다시 시도할 수 있다)', c2.enabled, `enabled=${c2.enabled}`);

// 실제 앱에서도 한 번 누른다 — **안전한 행동**(다시 확인)만. 파괴적 버튼은 누르지 않는다:
// 이 검사는 사용자의 실제 기억을 담은 기기에서도 돌 수 있다(§0 — 원본 자료를 건드리지 않는다).
//
// ⚠️ 여기는 주입 픽스처 페이지 위다 — **앱으로 돌아가야 도구가 있다.** 상태를 바꾸는 검사는
// 맨 뒤에 붙인다(`ui-responsive-dev` §3-C: 중간에서 goto하면 뒤따르는 검사가 화면을 잃는다).
await openDiagnosticsHub(page);
const firstTool = (await page.locator('.guide-card-diag[data-tool]').all())[0];
if (firstTool) {
  await firstTool.click();
  await page.waitForSelector('[data-verdict-recheck]', { timeout: 8000 }).catch(() => {});
  const recheck = page.locator('[data-verdict-recheck]').first();
  const had = await recheck.count();
  if (had) {
    await recheck.click();
    await page.waitForTimeout(600);
  }
  const c3 = await page.evaluate(() => ({
    badge: document.querySelector('.vd-badge')?.textContent?.trim() ?? '',
    stuck: document.body.innerText.includes('확인 중…'),
  }));
  check(
    'C⑥ 실제 앱에서 [다시 확인]을 눌러도 판정이 다시 그려진다(「확인 중…」에 멈추지 않는다)',
    had > 0 && c3.badge.length > 0 && !c3.stuck,
    `버튼=${had} 뱃지="${c3.badge}"`,
  );
} else {
  check('C⑥ 이하 — 도구를 못 열어 재지 못함(공허 통과 방지)', false, '허브에서 도구를 찾지 못했다');
}

// ── E층 v1.81: 🖼️ 「파일 실물」의 [열어 보기]를 **실제 앱에서 진짜로 누른다**(§13 4항) ──
//
// 🔴 이 버튼을 실제로 누르는 것이 안전한 이유: **읽기 전용**이다. 바이트를 디코드해 보기만
// 하고 Dexie에 쓰지 않는다 — 사용자의 실제 기억을 담은 기기에서 돌아도 아무것도 잃지 않는다.
// (파괴적 버튼이면 §13 4항에 따라 「행동 목록이 만들어지는지」까지만 재야 한다.)
//
// 「그리는 것」과 「도는 것」은 다른 층이다 — M-0046·M-0048은 둘 다 **버튼이 결함**이었는데
// 그때 라이브는 라벨만 읽고 있었다.
// 🔴 **진짜 파일을 심는다.** 첫 판은 빈 브라우저에서 눌러 「0개를 열어 봤고 전부 열렸어요」가
// 나왔다 — 버튼은 돌았지만 **디코드 로직은 한 번도 안 돌았다.** 그건 공허한 검사다(§4).
// 성한 사진 하나와 **일부러 깨뜨린** 사진 하나를 넣어 「깨진 것을 실제로 잡는가」를 잰다.
const seeded = await page.evaluate(async () => {
  // 성한 바이트는 캔버스로 만든다 — 브라우저가 스스로 인코딩하므로 반드시 디코드된다.
  const cv = document.createElement('canvas');
  cv.width = 8;
  cv.height = 8;
  const good = await new Promise((r) => cv.toBlob((b) => r(b), 'image/webp'));
  // 깨진 바이트: 형식은 사진이라고 주장하지만 내용이 사진이 아니다. 크기는 0이 아니므로
  // **크기만 보는 검사로는 못 잡는다** — 그게 이 도구가 존재하는 이유다.
  const bad = new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4])], { type: 'image/webp' });
  const now = new Date().toISOString();
  const row = (id, blob) => ({
    id, momentId: 'fr-live-moment', tripId: 'fr-live-trip',
    displayBlob: blob, thumbBlob: blob, width: 8, height: 8,
    takenAt: now, gpsLat: null, gpsLng: null, bytesOriginal: blob.size, bytesDisplay: blob.size,
    version: 1, baseVersion: 0, createdAt: now, updatedAt: now, deletedAt: null,
    clientOperationId: `fr-live-${id}`,
  });
  await new Promise((ok, no) => {
    const q = indexedDB.open('journey-archive');
    q.onsuccess = () => {
      const tx = q.result.transaction('localMedia', 'readwrite');
      tx.objectStore('localMedia').put(row('fr-live-good', good));
      tx.objectStore('localMedia').put(row('fr-live-bad', bad));
      tx.oncomplete = ok;
      tx.onerror = () => no(tx.error);
    };
    q.onerror = () => no(q.error);
  });
  return good.size > 0;
});
check('E⓪ 픽스처 주입(성한 사진 1 · 깨진 사진 1) — 크기는 둘 다 0이 아니다', seeded, `good.size>0=${seeded}`);

await openDiagnosticsHub(page);
const fileCard = page.locator('.guide-card-diag[data-tool="파일 실물"]');
const hasFileTool = (await fileCard.count()) === 1;
check('E① 🖼️ 「파일 실물」 도구가 허브에 있다(T-010·T-011로 빈 단계를 메웠다)', hasFileTool, `카드 ${await fileCard.count()}개`);
if (hasFileTool) {
  await fileCard.click();
  await page.waitForSelector('.vd-metric-top', { timeout: 10000 }).catch(() => {});
  const before = await page.evaluate(() => document.body.innerText);
  check(
    '🔴 E② 안 열어 봤으면 **정상이라고 하지 않는다**(안 해 본 것을 ok로 반올림 금지 · §8)',
    before.includes('아직 안 열어 봤어요') || before.includes('열어 봄'),
    before.includes('아직 안 열어 봤어요') ? '아직 안 열어 봤어요' : '(이미 스윕 기록이 있음)',
  );
  check(
    '🔴 E③ 시야의 경계를 **판정 옆에서** 말한다(§7-C 한정 생략 — 「이 기기」라고 못박는가)',
    before.includes('이 기기에 내려받은 바이트') && before.includes('다른 기기'),
    before.includes('이 기기에 내려받은 바이트') ? 'ok' : '(경계 문장 없음)',
  );
  const sweepBtn = page.locator('[file-open-sweep]');
  const hasBtn = (await sweepBtn.count()) === 1;
  check('E④ [사진·소리 실제로 열어 보기] 버튼이 있다', hasBtn, `버튼 ${await sweepBtn.count()}개`);
  if (hasBtn) {
    await sweepBtn.click();
    await page.waitForTimeout(2500);
    const after = await page.evaluate(() => ({
      text: document.body.innerText,
      enabled: !document.querySelector('[file-open-sweep]')?.disabled,
    }));
    // 🔴 누른 뒤 네 가지를 잰다(§13 4항): 결과가 화면에 나오는가 · 재판정이 도는가 ·
    //    실패를 삼키지 않는가 · 버튼이 잠기지 않는가.
    check(
      '🔴 E⑤ 누르면 **결과 문장이 화면에 나온다**(자료구조에만 있으면 M-0022의 행동판)',
      /열어 봤고|열리지 않았어요/.test(after.text),
      after.text.match(/[^\n]*열어 봤고[^\n]*|[^\n]*열리지 않았어요[^\n]*/)?.[0] ?? '(결과 문장 없음)',
    );
    check(
      '🔴 E⑥ 누른 뒤 **재판정이 돈다** — 「아직 안 열어 봤어요」가 사라진다(§8)',
      !after.text.includes('아직 안 열어 봤어요'),
      after.text.includes('아직 안 열어 봤어요') ? '옛 판정이 그대로 남음' : '재판정됨',
    );
    check('E⑦ 누른 뒤에도 버튼이 다시 눌린다(잠기지 않는다)', after.enabled, `enabled=${after.enabled}`);
    // 🔴 **여기가 이 층의 본론이다**: 크기가 0이 아닌 **깨진** 사진을 실제 디코더가 잡았는가.
    //    「전부 열렸어요」가 나오면 이 도구는 아무것도 안 재는 것이다.
    check(
      '🔴 E⑧ **깨진 사진을 실제로 잡는다**(크기만 보는 검사로는 못 잡는 자리 · §4 비공허)',
      /1개가 열리지 않았어요/.test(after.text),
      after.text.match(/[^\n]*열리지 않았어요[^\n]*|[^\n]*전부 열렸어요[^\n]*/)?.[0] ?? '(결과 문장 없음)',
    );
    check(
      '🔴 E⑨ 성한 사진은 **문제로 몰지 않는다**(오탐 차단 — 2개 중 1개만 실패)',
      /2개 중 1개가/.test(after.text),
      after.text.match(/\d+개 중 \d+개가/)?.[0] ?? '(개수 문장 없음)',
    );
    check(
      '🔴 E⑩ 깨진 파일을 두고 **지우라고 하지 않는다**(다른 기기에 사본이 있을 수 있다 · M-0048)',
      after.text.includes('지우지 마') && !/정리|삭제하세요/.test(after.text),
      after.text.includes('지우지 마') ? 'ok' : '(지우지 말라는 안내 없음)',
    );
    // 🔴 **원시 UTC를 사용자 화면에 내보내지 않는다**(M-0110). 실기기 캡처에
    // `2026-08-05T23:17:41.750Z`가 그대로 나갔고 기기 시계는 08:17이었다 — `check-timezone`이
    // `iso.slice(0,10)`을 금지하는 것과 같은 이유다. 화면 전체에서 ISO 꼴을 찾아 막는다.
    const rawIso = after.text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[\d:.]*Z?/);
    check(
      '🔴 E⑪ 시각을 **원시 UTC ISO로 내보내지 않는다**(사용자 시계와 다르다 · M-0110)',
      !rawIso,
      rawIso ? `화면에 그대로: ${rawIso[0]}` : '로컬 표기만 나감',
    );

    // ── E⑫ 🔴 **「모두 성해요」 갈래를 실제로 그려 본다** (M-0110 후속) ─────────────
    //
    // 사용자 지적: *"디자인의 문제는 니가 스크린샷으로 미리 확인가능하지않아?"* — 맞다.
    // 그런데 파고들어 보니 더 큰 것이 있었다: **이 층은 그 문장을 한 번도 안 그렸다.**
    // 픽스처에 깨진 파일이 늘 있어서 판정이 항상 「확인할 것이 있어요」로 끝났고,
    // 조사가 들어 있는 **정상 문장 자체가 화면에 나온 적이 없었다.**
    //
    // 🔴 그래서 규율이 하나 늘어난다: **픽스처는 「편한 값」이 아니라 갈래를 드러내는 값으로
    // 고른다.** 정상 갈래를 안 그리면 정상 화면의 결함은 영원히 안 보인다 — 그리고 사용자가
    // 가장 자주 보는 화면이 바로 그 정상 화면이다.
    await page.evaluate(async () => {
      await new Promise((ok) => {
        const q = indexedDB.open('journey-archive');
        q.onsuccess = () => {
          const tx = q.result.transaction('localMedia', 'readwrite');
          tx.objectStore('localMedia').delete('fr-live-bad'); // 깨진 것만 치운다 → 전부 성한 상태
          tx.oncomplete = ok;
          tx.onerror = ok;
        };
        q.onerror = ok;
      });
    });
    await page.locator('[file-open-sweep]').click();
    await page.waitForTimeout(2000);
    const allGood = await page.evaluate(() => document.body.innerText);
    const headline = allGood.match(/이 기기의 사진·소리 [^\n]*/)?.[0] ?? '';
    check(
      '🔴 E⑫ 정상 갈래의 판정 문장이 **실제로 그려지고 조사가 맞는다**(「71개이」가 실기기로 나갔다 · M-0110)',
      /^이 기기의 사진·소리 \d+개가 모두 성해요$/.test(headline.trim()),
      headline.trim() || '(정상 판정 문장을 못 찾음)',
    );

    await page.evaluate(async () => {
      const cv = document.createElement('canvas');
      cv.width = 8;
      cv.height = 8;
      const blob = await new Promise((ok) => cv.toBlob((b) => ok(b), 'image/webp'));
      const now = new Date().toISOString();
      await new Promise((ok, no) => {
        const q = indexedDB.open('journey-archive');
        q.onsuccess = () => {
          const tx = q.result.transaction('localMedia', 'readwrite');
          tx.objectStore('localMedia').put({
            id: 'fr-live-new', momentId: 'fr-live-moment', tripId: 'fr-live-trip',
            displayBlob: blob, thumbBlob: blob, width: 8, height: 8,
            takenAt: now, gpsLat: null, gpsLng: null, bytesOriginal: blob.size, bytesDisplay: blob.size,
            version: 1, baseVersion: 0, createdAt: now, updatedAt: now, deletedAt: null,
            clientOperationId: 'fr-live-new',
          });
          tx.oncomplete = ok;
          tx.onerror = () => no(tx.error);
        };
        q.onerror = () => no(q.error);
      });
    });
    await page.locator('.guide-back').click();
    await page.waitForSelector('[data-rollup]', { timeout: 10000 });
    await fileCard.click();
    await page.waitForFunction(
      () => (document.querySelector('.vd-headline')?.textContent ?? '').includes('새 1개는 아직 확인 전'),
      null,
      { timeout: 10000 },
    );
    const grown = await page.evaluate(() => ({
      headline: document.querySelector('.vd-headline')?.textContent?.trim() ?? '',
      text: document.body.innerText,
    }));
    check(
      '🔴 E⑬ sweep 뒤 새 파일이 늘면 headline도 확인한 것과 아직 확인 전을 함께 말한다(상위 ↔ todo 모순 금지)',
      grown.headline === '이 기기의 사진·소리: 확인한 1개는 모두 성하고, 새 1개는 아직 확인 전이에요',
      grown.headline || '(증가분 headline을 못 찾음)',
    );
    check(
      '🔴 E⑭ 증가분 headline과 하위 todo가 같은 sweep 값을 말한다',
      grown.text.includes('그때 1개 모두 열림 · 그 뒤 1개 늘었어요'),
      grown.text.match(/[^\n]*그때 1개 모두 열림 · 그 뒤 1개 늘었어요[^\n]*/)?.[0] ?? '(증가분 todo를 못 찾음)',
    );
  }
}
// ── F① ~ F⑤ 🔴 **저장소 보호: 거절 뒤에 무엇을 말하는가** (T-005) ─────────────
//
// 왜 라이브인가: 이 결함군은 **자료구조가 옳고 문장만 틀리는** 부류다(§10 ③). 그리고 이
// 자리는 실제로 그 형태로 두 번 샜다 — M-0046(찾아보지도 않고 「없다」) · M-0048(「이 기기에
// 없다」를 「없다」로 반올림). 옛 판은 표면과 무관하게 늘 *"메뉴(⋮) → 홈 화면에 추가"*라고
// 말했는데, **APK엔 그 메뉴가 없고 이미 설치한 PWA에겐 막다른 문장**이다.
//
// 🔴 이 버튼은 **파괴적이지 않다**(브라우저에 보호를 요청할 뿐 아무것도 지우지 않는다).
// 그래서 §13 4항대로 **실제로 누른다** — 헤드리스 크롬은 대개 거절하므로, 우리가 재려는
// **거절 갈래**가 바로 그려진다.
await openDiagnosticsHub(page);
const storeCard = page.locator('.guide-card-diag[data-tool="저장소 안전"]');
const hasStore = (await storeCard.count()) === 1;
check('F① 💾 「저장소 안전」 도구가 허브에 있다', hasStore, `카드 ${await storeCard.count()}개`);
if (hasStore) {
  await storeCard.click();
  await page.waitForSelector('.vd-metric-top', { timeout: 10000 }).catch(() => {});
  const before = await page.evaluate(() => document.body.innerText);
  // 🔴 앱이 아는 것을 화면에 내놓는가(§12) — 「설치는 했는데 왜 안 되지」에 답할 유일한 값이다.
  check(
    '🔴 F② **실행 표면**을 화면에 말한다(앱이 아는 것을 사람이 묻게 하지 않는다 · §12)',
    /실행 표면/.test(before) && /브라우저 탭|홈 화면에 추가된 앱|설치된 앱\(APK\)/.test(before),
    before.match(/실행 표면[^\n]*/)?.[0] ?? '(표면 줄 없음)',
  );
  // 🔴 F⑥ **한 화면이 자기와 모순되지 않는가** (M-0113 · 사용자 태블릿 캡처가 잡았다).
  //
  // 실기기에서 판정문은 「이 브라우저는 **저장 용량을 알려주지 않아요**」인데 바로 아래 줄이
  // 「**사용 0%**」였다. 자료구조는 옳았다 — `unknown`의 **이유가 여럿인데 문장이 하나**였다.
  // 유닛은 함수 하나만 보므로 이 모순을 볼 수 없다: 두 문장은 **다른 함수**가 만든다.
  // 그래서 이 층이 필요하다 — 화면은 그 둘이 만나는 유일한 자리다(§10 ③).
  const saysNoQuota = /저장 용량을 알려주지 않아요/.test(before);
  const showsPct = /사용 \d+%/.test(before);
  check(
    '🔴 F⑥ 판정문과 아래 줄이 **서로 모순되지 않는다**(용량을 모른다면서 사용률을 적지 않는다)',
    !(saysNoQuota && showsPct),
    saysNoQuota && showsPct
      ? `모순: 판정문은 「용량을 알려주지 않아요」인데 ${before.match(/사용 \d+%/)?.[0]}가 함께 나감`
      : saysNoQuota
        ? '용량 미상 — 사용률도 안 적음(일관)'
        : '용량을 알고 있음(일관)',
  );
  const askBtn = page.locator('[data-ask-persist]');
  if ((await askBtn.count()) === 1) {
    await askBtn.click();
    await page.waitForTimeout(1500);
    const after = await page.evaluate(() => ({
      text: document.body.innerText,
      enabled: !document.querySelector('[data-ask-persist]')?.disabled,
    }));
    const note = after.text.match(/[^\n]*(보호가 적용됐어요|허락하지 않았어요|기능이 없어요|거절될 수 있습니다)[^\n]*/)?.[0] ?? '';
    check('🔴 F③ 누르면 **결과 문장이 화면에 나온다**(삼키지 않는다 · §13 4항)', note !== '', note || '(결과 문장 없음)');
    // 🔴 거절도 상태다 — "안 됐다"에서 멈추지 말고 그래서 무엇을 하면 되는지까지(§7-D).
    check(
      '🔴 F④ 거절 문장이 **막다른 곳에서 끝나지 않는다** — 백업 경로가 함께 나온다(§7-D)',
      note.includes('보호가 적용됐어요') || after.text.includes('데이터 관리 › 백업'),
      note.includes('보호가 적용됐어요') ? '허락됨(해당 없음)' : after.text.includes('데이터 관리 › 백업') ? '백업 경로 있음' : '(막다른 문장)',
    );
    check('F⑤ 누른 뒤에도 버튼이 다시 눌린다(잠기지 않는다)', after.enabled, `enabled=${after.enabled}`);
  } else {
    // 이미 보호가 적용된 브라우저 — 버튼이 **없어야** 맞다. 없는 것을 실패로 세지 않는다.
    check('F③~F⑤ 보호가 이미 적용돼 요청 버튼이 없다(정상 — 침묵이 정상)', true, '버튼 없음');
  }
}

// ── G① ~ G④ 🔴 **셸(APK) 표면을 실제로 그려 본다** (M-0113) ────────────────────
//
// 🔴 **F⑥은 이 층이 없으면 공허하다.** 그 결함은 **셸 표면에서만** 났는데 헤드리스 크롬은
// 언제나 「브라우저 탭」이라, F⑥은 문제가 날 수 없는 자리에서 초록을 찍고 있었다 —
// 검사가 대상 0에서 통과하는 M-0046의 형태다(§4).
//
// 그래서 앱이 **자기를 셸이라고 믿게** 만든다: `window.Capacitor`를 심으면
// `persistSurface()`가 'shell'을 돌려주고, **실제 렌더러가 그 갈래를 그린다.**
// (판정 함수에 값을 먹이는 것이 아니라 앱 전체가 그 상태로 도는 것이라 더 강한 층이다.)
{
  const shellPage = await browser.newPage({ viewport: { width: 800, height: 1280 } });
  await shellPage.addInitScript(() => {
    Object.defineProperty(window, 'Capacitor', {
      value: { isNativePlatform: () => true, Plugins: { OriginalPhotos: {} } },
      configurable: true,
    });
  });
  await openDiagnosticsHub(shellPage);
  await shellPage.locator('.guide-card-diag[data-tool="저장소 안전"]').click();
  await shellPage.waitForSelector('.vd-metric-top', { timeout: 10000 }).catch(() => {});
  const t = await shellPage.evaluate(() => document.body.innerText);

  check(
    'G① 셸로 인식된다 — 「실행 표면 설치된 앱(APK)」',
    /실행 표면 설치된 앱\(APK\)/.test(t),
    t.match(/실행 표면[^\n]*/)?.[0] ?? '(표면 줄 없음)',
  );
  // 🔴 여기가 사용자 태블릿이 잡은 바로 그 자리다.
  check(
    '🔴 G② 용량을 아는데 「용량을 알려주지 않아요」라고 하지 않는다(M-0113 · 화면이 자기와 모순)',
    !(/저장 용량을 알려주지 않아요/.test(t) && /사용 \d+%/.test(t)),
    /저장 용량을 알려주지 않아요/.test(t) && /사용 \d+%/.test(t)
      ? `모순: 판정문 「용량을 알려주지 않아요」 + ${t.match(/사용 \d+%/)?.[0]}`
      : t.split('\n').find((l) => /재보지 못했어요|용량을 알려주지|보호를 켜면|임의로 지우지/.test(l)) ?? '(판정문 못 찾음)',
  );
  const shellBtn = shellPage.locator('[data-ask-persist]');
  if ((await shellBtn.count()) === 1) {
    await shellBtn.click();
    await shellPage.waitForTimeout(1500);
    const after = await shellPage.evaluate(() => document.body.innerText);
    // 🔴 APK에 「메뉴(⋮) → 홈 화면에 추가」를 말하면 사용자는 **없는 메뉴**를 찾아 헤맨다.
    check(
      '🔴 G③ 셸에게 「홈 화면에 추가」를 말하지 않는다(그 메뉴가 없다 · M-0048의 형태)',
      !/홈 화면에 추가/.test(after),
      /홈 화면에 추가/.test(after) ? '없는 메뉴를 안내함' : '표면에 맞는 안내',
    );
    check(
      'G④ 셸에서도 백업 경로로 끝난다(막다른 문장 금지 · §7-D)',
      after.includes('데이터 관리 › 백업') || after.includes('보호가 적용됐어요'),
      after.includes('데이터 관리 › 백업') ? '백업 경로 있음' : '허락됨(해당 없음)',
    );
  } else {
    check('G③~G④ 셸에서 보호가 이미 적용돼 요청 버튼이 없다(정상)', true, '버튼 없음');
  }
  await shellPage.close();
}

// ── H① ~ H⑤ 🔴 **허브 상단과 닫기** (사용자 지적 2026-08-06) ──────────────────
//
// 셋 다 **한 화면에서만 보이는 계약**이라 유닛으로는 원리적으로 못 본다(§17 모순 검사):
//   ① 닫기가 **온 곳으로** 돌려보내는가(자기를 닫고 연 화면이라 안 넘기면 첫 화면이 나온다)
//   ② 상단 [일괄 점검]·[결과 복사]가 **눌리고 결과 문장을 화면에 내는가**(§13 4항)
//   ③ **구조적 확인 불가가 총괄을 끌어내리지 않는가** — 셸 표면에서만 재현된다
{
  const hp = await browser.newPage({ viewport: { width: 412, height: 915 } });
  await hp.addInitScript(() => {
    Object.defineProperty(window, 'Capacitor', {
      value: { isNativePlatform: () => true, Plugins: { OriginalPhotos: {} } },
      configurable: true,
    });
  });
  await hp.goto(`http://127.0.0.1:4184${BASE}`, { waitUntil: 'networkidle' });
  await hp.waitForTimeout(400);
  await hp.getByRole('button', { name: /데이터 관리/ }).first().click();
  await hp.waitForTimeout(400);
  await hp.getByRole('button', { name: /진단 도구/ }).first().click();
  await hp.waitForSelector('[data-rollup]', { timeout: 10000 });
  await hp.waitForTimeout(3000);

  const line = await hp.locator('.vd-rollup-line').innerText();
  // 🔴 여기가 이 판의 본론: 셸에서 persist는 **구조적** 확인 불가다. 예전 판은 이 하나가
  // 총괄을 「확인하지 못한 항목이 있어요」로 끌어내려 멀쩡한 앱이 아파 보였다(§7-E).
  check(
    '🔴 H① 구조적 확인 불가가 **총괄을 끌어내리지 않는다**(사용자 지적 2026-08-06)',
    !/^확인하지 못한 항목이 있어요/.test(line.trim()),
    line.trim(),
  );
  // 그러나 **숨기지도 않는다** — 앱이 자기 시야의 경계를 개수로 말한다(§8 · §7-C).
  check(
    '🔴 H② 대신 **경계를 개수로 말한다**(판정을 숨기는 게 아니라 분류만 바꾼다)',
    /잴 수 없는 항목 \d+개/.test(line),
    line.match(/잴 수 없는 항목 \d+개/)?.[0] ?? '(경계 문구 없음)',
  );

  const recheck = hp.locator('[data-recheck-all]');
  const copyBtn = hp.locator('[data-copy-all]');
  const hasBar = (await recheck.count()) === 1 && (await copyBtn.count()) === 1;
  check('H③ 상단에 [일괄 점검]·[결과 복사]가 나란히 있다', hasBar, `점검 ${await recheck.count()} · 복사 ${await copyBtn.count()}`);
  if (hasBar) {
    await recheck.click();
    await hp.waitForTimeout(3000);
    const msg = await hp.locator('.vd-msg').innerText();
    check(
      '🔴 H④ [일괄 점검]을 누르면 **결과 문장이 화면에 나오고** 버튼이 잠기지 않는다(§13 4항)',
      /다시 쟀어요/.test(msg) && !(await hp.locator('[data-recheck-all]').isDisabled()),
      msg.trim() || '(결과 문장 없음)',
    );
  }

  // 🔴 닫기 → **온 곳(데이터 관리)** 으로. 「메인으로 튕긴다」가 사용자가 겪은 불편이다.
  await hp.locator('.guide-close').first().click();
  await hp.waitForTimeout(700);
  const backTo = await hp.evaluate(() =>
    document.querySelector('[aria-label="데이터 관리"]') ? '데이터 관리' : '(첫 화면)',
  );
  check('🔴 H⑤ 닫기가 **온 곳으로 돌려보낸다** — 첫 화면으로 튕기지 않는다', backTo === '데이터 관리', `닫은 뒤: ${backTo}`);
  await hp.close();
}

// 뒷정리 — 심은 픽스처를 지운다(§3-C, 내 상태를 남기지 않는다).
await page.evaluate(async () => {
  await new Promise((ok) => {
    const q = indexedDB.open('journey-archive');
    q.onsuccess = () => {
      const tx = q.result.transaction('localMedia', 'readwrite');
      for (const id of ['fr-live-good', 'fr-live-bad']) tx.objectStore('localMedia').delete(id);
      tx.oncomplete = ok;
      tx.onerror = ok;
    };
    q.onerror = ok;
  });
  try { localStorage.removeItem('journey.fileReality.sweep'); } catch { /* 접근 불가 환경 */ }
});

check('콘솔 에러 0', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
appServer.close();
fixServer.close();
await rm(TMP, { recursive: true, force: true });

const fails = results.filter((r) => !r.ok);
console.log(`\n${results.length - fails.length}/${results.length} PASS`);
process.exit(fails.length ? 1 : 0);
