// check-doc-counts.mjs — 문서 산문 속 카운트 마커 드리프트 게이트(§7).
//
// 문서에 <!--reg:KEY-->값<!--/reg--> 로 심은 live 카운트가 실제 registry(collect())와
// 일치하는지 대조한다. 어긋나면 RED — `node scripts/gen-registry.mjs`로 다시 심으라는 뜻.
// 알 수 없는 KEY(오타 등)도 RED. 비공허 자체검사 내장.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect, findMarkers, DOC_FILES } from './gen-registry.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── 비공허 자체검사: 값이 틀리면 반드시 ok=false로 잡혀야 한다 ──
(() => {
  const reg = { gateCount: 11 };
  const good = findMarkers('<!--reg:gateCount-->11<!--/reg-->', reg);
  const bad = findMarkers('<!--reg:gateCount-->99<!--/reg-->', reg);
  const unknown = findMarkers('<!--reg:nope-->1<!--/reg-->', reg);
  if (!(good[0]?.ok === true)) throw new Error('SELF-TEST 실패: 맞는 값을 통과시키지 못함.');
  if (!(bad[0]?.ok === false)) throw new Error('SELF-TEST 실패: 틀린 값을 잡지 못함(게이트 공허).');
  if (!(unknown[0]?.ok === false)) throw new Error('SELF-TEST 실패: 알 수 없는 KEY를 잡지 못함.');
})();

const reg = collect();
const problems = [];
let markerCount = 0;

for (const rel of DOC_FILES) {
  const path = join(ROOT, rel);
  if (!existsSync(path)) continue;
  const markers = findMarkers(readFileSync(path, 'utf8'), reg);
  for (const m of markers) {
    markerCount++;
    if (m.ok) continue;
    problems.push(
      m.known
        ? `${rel}: <!--reg:${m.key}--> = "${m.value}" 이지만 실제는 "${m.expected}"`
        : `${rel}: 알 수 없는 KEY "${m.key}" (registry에 없음 — 오타?)`,
    );
  }
}

if (problems.length > 0) {
  console.error('check-doc-counts: 문서 카운트 마커가 실제와 어긋남(손편집 드리프트).');
  for (const p of problems) console.error('  - ' + p);
  console.error('  → node scripts/gen-registry.mjs 로 다시 심은 뒤 커밋하세요.');
  process.exit(1);
}

console.log(`check-doc-counts: OK — 마커 ${markerCount}개가 실제 카운트와 일치.`);
