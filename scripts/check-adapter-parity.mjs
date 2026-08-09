// check-adapter-parity.mjs — **두 AI가 다르게 알고 있지 않은지.**
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 (사용자 지적 2026-07-29)
// ─────────────────────────────────────────────────────────────────────────────
// *"협업하는데 서로 다르게 알고 있으면 안 되니까.."*
//
// 실제로 갈라져 있었다. 대조해 보니 **네 군데**였고, 가장 무거운 것은 **「완료의 정의」가
// 서로를 포함하지 않은 것**이다 — `CLAUDE.md`엔 §13(화면·버튼)이 있고 배포 확인이 없었고,
// `AGENTS.md`엔 배포 그린이 있고 §13이 없었다. 즉 *Codex는 화면을 안 보고,
// Claude는 배포 확인 없이* 「완료」라 할 수 있었다 — **M-0046이 정확히 그 형태였다.**
//
// 이제 정본은 `docs/CONSTITUTION.md` 하나이고 두 어댑터는 마커 사이에 그것을 **심어 받는다.**
// 이 게이트는 「커밋본 == 재생성본」을 강제한다(`check-registry-gen`과 같은 계약).
//
// ─────────────────────────────────────────────────────────────────────────────
// 정직한 한계
// ─────────────────────────────────────────────────────────────────────────────
// 이 게이트는 **마커 안**만 본다. 마커 **밖**(도구별 서문)에 서로 모순되는 말을 새로 적으면
// 못 잡는다 — 그건 사람이 볼 자리다. 그래서 어댑터의 도구별 부분은 **의도적으로 짧게** 두고,
// 공통 사실은 한 줄도 거기 적지 않는다(적는 순간 그게 다음 드리프트의 씨앗이다).

import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE, ADAPTERS, BEGIN, END, render } from './gen-adapters.mjs';
import { OUT as LAW_OUT, render as renderLaw } from './gen-harness-law.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 헌법에서 **절만 골라** 생성하는 문서들. 새 문서가 생기면 여기 한 줄(§7 2층). */
const GENERATED_DOCS = [
  { out: LAW_OUT, render: renderLaw, cmd: 'node scripts/gen-harness-law.mjs' },
];

/** 마커 사이만 뽑는다. 없으면 null. 순수 함수라 셀프테스트가 직접 돌린다(§4). */
export function block(text) {
  const i = text.indexOf(BEGIN);
  const j = text.indexOf(END);
  if (i < 0 || j < 0 || j < i) return null;
  return text.slice(i + BEGIN.length, j).trim();
}

// ── 셀프테스트 ──
{
  const t = `앞\n${BEGIN}\n\n본문\n\n${END}\n뒤`;
  if (block(t) !== '본문') {
    console.error('check-adapter-parity: 셀프테스트 실패 — 마커 사이를 못 뽑았다.');
    process.exit(2);
  }
  if (block('마커 없음') !== null) {
    console.error('check-adapter-parity: 셀프테스트 실패 — 마커가 없는데 null을 안 냈다.');
    process.exit(2);
  }
  // 🔴 **다르면 다르다고 해야 한다** — 이 케이스가 없으면 게이트가 공허하다.
  if (block(`${BEGIN}\nA\n${END}`) === block(`${BEGIN}\nB\n${END}`)) {
    console.error('check-adapter-parity: 셀프테스트 실패 — 다른 내용을 같다고 봤다.');
    process.exit(2);
  }
}

const constitution = readFileSync(join(ROOT, SOURCE), 'utf8');
const problems = [];
const blocks = [];

for (const f of ADAPTERS) {
  const cur = readFileSync(join(ROOT, f), 'utf8');
  const b = block(cur);
  if (b === null) {
    problems.push(`${f}: 헌법 마커(BEGIN/END)가 없습니다 — 어댑터가 공통 계약을 안 싣고 있습니다.`);
    continue;
  }
  blocks.push({ f, b });
  const expected = render(cur, constitution);
  if (expected !== cur) {
    problems.push(
      `${f}: 커밋본이 재생성본과 다릅니다 — ${SOURCE}를 고쳤거나 어댑터를 직접 고쳤습니다.\n` +
        '      → node scripts/gen-adapters.mjs 로 재생성한 뒤 함께 커밋하세요.',
    );
  }
}

// 두 어댑터끼리도 직접 대조한다. 위 검사가 각자 정본과 맞는지를 보므로 논리적으로는 따라오지만,
// **이게 사용자가 실제로 걱정한 문장**이다("서로 다르게 알고 있으면 안 된다"). 직접 재서 말한다.
if (blocks.length === ADAPTERS.length) {
  const [a, ...rest] = blocks;
  for (const r of rest) {
    if (r.b !== a.b) problems.push(`${a.f} 와 ${r.f} 의 공통 계약이 **글자 단위로 다릅니다.**`);
  }
}

// ── 헌법에서 **잘라 심는** 생성 문서들도 같은 계약을 진다 ────────────────────
// 어댑터는 정본을 통째로 싣고, 아래는 **절만 골라** 싣는다. 실어 나르는 양은 달라도
// 계약은 하나다 — 「커밋본 == 재생성본」. 새 생성 문서가 생기면 이 표에 한 줄이고
// 나머지는 따라온다(§7 2층). 표에 안 올리면 그 문서만 조용히 낡는다.
for (const gen of GENERATED_DOCS) {
  const r = gen.render(constitution);
  if (r.error) {
    problems.push(`${gen.out}: ${r.error}`);
    continue;
  }
  const cur = (() => { try { return readFileSync(join(ROOT, gen.out), 'utf8'); } catch { return null; } })();
  if (cur === null) problems.push(`${gen.out}: 생성 문서가 없습니다 — ${gen.cmd} 로 만든 뒤 커밋하세요.`);
  else if (cur !== r.text) {
    problems.push(`${gen.out}: 커밋본이 재생성본과 다릅니다 — ${SOURCE}를 고쳤거나 생성물을 직접 고쳤습니다.\n      → ${gen.cmd} 로 재생성한 뒤 함께 커밋하세요.`);
  }
}

if (problems.length) {
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('check-adapter-parity: 두 AI가 다른 계약을 읽고 있거나, 생성 문서가 정본과 갈라졌습니다.');
  process.exit(1);
}

const lines = blocks[0] ? blocks[0].b.split('\n').length : 0;
console.log(
  `check-adapter-parity: OK (셀프테스트 통과 · 어댑터 ${ADAPTERS.length}개가 ${SOURCE}의 공통 계약 ${lines}줄을 글자 단위로 동일하게 싣고 있음 · 절 발췌 생성 문서 ${GENERATED_DOCS.length}개도 재생성본과 동일)`,
);
console.log('  ↳ 정직한 한계: **마커 밖**(도구별 서문)에 새로 적은 모순은 보지 못합니다 — 그건 사람이 볼 자리입니다.');
