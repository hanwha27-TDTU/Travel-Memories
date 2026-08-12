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

/** 현재 버전 마커를 과거 커밋·배포 기록에 붙이면 생성 때마다 역사가 바뀐다(M-0086). */
export function appVersionPlacementProblems(entries) {
  const found = [];
  for (const { rel, text } of entries) {
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (!/<!--reg:appVersion-->.*?<!--\/reg-->/.test(line)) continue;
      if (rel === 'docs/HANDOFF.md' && line.includes('**현재 단계**')) found.push({ allowed: true });
      else found.push({ allowed: false, message: `${rel}:${index + 1} 현재 버전 마커는 과거 기록에 둘 수 없음` });
    }
  }
  const bad = found.filter((x) => !x.allowed).map((x) => x.message);
  if (found.length !== 1) bad.push(`현재 버전 마커는 HANDOFF의 현재 단계 한 곳이어야 함(현재 ${found.length}곳)`);
  return bad;
}

// ── 비공허 자체검사: 값이 틀리면 반드시 ok=false로 잡혀야 한다 ──
(() => {
  const reg = { gateCount: 11 };
  const good = findMarkers('<!--reg:gateCount-->11<!--/reg-->', reg);
  const bad = findMarkers('<!--reg:gateCount-->99<!--/reg-->', reg);
  const unknown = findMarkers('<!--reg:nope-->1<!--/reg-->', reg);
  if (!(good[0]?.ok === true)) { console.error(`check-doc-counts: 자체검사 실패 — 게이트를 믿을 수 없다(§4): SELF-TEST 실패: 맞는 값을 통과시키지 못함.`); process.exit(2); }
  if (!(bad[0]?.ok === false)) { console.error(`check-doc-counts: 자체검사 실패 — 게이트를 믿을 수 없다(§4): SELF-TEST 실패: 틀린 값을 잡지 못함(게이트 공허).`); process.exit(2); }
  if (!(unknown[0]?.ok === false)) { console.error(`check-doc-counts: 자체검사 실패 — 게이트를 믿을 수 없다(§4): SELF-TEST 실패: 알 수 없는 KEY를 잡지 못함.`); process.exit(2); }

  const placed = appVersionPlacementProblems([
    { rel: 'docs/HANDOFF.md', text: '**현재 단계** v<!--reg:appVersion-->1.58<!--/reg-->' },
  ]);
  const historical = appVersionPlacementProblems([
    { rel: 'docs/HANDOFF.md', text: '과거 abc1234 v<!--reg:appVersion-->1.58<!--/reg--> 배포' },
  ]);
  if (placed.length !== 0) { console.error(`check-doc-counts: 자체검사 실패 — 게이트를 믿을 수 없다(§4): SELF-TEST 실패: 현재 단계 버전 마커를 통과시키지 못함.`); process.exit(2); }
  if (historical.length === 0) { console.error(`check-doc-counts: 자체검사 실패 — 게이트를 믿을 수 없다(§4): SELF-TEST 실패: 과거 기록의 현재 버전 마커를 잡지 못함.`); process.exit(2); }
})();

const reg = collect();
const problems = [];
let markerCount = 0;
const docs = [];

for (const rel of DOC_FILES) {
  const path = join(ROOT, rel);
  if (!existsSync(path)) continue;
  const doc = readFileSync(path, 'utf8');
  docs.push({ rel, text: doc });
  const markers = findMarkers(doc, reg);
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
problems.push(...appVersionPlacementProblems(docs));

if (problems.length > 0) {
  console.error('check-doc-counts: 문서 카운트 마커가 실제와 어긋남(손편집 드리프트).');
  for (const p of problems) console.error('  - ' + p);
  console.error('  → node scripts/gen-registry.mjs 로 다시 심은 뒤 커밋하세요.');
  process.exit(1);
}

console.log(`check-doc-counts: OK — 마커 ${markerCount}개가 실제 카운트와 일치.`);
