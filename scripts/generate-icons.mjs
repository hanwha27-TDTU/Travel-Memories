// generate-icons.mjs — public/icons/icon.svg(SSOT)에서 PNG 아이콘 파생 생성.
// iOS는 manifest 아이콘·SVG를 무시하므로 apple-touch-icon PNG가 필수이고,
// 설치성(installability)을 위해 192/512 PNG + maskable을 함께 생성한다.
// 재생성: CHROMIUM_BIN=<경로> node scripts/generate-icons.mjs  (headless Chromium 필요)
// 산출물은 커밋한다(빌드 파이프라인에 브라우저 의존을 넣지 않기 위한 의도적 선택).
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROMIUM = process.env.CHROMIUM_BIN ?? 'chromium';
const SVG = readFileSync('public/icons/icon.svg', 'utf8');
const BG = '#3f6f78'; // tokens.css --color-accent (라이트)

const svgDataUri = `data:image/svg+xml,${encodeURIComponent(SVG)}`;

/** size×size 아이콘 페이지. maskable은 안전영역(중앙 80%)에 축소 배치 + 전면 배경. */
function page(size, { maskable = false } = {}) {
  const inner = maskable ? Math.round(size * 0.8) : size;
  const bg = maskable ? BG : 'transparent';
  return `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;width:${size}px;height:${size}px;background:${bg};
      display:grid;place-items:center;overflow:hidden}
    img{width:${inner}px;height:${inner}px}
  </style><img src="${svgDataUri}">`;
}

const OUT = [
  { file: 'public/icons/icon-192.png', size: 192 },
  { file: 'public/icons/icon-512.png', size: 512 },
  { file: 'public/icons/icon-maskable-512.png', size: 512, maskable: true },
  { file: 'public/icons/apple-touch-icon.png', size: 180 },
];

const work = mkdtempSync(join(tmpdir(), 'ja-icons-'));
try {
  for (const o of OUT) {
    const html = join(work, `${o.size}${o.maskable ? 'm' : ''}.html`);
    writeFileSync(html, page(o.size, { maskable: o.maskable ?? false }));
    execFileSync(CHROMIUM, [
      '--headless=new', '--no-sandbox', '--disable-gpu',
      '--default-background-color=00000000', // 페이지가 투명하면 PNG도 투명(모서리)
      `--window-size=${o.size},${o.size}`,
      `--screenshot=${o.file}`,
      `file://${html}`,
    ], { stdio: 'pipe' });
    console.log(`✓ ${o.file} (${o.size}px${o.maskable ? ' · maskable' : ''})`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
