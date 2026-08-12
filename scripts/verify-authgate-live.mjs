// verify-authgate-live.mjs — **로그아웃 상태의 동작 잠금을 실제 브라우저로 잰다**(T-020 · ADR-0063).
//
// 🔴 왜 별도 게이트인가: 잠금은 `isConfigured()===true`에서만 돈다. 그런데 그 값은 **빌드 시
// 환경변수로 박히고**, 이 저장소의 `dist`와 `verify-editor-live` 픽스처는 둘 다 클라우드
// 미설정이다. 그래서 `verify-editor-live`가 `screens/dataManager.ts`를 `@live-covers`로
// 덮고 있어도 **잠금 갈래에는 원리적으로 닿지 못한다** — 그 초록의 뜻은 「잠금이 옳다」가
// 아니라 **「그 갈래를 안 봤다」**이다(§17 · HANDOFF-0154).
//
// 처방은 §13 1항이다 — 실제 앱에서 그 상태를 만들 수 없으면 **값을 먹여 실제 렌더러로 그린다.**
// 여기서는 픽스처를 **가짜 Supabase 환경변수로 빌드**해 `isConfigured()`를 참으로 만들고,
// 로그인은 하지 않는다(가짜 URL이라 세션 조회가 실패 → 로그아웃 상태). 그 위에 **진짜**
// `openDataManager`를 그린다.
//
// 🔴 그리고 §4에 따라 **자기가 공허하지 않은지 먼저 판정한다**: 카드가 실제로 그려졌는가,
// 그리고 `isConfigured()`가 정말 참인가. 둘 중 하나라도 아니면 나머지를 재지 않고 실패한다 —
// 클라우드 미설정에서는 모든 카드가 열려 있는 것이 **정상**이라, 전제를 확인하지 않으면
// 이 검사는 언제나 초록이 된다.
//
// @live-covers: screens/dataManager.ts

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** 임시 산출물. 점으로 시작해 어느 게이트의 스캔에도 걸리지 않는다(진단 라이브와 같은 규율). */
const TMP = join(ROOT, '.authgatelive');
/** `npx`는 셸 shim이라 `execFileSync`의 계약이 아니다 — Windows에서 ENOENT로 층 전체가 SKIP된다(M-0091). */
const VITE = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const PORT = 4178;

let chromium;
for (const spec of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs']) {
  try { ({ chromium } = await import(spec)); break; } catch { /* 다음 후보 */ }
}
if (!chromium) {
  console.error(
    'verify-authgate-live: playwright를 찾을 수 없습니다 — 이 실행은 잠금 갈래를 **재지 않았습니다**(통과가 아닙니다).',
  );
  process.exit(2);
}

// ────────────────────────────────────────────────────────────────────────────
// 주입 픽스처 — 진짜 화면을 그린다. 값만 우리가 정한다.
// ────────────────────────────────────────────────────────────────────────────
const SRC = join(ROOT, 'src').replace(/\\/g, '/');
const FIXTURE = `
import { openDataManager } from '${SRC}/ui/screens/dataManager';
import { isConfigured } from '${SRC}/services/supabase/client';

// 검사가 전제를 직접 읽는다 — 선언이 아니라 실제 값이다(§4 비공허).
(window as unknown as { __cloudConfigured: boolean }).__cloudConfigured = isConfigured();

openDataManager({ onChanged: () => undefined, goToTrip: () => undefined });
`;

await rm(TMP, { recursive: true, force: true });
await mkdir(join(TMP, 'src'), { recursive: true });
await writeFile(
  join(TMP, 'src', 'index.html'),
  '<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>t</title></head><body><script type="module" src="./main.ts"></script></body></html>',
);
await writeFile(join(TMP, 'src', 'main.ts'), FIXTURE);
await writeFile(
  join(TMP, 'vite.config.mjs'),
  `import { defineConfig } from 'vite';\nexport default defineConfig({ root: '${join(TMP, 'src').replace(/\\/g, '/')}', base: './', build: { outDir: '${join(TMP, 'out').replace(/\\/g, '/')}', emptyOutDir: true } });\n`,
);

if (!existsSync(VITE)) {
  console.error(
    'verify-authgate-live: Vite 진입점을 찾을 수 없습니다 — 의존성이 없어 주입 페이지를 빌드하지 못했습니다.\n' +
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
    // 🔴 이 게이트의 핵심. 가짜 값이라 서버에 닿지 못하고, 그래서 **로그인되지 않은 채로**
    //    `isConfigured()`만 참이 된다 — 정확히 우리가 재려는 상태다.
    env: {
      ...process.env,
      VITE_SUPABASE_URL: 'https://authgate-live.invalid',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_authgate_live_fixture',
    },
  });
} catch (e) {
  console.error(`verify-authgate-live: 주입 페이지 빌드 실패 — ${String(e.stderr ?? e).slice(0, 400)}`);
  await rm(TMP, { recursive: true, force: true });
  process.exit(1);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.map': 'application/json' };
const server = createServer(async (req, res) => {
  let p = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\//, '') || 'index.html';
  try {
    res.writeHead(200, { 'cache-control': 'no-store', 'content-type': MIME[extname(p)] ?? 'application/octet-stream' })
      .end(await readFile(join(TMP, 'out', p)));
  } catch {
    res.writeHead(404).end('');
  }
});
await new Promise((r) => server.listen(PORT, r));

let failed = 0;
let checked = 0;
const check = (label, ok, detail = '') => {
  checked++;
  if (!ok) failed++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const page = await browser.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('.dm-tool-group', { timeout: 15000 });

  // ── 전제 두 가지. 여기서 실패하면 아래를 **재지 않는다**(§4 — 공허한 초록 차단).
  const cloudConfigured = await page.evaluate(() => window.__cloudConfigured === true);
  check('전제① 픽스처가 클라우드 설정 상태다 — 아니면 잠금 갈래에 닿지 못한다', cloudConfigured, `isConfigured()=${cloudConfigured}`);

  const cards = await page.locator('.guide-card').count();
  check('전제② 카드가 실제로 그려졌다', cards >= 5, `카드 ${cards}개`);

  if (!cloudConfigured || cards < 5) {
    console.error('\nverify-authgate-live: 전제가 무너져 잠금 판정을 재지 않았습니다 — 이건 통과가 아닙니다.');
    failed++;
  } else {
    const cardState = async (label) => {
      const btn = page.locator('.guide-card', { hasText: label }).first();
      return {
        found: (await btn.count()) > 0,
        disabled: await btn.isDisabled(),
        text: (await btn.textContent()) ?? '',
      };
    };

    // ── 열려 있어야 하는 것: 내보내기(기억을 꺼낼 마지막 문)
    const backup = await cardState('백업 (내보내기)');
    check('🔴 백업(내보내기)은 로그아웃에도 **열려 있다**', backup.found && !backup.disabled, `disabled=${backup.disabled}`);

    // ── 잠겨 있어야 하는 것 셋
    for (const label of ['복원 (가져오기)', '휴지통', '이 기기를 클라우드 최종본으로']) {
      const s = await cardState(label);
      check(`🔴 「${label}」은 로그아웃에서 **잠긴다**`, s.found && s.disabled, `found=${s.found} disabled=${s.disabled}`);
      check(`  「${label}」이 이유와 다음 행동을 말한다`, s.text.includes('로그인해야'), s.text.replace(/\s+/g, ' ').slice(0, 60));
    }

    // ── §13 4항: 라벨만 읽지 말고 **눌러 본다.** 잠긴 카드는 눌러도 상세가 열리면 안 된다.
    await page.locator('.guide-card', { hasText: '휴지통' }).first().click({ force: true });
    const detailOpened = await page.locator('.guide-detail-bar').count();
    check('🔴 잠긴 카드는 **눌러도 상세가 열리지 않는다**', detailOpened === 0, `상세바 ${detailOpened}개`);

    // ── 그리고 열린 카드는 실제로 동작해야 한다(잠금이 전부를 막아 버리면 그것도 결함이다).
    await page.locator('.guide-card', { hasText: '백업 (내보내기)' }).first().click();
    await page.waitForSelector('.guide-detail-bar', { timeout: 5000 }).catch(() => undefined);
    const backupOpened = await page.locator('.guide-detail-bar').count();
    check('🔴 열린 카드(백업)는 **눌러서 실제로 열린다**', backupOpened === 1, `상세바 ${backupOpened}개`);
  }

  check('콘솔 오류 없음', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
  server.close();
  await rm(TMP, { recursive: true, force: true });
}

console.log(`\nverify-authgate-live: ${checked - failed}/${checked} PASS`);
process.exit(failed ? 1 : 0);
