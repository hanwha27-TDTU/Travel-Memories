#!/usr/bin/env node
// check-purge-scope — 「부모를 영구삭제하면 자식도 지운다」 계약이 실제 스키마와 일치하는가.
//
// C-1(2026-08-01 감사·실서버 확정): 여행 영구삭제가 자식을 `trip_id`로 찾는데 `journey.places`엔
// 그 컬럼이 없다(장소는 여행의 자식이 아님). 「trip 빼고 전부」로 자식을 뽑던 코드가 장소까지
// 넣어 질의했고, PostgREST가 `42703`을 내며 **여행 단위 영구삭제 전체가 서버에 영영 전파되지
// 않았다.** 게이트 40종·유닛이 전부 초록이었다 — 어느 게이트도 「손으로 쓴 질의 컬럼」을 안 봤다.
//
// 🔴 M-0107(2026-08-05 · 사용자 실기기 Windows PC): 같은 자리가 **반대 방향**으로 또 뚫렸다.
// 서버 FK는 `media/expenses/audio → moments → trips`로 **두 단계** cascade인데, 앱은 부모를
// 여행 하나로만 알았다(`if (domain === 'trip')`). 순간을 영구삭제하면 서버는 자식 사진을
// 지우는데 앱은 몰라, 자식이 ①원장에 못 들어가고 ②R2 바이트가 안 지워지고 ③로컬에 남아
// ④그 delete op이 FK 위반(4xx)으로 **영원히 막혔다**. 실측 13건.
//
// 그래서 이 게이트는 이제 **두 가지**를 대조한다:
//   ① `cascadeParents` ↔ migration의 `on delete cascade` **전이 폐포**(누가 나를 데려가는가)
//   ② `cascadeParents` ↔ rowmap의 부모 키 컬럼(그 컬럼으로 질의할 수 있는가 — C-1)
// 산문이 스키마와 갈라지면 RED. 이것이 §7 3층(기계)이고, 2층(데이터 선언)은 purge.ts가 갖는다.
//
// §4: 셀프테스트가 알려진 실패를 주입해 RED를 먼저 확인한 뒤에만 실제 검사를 돈다.

import { readFileSync, readdirSync } from 'node:fs';

const PURGE = 'src/services/purge.ts';
const MIGRATIONS = 'supabase/migrations';
const rowmapPath = (domain) => `src/domain/${domain}/rowmap.ts`;

/** 부모 → 자식 테이블에서 그 부모를 가리키는 컬럼. purge.ts의 `PARENT_KEY`와 같아야 한다. */
const PARENT_KEY = { trip: { table: 'trips', column: 'trip_id' }, moment: { table: 'moments', column: 'moment_id' } };
const PARENTS = Object.keys(PARENT_KEY);

/** DOMAIN_PURGE 객체 본문을 도메인 블록으로 쪼갠다. */
function domainBlocks(src) {
  const body = src.slice(src.indexOf('DOMAIN_PURGE'));
  const re = /^ {2}(\w+):\s*\{/gm;
  const keys = [];
  let m;
  while ((m = re.exec(body))) keys.push({ name: m[1], at: m.index });
  return keys.map((k, i) => [k.name, body.slice(k.at, i + 1 < keys.length ? keys[i + 1].at : body.length)]);
}

/** 각 도메인의 `cascadeParents` 선언을 뽑는다. */
export function parseCascadeParents(src) {
  const out = {};
  for (const [name, block] of domainBlocks(src)) {
    const m = block.match(/cascadeParents:\s*\[([^\]]*)\]/);
    if (!m) continue;
    out[name] = [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]);
  }
  return out;
}

/** 각 도메인의 서버 테이블 이름. migration의 테이블 이름과 도메인을 잇는 유일한 다리다. */
export function parseRemoteTables(src) {
  const out = {};
  for (const [name, block] of domainBlocks(src)) {
    const m = block.match(/remoteTable:\s*'(\w+)'/);
    if (m) out[name] = m[1];
  }
  return out;
}

/**
 * migration SQL에서 **`journey.X → journey.Y on delete cascade`** 직접 간선을 뽑는다.
 * `create table journey.X (` 블록 안의 `references journey.Y (…) on delete cascade`를 본다.
 * `auth.users` 참조는 대상이 아니다(사용자 삭제는 이 앱의 영구삭제 경로가 아니다).
 */
export function parseCascadeEdges(sqlFiles) {
  const edges = []; // { child: 'media', parent: 'moments' } — 테이블 이름 기준
  for (const sql of sqlFiles) {
    const lower = sql.replace(/--[^\n]*/g, ''); // 주석 제거(주석 속 예시를 계약으로 읽지 않게)
    const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?journey\.(\w+)\s*\(/gi;
    let m;
    const starts = [];
    while ((m = re.exec(lower))) starts.push({ table: m[1], at: m.index });
    for (let i = 0; i < starts.length; i += 1) {
      const block = lower.slice(starts[i].at, i + 1 < starts.length ? starts[i + 1].at : lower.length);
      const rf = /references\s+journey\.(\w+)\s*\([^)]*\)\s*on\s+delete\s+cascade/gi;
      let r;
      while ((r = rf.exec(block))) edges.push({ child: starts[i].table, parent: r[1] });
    }
  }
  return edges;
}

/** 간선의 **전이 폐포** — 「나를 데려가는 모든 조상 테이블」. 여행→순간→사진이 두 단계다. */
export function ancestorsOf(table, edges, seen = new Set()) {
  for (const e of edges.filter((x) => x.child === table && !seen.has(x.parent))) {
    seen.add(e.parent);
    ancestorsOf(e.parent, edges, seen);
  }
  return seen;
}

/** rowmap 파일이 서버 행 타입에 그 컬럼을 선언하는가. */
export function rowmapHasColumn(domain, column) {
  try {
    return new RegExp(`\\b${column}\\s*:`).test(readFileSync(rowmapPath(domain), 'utf8'));
  } catch {
    return null; // 파일 없음 — 도메인 이름 오타 등
  }
}

/** 불일치 목록을 돌려준다(비어 있으면 통과). */
export function scopeProblems(declared, remoteTables, edges, hasColumnFn) {
  const problems = [];
  for (const [domain, parents] of Object.entries(declared)) {
    const table = remoteTables[domain];
    if (!table) {
      problems.push(`${domain}: remoteTable을 못 읽었다 — migration과 이을 다리가 없다`);
      continue;
    }
    // ① 스키마가 말하는 조상 ↔ 코드가 선언한 부모
    const anc = ancestorsOf(table, edges);
    const fromSchema = PARENTS.filter((p) => anc.has(PARENT_KEY[p].table)).sort();
    const fromCode = [...parents].sort();
    if (fromSchema.join(',') !== fromCode.join(',')) {
      problems.push(
        `${domain}: cascadeParents=[${fromCode}]인데 스키마의 cascade 조상은 [${fromSchema}]다 — ` +
          `적게 적으면 그 부모를 지울 때 자식이 고아로 남고(M-0107), 많이 적으면 없는 컬럼으로 질의한다(C-1)`,
      );
      continue;
    }
    // ② 선언한 부모마다 그 키 컬럼이 실제로 있는가(그 컬럼으로 자식을 찾는다)
    for (const p of fromCode) {
      const has = hasColumnFn(domain, PARENT_KEY[p].column);
      if (has === null) {
        problems.push(`${domain}: rowmap(${rowmapPath(domain)})을 읽지 못했다`);
      } else if (!has) {
        problems.push(
          `${domain}: cascadeParents에 '${p}'가 있는데 rowmap에 ${PARENT_KEY[p].column}이 없다 — 서버가 42703을 낸다(C-1)`,
        );
      }
    }
  }
  return problems;
}

// ── 셀프테스트 (§4) ──────────────────────────────────────────────────────────
function selfTest() {
  const tables = { trip: 'trips', moment: 'moments', media: 'media', expense: 'expenses', audio: 'audio', place: 'places' };
  const edges = [
    { child: 'moments', parent: 'trips' },
    { child: 'media', parent: 'moments' },
    { child: 'expenses', parent: 'moments' },
    { child: 'audio', parent: 'moments' },
  ];
  const good = {
    trip: [], moment: ['trip'], media: ['trip', 'moment'],
    expense: ['trip', 'moment'], audio: ['trip', 'moment'], place: [],
  };
  const cols = {
    moment: ['trip_id'], media: ['trip_id', 'moment_id'], expense: ['trip_id', 'moment_id'],
    audio: ['trip_id', 'moment_id'], trip: [], place: [],
  };
  const has = (d, c) => (cols[d] ? cols[d].includes(c) : null);
  const cases = [
    ['정상 등록부는 통과', () => scopeProblems(good, tables, edges, has).length === 0],
    // 🔴 M-0107 그 자체: 사진이 순간을 부모로 안 적으면 → RED(순간 영구삭제가 사진을 남긴다)
    ['media에서 moment를 빼면 → RED', () => scopeProblems({ ...good, media: ['trip'] }, tables, edges, has).length > 0],
    // C-1 그 자체: place에 trip을 켜면(rowmap엔 trip_id 없고 스키마 조상도 아님) → RED
    ['place에 trip을 켜면 → RED', () => scopeProblems({ ...good, place: ['trip'] }, tables, edges, has).length > 0],
    ['media에서 trip을 빼면 → RED', () => scopeProblems({ ...good, media: ['moment'] }, tables, edges, has).length > 0],
    ['trip에 부모를 적으면 → RED', () => scopeProblems({ ...good, trip: ['trip'] }, tables, edges, has).length > 0],
    // 전이 폐포가 실제로 두 단계를 타는가(한 단계만 보면 media에 trip이 안 나온다)
    ['전이 폐포가 media → moments → trips를 탄다', () => ancestorsOf('media', edges).has('trips')],
    // 파서 공허 방지 — 실제 파일에서 6개를 다 뽑는가
    ['파서가 purge.ts에서 6개 도메인의 cascadeParents를 뽑는다', () =>
      Object.keys(parseCascadeParents(readFileSync(PURGE, 'utf8'))).length === 6],
    ['파서가 migration에서 cascade 간선 4개 이상을 뽑는다', () => readMigrationEdges().length >= 4],
  ];
  const failed = cases.filter(([, fn]) => !fn());
  if (failed.length) {
    console.error('check-purge-scope: 셀프테스트 실패 — 게이트가 공허하다(§4).');
    for (const [name] of failed) console.error(`  ✗ ${name}`);
    process.exit(2);
  }
}

function readMigrationEdges() {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(`${MIGRATIONS}/${f}`, 'utf8'));
  return parseCascadeEdges(files);
}

selfTest();
if (process.argv.includes('--selftest')) {
  console.log('check-purge-scope: 셀프테스트 통과');
  process.exit(0);
}

const src = readFileSync(PURGE, 'utf8');
const declared = parseCascadeParents(src);
if (Object.keys(declared).length !== 6) {
  console.error(`check-purge-scope: DOMAIN_PURGE에서 6개 도메인을 못 뽑았다(${Object.keys(declared).length}개) — 파서가 스키마 변화를 놓쳤다.`);
  process.exit(1);
}
const problems = scopeProblems(declared, parseRemoteTables(src), readMigrationEdges(), rowmapHasColumn);
if (problems.length) {
  console.error('check-purge-scope: cascadeParents 선언이 실제 스키마와 갈라졌다(C-1·M-0107 재발 위험).');
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log('check-purge-scope: OK — 도메인 6개의 cascadeParents가 migration의 cascade 폐포·rowmap 컬럼과 일치한다.');
