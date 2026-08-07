#!/usr/bin/env node
// check-sync-parallelism — 동기화가 독립 도메인을 직렬로 되돌리지 않는지, 직렬 경계에 구체적
// FK 사유가 있는지, 실패 시 병렬 형제를 전부 정산하는지 검사한다(헌법 §18-C · M-0122).

import { readFileSync } from 'node:fs';

const PLAN = 'src/services/syncPlan.ts';
const SYNC = 'src/services/sync.ts';

function between(src, start, end) {
  const from = src.indexOf(start);
  const to = src.indexOf(end, from + start.length);
  return from >= 0 && to > from ? src.slice(from, to) : '';
}

export function parallelismProblems(planSrc, syncSrc) {
  const problems = [];
  const push = between(planSrc, 'export const PUSH_SYNC_PLAN', 'export const PULL_SYNC_PLAN');
  const pull = between(planSrc, 'export const PULL_SYNC_PLAN', 'export async function runSyncPlan');
  const reasons = [...push.matchAll(/reason:\s*\n?\s*'([^']+)'/g)].map((match) => match[1]);

  if (!/id:\s*'roots'[\s\S]*?domains:\s*\['trip',\s*'place'\]/.test(push)) {
    problems.push('push roots는 서로 독립인 trip+place 병렬 그룹이어야 한다');
  }
  if (!/id:\s*'moments'[\s\S]*?domains:\s*\['moment'\]/.test(push)) {
    problems.push('moment는 부모 그룹 다음의 단일 FK 경계여야 한다');
  }
  if (!/id:\s*'moment-children'[\s\S]*?domains:\s*\['media',\s*'expense',\s*'audio'\]/.test(push)) {
    problems.push('media+expense+audio는 moment 다음 병렬 자식 그룹이어야 한다');
  }
  if (reasons.length !== 2 || reasons.some((reason) => reason.length < 40 || !reason.includes('복합 FK'))) {
    problems.push('두 직렬 경계마다 구체적인 복합 FK 사유를 40자 이상 적어야 한다');
  }
  if (!/id:\s*'all-domains'[\s\S]*?domains:\s*SYNC_DOMAINS/.test(pull)) {
    problems.push('pull은 결과 의존성이 없는 여섯 도메인을 한 병렬 그룹으로 실행해야 한다');
  }
  if (!planSrc.includes('Promise.allSettled(')) {
    problems.push('병렬 단계는 실패해도 모든 형제를 정산하는 Promise.allSettled를 써야 한다');
  }
  if (/Promise\.all\s*\(/.test(planSrc)) {
    problems.push('Promise.all 조기 reject는 형제 쓰기를 뒤에 남길 수 있어 동기화 단계에 쓸 수 없다');
  }
  if (!syncSrc.includes('runSyncPlan(PUSH_SYNC_PLAN') || !syncSrc.includes('runSyncPlan(PULL_SYNC_PLAN')) {
    problems.push('sync.ts의 push와 pull이 선언된 실행 계획을 실제로 소비해야 한다');
  }
  if (/const\s+(trip|place|moment|media|expense|audio)\s*=\s*await\s+(pushPending|pull)/.test(syncSrc)) {
    problems.push('도메인별 await 직렬 실행이 sync.ts에 다시 생겼다');
  }
  return problems;
}

// 셀프테스트: 원래 결함(전 도메인 직렬화), 사유 누락, 조기 reject를 각각 주입해 RED인지 확인.
const goodPlan = `
export const PUSH_SYNC_PLAN = [
 { id: 'roots', domains: ['trip', 'place'], waitsFor: null },
 { id: 'moments', domains: ['moment'], waitsFor: { reason:
 'moments 복합 FK 때문에 부모 여행과 장소가 서버에 먼저 존재해야 하므로 이 경계만 직렬로 기다린다.' } },
 { id: 'moment-children', domains: ['media', 'expense', 'audio'], waitsFor: { reason:
 '자식 복합 FK 때문에 서버 순간의 착지와 read-back이 끝나야 하므로 이 경계만 직렬로 기다린다.' } },
];
export const PULL_SYNC_PLAN = [{ id: 'all-domains', domains: SYNC_DOMAINS, waitsFor: null }];
export async function runSyncPlan() { await Promise.allSettled([]); }
`;
const goodSync = 'runSyncPlan(PUSH_SYNC_PLAN); runSyncPlan(PULL_SYNC_PLAN);';
const cases = [
  ['정상 계약 통과', goodPlan, goodSync, true],
  ['전 도메인 직렬 await를 주입하면 RED', goodPlan, `${goodSync}\nconst trip = await pushPending();`, false],
  ['직렬 사유를 지우면 RED', goodPlan.replace(/reason:\s*\n\s*'[^']+'/g, "reason: '짧음'"), goodSync, false],
  ['allSettled를 Promise.all로 바꾸면 RED', goodPlan.replace('Promise.allSettled', 'Promise.all'), goodSync, false],
];
const broken = cases.filter(([, plan, sync, clean]) => (parallelismProblems(plan, sync).length === 0) !== clean);
if (broken.length) {
  console.error(`check-sync-parallelism: 셀프테스트 실패 — 게이트가 공허함: ${broken.map(([name]) => name).join(', ')}`);
  process.exit(2);
}

if (process.argv.includes('--selftest')) {
  console.log('check-sync-parallelism: 셀프테스트 통과');
  process.exit(0);
}

const problems = parallelismProblems(readFileSync(PLAN, 'utf8'), readFileSync(SYNC, 'utf8'));
if (problems.length) {
  console.error('check-sync-parallelism: 동기화 병렬/직렬 계약 위반');
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exit(1);
}
console.log('check-sync-parallelism: OK — push 3단계(2+1+3), pull 6개 병렬, 실패 join-all 계약이 유지됩니다.');
