// check-step-duration.mjs — 빌드 단계가 기준선을 넘었는지 판정한다.
//
// ── 왜 필요한가 ──────────────────────────────────────────────────────────────
// 오래 걸리는 단계는 **그 자리에서 원인을 본다.** 넘긴 채 다음 단계로 가면, 느려진 이유가
// 다음 실패에 섞여 들어와 어느 판 탓인지 못 찾는다.
//
// ⚠️ **기준선을 지어내지 않는다.** 값은 `schemas/release-profile.json`의 실측
// (성공 실행 3회 이상 · run id 포함)에서만 온다. 지어낸 임계는 정상 빌드마다 오탐을 내고,
// 오탐이 반복되면 사람이 빨간불을 무시하기 시작한다 — 그때 이 판정기는 죽는다.
//
// ── 판정식 ───────────────────────────────────────────────────────────────────
//     소요 > max(기준선 × 1.5, 기준선 + 60초)
// 비율만 쓰면 짧은 단계가 과민해지고(9초 → 13.5초에 걸린다), 절대값만 쓰면 긴 단계가 둔해진다.
//
// ── 두 층 ────────────────────────────────────────────────────────────────────
//  · 기본(하네스 게이트) — **기준선 표가 온전한가**를 본다. 표본이 3회 미만이거나 임계가
//    식과 어긋나면 실패다. 실제 실행은 안 잰다(토큰이 없어도 도는 층).
//  · `--json <파일>` — GitHub Actions jobs 응답을 먹여 **실제 실행을 판정**한다. 토큰 없이
//    돌 수 있게 파일 입력만 받는다(권한을 요구하는 판정기는 결국 안 돌게 된다).
//
// 계약: exit 0 = 통과 · exit 1 = 위반. 판정은 종료코드로 한다(§18-A).

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIN_SAMPLES = 3;

/** 판정 임계 — 이 식이 정본이다. 프로필의 thresholdSec은 이 식의 **캐시**이고, 어긋나면 실패다. */
export function thresholdOf(baselineSec) {
  return Math.max(Math.round(baselineSec * 1.5), baselineSec + 60);
}

/** 기준선 표가 판정에 쓸 만한가 — 순수 함수(자체검사가 부른다). */
export function auditBaselines(table) {
  const problems = [];
  const steps = table?.steps;
  if (!Array.isArray(steps) || !steps.length) {
    problems.push('buildStepBaselines.steps가 비었다 — 판정할 기준이 없다');
    return problems;
  }
  if (!table.verdictFormula) problems.push('판정식이 적혀 있지 않다 — 임계의 출처를 알 수 없다');
  for (const s of steps) {
    const label = `${s?.workflow ?? '?'}/${s?.job ?? '?'}/${s?.step ?? '?'}`;
    const samples = Array.isArray(s?.samplesSec) ? s.samplesSec : [];
    if (samples.length < MIN_SAMPLES) {
      problems.push(`${label}: 표본이 ${samples.length}회다 — 기준선은 성공 실행 ${MIN_SAMPLES}회 이상에서만 파생한다(지어낸 임계 금지)`);
      continue;
    }
    if (typeof s.baselineSec !== 'number') { problems.push(`${label}: baselineSec이 숫자가 아니다`); continue; }
    const expected = thresholdOf(s.baselineSec);
    if (s.thresholdSec !== expected) problems.push(`${label}: thresholdSec ${s.thresholdSec}이(가) 판정식 값 ${expected}과 다르다 — 캐시가 식과 갈라졌다`);
    // 기준선이 표본 바깥이면 어딘가에서 손으로 고친 것이다.
    if (s.baselineSec < Math.min(...samples) || s.baselineSec > Math.max(...samples)) {
      problems.push(`${label}: baselineSec ${s.baselineSec}이(가) 표본 범위 [${Math.min(...samples)}, ${Math.max(...samples)}] 밖이다`);
    }
  }
  if (!table.evidenceRunIds || !Object.keys(table.evidenceRunIds).length) {
    problems.push('evidenceRunIds가 없다 — 근거 run id 없는 기준선은 재검증할 수 없다');
  }
  return problems;
}

/** 실제 실행 판정 — jobs 응답에서 단계 소요를 뽑아 기준선과 견준다. */
export function judgeRun(table, jobsPayload) {
  const jobs = jobsPayload?.jobs?.jobs ?? jobsPayload?.jobs ?? [];
  const byStep = new Map(table.steps.map((s) => [`${s.job}::${s.step}`, s]));
  const verdicts = [];
  for (const job of jobs) {
    const jobName = (job?.name ?? '').split(' (')[0];
    for (const step of job?.steps ?? []) {
      const known = byStep.get(`${jobName}::${step?.name}`);
      if (!known || !step?.started_at || !step?.completed_at) continue;
      const sec = Math.round((Date.parse(step.completed_at) - Date.parse(step.started_at)) / 1000);
      verdicts.push({ job: jobName, step: step.name, sec, baseline: known.baselineSec, threshold: known.thresholdSec, over: sec > known.thresholdSec });
    }
  }
  return verdicts;
}

// ── 자체검사(§4) ─────────────────────────────────────────────────────────────
const SELF = { pos: 0, neg: 0 };
const GOOD = {
  verdictFormula: 'max(1.5x, +60s)',
  evidenceRunIds: { 'ci.yml': [1, 2, 3] },
  steps: [{ workflow: 'ci.yml', job: 'harness', step: 'Build', samplesSec: [9, 9, 10], baselineSec: 9, thresholdSec: 69 }],
};

export function selfTest() {
  if (auditBaselines(GOOD).length) throw new Error('SELF-TEST 실패: 정상 표를 걸렀다(오탐)');
  SELF.neg = 1;
  const clone = () => JSON.parse(JSON.stringify(GOOD));
  const bad = [
    ['표본 부족', (t) => { t.steps[0].samplesSec = [9, 9]; }, '표본이 2회'],
    ['임계가 식과 갈라짐', (t) => { t.steps[0].thresholdSec = 20; }, '판정식 값'],
    ['기준선이 표본 밖', (t) => { t.steps[0].baselineSec = 40; t.steps[0].thresholdSec = thresholdOf(40); }, '표본 범위'],
    ['근거 run id 없음', (t) => { delete t.evidenceRunIds; }, 'evidenceRunIds'],
    ['판정식 미기재', (t) => { delete t.verdictFormula; }, '판정식이 적혀'],
    ['표가 빔', (t) => { t.steps = []; }, 'steps가 비었다'],
  ];
  for (const [label, mutate, needle] of bad) {
    const t = clone(); mutate(t);
    if (!auditBaselines(t).some((p) => p.includes(needle))) throw new Error(`SELF-TEST 실패: ${label}을(를) 놓쳤다`);
    SELF.pos += 1;
  }
  // 🔴 짧은 단계가 과민해지지 않는가 — 비율만 쓰면 9초가 13.5초에 걸린다.
  if (thresholdOf(9) !== 69) throw new Error('SELF-TEST 실패: 짧은 단계에 절대항이 안 걸렸다');
  // 🔴 긴 단계가 둔해지지 않는가 — 절대값만 쓰면 159초가 219초까지 봐준다.
  if (thresholdOf(159) !== 239) throw new Error('SELF-TEST 실패: 긴 단계에 비율항이 안 걸렸다');
  SELF.pos += 2;
  // 실제 판정도 주입으로 확인한다(표만 재고 판정을 안 재면 이 게이트는 반쪽이다).
  const payload = { jobs: { jobs: [{ name: 'harness', steps: [{ name: 'Build', started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:02:00Z' }] }] } };
  const v = judgeRun(GOOD, payload);
  if (v.length !== 1 || !v[0].over) throw new Error('SELF-TEST 실패: 120초짜리 Build를 초과로 잡지 못했다');
  SELF.pos += 1;
}

selfTest();

const isMain = process.argv[1] && process.argv[1].endsWith('check-step-duration.mjs');
if (isMain) {
  const profile = JSON.parse(readFileSync(join(ROOT, 'schemas', 'release-profile.json'), 'utf8'));
  const table = profile?.buildStepBaselines;
  const problems = auditBaselines(table);
  if (problems.length) {
    console.error('🔴 빌드 단계 기준선이 판정에 쓸 수 없습니다:');
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(1);
  }

  const jsonAt = process.argv.indexOf('--json');
  if (jsonAt >= 0) {
    const payload = JSON.parse(readFileSync(process.argv[jsonAt + 1], 'utf8'));
    const verdicts = judgeRun(table, payload);
    if (!verdicts.length) {
      console.error('🔴 준 파일에서 기준선과 짝지을 단계를 하나도 못 찾았습니다 — 모집단 0은 「위반 없음」이 아닙니다(HRL-2).');
      process.exit(1);
    }
    for (const v of verdicts) {
      const mark = v.over ? '🔴 초과' : '  정상';
      console.log(`${mark} ${v.job} / ${v.step} — ${v.sec}초 (기준선 ${v.baseline} · 임계 ${v.threshold})`);
    }
    const over = verdicts.filter((v) => v.over);
    console.log(`check-step-duration: 단계 ${verdicts.length}개 판정 · 초과 ${over.length}개`);
    if (over.length) process.exit(1);
    process.exit(0);
  }

  console.log(
    `check-step-duration: OK (자체검사 양성 ${SELF.pos}·음성 ${SELF.neg} · 기준선 단계 ${table.steps.length}개 · 표본 ${MIN_SAMPLES}회 이상 · 임계가 판정식과 일치)`,
  );
  console.log('  ↳ 정직한 한계: 이 실행은 **표가 온전한지**까지만 봅니다 — 실제 실행 판정은 `--json <jobs 응답>`입니다.');
}
