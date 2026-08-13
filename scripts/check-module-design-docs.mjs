// check-module-design-docs.mjs — 코드 기반 모듈 설계서 드리프트 게이트.
//
// 정직한 한계: 정적 추출이 설계의 의미를 이해한다고 주장하지 않는다. 대신 코드 한 바이트가
// 바뀌면 모듈 해시가 달라지고, 파일·API·의존·경계 표가 재계산되며, 커밋본이 다르면 RED다.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { collectModuleDesigns, expectedDocuments, isSourceInput, moduleIdOf, MODULE_CATALOG, OUTPUT_DIR, renderModuleDoc, ROOT } from './module-design-docs-lib.mjs';
import { runSelfTest } from './gate-selftest-lib.mjs';

export function findDrift(expected, actual) {
  const problems = [];
  for (const [name, content] of expected) {
    if (!actual.has(name)) problems.push(`${name}: 생성 문서 없음`);
    else if (actual.get(name) !== content) problems.push(`${name}: 코드에서 재생성한 내용과 다름`);
  }
  for (const name of actual.keys()) if (!expected.has(name)) problems.push(`${name}: 코드 모집단에 없는 화석 문서`);
  return problems;
}

// ── 셀프테스트: 정상·결함·오탐 대조군(게이트 비공허, §4) ──
runSelfTest('check-module-design-docs', () => {
  const good = new Map([['README.md', 'same']]);
  if (findDrift(good, new Map(good)).length !== 0) throw new Error('SELF-TEST 실패: 같은 문서를 오탐했다.');
  const changed = findDrift(good, new Map([['README.md', 'changed']]));
  if (changed.length !== 1 || !changed[0].includes('다름')) throw new Error('SELF-TEST 실패: 코드/문서 내용 변조를 못 잡았다(RED 대조군 공허).');
  if (!findDrift(good, new Map()).some((p) => p.includes('없음'))) throw new Error('SELF-TEST 실패: 누락 문서를 못 잡았다.');
  if (!findDrift(new Map(), new Map([['old.md', 'x']])).some((p) => p.includes('화석'))) throw new Error('SELF-TEST 실패: 화석 문서를 못 잡았다.');
  const sample = {
    ...MODULE_CATALOG[0], files: [], hash: 'a'.repeat(64), lines: 0, declarations: 0, exports: 0,
    externalImports: [], edges: [], entryPoints: ['sample.ts'], tests: [],
  };
  const changedHash = renderModuleDoc(sample).replace('a'.repeat(64), 'b'.repeat(64));
  if (renderModuleDoc(sample) === changedHash) throw new Error('SELF-TEST 실패: 코드 내용 해시 변화가 문서에 반영되지 않는다.');
  const ownerCases = new Map([
    ['src/app/router.ts', 'app-shell'],
    ['src/services/trips.ts', 'travel-core'],
    ['src/offline/db.ts', 'offline-db'],
    ['src/services/canonicalSync.ts', 'sync-canonical'],
    ['src/media/exif.ts', 'photo-storage'],
    ['src/media/editor-core.ts', 'photo-editor'],
    ['src/media/video.ts', 'video-pipeline'],
    ['src/services/audio.ts', 'audio-notes'],
    ['src/services/backup.ts', 'backup-restore'],
    ['src/services/purge.ts', 'trash-purge'],
    ['src/services/diagnostics.ts', 'diagnostics'],
    ['src/services/geocode.ts', 'map-place'],
    ['src/services/expenses.ts', 'expense-fx'],
    ['src/services/auth.ts', 'auth-security'],
    ['src/services/fileSave.ts', 'platform-runtime'],
    ['src/ui/dom.ts', 'ui-shell'],
    ['supabase/migrations/0001_init.sql', 'supabase-backend'],
    ['scripts/harness.mjs', 'quality-release'],
  ]);
  for (const [path, expectedOwner] of ownerCases) {
    if (moduleIdOf(path) !== expectedOwner) throw new Error(`SELF-TEST 실패: ${path}의 소유 모듈이 ${expectedOwner}가 아니다.`);
  }
  if (moduleIdOf('src/unclassified-new-sibling.ts') !== null) throw new Error('SELF-TEST 실패: 미분류 새 형제를 조용히 기존 모듈에 넣었다.');
  if (!isSourceInput(join(ROOT, 'supabase', 'functions', 'geocode', 'config.json'))) throw new Error('SELF-TEST 실패: 실제 Supabase JSON 소스를 제외했다.');
  if (!isSourceInput(join(ROOT, 'supabase', 'migrations', '0001_init.sql'))) throw new Error('SELF-TEST 실패: 실제 Supabase SQL 소스를 제외했다.');
  if (isSourceInput(join(ROOT, 'supabase', '.temp', 'linked-project.json'))) throw new Error('SELF-TEST 실패: Supabase CLI 임시 메타데이터를 소스로 포함했다.');
});

const collected = collectModuleDesigns();
const expected = expectedDocuments(collected);
const actual = new Map();
if (existsSync(OUTPUT_DIR)) {
  for (const name of readdirSync(OUTPUT_DIR).filter((f) => f.endsWith('.md'))) actual.set(name, readFileSync(join(OUTPUT_DIR, name), 'utf8'));
}
const problems = findDrift(expected, actual);
if (problems.length) {
  console.error(`check-module-design-docs: ${problems.length}개 드리프트 — 코드 변경과 설계서가 같은 묶음이 아닙니다.`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('  → npm run gen:module-designs 실행 후 생성 문서를 함께 커밋하세요.');
  process.exit(1);
}

console.log(`check-module-design-docs: OK (셀프테스트 정상/결함/오탐 통과 · 코드 입력 ${collected.inputs.length}개 · 모듈 ${collected.modules.length}개 · 생성 문서 ${expected.size}개 일치).`);
