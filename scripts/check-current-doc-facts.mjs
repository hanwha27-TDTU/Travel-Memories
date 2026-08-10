#!/usr/bin/env node
// 현재 상태 문서가 관측된 저장소 사실과 다시 갈라지는 것을 막는다.
// 역사 기록은 검사하지 않고, 현재 행동을 지시하는 문서만 대상으로 한다.

import { readFileSync, readdirSync } from 'node:fs';

/**
 * 도메인 원장(SYNC_DOMAINS) ↔ 문서에 쓰는 우리말 이름.
 *
 * 🔴 **새 도메인이 원장에 생기면 여기 이름을 적어야 통과한다.** 안 적으면 RED —
 * 「필수 시나리오에 소리가 없다」(TPL-9.2)가 정확히 그 형태로 생겼다. 오디오는 도메인
 * 원장에는 들어왔는데 검사 계획에는 아무도 안 넣었고, 손목록이라 빈칸이 안 보였다.
 */
export const DOMAIN_WORDS = Object.freeze({
  trip: '여행', place: '장소', moment: '순간', media: '사진', expense: '비용', audio: '소리', video: '영상',
});

/**
 * TEST_PLAN이 선언한 `tests/<층>`을 뽑는다. 선언했으면 실재해야 한다.
 *
 * 🔴 첫 판은 `[a-z]+`였고 그래서 **`tests/e2e`를 통째로 못 읽었다**(숫자가 들어 있다).
 * 하필 실재하지 않는 그 층을 못 읽으니, 게이트는 조용히 「위반 없음」을 냈을 것이다 —
 * 좁은 문자 클래스가 형제 하나를 지우는 이 저장소의 최빈형이다. 주입에서 잡혔다.
 */
export function declaredTestDirs(testPlan) {
  return [...new Set([...testPlan.matchAll(/`tests\/([a-z0-9]+)`/g)].map((m) => m[1]))];
}

/** 필수 시나리오 절(TPL-2)만 잘라낸다 — 다른 절에 낱말이 있다고 덮인 것이 아니다. */
export function scenarioSection(testPlan) {
  const start = testPlan.indexOf('## TPL-2 필수 시나리오');
  if (start < 0) return '';
  const next = testPlan.indexOf('\n## ', start + 1);
  return next < 0 ? testPlan.slice(start) : testPlan.slice(start, next);
}

/** `export const SYNC_DOMAINS = [...]` 한 줄에서만 뽑는다. 못 찾으면 던진다(조용한 0 금지). */
export function syncDomainsOf(source) {
  const m = /export const SYNC_DOMAINS\s*=\s*\[([^\]]*)\]/.exec(source);
  if (!m) throw new Error('syncPlan.ts에서 SYNC_DOMAINS 원장을 찾지 못했습니다 — 모집단 0으로 조용히 통과시키지 않습니다.');
  return [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
}

export function currentDocProblems({ roadmap, dataModel, testPlan, handoff }, latestMigration, world = {}) {
  const problems = [];
  const { testDirs = null, syncDomains = null } = world;

  // 축 ①: 선언한 검사 층이 실재하는가. 없는 디렉터리를 가리키는 문서는 사람을 헤매게 한다.
  if (testDirs) {
    for (const dir of declaredTestDirs(testPlan)) {
      if (!testDirs.includes(dir)) problems.push(`TEST_PLAN이 선언한 검사 층 tests/${dir}가 실재하지 않음 — 빈 서랍은 결번을 숨긴다`);
    }
  }
  // 축 ②: 도메인 원장 전부가 필수 시나리오에 있는가.
  if (syncDomains) {
    const section = scenarioSection(testPlan);
    for (const domain of syncDomains) {
      const word = DOMAIN_WORDS[domain];
      if (!word) { problems.push(`도메인 '${domain}'의 우리말 이름이 DOMAIN_WORDS에 없음 — 새 형제는 이름을 적어야 검사에 들어온다`); continue; }
      if (!section.includes(word)) problems.push(`필수 시나리오에 도메인 '${domain}'(${word})이 없음 — 형제 하나가 조용히 빠졌다`);
    }
  }
  const staleRoadmap = ['실제 2기기 canonical 게시/소비 왕복 검증', 'authenticated R2 왕복 실기기 검증', 'hooks 비어 있음'];
  for (const phrase of staleRoadmap) if (roadmap.includes(phrase)) problems.push(`ROADMAP에 완료된 상태 복제가 남음: ${phrase}`);
  if (!roadmap.includes('docs/BACKLOG.md')) problems.push('ROADMAP이 미완료 과제 SSOT(BACKLOG)를 가리키지 않음');
  if (!dataModel.includes(`운영·저장소 migration ${latestMigration}까지`)) problems.push(`DATA_MODEL의 운영 migration이 실제 최신 ${latestMigration}와 다름`);
  if (/운영 미적용/.test(dataModel)) problems.push('DATA_MODEL 현재 상태에 운영 미적용 표기가 남음');
  const sequence = ['버전/CHANGELOG 갱신', '앱 build', '전체 하네스+live', 'Ready PR', '병합', '즉시 배포', 'read-back'];
  let at = -1;
  for (const token of sequence) {
    const next = testPlan.indexOf(token, at + 1);
    if (next < 0) problems.push(`TEST_PLAN 릴리스 순서에 '${token}'이 없음`);
    else at = next;
  }
  if (handoff.includes('병합해두고 Actions가 못 돌게')) problems.push('HANDOFF_CODEX가 병합과 배포 분리를 지시함');
  if (/앱 버전이 v1\.64인지 확인/.test(handoff)) problems.push('HANDOFF_CODEX 시작점이 과거 고정 버전을 지시함');
  return problems;
}

const good = {
  roadmap: 'docs/BACKLOG.md가 정본',
  dataModel: '운영·저장소 migration 0028까지',
  testPlan: '버전/CHANGELOG 갱신 앱 build 전체 하네스+live Ready PR 병합 즉시 배포 read-back',
  handoff: '병합과 배포를 한 묶음으로',
};
const injected = { ...good, roadmap: `${good.roadmap} hooks 비어 있음` };
// 새 축 둘도 정상/결함 양쪽으로 주입한다(§4 — 넓힐 때 다시 공허해진다 · §11 ①).
const WORLD_OK = { testDirs: ['unit'], syncDomains: ['media', 'audio'] };
const goodPlan = { ...good, testPlan: `${good.testPlan}\n## TPL-2 필수 시나리오\n사진 소리\n## 끝\n\`tests/unit\`` };
const axisCases = [
  ['정상', goodPlan, WORLD_OK, 0],
  ['없는 검사 층 선언', { ...goodPlan, testPlan: `${goodPlan.testPlan} \`tests/e2e\`` }, WORLD_OK, 1],
  ['도메인 누락', { ...goodPlan, testPlan: goodPlan.testPlan.replace('사진 소리', '사진') }, WORLD_OK, 1],
  ['이름 없는 새 도메인', goodPlan, { ...WORLD_OK, syncDomains: ['media', 'audio', 'newthing'] }, 1],
];
const axisBroken = axisCases.filter(([, docs, w, want]) => currentDocProblems(docs, '0028', w).length !== want);
if (currentDocProblems(good, '0028').length || !currentDocProblems(injected, '0028').length || axisBroken.length) {
  console.error(`check-current-doc-facts: 셀프테스트 실패 — ${axisBroken.map((c) => c[0]).join(', ') || '알려진 문서 드리프트를 잡지 못함'}`);
  process.exit(2);
}
if (process.argv.includes('--selftest')) {
  console.log('check-current-doc-facts: 셀프테스트 통과');
  process.exit(0);
}

const migrations = readdirSync('supabase/migrations').filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
const latestMigration = migrations.at(-1)?.slice(0, 4);
if (!latestMigration) {
  console.error('check-current-doc-facts: migration 파일을 찾지 못함');
  process.exit(2);
}
const problems = currentDocProblems({
  roadmap: readFileSync('docs/ROADMAP.md', 'utf8'),
  dataModel: readFileSync('docs/DATA_MODEL.md', 'utf8'),
  testPlan: readFileSync('docs/TEST_PLAN.md', 'utf8'),
  handoff: readFileSync('docs/HANDOFF_CODEX.md', 'utf8'),
}, latestMigration, {
  testDirs: readdirSync('tests', { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name),
  // 🔴 원장은 **SYNC_DOMAINS 배열 하나**다. 첫 판은 파일의 모든 문자열을 도메인으로 읽어
  // 단계 id('roots'·'moments')까지 형제로 셌다 — 모집단을 넓게 잡는 것도 틀린 것이다.
  syncDomains: syncDomainsOf(readFileSync('src/services/syncPlan.ts', 'utf8')),
});
if (problems.length) {
  console.error('check-current-doc-facts: 현재 상태 문서 드리프트');
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exit(1);
}
console.log(`check-current-doc-facts: OK — 현재 문서가 migration ${latestMigration}·BACKLOG·릴리스 묶음과 일치`);
