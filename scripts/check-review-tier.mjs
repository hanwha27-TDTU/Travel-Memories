// check-review-tier.mjs — 독립 리뷰가 필요한 판인지 **diff에서 결정적으로** 판정한다.
//
// ── 왜 빈도가 아니라 범위인가 ────────────────────────────────────────────────
// 「N번당 1회」 같은 빈도 규칙은 두 가지가 동시에 나쁘다 — 색 하나 바꾼 판도 리뷰를 부르고,
// 언제 도는지가 **사람 기억에 달린다.** 그래서 diff에서 파생한다.
//
//   · 구조 마크업 · 접근성 속성 · 이벤트 배선 · 포커스/모달 · 키보드 흐름 ·
//     반응형 분기 · 레이아웃 구조 · 동적 마크업 생성 중 **하나라도** → 리뷰 필수
//   · 위 신호 0건이고 색·여백·글자 크기만                          → 면제
//   · UI 파일을 안 건드림                                          → 없음
//
// 🔴 **판정은 안전한 쪽으로 기운다.** UI 파일이 바뀌었는데 변경 줄을 하나도 못 읽으면
// 면제가 아니라 **필수**다. 못 읽은 것을 「깨끗함」으로 반올림하지 않는다(§8).
//
// ── 파서가 조용히 틀리는 자리 (실제 사고) ────────────────────────────────────
// git은 `core.quotepath` 기본값에서 **비ASCII 경로를 통째로 큰따옴표로 감싼다** — 헤더가
// `+++ b/경로`가 아니라 `+++ "b/경로"`가 된다. 어떤 파서는 그 형태를 못 알아보고도 **멈추지도
// 건너뛰지도 않고 「직전 파일」에 그 줄들을 붙였고**, 한국어 이름의 문서가 바로 앞 UI 파일의
// 변경으로 둔갑했다. 그래서 셋을 함께 한다:
//   ① `-c core.quotepath=false`로 원천에서 막는다
//   ② **모르는 형태를 만나면 던진다.** 조용히 직전 항목에 붙이지 않는다 — 기본값은 「멈춘다」다
//   ③ 창을 셋 다 본다 — 커밋됨 · `--cached` · 작업트리.
//      앞의 둘만 보면 `git add` 직후의 파일이 **어느 창에도 안 나온다**.
//
// 계약: exit 0 = 통과 · exit 1 = 위반. 판정은 종료코드로 한다(§18-A).

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 리뷰를 부르는 신호. 이름을 남기는 이유: 「무엇 때문에 필수인지」를 사람이 알아야 한다. */
export const SIGNALS = Object.freeze([
  ['구조 마크업', /<\/?[a-zA-Z][\w-]*[\s>/]|createElement|innerHTML|insertAdjacentHTML/],
  ['접근성 속성', /aria-[\w-]+|role\s*[:=]|\balt\s*=|tabIndex|tabindex/],
  ['이벤트 배선', /addEventListener|removeEventListener|\bon[A-Z]\w+\s*[:=]|\.on\(/],
  ['포커스·모달 제어', /\.focus\(|\.blur\(|showModal|closest\(|\bdialog\b|\binert\b/],
  ['키보드 흐름', /key(?:down|up|press)|['"](?:Escape|Enter|Tab|Arrow\w+)['"]/],
  ['반응형 분기', /@media|matchMedia|innerWidth|clientWidth|breakpoint/],
  ['레이아웃 구조', /(?:^|[\s;{])(?:display|position|overflow|grid-template|flex-direction|z-index)\s*:/],
  ['동적 마크업 생성', /html`|render\s*\(|template\s*[:=]/],
]);

/** 면제가 가능한 「보기만 바꾸는」 변경. 신호가 0건일 때만 본다. */
const COSMETIC = /(?:^|[\s;{])(?:color|background(?:-color)?|padding|margin|font-size|line-height|gap|border-radius|opacity)\s*:/;

/** 빈 줄·괄호만 있는 줄 — 판정에 아무 말도 보태지 않는다. */
const SAYS_NOTHING = /^[\s{}();,]*$/;

/**
 * 변경 줄 묶음에서 티어를 판정한다 — 순수 함수(자체검사가 부른다).
 *
 * @param files [{ path, lines: string[], generatedLines: string[] }]
 */
export function tierFor(files, uiMatch) {
  const ui = files.filter((f) => uiMatch(f.path));
  if (!ui.length) return { tier: 'none', why: 'UI 표면 파일이 바뀌지 않았다', signals: [] };

  const found = new Set();
  let readable = 0;
  let cosmeticOnly = true;
  let mixedGenerated = false;

  for (const f of ui) {
    // 🔴 생성 블록은 모집단에서 뺀다 — 그런데 **손으로 쓴 변경과 섞이면 여전히 필수**다.
    const hand = f.lines.filter((l) => !(f.generatedLines ?? []).includes(l));
    if ((f.generatedLines ?? []).length && hand.length) mixedGenerated = true;
    for (const line of hand) {
      // 🔴 빈 줄·괄호만 있는 줄은 **아무 말도 하지 않는다.** 이걸 「보기만 바꾸는 변경이
      // 아니다」로 세면, 색 한 줄 고치면서 빈 줄을 하나 넣은 판이 리뷰를 부른다 —
      // 실제로 첫 주입에서 그 오탐이 났다(§11 ③ 오탐은 틀린 게이트다).
      if (SAYS_NOTHING.test(line)) continue;
      readable += 1;
      for (const [name, re] of SIGNALS) if (re.test(line)) found.add(name);
      if (!COSMETIC.test(line)) cosmeticOnly = false;
    }
  }

  if (found.size) return { tier: 'required', why: `리뷰 신호 ${found.size}종`, signals: [...found], mixedGenerated };
  if (!readable) {
    // 🔴 UI 파일이 바뀌었는데 읽을 줄이 하나도 없다 — 면제가 아니라 필수다.
    return { tier: 'required', why: 'UI 파일이 바뀌었는데 변경 줄을 하나도 못 읽었다(안전한 쪽으로 기운다)', signals: [] };
  }
  if (cosmeticOnly) return { tier: 'exempt', why: '신호 0건 · 색·여백·글자 크기만', signals: [] };
  return { tier: 'required', why: '신호는 0건이나 보기만 바꾸는 변경으로 단정할 수 없다(안전한 쪽으로 기운다)', signals: [] };
}

/**
 * unified diff에서 파일별 추가/변경 줄을 뽑는다.
 * 🔴 모르는 헤더를 만나면 **던진다** — 조용히 직전 파일에 붙이지 않는다.
 */
export function parseDiff(text) {
  const files = [];
  let cur = null;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const rest = raw.slice(4).trim();
      if (rest === '/dev/null') { cur = null; continue; }
      if (rest.startsWith('"')) {
        throw new Error(`인용된 경로 헤더를 만났습니다(quotepath): ${raw} — core.quotepath=false로 다시 뽑으세요.`);
      }
      if (!rest.startsWith('b/')) throw new Error(`알 수 없는 diff 헤더 형태: ${raw}`);
      cur = { path: rest.slice(2), lines: [], generatedLines: [] };
      files.push(cur);
      continue;
    }
    if (raw.startsWith('--- ') || raw.startsWith('diff ') || raw.startsWith('index ') || raw.startsWith('@@')) continue;
    if (raw.startsWith('+') && cur) cur.lines.push(raw.slice(1));
  }
  return files;
}

// ── 자체검사(§4) ─────────────────────────────────────────────────────────────
const SELF = { pos: 0, neg: 0 };
const isUi = (p) => /^src\/ui\/.*\.(ts|css)$/.test(p) || p === 'index.html';

export function selfTest() {
  const t = (files) => tierFor(files, isUi).tier;
  if (t([{ path: 'src/ui/styles/app.css', lines: ['  color: var(--fg);', '  padding: 8px;'] }]) !== 'exempt') {
    throw new Error('SELF-TEST 실패: 색·여백만 바꾼 판을 면제로 안 봤다(오탐)');
  }
  // 🔴 실제 오탐(2026-08-09): 색 한 줄에 빈 줄이 섞이자 면제가 깨졌다.
  if (t([{ path: 'src/ui/styles/app.css', lines: ['', '.x { color: red; }', '}'] }]) !== 'exempt') {
    throw new Error('SELF-TEST 실패: 빈 줄·괄호가 섞였다고 면제를 깼다(오탐)');
  }
  if (t([{ path: 'scripts/harness.mjs', lines: ['const x = 1;'] }]) !== 'none') {
    throw new Error('SELF-TEST 실패: UI 아닌 파일을 티어에 넣었다');
  }
  SELF.neg = 3;

  const must = [
    ['접근성 속성', [{ path: 'src/ui/screens/home.ts', lines: ['  btn.setAttribute("aria-label", "닫기");'] }]],
    ['이벤트 배선', [{ path: 'src/ui/screens/home.ts', lines: ['  el.addEventListener("click", onClick);'] }]],
    ['키보드 흐름', [{ path: 'src/ui/screens/home.ts', lines: ['  if (e.key === "Escape") close();'] }]],
    ['반응형 분기', [{ path: 'src/ui/styles/app.css', lines: ['@media (max-width: 600px) {'] }]],
    ['레이아웃 구조', [{ path: 'src/ui/styles/app.css', lines: ['  display: grid;'] }]],
    ['포커스·모달', [{ path: 'src/ui/panels/x.ts', lines: ['  dlg.showModal();'] }]],
    ['구조 마크업', [{ path: 'index.html', lines: ['  <section class="hero">'] }]],
    // 🔴 UI가 바뀌었는데 읽을 줄이 없다 → 면제가 아니라 필수(안전한 쪽).
    ['읽을 줄 없음', [{ path: 'src/ui/screens/home.ts', lines: [] }]],
    // 🔴 신호는 없지만 보기만 바꾸는 것도 아니다 → 필수.
    ['정체 불명 변경', [{ path: 'src/ui/screens/home.ts', lines: ['  saveTrip(trip);'] }]],
  ];
  for (const [label, files] of must) {
    if (t(files) !== 'required') throw new Error(`SELF-TEST 실패: ${label}을(를) 필수로 안 봤다`);
    SELF.pos += 1;
  }

  // 🔴 생성 블록 제외가 **진짜 변경을 삼키지 않는가** — 섞이면 여전히 필수다.
  const mixed = [{ path: 'src/ui/screens/home.ts', lines: ['생성된 산문에 Escape가 나온다', '  el.addEventListener("click", f);'], generatedLines: ['생성된 산문에 Escape가 나온다'] }];
  const r = tierFor(mixed, isUi);
  if (r.tier !== 'required' || !r.mixedGenerated) throw new Error('SELF-TEST 실패: 생성 블록과 손편집이 섞였는데 필수로 안 봤다');
  SELF.pos += 1;
  // 생성 블록만 바뀌면 신호로 세지 않는다(그게 제외의 목적이다).
  const genOnly = [{ path: 'src/ui/screens/home.ts', lines: ['생성된 산문에 Escape가 나온다'], generatedLines: ['생성된 산문에 Escape가 나온다'] }];
  if (tierFor(genOnly, isUi).tier !== 'required') throw new Error('SELF-TEST 실패: 읽을 손편집이 0인데 면제로 반올림했다');
  SELF.pos += 1;

  // 파서: 모르는 형태는 던진다.
  let threw = false;
  try { parseDiff('+++ "b/한글.md"\n+x'); } catch { threw = true; }
  if (!threw) throw new Error('SELF-TEST 실패: 인용된 경로 헤더를 조용히 통과시켰다');
  threw = false;
  try { parseDiff('+++ weird\n+x'); } catch { threw = true; }
  if (!threw) throw new Error('SELF-TEST 실패: 알 수 없는 헤더를 조용히 통과시켰다');
  const parsed = parseDiff('diff --git a/src/ui/x.ts b/src/ui/x.ts\n--- a/src/ui/x.ts\n+++ b/src/ui/x.ts\n@@ -1 +1 @@\n+  color: red;');
  if (parsed.length !== 1 || parsed[0].lines.length !== 1) throw new Error('SELF-TEST 실패: 정상 diff를 못 읽었다');
  SELF.pos += 3;
}

selfTest();

const isMain = process.argv[1] && process.argv[1].endsWith('check-review-tier.mjs');
if (isMain) {
  const profile = JSON.parse(readFileSync(join(ROOT, 'schemas', 'release-profile.json'), 'utf8'));
  const globs = profile?.changeClasses?.uiSurface?.globs ?? [];
  if (!globs.length) {
    console.error('🔴 uiSurface.globs가 프로필에 없다 — 리뷰 티어가 볼 표면이 정의되지 않았다.');
    process.exit(1);
  }
  const res = globs.map((g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*/g, '[^/]*')}$`));
  const uiMatch = (p) => res.some((r) => r.test(p));

  // 🔴 창은 셋이다 — 커밋됨 · --cached · 작업트리. 둘만 보면 `git add` 직후가 어디에도 안 나온다.
  const git = (args) => execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // 🔴 **기준 가지가 없을 수 있다.** CI의 얕은 체크아웃(`actions/checkout` 기본값)은 PR ref만
  // 받아 `origin/main`이 아예 없다 — 실측 2026-08-09, 이 게이트가 CI에서 죽었다.
  // 없는 것을 **위반으로도 통과로도 반올림하지 않는다**(§8): 그 창을 못 쟀다고 말하고 나머지를 잰다.
  let hasBase = true;
  try { git(['rev-parse', '--verify', '--quiet', 'origin/main']); } catch { hasBase = false; }

  const windows = [
    ...(hasBase ? [['커밋됨(origin/main...HEAD)', () => git(['diff', 'origin/main...HEAD'])]] : []),
    ['스테이징(--cached)', () => git(['diff', '--cached'])],
    ['작업트리', () => git(['diff'])],
  ];
  const files = [];
  for (const [, get] of windows) {
    // 파싱 실패는 여전히 던진다 — 조용히 직전 파일에 붙이지 않는다(§1.11).
    try { files.push(...parseDiff(get())); } catch (e) {
      console.error(`🔴 diff 파싱 실패 — 조용히 넘어가지 않습니다: ${e.message}`);
      process.exit(1);
    }
  }

  const verdict = tierFor(files, uiMatch);
  console.log(`check-review-tier: ${verdict.tier.toUpperCase()} — ${verdict.why}`);
  if (verdict.signals?.length) console.log(`  · 신호: ${verdict.signals.join(' · ')}`);
  if (verdict.mixedGenerated) console.log('  · 생성 블록과 손편집이 섞였습니다 — 제외가 진짜 변경을 삼키지 않았습니다.');
  console.log(`  ↳ 자체검사 양성 ${SELF.pos}·음성 ${SELF.neg} · 창 ${windows.length}개 · UI 표면 ${globs.length}패턴`);
  if (!hasBase) {
    console.log('  ↳ 확인 불가: origin/main이 없어 **커밋된 diff는 재지 못했습니다**(얕은 체크아웃). 스테이징·작업트리만 봤습니다.');
  }
  console.log('  ↳ 정직한 한계: 리뷰가 **실제로 이뤄졌는지**는 보지 못합니다 — 필요 여부만 판정합니다.');
}
