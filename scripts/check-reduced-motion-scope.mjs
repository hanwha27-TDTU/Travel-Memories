// check-reduced-motion-scope — **「움직임 줄이기」 미디어 블록 안에는 움직임만 온다.**
//
// ── 왜 (2026-08-16 · T-052의 ③ 층) ─────────────────────────────────────────────
// T-052가 이 축의 계약을 세웠다: `reduce`는 **장식(확대·전환)을 끄는 것**이지
// **정보(「지금 들려 있다」·「여기로 간다」)를 끄는 것이 아니다.** 그런데 그 계약을
// 지키는 층이 라이브 검사 두 자리뿐이었고, **CSS에서 규율이 깨지는 것은 아무도 안 봤다.**
//
// 🔴 **`@media (prefers-reduced-motion: no-preference)`는 덫이다.** 거기 넣은 선언은
// reduce 사용자에게 **통째로 사라진다.** 지금은 장식만 들어 있지만, 누가 *정보*를
// 넣는 순간(색·글자·표시 여부) 그 사용자만 조용히 못 보게 된다 — 그리고 자료구조는
// 옳으므로 유닛은 영원히 초록이다(§10 ③의 CSS판).
//
// **반대 방향도 같은 규칙이다.** `reduce` 블록에서 끄는 것도 움직임이어야 한다.
// 거기서 `display: none`을 쓰면 그건 배려가 아니라 **기능을 뺏는 것**이다(M-0177).
//
// ── 무엇을 보는가 ───────────────────────────────────────────────────────────
// 두 방향의 `prefers-reduced-motion` 블록 안 **선언의 속성 이름**만 본다.
// 움직임 속성이면 통과, 아니면 **이유와 함께 등록**돼야 통과한다(§7 — 이유 없는 제외는 결함).
//
// ── 정직한 한계 ─────────────────────────────────────────────────────────────
// 🔴 이 게이트는 *"이 선언이 장식인가"*를 못 본다 — **속성 이름**만 본다.
// `color`로 장식을 하는 것도, `transform`으로 정보를 나르는 것도 여기서는 안 보인다.
// 하는 일은 「장식만 들었다」의 보증이 아니라 **「움직임이 아닌 것이 조용히 섞이는 것의 차단」**이다.
// 판단은 예외 등록의 *이유*가 지고, 그건 사람이 읽는다.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS = 'src/ui/styles/app.css';

/**
 * 움직임 속성 — 이것만 `prefers-reduced-motion` 블록 안에 그냥 올 수 있다.
 * 🔴 목록을 넓히고 싶으면 **왜 그것이 움직임인지**를 먼저 답하라. 넓히는 순간
 * 그만큼이 검사에서 빠진다.
 */
const MOTION_PROPS = new Set([
  'transition',
  'transition-property',
  'transition-duration',
  'transition-delay',
  'transition-timing-function',
  'animation',
  'animation-name',
  'animation-duration',
  'animation-delay',
  'animation-iteration-count',
  'animation-play-state',
  'animation-timing-function',
  'transform',
  'transform-origin',
  'translate',
  'rotate',
  'scale',
  'scroll-behavior',
  'will-change',
]);

/**
 * 움직임이 아닌데 여기 있어도 되는 것 — **이유와 함께**만 등록된다(§7).
 *
 * 🔴 **비면 규율이 죽는다는 뜻이 아니라, 비어 있는 것이 기본이라는 뜻이다.**
 * 한 줄 추가할 때마다 *"reduce 사용자가 이것을 못 봐도 되는가"*를 소리 내어 읽어라.
 * 키 형식: `<선택자> { <속성> }` — 선택자는 CSS에 적힌 그대로.
 */
const NON_MOTION_ALLOWED = {
  '.trip-card:hover { box-shadow }':
    '떠오르는 그림자는 **hover 장식**이다. 「누를 수 있다」는 `.trip-card[role="button"] { cursor: pointer }`가, ' +
    '「지금 여기 있다」는 `.trip-card:focus-visible { outline: 3px solid }`가 지고 — 둘 다 ' +
    '이 블록 **밖**에 있어 reduce에서도 살아 있다(2026-08-16 실측). 그림자만 사라진다.',
};

/** `/* … *\/` 주석을 지운다 — 주석 안의 속성 이름을 선언으로 세면 오탐이다(§11 ③). */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * `prefers-reduced-motion` 미디어 블록들을 통째로 꺼낸다.
 * 중첩 `{}`를 세어 블록 끝을 찾는다 — 정규식 하나로는 첫 `}`에서 끊긴다.
 */
export function extractRmBlocks(css) {
  const src = stripComments(css);
  const out = [];
  const re = /@media\s*\(\s*prefers-reduced-motion\s*:\s*(reduce|no-preference)\s*\)\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') depth -= 1;
      i += 1;
    }
    out.push({ pref: m[1], body: src.slice(re.lastIndex, i - 1) });
  }
  return out;
}

/** 블록 본문 → `{ selector, prop }` 목록. 규칙 하나에 선언 여럿이면 전부 편다. */
export function declarationsIn(body) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const selector = m[1].trim().replace(/\s+/g, ' ');
    for (const raw of m[2].split(';')) {
      const prop = raw.split(':')[0]?.trim().toLowerCase();
      if (prop) out.push({ selector, prop });
    }
  }
  return out;
}

/** 한 CSS 본문에 대한 위반 목록. 게이트 본체와 자체검사가 **같은 함수**를 쓴다(§7 2층). */
export function violations(css, allowed = NON_MOTION_ALLOWED) {
  const problems = [];
  let seen = 0;
  for (const { pref, body } of extractRmBlocks(css)) {
    for (const { selector, prop } of declarationsIn(body)) {
      seen += 1;
      if (MOTION_PROPS.has(prop)) continue;
      const key = `${selector} { ${prop} }`;
      if (Object.prototype.hasOwnProperty.call(allowed, key)) continue;
      problems.push(
        `(prefers-reduced-motion: ${pref}) 안의 \`${key}\`는 움직임 속성이 아닙니다. ` +
          (pref === 'no-preference'
            ? '이 블록에 든 것은 **reduce 사용자에게 통째로 사라집니다** — 정보라면 밖으로 빼고, 장식이면 이유와 함께 등록하세요.'
            : '`reduce`에서 끄는 것은 **움직임**이어야 합니다 — 기능·정보를 끄면 그건 배려가 아니라 결함입니다(M-0177).'),
      );
    }
  }
  return { problems, seen };
}

// ── 자체검사 (§4 — 알려진 실패를 주입해 RED를 본 뒤에만 이 게이트를 믿는다) ──────
{
  const cases = [
    // 양성(잡아야 한다)
    ['@media (prefers-reduced-motion: no-preference) { .a { color: red; } }', 1],
    ['@media (prefers-reduced-motion: reduce) { .a { display: none; } }', 1],
    ['@media (prefers-reduced-motion: reduce) { .a { transition: none; content: "x"; } }', 1],
    // 음성(잡으면 안 된다 — 오탐은 틀린 게이트다 §11 ③)
    ['@media (prefers-reduced-motion: reduce) { .a { animation: none; } }', 0],
    ['@media (prefers-reduced-motion: no-preference) { .a { transition: transform .2s; } }', 0],
    ['@media (prefers-reduced-motion: reduce) { /* color: red */ .a { transition: none; } }', 0],
    ['@media (min-width: 620px) { .a { color: red; } }', 0], // 다른 미디어는 대상이 아니다
  ];
  for (const [css, want] of cases) {
    const got = violations(css, {}).problems.length;
    if (got !== want) {
      console.error(
        `check-reduced-motion-scope: 자체검사 실패 — 게이트를 믿을 수 없다(§4). 기대 ${want} · 실제 ${got}\n  ${css}`,
      );
      process.exit(2);
    }
  }
  // 예외 등록이 실제로 통하는지도 잰다 — 안 통하면 등록부가 장식이다.
  if (violations('@media (prefers-reduced-motion: reduce) { .a { color: red; } }', { '.a { color }': '이유' }).problems.length !== 0) {
    console.error('check-reduced-motion-scope: 자체검사 실패 — 예외 등록이 통하지 않는다(§4).');
    process.exit(2);
  }
}

const css = readFileSync(join(ROOT, CSS), 'utf8');
const { problems, seen } = violations(css);

// 🔴 **모집단을 먼저 판정한다**(§4 · §2-J ①). 블록이 하나도 없으면 이 게이트는
//    「위반 없음」이 아니라 **「아무것도 안 봤음」**이다 — 빈 배열의 every는 true다.
if (seen === 0) {
  console.error(
    `check-reduced-motion-scope: ${CSS}에서 prefers-reduced-motion 선언을 **하나도 못 찾았습니다.** ` +
      '초록이 「위반 없음」이 아니라 「안 봤음」이 되므로 실패로 닫습니다(§4).',
  );
  process.exit(1);
}

if (problems.length > 0) {
  console.error('check-reduced-motion-scope: 움직임이 아닌 선언이 있습니다.');
  for (const p of problems) console.error(`  · ${p}`);
  process.exit(1);
}

const exempt = Object.keys(NON_MOTION_ALLOWED).length;
console.log(
  `check-reduced-motion-scope: OK — prefers-reduced-motion 블록의 선언 ${seen}개가 전부 움직임 속성이거나 ` +
    `이유와 함께 등록된 예외(${exempt}건)입니다.`,
);
console.log(
  '  ↳ 정직한 한계: **속성 이름**만 봅니다 — 「이 선언이 장식인가」는 못 봅니다. ' +
    '`transform`으로 정보를 나르면 이 게이트는 조용합니다. 판단은 예외 등록의 *이유*가 지고, 그건 사람이 읽습니다.',
);
