// known.mjs — **이 저장소가 이미 아는 것.** 증상을 넣으면 답이 어디 적혀 있는지 말한다.
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 (2026-08-01 · M-0064 · 사용자 지시)
// ─────────────────────────────────────────────────────────────────────────────
// 사용자: *"'제 기억을 믿는 대신 기계가 물어보게 만들어야 합니다.' 이 말을 구현해보자"*
//
// 나흘을 잃은 결함의 답은 **내가 나흘 전에 코드 주석으로 적어 둔 것**이었다:
//
//   src/ui/pickOriginal.ts:
//     "앱이 못 읽는 것이 아니라, 안드로이드 13+의 사진 선택기가 앱에 넘기면서 지우는 것이다.
//      파서를 고쳐도 소용없던 이유이고 … 사진 선택기를 안 거치면 된다."
//
// 그런데 조사할 때 그 주석을 **내 가설 목록에 올리지 않았다.** 기억의 문제가 아니라
// **찾는 방법의 문제**다 — 그리고 이 저장소에는 그 자리를 메울 도구가 **없었다**:
//
//   · `npm run brief <파일>` — *"이 **파일**을 고치려면 뭘 읽어야 하나"*
//   · (없음)                 — *"이 **증상**을 이미 아는가"*   ← 여기가 비어 있었다
//
// 조사는 파일이 아니라 **증상**에서 시작한다. 그래서 이 문이 필요하다.
//
// ─────────────────────────────────────────────────────────────────────────────
// 무엇을 뒤지나 — **네 층 전부**(하나라도 빠지면 그 층의 지식이 안 보인다)
// ─────────────────────────────────────────────────────────────────────────────
//   ① 실수 원장   docs/records/coding-mistakes.md  — M-#### 단위
//   ② 결정 기록   docs/DECISIONS.md                — ADR-#### 단위
//   ③ 작업 헌장   .claude/skills/*/SKILL.md        — ## 절 단위
//   ④ 🔴 코드 주석 src/**·supabase/**·scripts/**   — **이것이 M-0064에서 빠진 층이다**
//
// ④가 핵심이다. ①~③은 문서라 "읽어야지" 하고 넘어갈 수 있지만, **답이 코드 옆에 있을 때가
// 가장 많고 가장 안 읽힌다.** 이 저장소는 🔴로 위험을 표시하는 관례가 있어 뽑아낼 수 있다.
//
// 사용:
//   npm run known 위치 사진            # 두 낱말이 다 들어간 곳이 위로
//   npm run known accept 선택기
//   node scripts/known.mjs --selftest  # 게이트가 부르는 자기점검

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 뒤질 코드 뿌리. 문서가 아닌 층 — **여기가 M-0064에서 빠졌다.** */
const CODE_ROOTS = ['src', 'scripts', 'supabase'];
const CODE_EXT = /\.(ts|mjs|js|sql)$/;

/** 한 덩어리의 지식. `where`는 사람이 바로 열 수 있는 좌표여야 한다(file:line). */
/** @typedef {{ kind: string, title: string, file: string, line: number, body: string }} Entry */

function walk(dir, out = []) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (n === 'node_modules' || n === 'dist' || n.startsWith('.')) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (CODE_EXT.test(n)) out.push(p);
  }
  return out;
}

/** `## 제목` 또는 `# 제목`으로 갈린 절들. 문서 세 층이 같은 모양을 쓴다. */
export function splitSections(text, file, kind, headingRe = /^#{2,3} (.+)$/) {
  const lines = text.split('\n');
  const out = [];
  let title = '(머리말)';
  let start = 0;
  const push = (end) => {
    const body = lines.slice(start, end).join('\n').trim();
    if (body) out.push({ kind, title, file, line: start + 1, body });
  };
  for (let i = 0; i < lines.length; i += 1) {
    const m = headingRe.exec(lines[i]);
    if (!m) continue;
    push(i);
    title = m[1].replace(/\*\*/g, '').trim();
    start = i;
  }
  push(lines.length);
  return out;
}

/**
 * 🔴가 붙은 **주석 덩어리**를 뽑는다.
 *
 * 왜 주석만인가: 코드 본문까지 넣으면 낱말이 흔해 순위가 무너진다(`accept`는 어디에나 있다).
 * 이 저장소에서 **왜 그렇게 했는지**는 거의 항상 주석에 있고, 그게 조사할 때 필요한 것이다.
 *
 * 왜 🔴만인가: 표시가 곧 *"이건 위험하다·이유가 있다"*는 저자의 선언이다. 전부 뽑으면
 * 소음이 되고, 소음이 되면 아무도 안 본다(진단 §8의 「침묵이 정상」과 같은 규율).
 */
export function extractRedComments(text, file) {
  const lines = text.split('\n');
  const isComment = (s) => /^\s*(\/\/|\*|\/\*|--)/.test(s);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes('🔴') || !isComment(lines[i])) continue;
    // 위아래로 이어진 주석 줄을 한 덩어리로 — 문장이 여러 줄에 걸쳐 있다.
    let a = i;
    while (a > 0 && isComment(lines[a - 1])) a -= 1;
    let b = i;
    while (b + 1 < lines.length && isComment(lines[b + 1])) b += 1;
    const body = lines.slice(a, b + 1).join('\n');
    const title = (lines[i].replace(/^\s*(\/\/|\*|\/\*|--)\s*/, '').replace(/\*\*/g, '').trim() || '(무제)').slice(0, 90);
    out.push({ kind: '🔴 코드 주석', title, file, line: a + 1, body });
    i = b; // 같은 덩어리를 여러 번 넣지 않는다
  }
  return out;
}

/** 네 층을 전부 모은다. */
export function collectEntries(root = ROOT) {
  /** @type {Entry[]} */
  const out = [];
  const read = (p) => {
    try {
      return readFileSync(join(root, p), 'utf8');
    } catch {
      return null;
    }
  };

  const ledger = read('docs/records/coding-mistakes.md');
  if (ledger) out.push(...splitSections(ledger, 'docs/records/coding-mistakes.md', '실수 원장'));

  const adr = read('docs/DECISIONS.md');
  if (adr) out.push(...splitSections(adr, 'docs/DECISIONS.md', '결정(ADR)'));

  const handoff = read('docs/HANDOFF.md');
  if (handoff) out.push(...splitSections(handoff, 'docs/HANDOFF.md', '인계'));

  try {
    for (const d of readdirSync(join(root, '.claude/skills'))) {
      const rel = `.claude/skills/${d}/SKILL.md`;
      const t = read(rel);
      if (t) out.push(...splitSections(t, rel, `헌장 ${d}`));
    }
  } catch {
    /* 스킬 폴더가 없으면 그 층은 비어 있다 — 아래 비공허 검사가 잡는다 */
  }

  for (const r of CODE_ROOTS) {
    for (const f of walk(join(root, r))) {
      const t = readFileSync(f, 'utf8');
      if (!t.includes('🔴')) continue;
      out.push(...extractRedComments(t, relative(root, f)));
    }
  }
  return out;
}

/**
 * 낱말이 **몇 개나** 들어갔는지로 매긴다. 전부 들어간 것이 위로.
 *
 * 일부러 단순하게 둔다 — 정교한 점수는 *왜 이게 위인지*를 사람이 못 읽는다. 「7개 중 3개」는
 * 읽을 수 있고, 읽을 수 있어야 **틀렸을 때 의심할 수 있다**(§8 — 도구는 판정을 하되 근거를 준다).
 */
export function rank(entries, terms) {
  const low = terms.map((t) => t.toLowerCase()).filter(Boolean);
  if (low.length === 0) return [];
  const scored = entries
    .map((e) => {
      const hay = `${e.title}\n${e.body}`.toLowerCase();
      const hits = low.filter((t) => hay.includes(t));
      return { ...e, hits: hits.length, matched: hits };
    })
    .filter((e) => e.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.file.localeCompare(b.file));

  // 🔴 **층마다 자리를 보장한다**(2026-08-01, 만들자마자 잡은 결함).
  //
  // 처음엔 그냥 상위 12개를 잘랐다. 그랬더니 **코드 주석이 문서에 통째로 밀려 안 보였다** —
  // 문서는 낱말이 촘촘해 3/3이 쉽게 나오고, 정렬 동률에서 `.claude/`·`docs/`가 `src/`보다
  // 앞선다. 그런데 **내가 놓쳤던 층이 바로 코드 주석이다**(M-0064). 도구가 그 층을 다시
  // 가리면 이 도구는 존재 이유를 스스로 지운다.
  //
  // 그래서 각 층에서 최소 2개를 먼저 뽑고, 남은 자리를 점수순으로 채운다.
  const LIMIT = 12;
  const MIN_PER_KIND = 2;
  const layerOf = (e) => (e.kind.startsWith('헌장') ? '헌장' : e.kind);
  const picked = [];
  const seen = new Set();
  for (const layer of ['🔴 코드 주석', '실수 원장', '결정(ADR)', '헌장', '인계']) {
    for (const e of scored.filter((x) => layerOf(x) === layer).slice(0, MIN_PER_KIND)) {
      picked.push(e);
      seen.add(e);
    }
  }
  for (const e of scored) {
    if (picked.length >= LIMIT) break;
    if (!seen.has(e)) picked.push(e);
  }
  return picked.sort((a, b) => b.hits - a.hits).slice(0, LIMIT);
}

/** 덩어리에서 낱말이 처음 나오는 줄 — 사람이 눈으로 확인할 근거 한 줄. */
function evidenceLine(body, terms) {
  const lines = body.split('\n');
  for (const t of terms) {
    const i = lines.findIndex((l) => l.toLowerCase().includes(t.toLowerCase()));
    if (i >= 0) return lines[i].replace(/^\s*(\/\/|\*|\/\*|--)\s*/, '').trim().slice(0, 160);
  }
  return lines[0]?.trim().slice(0, 160) ?? '';
}

// ── 자기점검(§4) — 게이트가 이걸 부른다 ────────────────────────────────────
export function selfTest(root = ROOT) {
  const fails = [];

  const secs = splitSections('# A\n본문a\n\n## B\n본문b\n', 'x.md', 'k', /^#{1,3} (.+)$/);
  if (secs.length !== 2) fails.push(`절 나누기가 틀렸다(${secs.length} != 2)`);

  const red = extractRedComments('// 앞줄\n// 🔴 위험하다\n// 뒷줄\nconst x = 1;\n', 'y.ts');
  if (red.length !== 1) fails.push('🔴 주석 덩어리를 못 뽑았다');
  else if (!red[0].body.includes('앞줄') || !red[0].body.includes('뒷줄')) {
    fails.push('🔴 주석의 앞뒤 줄을 덩어리로 안 묶었다');
  }
  if (extractRedComments('const x = 1; // 평범한 주석\n', 'y.ts').length !== 0) {
    fails.push('🔴 없는 주석을 뽑았다(소음)');
  }
  // 주석이 아닌 줄의 🔴(문자열·마크다운)은 뽑지 않는다 — 오탐은 틀린 게이트다(§11 ③).
  if (extractRedComments('const s = "🔴 위험";\n', 'y.ts').length !== 0) {
    fails.push('주석이 아닌 줄의 🔴을 뽑았다(오탐)');
  }

  const ranked = rank(
    [
      { kind: 'k', title: 'A', file: 'a', line: 1, body: '사진 위치 선택기' },
      { kind: 'k', title: 'B', file: 'b', line: 1, body: '사진만 있음' },
    ],
    ['사진', '위치'],
  );
  if (ranked[0]?.file !== 'a' || ranked[0]?.hits !== 2) fails.push('낱말이 더 많이 맞은 것이 위로 안 갔다');

  // 🔴 층 배분 — 문서가 코드 주석을 밀어내지 않는가(이 도구가 존재하는 이유를 지키는 검사).
  const crowd = [];
  for (let i = 0; i < 20; i += 1) {
    crowd.push({ kind: '헌장 x', title: `doc${i}`, file: `.claude/${i}.md`, line: 1, body: '사진 위치' });
  }
  crowd.push({ kind: '🔴 코드 주석', title: 'code', file: 'src/z.ts', line: 1, body: '사진 위치' });
  if (!rank(crowd, ['사진', '위치']).some((e) => e.kind === '🔴 코드 주석')) {
    fails.push('문서 20개에 밀려 코드 주석이 결과에서 사라졌다 — M-0064의 층이 다시 가려진다');
  }

  // 🔴 **대상 0에서 초록이 되지 않게.** 이 도구의 값은 「찾아 준다」인데, 층이 하나라도
  // 비면 그 층의 지식은 영원히 안 보인다 — 그리고 조용하다.
  const all = collectEntries(root);
  for (const kind of ['실수 원장', '결정(ADR)', '🔴 코드 주석']) {
    if (!all.some((e) => e.kind === kind || e.kind.startsWith(kind))) fails.push(`${kind} 층이 비었다(공허)`);
  }
  if (!all.some((e) => e.kind.startsWith('헌장'))) fails.push('헌장 층이 비었다(공허)');

  // 🔴 **M-0064를 실제로 찾아내는가** — 이 도구가 태어난 이유가 그것이다.
  // 못 찾으면 이 도구는 자기 존재 이유를 만족하지 못한다.
  const found = rank(all, ['선택기', '위치']);
  if (!found.some((e) => /pickOriginal|photo-storage|M-0064/.test(`${e.file}${e.title}${e.body}`))) {
    fails.push('M-0064의 지식(사진 선택기가 위치를 지운다)을 못 찾는다 — 이 도구의 존재 이유다');
  }
  return fails;
}

// ── 실행 ──────────────────────────────────────────────────────────────────
//
// 🔴 **직접 실행할 때만 돈다.** 처음엔 모듈 본문에 그냥 뒀는데, 게이트가 `collectEntries`를
// import하는 순간 **CLI가 같이 돌아 사용법을 뱉었다.** 도구를 남이 쓸 수 있게 만들려면
// 부수효과를 진입점 뒤에 둬야 한다 — 안 그러면 재사용하는 쪽이 매번 우회로를 만든다.
const isMain = process.argv[1] && process.argv[1].endsWith('known.mjs');
const argv = isMain ? process.argv.slice(2) : null;

if (argv === null) {
  /* import된 것 — 아무것도 하지 않는다 */
} else if (argv.includes('--selftest')) {
  const fails = selfTest();
  if (fails.length) {
    console.error('known: **자기점검 실패** — 이 도구를 믿을 수 없습니다(§4).');
    for (const f of fails) console.error(`  ✗ ${f}`);
    // 자기점검 실패는 **위반이 아니라** 「이 도구를 믿을 수 없다」이다 → exit 2(§18-G).
    process.exit(2);
  }
  console.log(`known: OK — 네 층에서 ${collectEntries().length}덩어리를 색인합니다(자기점검 9건 포함).`);
} else {
  const terms = argv.filter((a) => !a.startsWith('--'));
if (terms.length === 0) {
  console.log('사용: npm run known <낱말...>      예) npm run known 위치 사진 선택기');
  console.log('  이 저장소가 그 증상에 대해 **이미 아는 것**을 찾습니다 — 원장·ADR·헌장·🔴 주석.');
  process.exit(0);
  }

const entries = collectEntries();
const hits = rank(entries, terms);

console.log(`\n═══ 이 저장소가 이미 아는 것 ═══   (${terms.join(' · ')})\n`);
if (hits.length === 0) {
  console.log(`  ${entries.length}덩어리를 뒤졌지만 걸리는 것이 없습니다.`);
  console.log('  → **아직 모르는 문제일 수 있습니다.** 낱말을 바꿔 한 번 더 해 보고,');
  console.log('     그래도 없으면 이번에 알아낸 것을 원장(docs/records/coding-mistakes.md)에 남기세요.\n');
  process.exit(0);
}
for (const h of hits) {
  console.log(`  [${h.kind}] ${h.title}`);
  console.log(`     ${h.file}:${h.line}   (낱말 ${h.hits}/${terms.length} — ${h.matched.join(', ')})`);
  console.log(`     ↳ ${evidenceLine(h.body, h.matched)}`);
  console.log('');
}
console.log('  🔴 **위에 답이 있으면 거기서 시작하라.** 내 가설을 먼저 세우고 그걸 확인하는');
console.log('     방향으로만 뒤지면, 이미 적어 둔 답을 지나친다 — 그렇게 나흘을 쓴 적이 있다(M-0064).\n');
}
