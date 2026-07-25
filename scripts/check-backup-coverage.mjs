// check-backup-coverage.mjs — 모든 사용자 데이터 Dexie 테이블이 백업 export/import에 다 들어있는지 대조 게이트.
//
// 왜: 비타협 원칙 #1(기억을 잃지 않는다)의 마지막 방어선은 백업이다. 새 테이블을 추가하고
// backup.ts에 반영하는 걸 잊으면, 그 데이터는 브라우저 축출·사이트데이터 삭제 시 조용히 사라진다
// (백업에도, 복원에도 없으니).
//
// 불변식: 각 사용자 데이터 테이블은 (a) 어떤 export-role 함수에서 읽히고 (b) 어떤 import-role 함수에서
// 병합되어야 한다. 형식(단일 JSON·여행별 ZIP)이 늘어도 둘 다 공통 코어(exportCollectRows/importMergeRows)를
// 거치므로, 이 게이트가 코어의 완전성을 저장소만으로(네트워크 없이) 강제한다. 하나라도 없으면 RED.
//
// 역할 분류는 함수명으로: 이름에 'export'가 있으면 export-role, 'import'가 있으면 import-role.
// 제외(파생 데이터 — 사용자 기억이 아니므로 백업 대상이 아니다. 명시적으로만 제외한다):
//   syncQueue    — 파생 큐(동기화 진행상태)
//   localFxRates — 환율 표 캐시. 공개 데이터이고 언제든 다시 받을 수 있으며, 과거 날짜 환율은
//                  확정값이라 재취득해도 같은 값이다. 백업에 넣으면 용량만 늘고 복원 가치가 없다.
// ⚠ 새 테이블을 여기 넣기 전에 자문: "이걸 잃으면 사용자의 기억이 사라지나?" 그렇다면 제외 금지.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB_FILE = join(ROOT, 'src/offline/db.ts');
const BACKUP_FILE = join(ROOT, 'src/services/backup.ts');

// purgedIds — "이 기기에서 영구히 치움" 표식(A안). 기억이 아니라 **로컬 표시 상태**다.
//   판단 기준("이걸 잃으면 사용자의 기억이 사라지나?"): 아니오 — 잃으면 휴지통에 다시 보일 뿐이다.
//   백업에 담으면 오히려 해롭다: 복원은 기억을 **되살리는** 행위인데, 표식까지 복원되면 사용자가
//   되살리려는 것을 다시 무시하게 된다(그래서 importMergeRows는 복원한 행의 표식을 지운다).
const EXCLUDE = new Set(['syncQueue', 'localFxRates', 'purgedIds']);

/** db.ts에서 Dexie 테이블 프로퍼티명을 뽑는다: `localTrips!: Table<...>`. */
function parseTableNames(src) {
  const names = [];
  const re = /(\w+)\s*!\s*:\s*Table\s*</g;
  let m;
  while ((m = re.exec(src))) names.push(m[1]);
  return names;
}

/**
 * backup.ts를 함수 단위로 가른다: 각 `function <name>(` 선언부터 다음 선언 직전까지를 본문으로.
 * 역할은 이름으로 분류(export/import). 반환: { exportBodies:[], importBodies:[] }.
 */
function splitByRole(src) {
  const declRe = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g;
  const marks = [];
  let m;
  while ((m = declRe.exec(src))) marks.push({ name: m[1], idx: m.index });
  if (marks.length === 0) throw new Error('backup.ts에서 함수 선언을 찾지 못함(파서 회귀?).');

  const exportBodies = [];
  const importBodies = [];
  for (let i = 0; i < marks.length; i += 1) {
    const start = marks[i].idx;
    const end = i + 1 < marks.length ? marks[i + 1].idx : src.length;
    const body = src.slice(start, end);
    const name = marks[i].name.toLowerCase();
    if (name.includes('export')) exportBodies.push({ name: marks[i].name, body });
    if (name.includes('import')) importBodies.push({ name: marks[i].name, body });
  }
  return { exportBodies, importBodies };
}

function referencesTable(body, table) {
  return new RegExp(`\\.${table}\\b`).test(body);
}

function anyRefs(bodies, table) {
  return bodies.some((b) => referencesTable(b.body, table));
}

/** 대조: 제외를 뺀 모든 테이블이 export-role·import-role 양쪽에 존재하는지. 위반 목록 반환. */
function findGaps(tables, exportBodies, importBodies) {
  const violations = [];
  for (const t of tables) {
    if (EXCLUDE.has(t)) continue;
    if (!anyRefs(exportBodies, t)) {
      violations.push(`백업 누락: ${t} 가 어떤 export-role 함수에서도 참조되지 않음 — 이 테이블은 백업에 담기지 않는다.`);
    }
    if (!anyRefs(importBodies, t)) {
      violations.push(`복원 누락: ${t} 가 어떤 import-role 함수에서도 참조되지 않음 — 백업에 있어도 복원되지 않는다.`);
    }
  }
  return violations;
}

// ── 비공허 자체검사: 백업에서 빠진 테이블은 반드시 잡혀야 한다 ──
function selfTest() {
  const fakeTables = ['localTrips', 'localGhost'];
  const exportBodies = [{ name: 'exportX', body: 'd.localTrips.toArray()' }]; // localGhost 없음
  const importBodies = [{ name: 'importX', body: 'd.localTrips.put()' }]; // localGhost 없음
  const v = findGaps(fakeTables, exportBodies, importBodies);
  if (!v.some((x) => x.includes('localGhost'))) {
    throw new Error('SELF-TEST 실패: 백업에서 빠진 테이블을 잡지 못함(게이트 공허).');
  }
}

if (!existsSync(DB_FILE) || !existsSync(BACKUP_FILE)) {
  console.error('check-backup-coverage: db.ts 또는 backup.ts를 찾지 못함.');
  process.exit(1);
}

selfTest();

const tables = parseTableNames(readFileSync(DB_FILE, 'utf8'));
if (tables.length === 0) {
  console.error('check-backup-coverage: db.ts에서 테이블 선언을 하나도 못 찾음(파서 회귀?).');
  process.exit(1);
}

const { exportBodies, importBodies } = splitByRole(readFileSync(BACKUP_FILE, 'utf8'));
if (exportBodies.length === 0 || importBodies.length === 0) {
  console.error('check-backup-coverage: export-role/import-role 함수를 찾지 못함(파서 회귀?).');
  process.exit(1);
}

const violations = findGaps(tables, exportBodies, importBodies);
if (violations.length > 0) {
  console.error('check-backup-coverage: 백업 커버리지 결함 발견\n' + violations.map((v) => '  - ' + v).join('\n'));
  process.exit(1);
}

const covered = tables.filter((t) => !EXCLUDE.has(t));
console.log(
  `check-backup-coverage: OK — 백업 대상 ${covered.length}개 테이블(${covered.join(', ')}) export/import 모두 커버` +
    ` (export-role ${exportBodies.length}·import-role ${importBodies.length} 함수)` +
    (EXCLUDE.size ? `; 제외 ${[...EXCLUDE].join(', ')}` : ''),
);
