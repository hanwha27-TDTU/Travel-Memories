#!/usr/bin/env node
// check-report-fields.mjs — **계산해 놓고 화면에 안 쓰는 값**을 잡는다.
//
// 왜 생겼나(M-0022, 2026-07-26): 이관 도구가 되읽기로 확인한 결과를 `safeToRemove`에 담아
// 반환까지 했는데 **화면 문장이 그 필드를 안 읽었다.** 사용자는 `8장 옮김.`만 보고 **되돌릴 수
// 없는 [옛 파일 정리]**를 눌러야 했다. 확인은 했는데 그 확인을 사용자가 볼 수 없었다.
//
// 타입 검사가 못 잡는 자리다: `noUnusedLocals`는 지역변수만 보고, **인터페이스 필드가
// 아무 데서도 소비되지 않는 것**은 아무도 안 본다. 컴파일도 통과하고 유닛도 통과한다
// (유닛은 숫자를 검사했고 숫자는 맞았다 — 검사의 시선이 사용자가 아니라 자료구조에 있었다).
//
// 규칙: **보고용 구조체의 모든 필드는 소비되어야 한다.** 소비란 화면이 읽거나, 사람이 읽는
// 문장을 만드는 함수가 읽는 것이다. 안 쓸 거면 필드를 만들지 말고, 쓸 이유가 있는데 아직
// 안 쓰면 `UNCONSUMED_OK`에 **근거를 적는다**(이유 없는 제외는 결함이다 — §7).

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), 'utf8') : '');

/**
 * 검사할 **보고용 구조체** 등록부.
 *
 * "보고용"이란 **사용자에게 보여주려고 만든 것**이다 — 계산 중간값이나 내부 상태가 아니라.
 * 그래서 소비처는 화면이거나, 사람이 읽는 문장을 만드는 함수다.
 */
export const REPORTS = [
  {
    /** 인터페이스가 선언된 파일. */
    declaredIn: 'src/services/storeState.ts',
    name: 'StoreComparison',
    /** 이 구조체를 화면으로 옮기는 곳들. */
    consumers: ['src/ui/panels/diagnostics.ts'],
  },
];

/** 근거 있는 제외. 비면 규율이 죽는다 — 새로 넣을 때는 한 줄 이유를 함께 쓴다. */
export const UNCONSUMED_OK = {
  // (지금은 없음 — 생기면 여기에 필드명과 이유를 적는다)
};

/** 주석을 걷어낸다 — 주석 속 필드 언급을 "소비"로 세지 않게. */
export function stripComments(src) {
  return src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * `export interface X { … }` 본문에서 필드 이름을 뽑는다.
 * 중첩 객체 타입은 바깥 필드만 센다(그 안쪽은 바깥이 소비되면 따라온다).
 */
export function fieldsOf(src, name) {
  const m = stripComments(src).match(new RegExp(`export interface ${name}\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!m) return null;
  const body = m[1] ?? '';
  const fields = [];
  let depth = 0;
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (depth === 0) {
      const f = t.match(/^(\w+)\??\s*:/);
      if (f) fields.push(f[1]);
    }
    depth += (t.match(/\{/g)?.length ?? 0) - (t.match(/\}/g)?.length ?? 0);
  }
  return fields;
}

/** 소비처 어딘가에서 `.field`로 읽거나 구조분해로 꺼내는가. */
export function isConsumed(consumerSrc, field) {
  const s = stripComments(consumerSrc);
  return (
    new RegExp(`\\.${field}\\b`).test(s) ||
    // `const { a, b } = cmp` 형태
    new RegExp(`\\{[^}]*\\b${field}\\b[^}]*\\}\\s*=`).test(s)
  );
}

export function audit(reports, readFn) {
  const problems = [];
  for (const r of reports) {
    const decl = readFn(r.declaredIn);
    const fields = fieldsOf(decl, r.name);
    if (fields === null) {
      problems.push(`${r.declaredIn}: interface ${r.name} 를 찾지 못함 — 등록부가 낡았다`);
      continue;
    }
    if (!fields.length) {
      problems.push(`${r.declaredIn}: ${r.name} 에 필드가 없음 — 검사가 공허해진다`);
      continue;
    }
    const consumed = r.consumers.map(readFn).join('\n');
    for (const f of fields) {
      if (f in UNCONSUMED_OK) continue;
      if (!isConsumed(consumed, f)) {
        problems.push(
          `${r.name}.${f} 를 아무 화면도 읽지 않음 — 계산해 놓고 사용자에게 안 보여주고 있다(M-0022). ` +
            `쓰거나, 지우거나, UNCONSUMED_OK에 이유를 적으세요.`,
        );
      }
    }
  }
  return problems;
}

// ── 비공허 자체검사 ─────────────────────────────────────────────────────────
let selfTestCount = 0;
{
  const DECL = `export interface R {\n  a: number;\n  b: string;\n  nested: { x: number; y: number };\n}`;
  const cases = [
    {
      name: '전부 소비되면 정상',
      fn: () => audit([{ declaredIn: 'd', name: 'R', consumers: ['c'] }], (k) => (k === 'd' ? DECL : 'r.a; r.b; r.nested;')),
      clean: true,
    },
    {
      name: '안 쓰는 필드 검출(M-0022가 정확히 이 형태였다)',
      fn: () => audit([{ declaredIn: 'd', name: 'R', consumers: ['c'] }], (k) => (k === 'd' ? DECL : 'r.a; r.nested;')),
      clean: false,
    },
    {
      name: '구조분해로 꺼내도 소비로 센다',
      fn: () =>
        audit([{ declaredIn: 'd', name: 'R', consumers: ['c'] }], (k) =>
          k === 'd' ? DECL : 'const { a, b, nested } = r;',
        ),
      clean: true,
    },
    {
      name: '주석 속 언급은 소비가 아니다(오탐 아니라 미탐 방지)',
      fn: () => audit([{ declaredIn: 'd', name: 'R', consumers: ['c'] }], (k) => (k === 'd' ? DECL : 'r.a; r.nested; // r.b 는 나중에')),
      clean: false,
    },
    {
      name: '중첩 객체 안쪽 필드는 세지 않는다(바깥이 소비되면 따라온다)',
      fn: () => audit([{ declaredIn: 'd', name: 'R', consumers: ['c'] }], (k) => (k === 'd' ? DECL : 'r.a; r.b; r.nested;')),
      clean: true,
    },
    {
      name: '인터페이스가 사라지면 검출(등록부 낡음)',
      fn: () => audit([{ declaredIn: 'd', name: 'Gone', consumers: ['c'] }], () => DECL),
      clean: false,
    },
  ];
  const broken = cases.filter((c) => (c.fn().length === 0) !== c.clean);
  if (broken.length) {
    console.error(`check-report-fields: 셀프테스트 실패 — 게이트가 공허함: ${broken.map((c) => c.name).join(', ')}`);
    process.exit(2);
  }
  selfTestCount = cases.length;
}

const problems = audit(REPORTS, read);
if (problems.length) {
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('check-report-fields: 계산해 놓고 화면에 안 쓰는 값이 있습니다.');
  process.exit(1);
}
console.log(
  `check-report-fields: OK (셀프테스트 ${selfTestCount}건 · 보고 구조체 ${REPORTS.length}종 · 근거 있는 제외 ${Object.keys(UNCONSUMED_OK).length}개)`,
);
