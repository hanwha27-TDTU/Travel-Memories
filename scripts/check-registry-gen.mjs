// check-registry-gen.mjs — 생성 레지스트리(src/app/registry.gen.ts) 드리프트 게이트.
//
// 커밋된 registry.gen.ts가 SSOT에서 재생성한 결과와 정확히 같은지 대조한다(손편집 중복 방지·§7).
// 다르면 RED — `node scripts/gen-registry.mjs`로 재생성 후 커밋하라는 뜻. 비공허 자체검사 내장.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect, render } from './gen-registry.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src/app/registry.gen.ts');

// ── 비공허 자체검사: 다른 내용이면 반드시 불일치로 잡혀야 한다 ──
(() => {
  const a = render({ gates: ['x'], gateCount: 1, agentCount: 1, screenCount: 1, migrationCount: 1, changelogCount: 1, researchCount: 1 });
  const b = render({ gates: ['y'], gateCount: 2, agentCount: 1, screenCount: 1, migrationCount: 1, changelogCount: 1, researchCount: 1 });
  if (a === b) throw new Error('SELF-TEST 실패: 다른 레지스트리가 같은 렌더로 나옴(게이트 공허).');
})();

if (!existsSync(OUT)) {
  console.error('check-registry-gen: src/app/registry.gen.ts 없음 — node scripts/gen-registry.mjs 먼저 실행.');
  process.exit(1);
}

const expected = render(collect());
const actual = readFileSync(OUT, 'utf8');

if (expected !== actual) {
  console.error(
    'check-registry-gen: registry.gen.ts가 SSOT와 어긋남(손 스냅샷 드리프트).\n' +
      '  → node scripts/gen-registry.mjs 로 재생성 후 커밋하세요.',
  );
  process.exit(1);
}

const reg = collect();
console.log(
  `check-registry-gen: OK — 게이트 ${reg.gateCount}·에이전트 ${reg.agentCount}·화면 ${reg.screenCount}·마이그 ${reg.migrationCount} 자동 집계 일치.`,
);
