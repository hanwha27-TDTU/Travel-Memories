// check-constitution-gen.mjs — 헌법 파생물(src/app/constitution.gen.ts) 드리프트 게이트.
//
// 커밋된 파일이 docs/CONSTITUTION.md에서 재생성한 결과와 정확히 같은지 대조한다.
// 다르면 RED — `node scripts/gen-constitution.mjs`로 재생성 후 커밋하라는 뜻.
//
// 왜 이 게이트가 필요한가: 화면이 헌법 문장을 **손으로 옮겨 적고** 있었고, 헌법을 고쳐도
// 화면은 옛 문장을 보여줬다. 자료구조가 옳고 사용자에게 가는 문장만 틀리는 부류(§10 ③)라
// 유닛으로는 영원히 안 잡힌다.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect, render, parse, numberedItems, bulletItems, sectionBody, SRC } from './gen-constitution.mjs';
import { runSelfTest } from './gate-selftest-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src/app/constitution.gen.ts');

// ── 비공허 자체검사: 파싱과 렌더가 실제로 내용을 보고 있어야 한다 ──
runSelfTest('check-constitution-gen', () => {
  const sample = [
    '## 비타협 원칙 (목적의 일부이지, 목적과 맞바꿀 대상이 아니다)',
    '',
    '1. **하나.** 첫째 본문 `코드`.',
    '2. **둘.** 둘째 본문.',
    '',
    '## 절대 위반 금지 (§0)',
    '',
    '- 하지 마라 하나.',
    '- 하지 마라 둘.',
    '',
    '### 실행 규율',
    '',
    '1. **규율 하나.** 설명.',
  ].join('\n');

  const d = parse(sample);
  // 제목은 굵게 표시된 그대로 받는다(마침표 포함) — 헌법 문장을 임의로 다듬지 않는다.
  if (d.principles.length !== 2 || d.principles[0].title !== '하나.') {
    throw new Error(`SELF-TEST 실패: 원칙 파싱이 틀림(${JSON.stringify(d.principles)}).`);
  }
  if (d.principles[0].body !== '첫째 본문 코드.') {
    throw new Error(`SELF-TEST 실패: 마크다운 장식이 안 벗겨짐(${d.principles[0].body}).`);
  }
  if (d.neverDo.length !== 2 || d.discipline.length !== 1) {
    throw new Error('SELF-TEST 실패: §0/실행 규율 파싱이 틀림.');
  }
  // 내용이 다르면 렌더도 달라야 한다(같으면 아래 「커밋본==재생성본」 대조가 공허하다).
  const other = { ...d, neverDo: ['다른 문장'] };
  if (render(d) === render(other)) throw new Error('SELF-TEST 실패: 다른 내용이 같은 렌더로 나옴(공허).');
  // 제목이 어긋나면 **조용한 빈 목록**이 아니라 실패여야 한다.
  let threw = false;
  try {
    parse(sample.replace('### 실행 규율', '### 실행 규율(개명)'));
  } catch {
    threw = true;
  }
  if (!threw) throw new Error('SELF-TEST 실패: 절(節)을 못 찾았는데도 통과함(조용한 소실).');
  if (sectionBody(sample, '## 없는 절') !== null) throw new Error('SELF-TEST 실패: 없는 절을 찾았다고 함.');
  if (numberedItems('') .length !== 0 || bulletItems('').length !== 0) {
    throw new Error('SELF-TEST 실패: 빈 입력에서 항목이 나옴.');
  }
});

if (!existsSync(OUT)) {
  console.error('check-constitution-gen: src/app/constitution.gen.ts 없음 — node scripts/gen-constitution.mjs 먼저 실행.');
  process.exit(1);
}

const expected = render(collect());
const actual = readFileSync(OUT, 'utf8');

if (expected !== actual) {
  console.error(
    `check-constitution-gen: constitution.gen.ts가 ${SRC}와 어긋남(화면이 옛 조항을 보여주는 중).\n` +
      '  → node scripts/gen-constitution.mjs 로 재생성 후 커밋하세요.',
  );
  process.exit(1);
}

const d = collect();
console.log(
  `check-constitution-gen: OK — 비타협 원칙 ${d.principles.length}·실행 규율 ${d.discipline.length}·§0 금지 ${d.neverDo.length}가 헌법과 일치.`,
);
