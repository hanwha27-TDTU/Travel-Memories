// gen-harness-law.mjs — **헌법에 흩어진 릴리스 규율을 한 문서로 모은다(생성물).**
//
// ── 왜 (사용자 지시 2026-08-09) ──────────────────────────────────────────────
// *"우리 앱에 별도 하네스 릴리스법을 하나 별도로 만들어서 통합관리하고"*
//
// 요구는 타당하다. 릴리스에 관한 규율이 헌법 안에 **네 곳으로 흩어져** 있다 —
// §18(하네스·릴리스 법) · §15(어떤 초록이 무엇을 뜻하는가) · 「완료의 정의」 · 「검증 명령」.
// 릴리스를 하려는 사람이 1000줄짜리 헌법에서 그 넷을 스스로 주워 모아야 했다.
// 게다가 이 규율들은 **다른 앱에 이식하는 것이 실제 용도**인데, 그때 줄 파일이 없었다.
//
// ── 🔴 그런데 손으로 옮겨 적지 않는다 ────────────────────────────────────────
// §2: *"어떤 사실이 2곳 이상에 나오면 하나의 레지스트리를 두고 파생물은 **재생성**한다.
// 손편집 중복 자체가 결함이다."* 이 저장소는 그 사고를 이미 겪었다 — 2026-07-29에
// CLAUDE.md와 AGENTS.md가 **네 군데 갈라져** 있었고, 그중 「완료의 정의」는 서로를
// 포함하지 않았다(Codex는 화면을 안 보고, Claude는 배포 확인 없이 「완료」라 할 수 있었다).
//
// 그래서 이 문서는 **읽기 전용 생성물**이다. 고칠 곳은 언제나 `docs/CONSTITUTION.md`이고,
// `check-adapter-parity`가 「커밋본 == 재생성본」을 강제한다(어댑터 둘과 같은 계약).
//
// 사용: node scripts/gen-harness-law.mjs        (심는다)
//       node scripts/check-adapter-parity.mjs   (드리프트 차단)

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripFrontmatter } from './gen-adapters.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE = 'docs/CONSTITUTION.md';
export const OUT = 'docs/HARNESS_RELEASE_LAW.md';

/**
 * 모을 절과 **왜 모으는가**. 🔴 이유 없는 항목은 두지 않는다 — 「릴리스 관련 같아서」로
 * 넣기 시작하면 이 문서는 헌법의 사본이 되고, 사본은 읽히지 않는다.
 *
 * `heading`은 `## `로 시작하는 절 제목의 **접두사**다(제목에 조항 번호·날짜가 붙어 자라므로
 * 전체 일치로 잡으면 헌법을 고칠 때마다 여기가 조용히 빈다 — 그건 결번이지 통과가 아니다).
 */
export const SECTIONS = Object.freeze([
  { heading: '## 하네스·릴리스 법', why: '조항 본체(§18-A~H)' },
  { heading: '## CI 실행 정책', why: '어떤 초록이 무엇을 뜻하는가(§15) — 조항이 기대는 판정 계약' },
  { heading: '## 완료의 정의', why: '릴리스 한 묶음의 순서. §18-H의 arm/close가 여기 박혀 있다' },
  { heading: '## 검증 명령', why: '실제로 치는 명령. §18-A(파이프 금지)가 여기에 걸린다' },
]);

/** 헌법에서 `## ` 절 하나를 통째로 잘라낸다. 못 찾으면 `null`(호출부가 RED로 판정). */
export function sectionOf(text, headingPrefix) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(headingPrefix));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) { end = i; break; }
  }
  return lines.slice(start, end).join('\n').trimEnd();
}

const HEADER = `---
shape: prose
shape_reason: 생성물 — 정본(docs/CONSTITUTION.md)의 절 구조를 그대로 옮긴다. 여기서 구조를 다시 세우면 정본과 갈라진다.
---
# 하네스·릴리스 법 · Bugeon Journey (통합본)

> 🔴 **이 파일은 생성물이다. 여기를 고치지 마라.**
> 정본은 \`docs/CONSTITUTION.md\`이고, 이 문서는 거기서 **릴리스에 관한 절만 모아** 심은 것이다.
> 고치려면 \`docs/CONSTITUTION.md\`를 고치고 \`node scripts/gen-harness-law.mjs\`를 돌린다.
> \`check-adapter-parity\`가 「커밋본 == 재생성본」을 강제한다(CLAUDE.md·AGENTS.md와 같은 계약).
>
> **왜 별도 문서인가**: 릴리스 규율이 헌법 안에 네 곳으로 흩어져 있어, 릴리스하려는 사람이
> 스스로 주워 모아야 했다. 그리고 이 규율들은 **다른 앱에 이식하는 것이 실제 용도**인데
> 그때 건네줄 파일이 없었다 — 이 파일 하나면 된다.
>
> **이 법의 기계층이 사는 곳**(이식할 때 함께 가져갈 것):
> \`scripts/harness.mjs\`(게이트 원장) · \`src/app/gates.ts\`(GATE_DESC·GATE_AXIS·**GATE_WORLD**) ·
> \`scripts/check-env-assumption.mjs\`(§18-G 빈 세계 시연) ·
> \`scripts/release-lock.mjs\`+\`scripts/hook-release-freeze.mjs\`(§18-H 묶음 동결) ·
> \`scripts/hook-verify-exit.mjs\`(§18-A 파이프 차단) · \`scripts/check-ci-policy.mjs\`(§15) ·
> \`schemas/release-profile.json\`(§18-F 배포 프로필).
`;

/** 통합본 전체 텍스트를 만든다 — **순수 함수**(게이트가 그대로 불러 대조한다). */
export function render(constitutionText) {
  const body = stripFrontmatter(constitutionText);
  const parts = [];
  for (const s of SECTIONS) {
    const cut = sectionOf(body, s.heading);
    if (cut === null) return { error: `정본에서 절을 찾지 못했습니다: "${s.heading}" — 제목이 바뀌었으면 SECTIONS를 함께 고치세요(조용히 빈 문서를 내지 않습니다)` };
    parts.push(cut);
  }
  return { text: `${HEADER}\n${parts.join('\n\n---\n\n')}\n` };
}

// ── 셀프테스트: 알려진 실패가 잡히는지(§4) ──────────────────────────────────
{
  const fake = ['# C', '## 하네스·릴리스 법 (§18)', 'A본문', '## CI 실행 정책 — 뜻', 'B본문',
    '## 완료의 정의 (DoD)', 'C본문', '## 검증 명령 (공통)', 'D본문', '## 문서 지도', '섞이면 안 됨'].join('\n');
  const ok = render(fake);
  const must = ['A본문', 'B본문', 'C본문', 'D본문'];
  if (ok.error || must.some((m) => !ok.text.includes(m))) {
    console.error('gen-harness-law: 셀프테스트 실패 — 절을 다 모으지 못했다.');
    process.exit(2);
  }
  // 🔴 **다음 절이 딸려 오면** 이 문서는 헌법의 사본이 된다(잘라내기가 안 된 것).
  if (ok.text.includes('섞이면 안 됨')) {
    console.error('gen-harness-law: 셀프테스트 실패 — 다음 절이 딸려 왔다(경계 판정 실패).');
    process.exit(2);
  }
  // 제목이 바뀌어 절을 못 찾으면 **조용히 빈 문서를 내지 않는다**(결번은 통과가 아니다).
  if (!render(fake.replace('## 검증 명령 (공통)', '## 검사 명령 (공통)')).error) {
    console.error('gen-harness-law: 셀프테스트 실패 — 없는 절을 조용히 통과시켰다.');
    process.exit(2);
  }
  // frontmatter가 본문에 섞이지 않는지(gen-adapters가 겪은 실측 결함과 같은 자리).
  if (render(`---\nshape: prose\n---\n${fake}`).text.includes('shape: prose\n---\n# C')) {
    console.error('gen-harness-law: 셀프테스트 실패 — 정본 frontmatter가 본문에 실려 나간다.');
    process.exit(2);
  }
}

if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const r = render(readFileSync(join(ROOT, SOURCE), 'utf8'));
  if (r.error) {
    console.error(`gen-harness-law: ${r.error}`);
    process.exit(1);
  }
  const p = join(ROOT, OUT);
  const cur = (() => { try { return readFileSync(p, 'utf8'); } catch { return null; } })();
  if (cur === r.text) console.log('gen-harness-law: 이미 최신.');
  else {
    writeFileSync(p, r.text);
    console.log(`gen-harness-law: ${OUT} 갱신됨(절 ${SECTIONS.length}개).`);
  }
}
