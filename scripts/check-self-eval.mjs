// check-self-eval.mjs — 자기평가가 **자기위안이 되지 않도록** 구조를 잠근다.
//
// 자기평가의 실패 양식은 정해져 있다: 가중치를 슬쩍 옮겨 총점을 올리고, 근거 없이 점수만 높이고,
// 못 한 것(gap)을 비워 두는 것. 셋 다 기계로 막을 수 있다.
//
// A) **가중치 합 = 100.** 한 항목을 올리려면 다른 항목을 내려야 한다(제로섬).
// B) **근거 없는 고득점 금지.** 증거수준(Lv)이 낮은데 점수가 높으면 실패.
//    Lv별 상한: 0→50, 1→60, 2→75, 3→85, 4→94, 5→100. (Lv4 이상이어야 '세계적' 구간 진입)
// C) **gap 비어 있으면 실패.** "못 한 것이 없다"는 자기평가는 거의 언제나 거짓이다.
// D) **6하원칙 6필드 전부 채움.** 답이 막히는 지점이 위험 지점이라는 규율(CLAUDE.md §0)의 강제.
// E) 항목 번호는 1..N 연속(누락·중복 방지).

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'src/app/selfEval.ts');

/** 증거수준별 점수 상한 — 근거 없이 높은 점수를 못 쓰게 한다. */
export const EVIDENCE_CAP = [50, 60, 75, 85, 94, 100];
const W_KEYS = ['why', 'what', 'where', 'when', 'who', 'how'];

/** selfEval.ts 소스에서 항목을 파싱한다(런타임 import 없이 — 게이트는 빌드 전에도 돌아야 한다). */
export function parseItems(src) {
  const items = [];
  for (const m of src.matchAll(/\{\s*\n\s*n:\s*(\d+),/g)) {
    const start = m.index;
    const chunk = src.slice(start, start + 4000);
    const num = (k) => {
      const r = chunk.match(new RegExp(`\\b${k}:\\s*(\\d+)`));
      return r ? Number(r[1]) : null;
    };
    const str = (k) => {
      const r = chunk.match(new RegExp(`\\b${k}:\\s*(['\`])`));
      if (!r) return null;
      const q = r[1];
      const from = chunk.indexOf(r[0]) + r[0].length;
      const end = chunk.indexOf(q, from);
      return end < 0 ? '' : chunk.slice(from, end);
    };
    const w = {};
    for (const k of W_KEYS) w[k] = str(k);
    items.push({ n: Number(m[1]), weight: num('weight'), score: num('score'), evidence: num('evidence'), gap: str('gap'), w });
  }
  return items;
}

export function checkItems(items) {
  const problems = [];
  if (!items.length) return ['selfEval.ts에서 평가 항목을 하나도 찾지 못함(파싱 실패 또는 빈 목록)'];

  const weightSum = items.reduce((a, b) => a + (b.weight ?? 0), 0);
  if (weightSum !== 100) problems.push(`가중치 합이 ${weightSum} — 100이어야 한다(제로섬: 하나를 올리면 하나를 내려야 함)`);

  for (const it of items) {
    const cap = EVIDENCE_CAP[it.evidence ?? -1];
    if (cap === undefined) problems.push(`#${it.n}: 증거수준이 0~5 범위 밖(${it.evidence})`);
    else if ((it.score ?? 0) > cap) {
      problems.push(`#${it.n}: 증거수준 Lv${it.evidence}의 점수 상한은 ${cap}인데 ${it.score} — 근거 없는 고득점`);
    }
    if (!it.gap || it.gap.trim().length < 10) {
      problems.push(`#${it.n}: gap(아직 못 한 것)이 비었거나 너무 짧다 — "없다"는 자기평가는 거의 언제나 거짓이다`);
    }
    for (const k of W_KEYS) {
      if (!it.w[k] || it.w[k].trim().length < 5) problems.push(`#${it.n}: 6하원칙 '${k}'가 비었음(답이 막히는 지점이 위험 지점)`);
    }
  }

  const ns = items.map((i) => i.n).sort((a, b) => a - b);
  for (let i = 0; i < ns.length; i++) {
    if (ns[i] !== i + 1) {
      problems.push(`항목 번호가 1..${ns.length} 연속이 아님(${ns.join(',')})`);
      break;
    }
  }
  return problems;
}

// ── 셀프테스트: 알려진 실패가 RED로 잡히는지(게이트 비공허) ──
{
  const good = (over = {}) => ({
    n: 1, weight: 100, score: 80, evidence: 3, gap: '실기기 검증은 아직 수행하지 못했다.',
    w: { why: '이유가 분명히 있다', what: '무엇을 하는지 적는다', where: '어느 파일인지', when: '언제 도는지', who: '누가 소유하는지', how: '어떻게 검증하는지' },
    ...over,
  });
  const cases = [
    { name: '정상 통과', items: [good()], clean: true },
    { name: '가중치 합 위반', items: [good({ weight: 90 })], clean: false },
    { name: '근거 없는 고득점', items: [good({ evidence: 1, score: 95 })], clean: false },
    { name: 'gap 공백', items: [good({ gap: '' })], clean: false },
    { name: '6하원칙 누락', items: [good({ w: { why: '이유가 분명히 있다', what: '', where: '어느 파일인지', when: '언제 도는지', who: '누가 소유하는지', how: '어떻게 검증하는지' } })], clean: false },
    { name: '번호 불연속', items: [good({ n: 1, weight: 50 }), good({ n: 3, weight: 50 })], clean: false },
    { name: '빈 목록 검출', items: [], clean: false },
  ];
  const broken = cases.filter((c) => (checkItems(c.items).length === 0) !== c.clean);
  if (broken.length) {
    console.error(`check-self-eval: 셀프테스트 실패 — 게이트가 공허함: ${broken.map((c) => c.name).join(', ')}`);
    process.exit(2);
  }
}

// ── 실제 검사 ──
const items = parseItems(readFileSync(FILE, 'utf8'));
const problems = checkItems(items);
if (problems.length) {
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('check-self-eval: 자기평가 구조 계약 위반.');
  process.exit(1);
}
const total = items.reduce((a, b) => a + b.score * b.weight, 0) / 100;
console.log(`check-self-eval: OK (셀프테스트 통과 · ${items.length}항목 · 가중치 100 · 종합 ${total.toFixed(1)})`);
