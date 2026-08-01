#!/usr/bin/env node
// check-purge-scope — 「여행 영구삭제가 자식을 trip_id로 지운다」 계약이 스키마와 일치하는가.
//
// C-1(2026-08-01 감사·실서버 확정): 여행 영구삭제가 자식을 `trip_id`로 찾는데 `journey.places`엔
// 그 컬럼이 없다(장소는 여행의 자식이 아님). 「trip 빼고 전부」로 자식을 뽑던 코드가 장소까지
// 넣어 질의했고, PostgREST가 `42703`을 내며 **여행 단위 영구삭제 전체가 서버에 영영 전파되지
// 않았다.** 게이트 40종·유닛이 전부 초록이었다 — 어느 게이트도 「손으로 쓴 질의 컬럼」을 안 봤다.
//
// 이 게이트가 그 사각을 닫는다: `DOMAIN_PURGE[d].tripScoped`(코드가 trip_id로 질의할지 결정하는
// 플래그)가 **그 도메인의 rowmap이 실제로 `trip_id`를 선언하는지**와 일치해야 한다. 산문이
// 스키마와 갈라지면 RED. 이것이 §7 3층(기계)이다 — 2층(데이터 플래그)은 purge.ts가 갖는다.
//
// §4: 셀프테스트가 알려진 실패를 주입해 RED를 먼저 확인한 뒤에만 실제 검사를 돈다.

import { readFileSync } from 'node:fs';

const PURGE = 'src/services/purge.ts';
const rowmapPath = (domain) => `src/domain/${domain}/rowmap.ts`;

/**
 * DOMAIN_PURGE에서 각 도메인의 tripScoped 플래그를 뽑는다.
 * 블록 파서: `key: {` … `}` 안에서 `tripScoped: true|false`를 찾는다.
 */
export function parseTripScoped(src) {
  const out = {};
  // DOMAIN_PURGE 객체 본문만 대상으로 — 도메인 키: { … } 블록을 순서대로 훑는다.
  const body = src.slice(src.indexOf('DOMAIN_PURGE'));
  const re = /(\w+):\s*\{/g;
  let m;
  const keys = [];
  while ((m = re.exec(body))) keys.push({ name: m[1], at: m.index });
  for (let i = 0; i < keys.length; i += 1) {
    const start = keys[i].at;
    const end = i + 1 < keys.length ? keys[i + 1].at : body.length;
    const block = body.slice(start, end);
    const flag = block.match(/tripScoped:\s*(true|false)/);
    if (flag) out[keys[i].name] = flag[1] === 'true';
  }
  return out;
}

/** rowmap 파일이 서버 행 타입에 `trip_id` 컬럼을 선언하는가. */
export function rowmapHasTripId(domain) {
  try {
    return /\btrip_id\s*:/.test(readFileSync(rowmapPath(domain), 'utf8'));
  } catch {
    return null; // 파일 없음 — 도메인 이름 오타 등
  }
}

/** 불일치 목록을 돌려준다(비어 있으면 통과). */
export function scopeProblems(tripScopedMap, hasTripIdFn) {
  const problems = [];
  for (const [domain, scoped] of Object.entries(tripScopedMap)) {
    if (domain === 'trip') {
      // 여행 자신은 부모다 — tripScoped여선 안 되고, 자기 rowmap에 trip_id도 없어야 한다.
      if (scoped) problems.push(`trip은 부모다 — tripScoped: false여야 한다`);
      continue;
    }
    const has = hasTripIdFn(domain);
    if (has === null) {
      problems.push(`${domain}: rowmap(${rowmapPath(domain)})을 읽지 못했다`);
      continue;
    }
    if (scoped && !has) {
      problems.push(`${domain}: tripScoped: true인데 rowmap에 trip_id가 없다 — trip_id로 질의하면 서버가 42703을 낸다(C-1)`);
    }
    if (!scoped && has) {
      problems.push(`${domain}: tripScoped: false인데 rowmap에 trip_id가 있다 — 여행 영구삭제가 이 자식을 안 지우고 남긴다`);
    }
  }
  return problems;
}

// ── 셀프테스트 (§4) ──────────────────────────────────────────────────────────
function selfTest() {
  const goodMap = { trip: false, moment: true, media: true, expense: true, audio: true, place: false };
  const goodHas = (d) => ({ moment: true, media: true, expense: true, audio: true, place: false })[d] ?? null;
  const cases = [
    ['정상 등록부는 통과', () => scopeProblems(goodMap, goodHas).length === 0],
    // C-1 그 자체: place가 tripScoped: true로 바뀌면(rowmap엔 trip_id 없음) RED
    ['place를 tripScoped로 켜면 → RED', () => scopeProblems({ ...goodMap, place: true }, goodHas).length > 0],
    // 반대 방향: 자식이 tripScoped: false로 새면(여행 삭제가 안 지움) RED
    ['media를 tripScoped 끄면 → RED', () => scopeProblems({ ...goodMap, media: false }, goodHas).length > 0],
    ['trip을 tripScoped 켜면 → RED', () => scopeProblems({ ...goodMap, trip: true }, goodHas).length > 0],
    // 파서가 실제 파일에서 6개를 다 뽑는가(공허 방지 — 0개를 통과로 읽지 않게)
    ['파서가 purge.ts에서 6개 도메인을 뽑는다', () => Object.keys(parseTripScoped(readFileSync(PURGE, 'utf8'))).length === 6],
  ];
  const failed = cases.filter(([, fn]) => !fn());
  if (failed.length) {
    console.error('check-purge-scope: 셀프테스트 실패 — 게이트가 공허하다(§4).');
    for (const [name] of failed) console.error(`  ✗ ${name}`);
    process.exit(2);
  }
}

selfTest();
if (process.argv.includes('--selftest')) {
  console.log('check-purge-scope: 셀프테스트 통과');
  process.exit(0);
}

const map = parseTripScoped(readFileSync(PURGE, 'utf8'));
if (Object.keys(map).length !== 6) {
  console.error(`check-purge-scope: DOMAIN_PURGE에서 6개 도메인을 못 뽑았다(${Object.keys(map).length}개) — 파서가 스키마 변화를 놓쳤다.`);
  process.exit(1);
}
const problems = scopeProblems(map, rowmapHasTripId);
if (problems.length) {
  console.error('check-purge-scope: tripScoped 플래그가 실제 스키마와 갈라졌다(C-1 재발 위험).');
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log('check-purge-scope: OK — tripScoped 6개가 전부 rowmap의 trip_id 유무와 일치한다.');
