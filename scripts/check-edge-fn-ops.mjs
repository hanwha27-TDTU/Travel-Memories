#!/usr/bin/env node
// check-edge-fn-ops.mjs — Edge Function이 **자기 능력을 정직하게 밝히는가.**
//
// 왜 생겼나(2026-07-26 사후분석 근본형 B — "판정 문장이 한정을 생략한다"의 서버 판):
//   클라이언트가 새 응답 필드를 기대하는데 서버에 **옛 함수가 배포돼 있으면** 앱은 그걸 알
//   방법이 없다. 그래서 `typeof d.outside === 'number' ? d.outside : 0` 같은 방어 코드를 쓰게
//   되는데, 그 순간 **"0개"와 "모른다"가 구분되지 않는다.** 실제로 그날 그 코드를 썼다.
//
//   해법은 함수가 `capabilities`로 **판(version)과 지원 op 목록**을 스스로 밝히는 것이다.
//   그러면 화면이 「앱이 기대하는 기능이 서버에 없어요」라고 정직하게 말할 수 있다(원칙 #4).
//
//   그런데 그 선언은 **손으로 유지되는 목록**이다 — 손편집 중복은 그 자체가 결함이다(§SSOT).
//   op을 구현하고 목록에 안 넣거나, 목록에만 넣고 구현을 안 하면 선언이 거짓말이 된다.
//   이 게이트가 그 두 방향을 **모두** 잡는다.
//
// 왜 유닛이 아니라 게이트인가: 소스 파일을 읽어야 하는데 `node:fs`는 유닛 TS 설정 밖이다.
//   같은 이유로 예전에도 소스 구조 검사를 게이트 층으로 옮겼다 — 검사는 제 집에 있어야 한다.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FN_PATH = 'supabase/functions/media-sign/index.ts';

/**
 * 핸들러가 실제로 분기하는 op 이름.
 *
 * `body.op === 'string'`(typeof 비교)까지 세면 거짓 경보가 난다 — 실제로 처음 짰을 때 그렇게
 * 걸렸다. **앞에 점이나 글자가 없는 `op`**만 센다.
 */
export function handledOps(src) {
  return new Set([...src.matchAll(/(?<![.\w])op === '(\w+)'/g)].map((m) => m[1]));
}

/** `export const FN_OPS = [...] as const;` 에서 선언된 op 이름. 못 찾으면 null. */
export function declaredOps(src) {
  const m = src.match(/export const FN_OPS = \[([\s\S]*?)\]/);
  if (!m) return null;
  return new Set([...(m[1] ?? '').matchAll(/'(\w+)'/g)].map((x) => x[1]));
}

export function audit(src) {
  const problems = [];
  const declared = declaredOps(src);
  if (declared === null) {
    problems.push('FN_OPS 선언을 찾지 못했습니다 — 함수가 자기 능력을 밝히지 않으면 클라이언트는 추측할 수밖에 없습니다.');
    return problems;
  }
  if (declared.size === 0) {
    problems.push('FN_OPS가 비어 있습니다 — 선언이 비면 검사가 공허해집니다.');
    return problems;
  }
  const handled = handledOps(src);
  if (handled.size === 0) {
    problems.push("핸들러에서 op 분기를 찾지 못했습니다 — 검사가 무엇도 대조하지 못합니다.");
    return problems;
  }
  for (const o of handled) {
    if (!declared.has(o)) {
      problems.push(`op '${o}' 를 구현했는데 FN_OPS에 선언하지 않았습니다 — 클라이언트가 없는 기능으로 취급합니다.`);
    }
  }
  for (const o of declared) {
    if (!handled.has(o)) {
      problems.push(`op '${o}' 를 FN_OPS에 선언했는데 구현이 없습니다 — 선언이 빈 약속이 됩니다.`);
    }
  }
  if (!/export const FN_VERSION = \d+;/.test(src)) {
    problems.push('FN_VERSION 선언이 없습니다 — 서버 판을 못 밝히면 "옛 함수가 배포됨"을 구분할 수 없습니다.');
  }
  return problems;
}

// ── 비공허 자체검사 ─────────────────────────────────────────────────────────
let selfTestCount = 0;
{
  const ok = `export const FN_VERSION = 4;
export const FN_OPS = ['probe', 'list'] as const;
const op = typeof body.op === 'string' ? body.op : '';
if (op === 'probe') { }
if (op === 'list') { }`;
  const cases = [
    { name: '선언과 구현이 맞으면 정상', src: ok, clean: true },
    {
      name: "구현했는데 선언 안 함(실제로 낼 실수)",
      src: ok.replace("'probe', 'list'", "'probe'"),
      clean: false,
    },
    {
      name: '선언했는데 구현 안 함(빈 약속)',
      src: ok.replace("'probe', 'list'", "'probe', 'list', 'ghost'"),
      clean: false,
    },
    {
      name: "typeof 비교(`body.op === 'string'`)를 op으로 세지 않는다(거짓 경보 방지)",
      src: ok,
      clean: true,
    },
    { name: 'FN_OPS가 없으면 검출', src: ok.replace(/export const FN_OPS[\s\S]*?as const;/, ''), clean: false },
    { name: 'FN_OPS가 비면 검출(공허해짐)', src: ok.replace("'probe', 'list'", ''), clean: false },
    { name: 'FN_VERSION이 없으면 검출', src: ok.replace('export const FN_VERSION = 4;', ''), clean: false },
    {
      name: '핸들러 분기가 하나도 없으면 검출(대조 불가)',
      src: `export const FN_VERSION = 4;\nexport const FN_OPS = ['probe'] as const;`,
      clean: false,
    },
  ];
  const broken = cases.filter((c) => (audit(c.src).length === 0) !== c.clean);
  if (broken.length) {
    console.error(`check-edge-fn-ops: 셀프테스트 실패 — 게이트가 공허함: ${broken.map((c) => c.name).join(', ')}`);
    process.exit(2);
  }
  selfTestCount = cases.length;
}

if (!existsSync(join(ROOT, FN_PATH))) {
  console.error(`check-edge-fn-ops: ${FN_PATH} 를 찾지 못했습니다 — 경로가 바뀌었으면 이 게이트도 함께 고치세요.`);
  process.exit(1);
}
const problems = audit(readFileSync(join(ROOT, FN_PATH), 'utf8'));
if (problems.length) {
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('check-edge-fn-ops: 함수의 능력 선언과 구현이 어긋납니다.');
  process.exit(1);
}
const declared = declaredOps(readFileSync(join(ROOT, FN_PATH), 'utf8'));
console.log(`check-edge-fn-ops: OK (셀프테스트 ${selfTestCount}건 · 선언·구현 op ${declared.size}종 대칭)`);
