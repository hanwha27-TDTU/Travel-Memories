// gen-adapters.mjs — **헌법 한 곳 → 두 어댑터에 심는다.**
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 (사용자 지적 2026-07-29)
// ─────────────────────────────────────────────────────────────────────────────
// *"CLAUDE.md와 AGENTS.md를 비교 분석해서 둘의 내용이 서로 같아지게 합쳐주세요. 상충되는
// 것도 정리하고. 왜냐하면 협업하는데 서로 다르게 알고 있으면 안 되니까.."*
//
// 대조해 보니 **네 군데가 갈라져 있었다**(`docs/CONSTITUTION.md` 상단 표). 가장 무거운 것은
// **「완료의 정의」가 서로를 포함하지 않은 것**이다 — Codex는 화면을 안 보고, Claude는 배포
// 확인 없이 「완료」라 할 수 있었다. M-0046이 정확히 그 형태였다.
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 복사가 아니라 생성인가
// ─────────────────────────────────────────────────────────────────────────────
// §1: *"어떤 사실이 2곳 이상에 나오면 하나의 레지스트리를 두고 파생물은 재생성한다.
// **손편집 중복 자체가 결함이다.**"*
//
// 그런데 **중복은 도구 제약상 불가피하다** — Claude Code는 `CLAUDE.md`를, Codex는
// `AGENTS.md`를 읽는다. 포인터만 두면 본문이 맥락에 안 들어온다. 그러면 답은 이 저장소가
// 이미 아는 것이다: **불가피한 중복은 손으로 하지 말고 기계화한다**(`gen-registry` 패턴).
//
// 사용: node scripts/gen-adapters.mjs        (심는다)
//       node scripts/check-adapter-parity.mjs (드리프트 차단)

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE = 'docs/CONSTITUTION.md';

/**
 * 문서 트리 규율의 frontmatter(`shape:` 등)는 **문서 메타이지 계약 본문이 아니다.**
 * 걷어내지 않으면 두 어댑터 머리에 `--- shape: prose-debt ---`가 실려 나가고, 그러면
 * 두 AI가 읽는 「공통 계약」에 자기 문서의 관리 메타가 섞인다(2026-08-09 실측 — 이 게이트가
 * 즉시 RED로 잡았다). 순수 함수로 두어 셀프테스트가 부를 수 있게 한다.
 */
export function stripFrontmatter(text) {
  if (!text.startsWith('---\n')) return text;
  const end = text.indexOf('\n---\n', 3);
  return end < 0 ? text : text.slice(end + 5);
}
export const BEGIN = '<!--CONSTITUTION:BEGIN — 생성됨. 고치려면 docs/CONSTITUTION.md를 고치고 node scripts/gen-adapters.mjs-->';
export const END = '<!--CONSTITUTION:END-->';

/** 어댑터 목록. 새 도구(다른 AI)가 생기면 **여기 한 줄**이고 나머지는 따라온다(§7 2층). */
export const ADAPTERS = ['CLAUDE.md', 'AGENTS.md'];

/**
 * 마커 사이를 갈아 끼운 전체 텍스트를 만든다. **순수 함수** — 게이트가 이걸 그대로 불러
 * 「커밋본 == 재생성본」을 대조한다(두 곳에 로직을 손으로 구현하면 그 순간 갈라진다).
 */
export function render(adapterText, constitutionText) {
  const i = adapterText.indexOf(BEGIN);
  const j = adapterText.indexOf(END);
  if (i < 0 || j < 0 || j < i) return null; // 마커 없음 — 호출부가 판정한다
  // 🔴 frontmatter를 **여기서** 걷는다. 호출부(생성기·검사기) 각자 걷게 두면 한쪽만 고쳐져
  // 갈라진다 — 실제로 2026-08-09에 생성기만 고쳤다가 검사기가 RED를 냈다(§7 2층).
  return adapterText.slice(0, i + BEGIN.length) + '\n\n' + stripFrontmatter(constitutionText).trim() + '\n\n' + adapterText.slice(j);
}

// ── 셀프테스트: 알려진 실패가 잡히는지(§4) ──
{
  const ok = render(`A\n${BEGIN}\n옛 내용\n${END}\nB`, '새 내용');
  // frontmatter가 계약 본문에 섞여 나가지 않는지(2026-08-09 실측 결함).
  const fm = render(`A\n${BEGIN}\n옛\n${END}\nB`, '---\nshape: prose-debt\n---\n# 계약');
  if (fm.includes('shape: prose-debt')) {
    console.error('gen-adapters: 셀프테스트 실패 — frontmatter가 어댑터 본문에 실려 나간다.');
    process.exit(2);
  }
  if (!ok || !ok.includes('새 내용') || ok.includes('옛 내용')) {
    console.error('gen-adapters: 셀프테스트 실패 — 마커 사이를 갈아 끼우지 못했다.');
    process.exit(2);
  }
  if (render('마커 없음', 'x') !== null) {
    console.error('gen-adapters: 셀프테스트 실패 — 마커가 없는데 null을 안 냈다.');
    process.exit(2);
  }
  // 앞뒤 텍스트(도구별 부분)는 **보존**되어야 한다 — 어댑터의 존재 이유다.
  if (!ok.startsWith('A\n') || !ok.endsWith('\nB')) {
    console.error('gen-adapters: 셀프테스트 실패 — 도구별 부분이 보존되지 않았다.');
    process.exit(2);
  }
}

if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const constitution = readFileSync(join(ROOT, SOURCE), 'utf8');
  const done = [];
  for (const f of ADAPTERS) {
    const p = join(ROOT, f);
    const cur = readFileSync(p, 'utf8');
    const next = render(cur, constitution);
    if (next === null) {
      console.error(`gen-adapters: ${f} 에 마커가 없습니다 — BEGIN/END를 넣으세요.`);
      process.exit(1);
    }
    if (next !== cur) {
      writeFileSync(p, next);
      done.push(f);
    }
  }
  console.log(done.length ? `gen-adapters: ${done.join(', ')} 갱신됨.` : 'gen-adapters: 이미 최신.');
}
