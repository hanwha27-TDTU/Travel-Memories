// check-schema-parity.mjs — 클라이언트 rowmap ↔ 서버 마이그레이션 스키마 대조 게이트.
//
// 왜: 클라 rowmap이 서버에 없는 컬럼을 push하면 조용히 sync가 깨진다(place_lat/place_lng 드리프트가
// 실제로 이 문제였다 — rowmap엔 있었는데 journey.moments 컬럼이 없어 좌표 동기화가 막혔다).
// 이 게이트는 각 `interface XRow`의 snake_case 필드가 대응 journey 테이블 컬럼에 모두 존재하는지
// 저장소만으로(네트워크 없이) 확인한다. 하나라도 없으면 RED.
//
// 정직성: 저장소 마이그레이션 SQL이 서버 진실의 프록시다. 실제 DB와 마이그레이션이 어긋나면
// 그건 별도 문제(마이그레이션 미적용) — 그건 배포 계약(DEPLOYMENT)에서 다룬다.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIG_DIR = join(ROOT, 'supabase/migrations');
const DOMAIN_DIR = join(ROOT, 'src/domain');

// interface 이름 → journey 테이블. 새 동기화 엔티티를 추가하면 여기 매핑도 추가해야 한다(강제 갱신).
const ROW_TO_TABLE = {
  TripRow: 'trips',
  MomentRow: 'moments',
  MediaRow: 'media',
  ExpenseRow: 'expenses',
  AudioRow: 'audio',
  PlaceRow: 'places',
};

const SQL_KEYWORDS = new Set(['constraint', 'foreign', 'unique', 'primary', 'check', 'create']);

/** 마이그레이션 SQL 전체에서 journey.<table> → Set(컬럼명) 을 만든다. */
function parseServerColumns() {
  const tables = {};
  const addCol = (t, c) => {
    (tables[t] ??= new Set()).add(c);
  };
  const files = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = readFileSync(join(MIG_DIR, f), 'utf8');

    // create table journey.X ( ... );  — 괄호 블록 안의 컬럼 라인 첫 토큰
    const createRe = /create\s+table\s+journey\.(\w+)\s*\(([\s\S]*?)\n\s*\)\s*;/gi;
    let m;
    while ((m = createRe.exec(sql))) {
      const table = m[1];
      for (const raw of m[2].split('\n')) {
        const line = raw.trim().replace(/,$/, '');
        if (!line || line.startsWith('--')) continue;
        const first = line.split(/\s+/)[0].toLowerCase();
        if (SQL_KEYWORDS.has(first)) continue;
        if (/^\w+$/.test(first)) addCol(table, first);
      }
    }

    // alter table journey.X ... add column [if not exists] Y ...
    const alterRe = /alter\s+table\s+journey\.(\w+)([\s\S]*?);/gi;
    while ((m = alterRe.exec(sql))) {
      const table = m[1];
      const addRe = /add\s+column\s+(?:if\s+not\s+exists\s+)?(\w+)/gi;
      let a;
      while ((a = addRe.exec(m[2]))) addCol(table, a[1]);
    }
  }
  return tables;
}

/** 각 rowmap의 `interface XRow { ... }` 필드명을 뽑는다. */
function parseRowmapInterfaces() {
  const found = [];
  for (const ent of readdirSync(DOMAIN_DIR)) {
    const file = join(DOMAIN_DIR, ent, 'rowmap.ts');
    if (!existsSync(file)) continue;
    const src = readFileSync(file, 'utf8');
    const ifaceRe = /export\s+interface\s+(\w+Row)\s*\{([\s\S]*?)\n\}/g;
    let m;
    while ((m = ifaceRe.exec(src))) {
      const name = m[1];
      const fields = [];
      for (const raw of m[2].split('\n')) {
        const fm = raw.trim().match(/^(\w+)\??\s*:/);
        if (fm) fields.push(fm[1]);
      }
      found.push({ name, fields, file: `src/domain/${ent}/rowmap.ts` });
    }
  }
  return found;
}

/** 대조: rowmap 필드가 서버 컬럼의 부분집합인지. 위반 목록 반환. */
function findDrift(server, rowmaps) {
  const violations = [];
  for (const rm of rowmaps) {
    const table = ROW_TO_TABLE[rm.name];
    if (!table) {
      violations.push(`매핑 없음: ${rm.name}(${rm.file}) → ROW_TO_TABLE에 테이블을 추가하세요.`);
      continue;
    }
    const cols = server[table];
    if (!cols) {
      violations.push(`서버 테이블 없음: journey.${table} (마이그레이션 확인) — ${rm.name}`);
      continue;
    }
    for (const f of rm.fields) {
      if (!cols.has(f)) {
        violations.push(`드리프트: ${rm.name}.${f} 가 journey.${table} 컬럼에 없음 (${rm.file}).`);
      }
    }
  }
  return violations;
}

// ── 비공허 자체검사: 가짜 컬럼을 넣으면 반드시 잡혀야 한다 ──
function selfTest(server) {
  const fake = [{ name: 'MomentRow', fields: ['id', '__nonexistent_col__'], file: 'selftest' }];
  const v = findDrift(server, fake);
  if (!v.some((x) => x.includes('__nonexistent_col__'))) {
    throw new Error('SELF-TEST 실패: 가짜 컬럼 드리프트를 잡지 못함(게이트 공허).');
  }
}

const server = parseServerColumns();
selfTest(server);
const rowmaps = parseRowmapInterfaces();
if (rowmaps.length === 0) {
  console.error('check-schema-parity: rowmap interface를 하나도 못 찾음(파서 회귀?).');
  process.exit(1);
}
const violations = findDrift(server, rowmaps);

if (violations.length > 0) {
  console.error('check-schema-parity: 클라↔서버 스키마 드리프트 발견\n' + violations.map((v) => '  - ' + v).join('\n'));
  process.exit(1);
}

const summary = rowmaps.map((r) => `${r.name}→journey.${ROW_TO_TABLE[r.name]}(${r.fields.length})`).join(', ');
console.log(`check-schema-parity: OK — ${summary}`);
