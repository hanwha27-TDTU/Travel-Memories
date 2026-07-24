// check-backup-coverage.mjs — 모든 사용자 데이터 Dexie 테이블이 백업 export/import에 다 들어있는지 대조 게이트.
//
// 왜: 비타협 원칙 #1(기억을 잃지 않는다)의 마지막 방어선은 백업이다. 새 테이블을 추가하고
// backup.ts에 반영하는 걸 잊으면, 그 데이터는 브라우저 축출·사이트데이터 삭제 시 조용히 사라진다
// (JSON 백업에도, 복원에도 없으니). 이 게이트는 db.ts의 테이블 선언을 진실원으로 삼아
// 각 사용자 데이터 테이블이 exportBackup·importBackup 양쪽에서 참조되는지 저장소만으로 확인한다.
//
// 제외: syncQueue는 파생 큐(사용자 기억이 아님) — 백업 대상이 아니다. 명시적으로 제외한다.
// 새 큐/캐시 성격 테이블을 추가하면 EXCLUDE에 넣거나(의도된 비대상) 백업에 넣어야 한다(강제 선택).

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB_FILE = join(ROOT, 'src/offline/db.ts');
const BACKUP_FILE = join(ROOT, 'src/services/backup.ts');

// 백업 대상이 아닌 테이블(파생 큐·캐시). 사용자 기억이 아니라서 export/import에 없어도 정상.
const EXCLUDE = new Set(['syncQueue']);

/** db.ts에서 Dexie 테이블 프로퍼티명을 뽑는다: `localTrips!: Table<...>`. */
function parseTableNames(src) {
  const names = [];
  const re = /(\w+)\s*!\s*:\s*Table\s*</g;
  let m;
  while ((m = re.exec(src))) names.push(m[1]);
  return names;
}

/**
 * backup.ts를 exportBackup 본문 / importBackup 본문으로 가른다.
 * importBackup 선언 위치를 경계로 split(그 이전=export 영역, 이후=import 영역).
 */
function splitBackup(src) {
  const marker = /export\s+async\s+function\s+importBackup\b/;
  const idx = src.search(marker);
  if (idx < 0) throw new Error('backup.ts에서 importBackup을 찾지 못함(파서 회귀?).');
  return { exportSection: src.slice(0, idx), importSection: src.slice(idx) };
}

/** 테이블명이 `.localTrips` 형태로 해당 영역에서 참조되는지. */
function referencesTable(section, table) {
  return new RegExp(`\\.${table}\\b`).test(section);
}

/** 대조: 제외를 뺀 모든 테이블이 export·import 양쪽에 있는지. 위반 목록 반환. */
function findGaps(tables, exportSection, importSection) {
  const violations = [];
  for (const t of tables) {
    if (EXCLUDE.has(t)) continue;
    if (!referencesTable(exportSection, t)) {
      violations.push(`백업 누락: ${t} 가 exportBackup에서 참조되지 않음 — 이 테이블은 백업 파일에 담기지 않는다.`);
    }
    if (!referencesTable(importSection, t)) {
      violations.push(`복원 누락: ${t} 가 importBackup에서 참조되지 않음 — 백업에 있어도 복원되지 않는다.`);
    }
  }
  return violations;
}

// ── 비공허 자체검사: 백업에서 빠진 테이블은 반드시 잡혀야 한다 ──
function selfTest() {
  const fakeTables = ['localTrips', 'localGhost'];
  const exportSection = 'd.localTrips.toArray()'; // localGhost 없음
  const importSection = 'd.localTrips.put()'; // localGhost 없음
  const v = findGaps(fakeTables, exportSection, importSection);
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

const { exportSection, importSection } = splitBackup(readFileSync(BACKUP_FILE, 'utf8'));
const violations = findGaps(tables, exportSection, importSection);

if (violations.length > 0) {
  console.error('check-backup-coverage: 백업 커버리지 결함 발견\n' + violations.map((v) => '  - ' + v).join('\n'));
  process.exit(1);
}

const covered = tables.filter((t) => !EXCLUDE.has(t));
console.log(
  `check-backup-coverage: OK — 백업 대상 ${covered.length}개 테이블(${covered.join(', ')}) export/import 모두 커버` +
    (EXCLUDE.size ? `; 제외 ${[...EXCLUDE].join(', ')}` : ''),
);
