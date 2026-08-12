// check-hand-counts.mjs — 지시문서에 손으로 적은 게이트 개수·목록을 막는 게이트(§7 3층).
//
// 왜: 이 저장소는 "숫자를 손으로 세지 않는다"를 CLAUDE.md·스킬 헌장·gen-registry 주석에
// 세 번 적어 놓고도 **다섯 군데에서 어겼다.** 건강검진(2026-07-26) 실측:
//   · docs/HANDOFF.md 인계 요약 — 게이트 12개 나열(실제 22) · "마이그레이션 0001–0010"(실제 16) · "v0.44"(실제 0.99)
//   · .claude/skills/{gates-mechanization,sync-offline,expense-fx}-dev/SKILL.md — "12게이트"
//   · docs/STORAGE_R2_PROPOSAL.md — "harness 12게이트"
// 조항(1층)과 마커 구조(2층)는 이미 있었다. **없던 것은 이탈을 잡는 층뿐이었다.**
//
// 무엇을 보는가: **지금 이렇다고 지시하는 문서**에서 하네스 게이트 개수를 손으로 쓴 자리.
// 고치는 법은 둘 중 하나 — 숫자를 지우거나(`npm run harness`로 충분), 마커로 심는다:
//   게이트 <!--reg:gateCount-->23<!--/reg-->개   ← check-doc-counts가 실제와 대조한다
//
// 무엇을 **안** 보는가(§3 EXCLUDE 규율 — 이유를 남긴다):
//   과거 기록 문서. "그때 harness 9게이트로 통과했다"는 **참인 역사**이고, 이걸 최신값으로
//   고치면 기록이 거짓이 된다. docs/HANDOFF.md의 Phase 기록, DECISIONS·CHANGELOG·LESSONS·
//   records/ 가 여기 해당한다. HANDOFF는 한 파일에 둘이 섞여 있어 **인계 요약 블록만** 본다.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 하네스 게이트 개수를 손으로 적은 자리.
// `§4 게이트는 비공허하게`처럼 **절 번호 뒤에 오는 '게이트'**는 개수가 아니다 —
// 이 오탐을 실제로 냈다(§/# 앞 숫자를 제외한 이유). 마커 안 숫자는 사전 제거된다.
const HAND_COUNT_RE = /(?<![§#\d.])(\d+)\s*게이트|게이트\s*(?:계열\s*)?(\d+)\s*개|게이트\s*\(현재\s*(\d+)/g;

/** 줄 단위 옵트아웃. 과거 기록 한 줄에 붙인다(§3 EXCLUDE 규율 — 근거를 곁에 쓴다). */
const HIST_OPT_OUT = '<!--hist-->';

/** 마커(<!--reg:...-->값<!--/reg-->)를 지운 본문. 마커로 심은 값은 이미 대조되므로 검사 대상이 아니다. */
export function stripMarkers(text) {
  return text.replace(/<!--reg:\w+-->.*?<!--\/reg-->/g, '');
}

/** 손편집 게이트 개수 위반 목록(순수 — 자체검사가 직접 부른다). */
export function findHandCounts(text) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    if (raw.includes(HIST_OPT_OUT)) continue; // 과거 기록 — 최신값으로 고치면 기록이 거짓이 된다
    for (const m of stripMarkers(raw).matchAll(HAND_COUNT_RE)) {
      out.push({ text: m[0].trim(), value: m[1] ?? m[2] ?? m[3] });
    }
  }
  return out;
}

/** HANDOFF에서 '인계 요약' 블록만 잘라낸다(그 아래 Phase 기록은 역사라 검사 제외). */
export function handoffSummary(text) {
  const start = text.indexOf('## 🔰 인계 요약');
  if (start < 0) return null; // 헤딩이 바뀌면 조용히 통과하지 않게 호출부에서 RED
  const rest = text.slice(start + 1);
  const nextPhase = rest.search(/\n\*\*Phase /);
  return nextPhase < 0 ? rest : rest.slice(0, nextPhase);
}

// ── 비공허 자체검사: 알려진 실패를 주입해 잡히는지 먼저 증명한다(§4) ──
(() => {
  // 🔴 `stripMarkers`가 대조군에 없었다(2026-08-12 실측 — 망가뜨려도 안 잡혔다).
  //    마커 안의 값은 **생성물**이라 손편집이 아니다. 안 지우면 정상을 위반으로 잡는다.
  if (stripMarkers('앞 <!--reg:gateCount-->23<!--/reg--> 뒤') !== '앞  뒤')
    { console.error(`check-hand-counts: 자체검사 실패 — 게이트를 믿을 수 없다(§4): stripMarkers가 마커를 안 지운다.`); process.exit(2); }
  if (stripMarkers('마커 없는 산문') !== '마커 없는 산문')
    { console.error(`check-hand-counts: 자체검사 실패 — 게이트를 믿을 수 없다(§4): stripMarkers가 멀쩡한 글을 건드린다(오탐).`); process.exit(2); }
  if (findHandCounts('harness 12게이트로 통과').length !== 1)
    { console.error(`check-hand-counts: 자체검사 실패 — 게이트를 믿을 수 없다(§4): SELF-TEST 실패: "N게이트"를 못 잡음(게이트 공허).`); process.exit(2); }
  if (findHandCounts('전체 게이트(현재 12)').length !== 1)
    { console.error(`check-hand-counts: 자체검사 실패 — 게이트를 믿을 수 없다(§4): SELF-TEST 실패: "게이트(현재 N)"을 못 잡음.`); process.exit(2); }
  if (findHandCounts('게이트 20개 통과').length !== 1)
    { console.error(`check-hand-counts: 자체검사 실패 — 게이트를 믿을 수 없다(§4): SELF-TEST 실패: "게이트 N개"를 못 잡음.`); process.exit(2); }
  if (findHandCounts('게이트 <!--reg:gateCount-->23<!--/reg-->개').length !== 0)
    { console.error(`check-hand-counts: 자체검사 실패 — 게이트를 믿을 수 없다(§4): SELF-TEST 실패: 마커로 심은 값을 위반으로 오탐한다.`); process.exit(2); }
  if (findHandCounts('게이트는 비공허해야 한다').length !== 0)
    { console.error(`check-hand-counts: 자체검사 실패 — 게이트를 믿을 수 없다(§4): SELF-TEST 실패: 숫자 없는 산문을 오탐한다.`); process.exit(2); }
  if (findHandCounts('`CLAUDE.md`(§4 게이트는 비공허하게 · §6 결함군 승격)').length !== 0)
    { console.error(`check-hand-counts: 자체검사 실패 — 게이트를 믿을 수 없다(§4): SELF-TEST 실패: 절 번호 참조(§4 게이트)를 개수로 오탐한다.`); process.exit(2); }
  if (findHandCounts(`| 실제(10·28)와 어긋남 6게이트 | ${HIST_OPT_OUT}`).length !== 0)
    { console.error(`check-hand-counts: 자체검사 실패 — 게이트를 믿을 수 없다(§4): SELF-TEST 실패: 줄 단위 옵트아웃이 안 먹는다.`); process.exit(2); }
  if (findHandCounts(`옛날엔 6게이트였다\n지금은 12게이트다 ${HIST_OPT_OUT}`).length !== 1)
    { console.error(`check-hand-counts: 자체검사 실패 — 게이트를 믿을 수 없다(§4): SELF-TEST 실패: 옵트아웃이 다른 줄까지 통과시킨다.`); process.exit(2); }
  if (handoffSummary('## 🔰 인계 요약\n지금 이렇다\n**Phase 9(옛날)**: 9게이트') === null)
    { console.error(`check-hand-counts: 자체검사 실패 — 게이트를 믿을 수 없다(§4): SELF-TEST 실패: 요약 블록을 못 찾음.`); process.exit(2); }
  if (findHandCounts(handoffSummary('## 🔰 인계 요약\n지금\n**Phase 9**: 9게이트')).length !== 0)
    { console.error(`check-hand-counts: 자체검사 실패 — 게이트를 믿을 수 없다(§4): SELF-TEST 실패: Phase 기록(역사)을 검사 대상에 넣는다.`); process.exit(2); }
})();

/** 검사 대상: 지금 상태를 지시하는 문서들. */
const targets = [];

const handoffPath = join(ROOT, 'docs/HANDOFF.md');
const handoffRaw = readFileSync(handoffPath, 'utf8');
const summary = handoffSummary(handoffRaw);
if (summary === null) {
  console.error('check-hand-counts: docs/HANDOFF.md에서 "## 🔰 인계 요약" 헤딩을 찾지 못했습니다.');
  console.error('  → 헤딩을 바꿨다면 이 게이트의 handoffSummary()도 같은 커밋에서 갱신하세요.');
  console.error('  → (못 찾은 채 통과시키면 게이트가 조용히 공허해집니다.)');
  process.exit(1);
}
targets.push({ label: 'docs/HANDOFF.md (인계 요약 블록)', text: summary });

// 스킬 헌장은 전부 "지금 이렇게 하라"는 지시문서다 — 과거 기록 절이 없다.
const skillsDir = join(ROOT, '.claude/skills');
for (const d of readdirSync(skillsDir, { withFileTypes: true })) {
  const p = join(skillsDir, d.name, 'SKILL.md');
  if (d.isDirectory() && existsSync(p)) {
    targets.push({ label: `.claude/skills/${d.name}/SKILL.md`, text: readFileSync(p, 'utf8') });
  }
}

for (const rel of ['CLAUDE.md', 'README.md', 'docs/STORAGE_R2_PROPOSAL.md']) {
  const p = join(ROOT, rel);
  if (existsSync(p)) targets.push({ label: rel, text: readFileSync(p, 'utf8') });
}

const problems = [];
for (const t of targets) {
  for (const hit of findHandCounts(t.text)) {
    problems.push(`${t.label}: "${hit.text}" — 손으로 적은 게이트 개수`);
  }
}

if (problems.length > 0) {
  console.error('check-hand-counts: 지시문서에 게이트 개수를 손으로 적었습니다(반드시 낡습니다).');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('  → 숫자를 지우거나(`npm run harness`가 실제를 말한다),');
  console.error('  → 마커로 심으세요: 게이트 <!--reg:gateCount-->N<!--/reg-->개');
  console.error('  → 심은 뒤 node scripts/gen-registry.mjs 로 값을 채웁니다.');
  process.exit(1);
}

console.log(`check-hand-counts: OK — 지시문서 ${targets.length}곳에 손편집 게이트 개수 없음.`);
