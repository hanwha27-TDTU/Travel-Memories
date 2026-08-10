// measure-live-time.mjs — 라이브 게이트의 시간이 **어디로 가는가**를 성분별로 가른다(T-016 · BGT-2).
//
// 게이트가 아니다 — harness에 배선하지 않는다. **조사 도구**이고, T-018(남은 고정 대기
// 126곳)을 할 때 같은 방법으로 다시 재기 위해 남긴다.
//
//     node scripts/measure-live-time.mjs scripts/verify-editor-live.mjs
//     (반드시 `npm run build` 다음에 — 낡은 dist를 재면 측정이 공허하다)
//
// ── 🔴 두 가지를 틀렸다가 고쳤다(다음 사람이 같은 데서 넘어지지 않게) ────────
// ① **게이트를 고쳐서 재지 않는다.** 고치면 그건 다른 측정이다. 그래서 게이트보다 **먼저**
//    playwright를 import해 감싼다 — ESM 모듈 캐시가 프로세스 안에서 공유되므로 게이트도
//    감싼 것을 쓴다.
// ② **그 공유는 「같은 specifier로 해석될 때만」 참이다.** 처음엔 이 파일을 저장소 **밖**에
//    두고 돌렸는데, 거기서는 'playwright'가 안 풀려 전역 경로로 떨어졌고 게이트는
//    node_modules 것을 썼다 — **다른 인스턴스**라 계측값이 전부 0이었다. 0을 「대기가 없다」로
//    읽을 뻔했다. 이 파일이 `scripts/`에 사는 이유가 그것이다.
//
// ── 읽는 법 ────────────────────────────────────────────────────────────────
// 페이지가 겹쳐 돌면 **성분 합이 벽시계를 넘는다**(2026-08-09 실측: 대기 137.3s / 전체 128.6s).
// 비율이 100%를 넘는 것은 오류가 아니라 **겹쳤다는 뜻**이다.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// BGT-2 계측기 — 라이브 게이트의 시간이 **어디로 가는가**를 성분별로 가른다.
// 게이트 파일을 고치지 않는다(고치면 그건 다른 측정이다). ESM 모듈 캐시가 프로세스 안에서
// 공유되므로, 게이트보다 **먼저** playwright를 import해 감싸면 게이트도 감싼 것을 쓴다.
let chromium;
for (const spec of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs']) {
  try { ({ chromium } = await import(spec)); break; } catch { /* 다음 후보 */ }
}
if (!chromium) { console.error('playwright 없음'); process.exit(2); }

const t0 = Date.now();
const stat = {
  launchMs: 0, launches: 0,
  gotoMs: 0, gotos: 0,
  sleepMs: 0, sleeps: 0,
  waitForMs: 0, waitFors: 0,
  evalMs: 0, evals: 0,
};

const origLaunch = chromium.launch.bind(chromium);
chromium.launch = async (...a) => {
  const s = Date.now();
  const browser = await origLaunch(...a);
  stat.launchMs += Date.now() - s; stat.launches += 1;

  const wrapPage = (page) => {
    for (const [name, bucket, count] of [
      ['goto', 'gotoMs', 'gotos'],
      ['waitForTimeout', 'sleepMs', 'sleeps'],
      ['waitForFunction', 'waitForMs', 'waitFors'],
      ['waitForSelector', 'waitForMs', 'waitFors'],
      ['evaluate', 'evalMs', 'evals'],
    ]) {
      const orig = page[name];
      if (typeof orig !== 'function') continue;
      page[name] = async (...args) => {
        const s2 = Date.now();
        try { return await orig.apply(page, args); }
        finally { stat[bucket] += Date.now() - s2; stat[count] += 1; }
      };
    }
    return page;
  };

  const origNewPage = browser.newPage.bind(browser);
  browser.newPage = async (...a2) => wrapPage(await origNewPage(...a2));
  const origNewContext = browser.newContext.bind(browser);
  browser.newContext = async (...a2) => {
    const ctx = await origNewContext(...a2);
    const origCtxNewPage = ctx.newPage.bind(ctx);
    ctx.newPage = async (...a3) => wrapPage(await origCtxNewPage(...a3));
    return ctx;
  };
  return browser;
};

function report() {
  const total = Date.now() - t0;
  const pct = (x) => `${((x / total) * 100).toFixed(1)}%`;
  console.error('\n════ BGT-2 성분별 실측 ════');
  console.error(`전체 벽시계            ${(total / 1000).toFixed(1)}s`);
  console.error(`① 브라우저 띄우기      ${(stat.launchMs / 1000).toFixed(1)}s (${pct(stat.launchMs)}) · ${stat.launches}회`);
  console.error(`② 페이지 열기(goto)    ${(stat.gotoMs / 1000).toFixed(1)}s (${pct(stat.gotoMs)}) · ${stat.gotos}회`);
  console.error(`🔴 고정 대기(sleep)    ${(stat.sleepMs / 1000).toFixed(1)}s (${pct(stat.sleepMs)}) · ${stat.sleeps}회`);
  console.error(`④ 내용 기다리기        ${(stat.waitForMs / 1000).toFixed(1)}s (${pct(stat.waitForMs)}) · ${stat.waitFors}회`);
  console.error(`⑤ evaluate(앱 안 실행) ${(stat.evalMs / 1000).toFixed(1)}s (${pct(stat.evalMs)}) · ${stat.evals}회`);
  const known = stat.launchMs + stat.gotoMs + stat.sleepMs + stat.waitForMs + stat.evalMs;
  console.error(`나머지(계측 밖)        ${((total - known) / 1000).toFixed(1)}s (${pct(total - known)})`);
}
const origExit = process.exit.bind(process);
process.exit = (code) => { report(); origExit(code); };
process.on('exit', () => {});

const targetArg = process.argv[2];
if (!targetArg) {
  console.error('사용법: node scripts/measure-live-time.mjs scripts/verify-editor-live.mjs');
  process.exit(2);
}
const target = resolve(targetArg);
if (!existsSync(target)) {
  console.error(`[계측] 대상 파일이 없습니다: ${target}`);
  process.exit(2);
}
process.argv = [process.argv[0], target];
try {
  await import(pathToFileURL(target).href);
} catch (e) {
  console.error('[계측] 게이트가 예외로 끝남:', e?.message);
  // 대상이 띄운 HTTP 서버가 살아 있어도 실패는 즉시 종료해야 한다. exitCode만 설정하면
  // 이벤트 루프가 비지 않아 계측기가 영원히 매달린다(실제 T-018 실패 조사에서 재현).
  process.exit(1);
}
report();
