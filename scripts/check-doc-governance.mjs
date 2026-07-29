// check-doc-governance.mjs — **지시·계약 문서가 누락 없이 등록되는가.**
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 (사용자 지시 2026-07-29)
// ─────────────────────────────────────────────────────────────────────────────
// *"문서규정 및 기준 그리고 프롬프트 등이 변경 시 CLAUDE.md와 agents.md를 비교 분석해서
// 니가 정한 방식대로 업데이트 누락되지 않게 헌법에 박아두세요."*
//
// 조항은 `docs/CONSTITUTION.md`의 **「지시·계약 문서를 바꿀 때」**에 적었다. 그런데 §7이
// 말하듯 **조항만으로는 안 지켜진다** — 이 저장소가 세 번 겪고 적어 둔 사실이다.
// `check-adapter-parity`가 「두 어댑터가 같은가」를 이미 막으므로, 이 게이트는 **그 앞단의
// 누락**을 막는다: *애초에 등록되지 않아 비교 대상에도 못 들어오는 것.*
//
// ─────────────────────────────────────────────────────────────────────────────
// 무엇을 검사하나 — 둘 다 실물로 확인된 구멍이다
// ─────────────────────────────────────────────────────────────────────────────
//  A) **모든 `docs/*.md`가 문서 지도에 있다.** 만들면서 지도에 안 적으면 다음 사람은 그 문서가
//     있는 줄도 모른다. 실측(2026-07-29): 25개 중 **4개가 빠져 있었고**, 그중
//     `DISASTER_RECOVERY.md`는 전용 감사 에이전트가 참조하는 **계약 문서**였다.
//  B) **알려진 AI 지시문 파일이 전부 어댑터로 등록돼 있다.** 새 도구(Gemini·Cursor·Copilot)의
//     지시문을 추가하면서 `ADAPTERS`에 안 넣으면, 그 AI만 **다른 계약**을 읽는다 —
//     사용자가 걱정한 바로 그 상태가 조용히 재발한다(§7: 다음 형제가 자동으로 따라오는가).
//
// ─────────────────────────────────────────────────────────────────────────────
// 정직한 한계
// ─────────────────────────────────────────────────────────────────────────────
// **내용의 모순은 못 본다.** 스킬 문서가 헌법과 반대되는 말을 해도 이 게이트는 조용하다 —
// 그건 §9 2단계(「정독 중 구멍 메우기」)에서 사람이 하는 일이다. 이 게이트가 하는 일은
// *"내용이 맞다"의 보증*이 아니라 **"등록되지 않은 지시문이 조용히 생기는 것의 차단"**이다.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS } from './gen-adapters.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONSTITUTION = join(ROOT, 'docs/CONSTITUTION.md');

/**
 * 문서 지도에 없어도 되는 `docs/*.md` — **이유를 반드시 적는다**(비면 규율이 죽는다).
 *
 * 여기 한 줄은 *"이 문서는 다음 사람이 몰라도 된다"*는 선언이다. 그러니 이유는 **왜 몰라도
 * 손해가 없는가**를 적어야 한다.
 */
const NO_MAP_REQUIRED = new Map([
  [
    'CONSTITUTION.md',
    '지도를 담고 있는 문서 자신. 자기를 자기 목록에 넣는 것은 순환이고, 두 어댑터가 이 파일을 ' +
      '통째로 싣고 있으므로 존재를 모를 수가 없다.',
  ],
  [
    'VIDEO_PROPOSAL.md',
    '**제안서**이지 계약이 아니다 — 사용자 결정 대기 중이고 채택되면 그때 ADR과 함께 지도에 ' +
      '올린다. 미채택 제안을 지도에 올리면 다음 사람이 이미 정해진 일로 읽는다.',
  ],
  [
    'STORAGE_R2_PROPOSAL.md',
    '위와 같은 부류(제안서). R2는 이미 채택돼 계약은 `DEPLOYMENT.md`·`MEDIA_PIPELINE.md`에 ' +
      '있고, 이 문서는 **그때의 검토 기록**이라 Records 계층이다.',
  ],
  [
    'PHOTO_EDITOR_PORTING.md',
    '다른 앱에서 편집기를 옮겨 온 **작업 노트**(1회성). 지금 계약은 ' +
      '`.claude/skills/photo-editor-dev`가 정본이라 지도에 올리면 정본이 둘로 보인다.',
  ],
]);

/**
 * 이 저장소가 아는 **AI 지시문 파일**들. 있으면 반드시 어댑터로 등록돼야 한다.
 *
 * 손으로 적는 목록이지만 **없는 파일은 검사하지 않으므로** 오탐이 없고, 새 도구를 도입할 때
 * 여기 한 줄을 더하는 것이 곧 "그 도구도 같은 계약을 읽게 하라"는 신호가 된다.
 */
const KNOWN_INSTRUCTION_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  'GEMINI.md',
  '.cursorrules',
  '.github/copilot-instructions.md',
];

/** 문서 지도 절만 잘라낸다. 순수 함수라 셀프테스트가 직접 돌린다(§4). */
export function docMapSection(text) {
  const m = /## 문서 지도 \(SSOT\)([\s\S]*?)(?=\n## |$)/.exec(text);
  return m ? m[1] : null;
}

/** 지도에 안 실린 문서를 고른다. */
export function unmapped(docs, mapText, excused) {
  return docs.filter((d) => !excused.has(d) && !mapText.includes(d));
}

/** 등록되지 않은 지시문 파일을 고른다. */
export function unregistered(present, adapters) {
  return present.filter((f) => !adapters.includes(f));
}

// ── 셀프테스트: 알려진 실패가 RED로 잡히는지(§4) ──
{
  const cases = [
    { n: '지도에 있으면 통과', d: ['A.md'], m: '· `A.md`(설명)', e: new Map(), want: 0 },
    { n: '🔴 지도에 없으면 잡는다', d: ['A.md'], m: '', e: new Map(), want: 1 },
    { n: '이유 있는 제외는 통과', d: ['A.md'], m: '', e: new Map([['A.md', '이유']]), want: 0 },
    { n: '🔴 여럿이면 여럿을 잡는다', d: ['A.md', 'B.md'], m: '', e: new Map(), want: 2 },
  ];
  const bad = cases.filter((c) => unmapped(c.d, c.m, c.e).length !== c.want);
  if (bad.length) {
    console.error(`check-doc-governance: 셀프테스트 실패 — 게이트가 공허함: ${bad.map((c) => c.n).join(', ')}`);
    process.exit(2);
  }
  if (unregistered(['CLAUDE.md', 'GEMINI.md'], ['CLAUDE.md']).join() !== 'GEMINI.md') {
    console.error('check-doc-governance: 셀프테스트 실패 — 미등록 지시문을 못 잡았다.');
    process.exit(2);
  }
  if (docMapSection('## 문서 지도 (SSOT)\n내용\n## 다음') !== '\n내용') {
    console.error('check-doc-governance: 셀프테스트 실패 — 문서 지도 절을 못 잘랐다.');
    process.exit(2);
  }
}

// ── 실제 검사 ──
const problems = [];
const con = readFileSync(CONSTITUTION, 'utf8');
const mapText = docMapSection(con);
if (mapText === null) {
  console.error('check-doc-governance: 헌법에 「문서 지도 (SSOT)」 절이 없습니다 — 지도 자체가 사라졌습니다.');
  process.exit(1);
}

const docs = readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md'));
for (const d of unmapped(docs, mapText, NO_MAP_REQUIRED)) {
  problems.push(
    `docs/${d}: **문서 지도에 없습니다.** 만들면서 지도에 안 적으면 다음 사람은 있는 줄도 모릅니다 — ` +
      'docs/CONSTITUTION.md의 「문서 지도」에 넣거나 NO_MAP_REQUIRED에 **이유와 함께** 등록하세요.',
  );
}
for (const d of NO_MAP_REQUIRED.keys()) {
  if (!docs.includes(d)) problems.push(`NO_MAP_REQUIRED에 없는 문서 '${d}'가 남아 있음 — 화석이 된 이유를 지우세요.`);
}

const present = KNOWN_INSTRUCTION_FILES.filter((f) => existsSync(join(ROOT, f)));
for (const f of unregistered(present, ADAPTERS)) {
  problems.push(
    `${f}: AI 지시문인데 **어댑터로 등록되지 않았습니다.** 그 도구만 다른 계약을 읽게 됩니다 — ` +
      'scripts/gen-adapters.mjs의 ADAPTERS에 넣고 마커를 심으세요.',
  );
}

if (problems.length) {
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('check-doc-governance: 등록되지 않은 지시·계약 문서가 있습니다(CONSTITUTION 「지시·계약 문서를 바꿀 때」).');
  process.exit(1);
}
console.log(
  `check-doc-governance: OK (셀프테스트 통과 · docs ${docs.length}개 중 ${docs.length - NO_MAP_REQUIRED.size}개가 지도에 · ` +
    `이유 있는 제외 ${NO_MAP_REQUIRED.size}개 · AI 지시문 ${present.length}개 전부 어댑터로 등록됨)`,
);
