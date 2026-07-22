// check-domain-wiring.mjs — DOMAIN_REGISTRY ↔ DATA_MODEL.md 대칭성 게이트
// 기대 집합을 손편집 상수로 두지 않는다(SSOT — 그 자체가 M-0001형 드리프트였다).
// 문서 SSOT(docs/DATA_MODEL.md)의 테이블 헤딩에서 기대 집합을 파생해
// 코드 레지스트리(src/domain/registry.ts)와 교차 검증한다: 서로 독립인 두 원천의
// 불일치 = 누군가 한쪽만 고친 것. 이후 Phase에서 엔티티×생명주기노드로 확장.
import { readFileSync } from 'node:fs';

/** DATA_MODEL.md에서 테이블 헤딩(## snake_case[ / snake_case][ (주석)])을 추출. */
function tablesFromDoc(md) {
  const tables = [];
  for (const m of md.matchAll(/^## ([a-z_]+(?: \/ [a-z_]+)*)(?: \(.*\))?$/gm)) {
    for (const t of m[1].split(' / ')) tables.push(t);
  }
  return tables;
}

/** registry.ts에서 table: '...' 선언을 추출. */
function tablesFromRegistry(src) {
  return [...src.matchAll(/table:\s*'([a-z_]+)'/g)].map((m) => m[1]);
}

/** 두 목록 대조. 견고한 추출기 규율: 한쪽이 비정상적으로 적으면 파서 실패로 간주. */
function compare(docTables, regTables) {
  const problems = [];
  if (docTables.length < 5) problems.push(`DATA_MODEL.md 테이블 추출 이상(${docTables.length}개) — 파서/문서 형식 확인`);
  if (regTables.length < 5) problems.push(`registry.ts 테이블 추출 이상(${regTables.length}개) — 파서/코드 형식 확인`);
  for (const t of docTables) if (!regTables.includes(t)) problems.push(`registry 누락(문서에는 있음): ${t}`);
  for (const t of regTables) if (!docTables.includes(t)) problems.push(`문서 누락(registry에는 있음): ${t}`);
  const dup = regTables.filter((t, i) => regTables.indexOf(t) !== i);
  if (dup.length) problems.push(`registry 중복: ${dup.join(', ')}`);
  return problems;
}

// ── 셀프테스트: 알려진 드리프트 주입이 RED로 잡히는지 확인(게이트 비공허) ──
const DOC_FIX = '## alpha\n본문\n## beta / gamma\n## delta (주석 · ⛔)\n## 한국어 헤딩 무시\n## epsilon\n## zeta\n';
const REG_FIX = "{ table: 'alpha' }, { table: 'beta' }, { table: 'gamma' }, { table: 'delta' }, { table: 'epsilon' }, { table: 'zeta' },";
const selfCases = [
  { name: '정합 통과', doc: DOC_FIX, reg: REG_FIX, expectClean: true },
  { name: 'registry 누락 검출', doc: DOC_FIX, reg: REG_FIX.replace("{ table: 'zeta' },", ''), expectClean: false },
  { name: '문서 누락 검출', doc: DOC_FIX.replace('## epsilon\n', ''), reg: REG_FIX, expectClean: false },
  { name: '빈 추출 = 파서 실패 검출', doc: '본문뿐', reg: REG_FIX, expectClean: false },
];
const brokenSelf = selfCases.filter(
  (c) => (compare(tablesFromDoc(c.doc), tablesFromRegistry(c.reg)).length === 0) !== c.expectClean,
);
if (brokenSelf.length) {
  console.error(`check-domain-wiring: 셀프테스트 실패 — 게이트가 공허함: ${brokenSelf.map((c) => c.name).join(', ')}`);
  process.exit(2);
}

// ── 실제 검사 ──
const docTables = tablesFromDoc(readFileSync('docs/DATA_MODEL.md', 'utf8'));
const regTables = tablesFromRegistry(readFileSync('src/domain/registry.ts', 'utf8'));
const problems = compare(docTables, regTables);

if (problems.length) {
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('check-domain-wiring: DATA_MODEL.md ↔ DOMAIN_REGISTRY 불일치(대칭 위반).');
  process.exit(1);
}
console.log(`check-domain-wiring: OK (셀프테스트 통과 · 문서↔레지스트리 ${regTables.length}개 도메인 정합)`);
