// check-platform-map.mjs — 플랫폼 지도(src/app/platformMap.gen.ts) 드리프트 게이트.
//
// 커밋된 파일이 **코드에서 재생성한 결과**와 정확히 같은지 대조한다. 다르면 RED —
// `node scripts/gen-platform-map.mjs`로 재생성 후 커밋하라는 뜻이다.
//
// 이 게이트가 진짜로 막는 것: **저장소나 구조를 바꿨는데 가이드 표는 옛말을 하는 상태.**
// 오늘 하루만 해도 사진 바이트가 Supabase Storage → R2로 옮겨졌다(v0.86). 손으로 적은
// 표였다면 그 순간부터 거짓말을 했을 것이고, 아무도 몰랐을 것이다.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect, render, ROWS } from './gen-platform-map.mjs';
import { runSelfTest } from './gate-selftest-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src/app/platformMap.gen.ts');

// ── 비공허 자체검사 ─────────────────────────────────────────────────────────
runSelfTest('check-platform-map', () => {
  const row = (where) => [{ id: 'a', what: 'x', detail: 'y', where, part: 'p', evidence: 'e' }];
  if (render(row('Supabase')) === render(row('Cloudflare'))) {
    throw new Error('SELF-TEST 실패: 다른 지도가 같은 렌더로 나옴(게이트 공허).');
  }
  // 행이 하나라도 있어야 의미가 있다 — 비면 게이트가 늘 통과한다.
  if (!ROWS.length) throw new Error('SELF-TEST 실패: ROWS가 비었음(게이트 공허).');
  // 모든 행에 근거 파일이 있어야 한다 — 근거 없는 행은 "주장"이지 실측이 아니다.
  const noEvidence = ROWS.filter((r) => !r.evidence || typeof r.probe !== 'function').map((r) => r.id);
  if (noEvidence.length) throw new Error(`SELF-TEST 실패: 근거·probe 없는 행 ${noEvidence.join(', ')}`);
});

if (!existsSync(OUT)) {
  console.error('check-platform-map: src/app/platformMap.gen.ts 없음 — node scripts/gen-platform-map.mjs 먼저 실행.');
  process.exit(1);
}

let expected;
try {
  expected = render(collect());
} catch (e) {
  // 판정 불가도 RED다. 모르는 것을 표에 적느니 빌드를 세운다(비타협 원칙 #4).
  console.error(`  ✗ ${e.message}`);
  console.error('check-platform-map: 코드에서 플랫폼 지도를 판정하지 못했습니다.');
  process.exit(1);
}

const actual = readFileSync(OUT, 'utf8');
if (expected !== actual) {
  console.error('check-platform-map: platformMap.gen.ts가 코드와 어긋남(손편집 또는 구조 변경).');
  console.error('  → node scripts/gen-platform-map.mjs 로 재생성 후 커밋하세요.');
  process.exit(1);
}

console.log(`check-platform-map: OK (행 ${ROWS.length}개 · 전부 코드에서 실측)`);
