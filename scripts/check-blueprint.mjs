// check-blueprint.mjs — 설계 개요도(app/blueprint.ts) 선언 ↔ 현실 대조 게이트.
//
// 왜: 배선맵은 손으로 그리면 코드와 어긋나 "거짓말"을 한다(LESSONS §3·§7). 이 게이트가
// blueprint의 선언을 실제 구조와 저장소만으로 대조해, 어긋나면 RED로 잡는다:
//  A. db.ts의 사용자 Dexie 테이블(syncQueue 제외)이 모두 implemented SOURCE로 선언됐는가(끊긴 발전원 방지).
//  B. hasRowmap:true인 SOURCE는 src/domain/<key>/rowmap.ts 파일이 실제로 있는가.
//  C. hasSync:true인 SOURCE는 sync.ts에 그 table이 실제로 배선됐는가.
//  D. 선언된 모든 SCREEN.file이 src/ui/screens/에 실제로 있는가(끊긴 말단 방지).
// 하나라도 어긋나면 그림이 현실과 다르다는 뜻 → RED.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BP = join(ROOT, 'src/app/blueprint.ts');
const DB = join(ROOT, 'src/offline/db.ts');
const SYNC = join(ROOT, 'src/services/sync.ts');
const SCREENS_DIR = join(ROOT, 'src/ui/screens');
const DOMAIN_DIR = join(ROOT, 'src/domain');

const EXCLUDE_TABLES = new Set(['syncQueue']);

/** blueprint.ts에서 SOURCES 객체들을 뽑는다. */
function parseSources(src) {
  const block = /export const SOURCES[\s\S]*?\n\];/.exec(src);
  if (!block) throw new Error('blueprint SOURCES 블록을 찾지 못함(파서 회귀?).');
  const out = [];
  for (const line of block[0].split('\n')) {
    const key = /key:\s*'([^']+)'/.exec(line);
    if (!key || !/implemented:/.test(line)) continue;
    out.push({
      key: key[1],
      table: (/table:\s*'([^']+)'/.exec(line) || [])[1],
      implemented: /implemented:\s*true/.test(line),
      localTable: (/localTable:\s*'([^']+)'/.exec(line) || [])[1],
      hasRowmap: /hasRowmap:\s*true/.test(line),
      hasSync: /hasSync:\s*true/.test(line),
    });
  }
  return out;
}

function parseScreens(src) {
  const block = /export const SCREENS[\s\S]*?\n\];/.exec(src);
  if (!block) throw new Error('blueprint SCREENS 블록을 찾지 못함(파서 회귀?).');
  const files = [];
  const re = /file:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(block[0]))) files.push(m[1]);
  return files;
}

/** db.ts의 Dexie 테이블 프로퍼티명(syncQueue 제외). */
function parseDbTables(src) {
  const names = [];
  const re = /(\w+)\s*!\s*:\s*Table\s*</g;
  let m;
  while ((m = re.exec(src))) if (!EXCLUDE_TABLES.has(m[1])) names.push(m[1]);
  return names;
}

function findViolations(sources, screenFiles, dbTables, syncText) {
  const v = [];
  const byLocal = new Map(sources.filter((s) => s.localTable).map((s) => [s.localTable, s]));

  // A. 모든 사용자 Dexie 테이블이 implemented SOURCE로 선언됐는가.
  for (const t of dbTables) {
    const s = byLocal.get(t);
    if (!s) v.push(`발전원 누락: db.ts 테이블 ${t} 가 blueprint SOURCES에 없음(끊긴 발전원).`);
    else if (!s.implemented) v.push(`상태 불일치: ${t}(${s.key})가 SOURCES에 implemented:false로 선언됨.`);
  }
  // B. hasRowmap 주장 검증.
  for (const s of sources) {
    if (s.hasRowmap && !existsSync(join(DOMAIN_DIR, s.key, 'rowmap.ts'))) {
      v.push(`rowmap 없음: ${s.key} 는 hasRowmap:true인데 src/domain/${s.key}/rowmap.ts가 없음.`);
    }
    // C. hasSync 주장 검증.
    if (s.hasSync && s.table && !new RegExp(`['"\\.]${s.table}\\b`).test(syncText)) {
      v.push(`동기화 배선 없음: ${s.key} 는 hasSync:true인데 sync.ts에 '${s.table}' 참조가 없음.`);
    }
  }
  // D. 화면 파일 실재.
  for (const f of screenFiles) {
    if (!existsSync(join(SCREENS_DIR, f))) v.push(`화면 파일 없음: SCREENS에 선언된 ${f} 가 src/ui/screens/에 없음.`);
  }
  return v;
}

// ── 비공허 자체검사: db 테이블이 blueprint에서 빠지면 반드시 잡혀야 한다 ──
function selfTest() {
  const v = findViolations([{ key: 'trip', table: 'trips', implemented: true, localTable: 'localTrips' }], [], ['localGhost'], '');
  if (!v.some((x) => x.includes('localGhost'))) {
    throw new Error('SELF-TEST 실패: 빠진 발전원을 잡지 못함(게이트 공허).');
  }
}

for (const f of [BP, DB, SYNC]) {
  if (!existsSync(f)) {
    console.error(`check-blueprint: 필수 파일 없음 — ${f}`);
    process.exit(1);
  }
}

selfTest();

const bpSrc = readFileSync(BP, 'utf8');
const sources = parseSources(bpSrc);
const screenFiles = parseScreens(bpSrc);
const dbTables = parseDbTables(readFileSync(DB, 'utf8'));
const syncText = readFileSync(SYNC, 'utf8');

if (sources.length === 0 || screenFiles.length === 0) {
  console.error('check-blueprint: SOURCES/SCREENS를 파싱하지 못함(파서 회귀?).');
  process.exit(1);
}

const violations = findViolations(sources, screenFiles, dbTables, syncText);
if (violations.length > 0) {
  console.error('check-blueprint: 설계 개요도 ↔ 현실 불일치\n' + violations.map((x) => '  - ' + x).join('\n'));
  process.exit(1);
}

const built = sources.filter((s) => s.implemented).length;
console.log(
  `check-blueprint: OK — 발전원 ${sources.length}(실장 ${built})·화면 ${screenFiles.length} 선언이 현실과 일치(db 테이블 ${dbTables.length} 커버).`,
);
