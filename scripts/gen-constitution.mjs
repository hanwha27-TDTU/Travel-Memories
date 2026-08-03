// gen-constitution.mjs — 헌법의 「목록형 조항」을 화면이 읽을 수 있는 TS로 파생한다(§2 SSOT).
//
// 왜 필요한가: 가이드 화면이 **비타협 원칙 5·실행 규율 6·§0 금지**를 손으로 옮겨 적고 있었다.
// 그 화면은 바로 그 옆에서 *"단일 진실원 — 손편집 중복 자체가 결함"*이라고 말하고 있었다.
// 헌법을 고쳐도 화면은 옛 문장을 보여줬고, 아무도 그 어긋남을 재고 있지 않았다.
//
// SSOT = docs/CONSTITUTION.md → 파생 = src/app/constitution.gen.ts → 가이드가 읽음.
// `check-constitution-gen`이 「커밋본 == 재생성본」을 강제한다.
// 사용: node scripts/gen-constitution.mjs  (파일 갱신) / --check (표준출력만)

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SRC = 'docs/CONSTITUTION.md';
const OUT = join(ROOT, 'src/app/constitution.gen.ts');

/** 마크다운 장식을 걷어낸다(화면은 textContent로만 넣으므로 마크업이 그대로 보인다). */
export function plain(md) {
  return md
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `## 제목` / `### 제목` 아래 본문(다음 같은/상위 수준 제목 전까지)을 돌려준다. */
export function sectionBody(text, heading) {
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => l.trim() === heading);
  if (i < 0) return null;
  const level = (heading.match(/^#+/) ?? ['#'])[0].length;
  const out = [];
  for (const line of lines.slice(i + 1)) {
    const m = line.match(/^(#+)\s/);
    if (m && m[1].length <= level) break;
    out.push(line);
  }
  return out.join('\n');
}

/** `1. **제목** 본문` 꼴 항목들 → [{title, body}]. 제목이 없으면 전체가 title. */
export function numberedItems(body) {
  const out = [];
  for (const line of (body ?? '').split(/\r?\n/)) {
    const m = line.match(/^\d+\.\s+(.*)$/);
    if (!m) continue;
    const rest = m[1];
    const t = rest.match(/^\*\*(.+?)\*\*\s*(.*)$/);
    out.push(t ? { title: plain(t[1]), body: plain(t[2]) } : { title: plain(rest), body: '' });
  }
  return out;
}

/** `- 문장` 꼴 항목들 → [문장]. 인용(>)·중첩은 세지 않는다. */
export function bulletItems(body) {
  return (body ?? '')
    .split(/\r?\n/)
    .filter((l) => /^- \S/.test(l))
    .map((l) => plain(l.slice(2)));
}

/** 헌법 텍스트 → 화면이 쓸 자료구조(순수 — 게이트가 그대로 부른다). */
export function parse(text) {
  const principles = numberedItems(
    sectionBody(text, '## 비타협 원칙 (목적의 일부이지, 목적과 맞바꿀 대상이 아니다)'),
  );
  const discipline = numberedItems(sectionBody(text, '### 실행 규율'));
  const neverDo = bulletItems(sectionBody(text, '## 절대 위반 금지 (§0)'));

  // 🔴 **비어 있으면 조용히 통과시키지 않는다**(§4 — 게이트도 검사도 공허해질 수 있다).
  // 헌법의 제목 한 글자가 바뀌면 위 findIndex가 null을 돌려주고, 그러면 화면에서 조항이
  // **소리 없이 사라진다.** 그건 「빈 화면」이 아니라 「거짓말」이므로 생성 자체를 멈춘다.
  for (const [key, arr] of [['principles', principles], ['discipline', discipline], ['neverDo', neverDo]]) {
    if (arr.length === 0) {
      throw new Error(`gen-constitution: '${key}' 항목을 하나도 찾지 못했습니다 — ${SRC}의 제목이 바뀌었나요?`);
    }
  }
  return { principles, discipline, neverDo };
}

const q = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** 결정적 TS 파일 문자열(손편집 금지 헤더 포함). */
export function render(data) {
  const pairs = (items) =>
    items.map((it) => `  { title: ${q(it.title)}, body: ${q(it.body)} },`).join('\n');
  const strs = (items) => items.map((s) => `  ${q(s)},`).join('\n');
  return `// GENERATED — 손으로 편집하지 마세요. 재생성: node scripts/gen-constitution.mjs
// SSOT: ${SRC} (비타협 원칙 · 실행 규율 · §0 절대 위반 금지)
// check-constitution-gen 게이트가 이 파일이 헌법과 일치하는지(커밋본==재생성본) 검사합니다.

export interface ConstitutionItem {
  title: string;
  body: string;
}

/** 비타협 원칙 — 목적의 일부이지, 목적과 맞바꿀 대상이 아니다. */
export const PRINCIPLES: readonly ConstitutionItem[] = [
${pairs(data.principles)}
];

/** 실행 규율 — 품질은 모델이 아니라 규율에서 나온다. */
export const DISCIPLINE: readonly ConstitutionItem[] = [
${pairs(data.discipline)}
];

/** 절대 위반 금지 (§0). */
export const NEVER_DO: readonly string[] = [
${strs(data.neverDo)}
];
`;
}

/** SSOT를 읽어 파싱한다. */
export function collect() {
  return parse(readFileSync(join(ROOT, SRC), 'utf8'));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const out = render(collect());
  if (process.argv.includes('--check')) {
    process.stdout.write(out);
  } else {
    writeFileSync(OUT, out);
    console.log('gen-constitution: src/app/constitution.gen.ts 갱신됨.');
  }
}
