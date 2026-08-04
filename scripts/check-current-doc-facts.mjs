#!/usr/bin/env node
// 현재 상태 문서가 관측된 저장소 사실과 다시 갈라지는 것을 막는다.
// 역사 기록은 검사하지 않고, 현재 행동을 지시하는 문서만 대상으로 한다.

import { readFileSync, readdirSync } from 'node:fs';

export function currentDocProblems({ roadmap, dataModel, testPlan, handoff }, latestMigration) {
  const problems = [];
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
if (currentDocProblems(good, '0028').length || !currentDocProblems(injected, '0028').length) {
  console.error('check-current-doc-facts: 셀프테스트 실패 — 알려진 문서 드리프트를 잡지 못함');
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
}, latestMigration);
if (problems.length) {
  console.error('check-current-doc-facts: 현재 상태 문서 드리프트');
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exit(1);
}
console.log(`check-current-doc-facts: OK — 현재 문서가 migration ${latestMigration}·BACKLOG·릴리스 묶음과 일치`);
