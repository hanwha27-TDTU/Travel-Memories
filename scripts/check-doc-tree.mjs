// check-doc-tree.mjs — 거버넌스 문서를 산문에서 **목차형**으로 옮기는 규율(TRE).
//
// ── 왜 필요한가 ──────────────────────────────────────────────────────────────
// 이 저장소 결함의 최빈형은 **모집단 결번**이다 — 목록에 있어야 할 것이 없음. 2026-08-09
// 하루에만 둘이 나왔다: `check-gate-integrity`의 모집단이 파일명 glob이라 라이브 게이트 둘을
// 통째로 빠뜨렸고, 재생성 writer에는 대응 check 원장이 아예 없었다.
//
// 산문은 **존재하는 것만 서술한다.** 없는 것을 서술하는 문장은 쓰이지 않으므로, 읽는 사람은
// 빠진 칸을 볼 방법이 없다. 형제를 나란히 세우면 빈칸이 **모양으로** 드러난다.
//
// ── 그러나 잘못 자른 트리는 산문보다 위험하다 ────────────────────────────────
// 완전해 보여서 **아무도 다시 안 센다.** 그래서 트리에 둘을 더 요구한다:
//   · **축** — 자식을 무엇으로 나눴는가. 없으면 형제가 뒤섞이고 그 순간 빈칸이 사라진다.
//   · **근거** — 이 목록이 전부인 걸 어떻게 아는가. `원장 파생` 또는 `손목록`으로 **적게 한다.**
//     「손목록」이라고 적게 강제하면, **안 적으려는 사람이 파생을 한다.**
//
// 계약: exit 0 = 통과 · exit 1 = 위반. 판정은 종료코드로 한다(§18-A).

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHAPES = Object.freeze(['tree', 'prose', 'prose-debt']);

/** governed 문서 집합 — `docs/**.md` 전부. 모집단을 손으로 적지 않는다(HRL-1). */
export function governedDocs(root) {
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(rel, e.name));
      else if (e.name.endsWith('.md')) out.push(join(rel, e.name));
    }
  };
  walk('docs');
  return out.sort();
}

/** frontmatter를 읽는다. 없으면 `null` — **미선언은 실패**이지 통과가 아니다. */
export function parseFrontmatter(text) {
  text = text.replace(/\r\n?/g, '\n');
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---\n', 3);
  if (end < 0) return null;
  const meta = {};
  for (const line of text.slice(4, end).split('\n')) {
    const m = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
    if (m) meta[m[1]] = m[2].trim();
  }
  return meta;
}

/**
 * 트리 규칙 다섯을 판정한다 — 순수 함수(자체검사가 가짜 문서로 부른다).
 *
 * 🔴 **축·근거는 「대분류 자신의 머리말」에서만 인정한다**(TRE-2.4). Medical Note의 첫 판은
 * 자식(`###`)의 축이 부모를 대신 만족시켜 **축을 지워도 초록**이었다. 판정 범위를 첫 중분류
 * 앞으로 좁히지 않으면 이 게이트는 조용히 공허해진다.
 */
export function findTreeProblems(rel, body) {
  const problems = [];
  const lines = body.split('\n');
  const majors = [];
  lines.forEach((line, i) => {
    if (/^##\s+\S/.test(line) && !/^###/.test(line)) majors.push({ title: line.slice(3).trim(), at: i });
  });
  if (!majors.length) problems.push(`${rel}: 대분류(##)가 없다 — 트리로 선언했지만 형제를 세우지 않았다`);

  majors.forEach((maj, idx) => {
    const end = idx + 1 < majors.length ? majors[idx + 1].at : lines.length;
    const slice = lines.slice(maj.at + 1, end);
    const firstChild = slice.findIndex((l) => /^###\s+\S/.test(l));
    // 머리말 = 대분류 제목 다음부터 **첫 중분류 앞**까지.
    const head = (firstChild < 0 ? slice : slice.slice(0, firstChild)).join('\n');
    const children = slice.filter((l) => /^###\s+\S/.test(l));

    if (!/축\s*:/.test(head)) problems.push(`${rel} / ${maj.title}: 대분류 머리말에 **축** 선언이 없다(자식에만 있으면 인정하지 않는다)`);
    const groundMatch = /근거\s*:\s*\**\s*(원장 파생|손목록)/.exec(head);
    if (!groundMatch) problems.push(`${rel} / ${maj.title}: 대분류 머리말에 **근거**가 없거나 값이 「원장 파생·손목록」이 아니다`);
    if (children.length === 1) problems.push(`${rel} / ${maj.title}: 자식이 하나뿐이다 — 하나로 나눈 것은 나눈 것이 아니다`);
  });

  if (!/사각지대|못 보는 것|보지 못하는/.test(body)) {
    problems.push(`${rel}: **사각지대 절**이 없다 — 무엇을 못 보는지 적지 않은 트리는 완전해 보인다`);
  }
  return problems;
}

// ── 자체검사(§4·TRE-2.4) ─────────────────────────────────────────────────────
const SELF = { pos: 0, neg: 0 };
const OK_DOC = [
  '## X-1 첫 대분류',
  '> 축: 무엇으로 나눴는가',
  '> 근거: 손목록',
  '### X-1.1 자식 하나',
  '내용',
  '### X-1.2 자식 둘',
  '내용',
  '## X-9 이 문서가 못 보는 것',
  '> 축: 원리적 한계',
  '> 근거: 손목록',
  '### X-9.1 사각지대',
  '내용',
  '### X-9.2 또 하나',
  '내용',
].join('\n');

export function selfTest() {
  if (findTreeProblems('t.md', OK_DOC).length) throw new Error('SELF-TEST 실패: 정상 트리를 걸렀다(오탐)');
  SELF.neg = 1;
  const cases = [
    // 🔴 TRE-2.4가 반드시 넣으라고 지목한 두 축 — 실제로 이 형태로 뚫린 적이 있다.
    ['축이 자식에만 있고 대분류 머리말엔 없음', OK_DOC.replace('> 축: 무엇으로 나눴는가\n', ''), '**축** 선언이 없다'],
    ['근거가 자식에만 있음', OK_DOC.replace('> 근거: 손목록\n### X-1.1', '### X-1.1\n> 근거: 손목록'), '**근거**가 없거나'],
    ['근거 값이 자유 서술', OK_DOC.replace('> 근거: 손목록\n### X-1.1', '> 근거: 대충 다 적었음\n### X-1.1'), '**근거**가 없거나'],
    ['자식이 하나뿐인 대분류', OK_DOC.replace('### X-1.2 자식 둘\n내용\n', ''), '하나로 나눈 것은'],
    ['사각지대 절 없음', OK_DOC.replace('## X-9 이 문서가 못 보는 것', '## X-9 남은 이야기').replace('### X-9.1 사각지대', '### X-9.1 기타'), '사각지대'],
    ['대분류 자체가 없음', '# 제목\n\n산문만 있다. 사각지대도 적었다.', '대분류(##)가 없다'],
  ];
  for (const [label, doc, needle] of cases) {
    if (!findTreeProblems('t.md', doc).some((p) => p.includes(needle))) throw new Error(`SELF-TEST 실패: ${label}을(를) 놓쳤다`);
    SELF.pos += 1;
  }
  // shape 파서 축
  if (parseFrontmatter('# 제목') !== null) throw new Error('SELF-TEST 실패: frontmatter 없는 문서를 선언된 것으로 읽었다');
  if (parseFrontmatter('---\nshape: tree\n---\n본문').shape !== 'tree') throw new Error('SELF-TEST 실패: shape를 못 읽었다');
  if (parseFrontmatter('---\r\nshape: prose\r\nshape_reason: 인과\r\n---\r\n본문').shape !== 'prose') {
    throw new Error('SELF-TEST 실패: Windows CRLF frontmatter를 못 읽었다');
  }
  SELF.pos += 2;
}

selfTest();

const isMain = process.argv[1] && process.argv[1].endsWith('check-doc-tree.mjs');
if (isMain) {
  const docs = governedDocs(ROOT);
  const problems = [];
  const debt = [];
  const counts = { tree: 0, prose: 0, 'prose-debt': 0 };

  for (const rel of docs) {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    const meta = parseFrontmatter(text);
    if (!meta || !meta.shape) {
      problems.push(`${rel}: shape 미선언 — 「모르는 상태」를 통과로 두지 않는다(tree·prose·prose-debt 중 하나)`);
      continue;
    }
    if (!SHAPES.includes(meta.shape)) {
      problems.push(`${rel}: shape 값이 ${SHAPES.join('·')} 중 하나가 아니다 — "${meta.shape}"`);
      continue;
    }
    counts[meta.shape] += 1;
    if (meta.shape === 'prose' && !meta.shape_reason) {
      // 🔴 사유를 요구하지 않으면 `prose`가 **부채를 영구로 세탁하는 통로**가 된다.
      problems.push(`${rel}: shape: prose에 shape_reason이 없다 — 인과가 가치인 이유를 적지 않으면 영구 면제가 된다`);
    }
    if (meta.shape === 'prose-debt') debt.push(rel);
    if (meta.shape === 'tree') problems.push(...findTreeProblems(rel, text));
  }

  if (problems.length) {
    console.error('🔴 문서 트리 규율 위반:');
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log(
    `check-doc-tree: OK (자체검사 양성 ${SELF.pos}·음성 ${SELF.neg} · 문서 ${docs.length}개 · tree ${counts.tree} · prose ${counts.prose} · 이관 부채 ${counts['prose-debt']})`,
  );
  // 🔴 **부채는 조용히 사라지지 않아야 부채다.** 요약하거나 접으면 배경 소음이 된다(TRE-2.3).
  if (debt.length) {
    console.warn(`  ⚠️ 아직 트리로 안 옮긴 문서 ${debt.length}개 — 그 문서를 손볼 일이 생기면 함께 옮깁니다:`);
    for (const rel of debt) console.warn(`     · ${rel}`);
  }
  console.log('  ↳ 정직한 한계: 축과 근거의 **내용이 옳은지**는 보지 못합니다 — 형식과 누락만 봅니다.');
}
