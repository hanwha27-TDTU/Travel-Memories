#!/usr/bin/env node
// check-migration-grants.mjs — 새 테이블이 **권한과 초대제를 빠뜨리고** 배포되는 것을 막는다.
//
// 왜 생겼나(M-0020, 2026-07-26 사용자 실기기): 마이그레이션 0012가 `journey.purged_ids`를
// 만들면서 RLS 정책은 썼는데 **GRANT를 빠뜨렸고**, 정책에 **`is_allowed()`(초대제)도 없었다.**
// 결과: 앱(`authenticated` 역할)의 모든 요청이 permission denied → 진단 화면이 통째로 빨갛고,
// **영구삭제가 서버에 반영되지 않았다**(v0.79의 핵심 기능이 실제로는 죽어 있었다).
//
// RLS와 GRANT는 **다른 층**이다:
//   · GRANT = "이 역할이 이 테이블에 접근이나 할 수 있는가"
//   · RLS   = "그중 어느 행을 볼 수 있는가"
// RLS만 쓰고 GRANT를 잊으면 정책이 아무리 옳아도 문이 잠겨 있다. 형제 테이블 넷에는 다 있었고
// 새 테이블 하나만 조용히 빠졌다 — 이 저장소의 최빈 결함군 그대로다(CLAUDE.md §7).
//
// 왜 사람이 못 잡았나: 적용 직후 검증 SQL을 **superuser로** 돌렸다. superuser는 GRANT도 RLS도
// 우회한다 — 앱이 쓰는 역할이 아니다. `supabase-security-dev` §4는 `set_config(
// 'request.jwt.claims', …)`로 **남이 되어 보라**고 적혀 있었고, 그대로 했으면 즉시 잡혔다.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'supabase/migrations');

/**
 * 이 규칙에서 빠지는 테이블과 **그 이유**. 이유 없는 제외는 결함이다(CLAUDE.md §7).
 * 비면 규율이 죽으므로, 새로 넣을 때는 반드시 한 줄 근거를 함께 쓴다.
 */
export const NO_GRANT_REQUIRED = {
  allowed_users:
    '허용목록 자체. 앱이 직접 읽지 않고 `is_allowed()`(SECURITY DEFINER)만 읽는다 — 권한을 주면 초대제 명단이 노출된다.',
};

/** 주석을 걷어낸다 — 주석 속 예시 SQL을 실제 문장으로 읽지 않게. */
export function stripSql(src) {
  return src.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** `create table [if not exists] journey.X` 에서 X들을 뽑는다. */
export function createdTables(sql) {
  return [...stripSql(sql).matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?journey\.(\w+)/gi)].map((m) =>
    m[1].toLowerCase(),
  );
}

/** 이 테이블에 `authenticated` 권한을 주는 grant가 어디엔가 있는가. */
export function hasGrant(allSql, table) {
  const re = new RegExp(`grant[\\s\\S]{0,120}?\\bon\\s+journey\\.${table}\\b[\\s\\S]{0,60}?to\\s+authenticated`, 'i');
  return re.test(allSql);
}

/**
 * 이 테이블의 정책들이 초대제(`is_allowed()`)를 결합하는가.
 * 정책이 하나라도 초대제 없이 남아 있으면 허용목록 밖 사용자가 그 경로로 들어온다.
 */
export function policiesGateInvite(allSql, table) {
  const bad = [];
  const re = new RegExp(
    `create\\s+policy\\s+(\\w+)\\s+on\\s+journey\\.${table}\\b([\\s\\S]*?)(?=;\\s*(?:create|drop|grant|alter|comment|revoke|$))`,
    'gi',
  );
  for (const m of stripSql(allSql).matchAll(re)) {
    if (!/is_allowed\s*\(/i.test(m[2] ?? '')) bad.push(m[1]);
  }
  return bad;
}

export function auditMigrations(files) {
  const allSql = files.map(([, s]) => s).join('\n');
  const problems = [];
  const seen = new Set();

  for (const [rel, src] of files) {
    for (const t of createdTables(src)) {
      if (seen.has(t)) continue;
      seen.add(t);
      if (t in NO_GRANT_REQUIRED) continue;

      if (!hasGrant(allSql, t)) {
        problems.push(
          `${rel}: journey.${t} 에 authenticated GRANT가 없음 — RLS가 아무리 옳아도 앱은 permission denied를 받는다(M-0020)`,
        );
      }
      // 최신 정책만 보면 되므로, 초대제 누락은 **마지막 정의**를 기준으로 판정한다.
      const lastDefs = policiesGateInvite(allSql, t);
      const anyGated = /is_allowed\s*\(/i.test(
        [...stripSql(allSql).matchAll(new RegExp(`create\\s+policy[\\s\\S]{0,400}?on\\s+journey\\.${t}\\b[\\s\\S]{0,400}`, 'gi'))]
          .map((x) => x[0])
          .join('\n'),
      );
      if (lastDefs.length && !anyGated) {
        problems.push(
          `${rel}: journey.${t} 의 정책 ${lastDefs.join(', ')} 에 is_allowed()(초대제)가 없음 — 허용목록 밖 사용자가 이 경로로 들어온다`,
        );
      }
    }
  }
  return problems;
}

// ── 셀프테스트: 알려진 실패가 RED로 잡히는지(게이트 비공허, CLAUDE.md §4) ──
let selfTestCount = 0;
{
  const OK = [
    [
      '0001.sql',
      `create table journey.foo (id uuid primary key);
       grant select, insert on journey.foo to authenticated;
       create policy foo_sel on journey.foo for select using (user_id = auth.uid() and journey.is_allowed());`,
    ],
  ];
  const cases = [
    { name: '권한·초대제 다 있으면 정상', fn: () => auditMigrations(OK), clean: true },
    {
      name: 'GRANT 누락 검출(0012에서 실제로 낸 결함)',
      fn: () =>
        auditMigrations([
          [
            '0012.sql',
            `create table if not exists journey.purged_ids (id uuid primary key);
             create policy p_sel on journey.purged_ids for select using (user_id = auth.uid() and journey.is_allowed());`,
          ],
        ]),
      clean: false,
    },
    {
      name: '초대제 누락 검출(0012에서 실제로 낸 결함)',
      fn: () =>
        auditMigrations([
          [
            '0012.sql',
            `create table journey.purged_ids (id uuid primary key);
             grant select on journey.purged_ids to authenticated;
             create policy p_sel on journey.purged_ids for select using (user_id = auth.uid());`,
          ],
        ]),
      clean: false,
    },
    {
      name: '권한이 다른 파일에 있어도 정상(마이그레이션은 추가 전용이다)',
      fn: () =>
        auditMigrations([
          ['0012.sql', `create table journey.foo (id uuid primary key);`],
          [
            '0013.sql',
            `grant select, insert on journey.foo to authenticated;
             create policy foo_sel on journey.foo for select using (user_id = auth.uid() and journey.is_allowed());`,
          ],
        ]),
      clean: true,
    },
    {
      name: '근거를 적은 제외는 통과(NO_GRANT_REQUIRED)',
      fn: () => auditMigrations([['0001.sql', `create table journey.allowed_users (email text primary key);`]]),
      clean: true,
    },
    {
      name: '주석 속 예시 SQL을 실제로 읽지 않는다(오탐 방지)',
      fn: () => auditMigrations([['0001.sql', `-- create table journey.ghost (id uuid);`]]),
      clean: true,
    },
    {
      name: '제외 목록이 비면 규율이 죽는다',
      fn: () => (Object.keys(NO_GRANT_REQUIRED).length ? [] : ['비었음']),
      clean: true,
    },
  ];
  const broken = cases.filter((c) => (c.fn().length === 0) !== c.clean);
  if (broken.length) {
    console.error(`check-migration-grants: 셀프테스트 실패 — 게이트가 공허함: ${broken.map((c) => c.name).join(', ')}`);
    process.exit(2);
  }
  selfTestCount = cases.length;
}

const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => [relative(ROOT, join(DIR, f)), readFileSync(join(DIR, f), 'utf8')]);

const problems = auditMigrations(files);
if (problems.length) {
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('check-migration-grants: 새 테이블에 권한·초대제가 빠졌다 — 앱은 permission denied를 받는다.');
  process.exit(1);
}
console.log(
  `check-migration-grants: OK (셀프테스트 ${selfTestCount}건 통과 · 마이그레이션 ${files.length}개 · 근거 있는 제외 ${Object.keys(NO_GRANT_REQUIRED).length}개)`,
);
