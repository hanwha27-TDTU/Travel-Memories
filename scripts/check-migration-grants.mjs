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

import { readFileSync, readdirSync, existsSync } from 'node:fs';
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

/**
 * **코드가 하는 연산을 서버가 허락하는가**(M-0024, 2026-07-26).
 *
 * ADR-0030에서 영구삭제를 "tombstone 유지" → "행 하드 삭제"로 바꿨는데, 서버에 DELETE 권한도
 * 정책도 주지 않았다. `pushPurges`는 원장 기록(INSERT)까지 성공하고 그 다음 삭제에서 막혔다 —
 * 사용자 화면엔 `3건을 서버로 보냈어요`라고 뜨는데 **서버에선 아무것도 안 지워졌다.**
 *
 * M-0020과 같은 근본형이다: 그때는 *새 테이블*의 GRANT를, 이번엔 *새 연산*의 GRANT를 빠뜨렸다.
 * 그래서 이 검사는 테이블이 아니라 **연산**을 본다 — `.delete()`를 부르는 테이블마다 DELETE
 * 권한과 정책이 있는지.
 */
export function deleteOpsAreGranted(srcFiles, allSql) {
  const problems = [];
  const src = srcFiles.map(([, t]) => t).join('\n');
  if (!/\.delete\(\)/.test(src)) return problems; // 하드 삭제를 안 하면 검사할 것이 없다

  // ⚠️ **문장 단위로 끊어서 본다.** 처음엔 `grant …{0,120}… delete …{0,120}… on journey.trips`
  // 같은 느슨한 정규식을 썼는데, 그게 **문장 경계를 넘어** 다른 테이블의 grant를 잘못 물었다.
  // 그래서 trips의 DELETE 권한을 지워도 게이트가 통과했다 — 게이트가 공허했다.
  // 비공허 확인을 안 했으면 이 결함을 그대로 배포했을 것이다(§4가 존재하는 이유).
  const stmts = stripSql(allSql)
    .split(';')
    .map((x) => x.trim().replace(/\s+/g, ' '))
    .filter(Boolean);

  const grantsDelete = (t) =>
    stmts.some((st) => {
      const m = st.match(/^grant\s+([\w\s,]+?)\s+on\s+journey\.(\w+)\s+to\s+authenticated$/i);
      if (!m || m[2].toLowerCase() !== t) return false;
      return m[1]
        .split(',')
        .map((x) => x.trim().toLowerCase())
        .some((x) => x === 'delete' || x === 'all');
    });

  const hasDeletePolicy = (t) =>
    stmts.some((st) => new RegExp(`^create\\s+policy\\s+\\w+\\s+on\\s+journey\\.${t}\\s+for\\s+delete\\b`, 'i').test(st));

  const domains = [...src.matchAll(/remoteTable:\s*'(\w+)'/g)].map((m) => m[1].toLowerCase());
  for (const t of new Set(domains)) {
    if (!grantsDelete(t)) {
      problems.push(`journey.${t}: 코드가 하드 삭제(.delete())를 하는데 DELETE GRANT가 없음 — 서버가 조용히 막는다(M-0024)`);
    }
    if (!hasDeletePolicy(t)) {
      problems.push(`journey.${t}: DELETE RLS 정책이 없음 — 권한이 있어도 RLS가 기본 거부한다`);
    }
  }
  return problems;
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

/**
 * 정책의 **최종 정의**만 모은다.
 *
 * 마이그레이션은 추가 전용이라 옛 정의가 파일에 그대로 남아 있다 — 전체를 훑어 위반을 세면
 * 역사를 결함으로 신고하는 **오탐**이 된다(§2-B ③). 같은 이름의 정책이 여러 번 재정의되면
 * 파일 순서상 **마지막 것이 서버의 현실**이므로 그것만 판정 대상이다.
 */
export function latestPolicyDefs(files) {
  const out = new Map();
  const re =
    /create\s+policy\s+(\w+)\s+on\s+journey\.(\w+)\b([\s\S]*?)(?=;\s*(?:create|drop|grant|alter|comment|revoke|$))/gi;
  for (const [rel, src] of files) {
    for (const m of stripSql(src).matchAll(re)) {
      out.set(`${m[2].toLowerCase()}.${m[1].toLowerCase()}`, { rel, body: m[3] ?? '' });
    }
  }
  return out;
}

/** 스칼라 서브쿼리로 감싼 호출을 지운 뒤에도 **맨 호출**이 남는가. */
function bareCallRemains(body, callRe) {
  return new RegExp(callRe, 'i').test(body.replace(new RegExp(`\\(\\s*select\\s+${callRe}\\s*\\)`, 'gi'), ''));
}

/**
 * **정책 선언의 모양**을 잠근다(2026-07-27 건강진단 · advisor `auth_rls_initplan` 18건).
 *
 * 세 가지를 본다. 셋 다 "지금은 무해한데 조용히 어긋나는" 부류라 사람 눈으로는 안 잡힌다:
 *
 *  ① `auth.uid()`·`is_allowed()`를 **행마다** 재평가하지 않는가.
 *     둘 다 STABLE이므로 `(select …)`로 감싸면 Postgres가 InitPlan으로 끌어올려 **질의당
 *     1회**만 평가한다. 술어의 뜻은 바뀌지 않는다 — 바뀌는 것은 횟수뿐이다. `is_allowed()`는
 *     테이블을 조회하는 함수라, 감싸지 않으면 사진 N장에 조회가 N번 붙는다.
 *  ② 초대제가 결합돼 있는가(형제 전부가 지키는 계약 — 헌장 §2 불변식 #2).
 *  ③ 역할이 `authenticated`로 좁혀져 있는가.
 *     0013·0015가 `to authenticated`를 빠뜨려 정책 6개만 `public`이었다. anon은 GRANT가
 *     없고 `auth.uid()`가 NULL이라 실害는 없었지만, **이유 없는 비대칭은 결함처럼 보이고
 *     다음 사람이 반대 방향으로 통일한다**(§7).
 */
export function auditPolicyShape(files) {
  const problems = [];
  for (const [key, p] of latestPolicyDefs(files)) {
    if (bareCallRemains(p.body, 'auth\\.uid\\(\\s*\\)'))
      problems.push(
        `${p.rel}: 정책 ${key} 가 auth.uid()를 행마다 재평가한다 — (select auth.uid())로 감싼다(뜻은 같고 질의당 1회가 된다)`,
      );
    if (bareCallRemains(p.body, 'journey\\.is_allowed\\(\\s*\\)'))
      problems.push(
        `${p.rel}: 정책 ${key} 가 is_allowed()를 행마다 재평가한다 — (select journey.is_allowed())로 감싼다`,
      );
    if (!/is_allowed\s*\(/i.test(p.body))
      problems.push(`${p.rel}: 정책 ${key} 에 초대제(is_allowed())가 없다 — 허용목록 밖 사용자가 이 경로로 들어온다`);
    if (!/\bto\s+authenticated\b/i.test(p.body))
      problems.push(`${p.rel}: 정책 ${key} 에 'to authenticated'가 없다 — 역할이 public이 되어 형제 정책과 어긋난다`);
  }
  return problems;
}

/**
 * **`SECURITY DEFINER` 함수의 search_path가 빈 문자열로 고정돼 있는가**(헌장 §2 불변식 #5).
 *
 * 이 규칙은 헌장에 **처음부터 적혀 있었다.** 그런데 `block_purged_reinsert()`(0012)와
 * `unpurge_ids()`(0017)는 `journey, public`으로 태어났고, 2026-07-27 건강진단까지 아무도
 * 몰랐다. 참조를 전부 스키마로 한정해 두어 실害는 없었지만 — **불변식이 깨진 채로 있으면
 * 다음 사람이 그것을 기준으로 삼는다.** 조항(1층)만 있고 기계 검사(3층)가 없던 자리다.
 *
 * 최종 상태로 판정한다: 마지막 `create`가 정하고, 뒤따르는 `alter … set search_path`가 덮는다.
 */
export function auditDefinerSearchPath(files) {
  const state = new Map();
  for (const [rel, src] of files) {
    const clean = stripSql(src);
    for (const m of clean.matchAll(/create\s+(?:or\s+replace\s+)?function\s+journey\.(\w+)\s*\([^)]*\)([\s\S]*?)\bas\s+\$/gi)) {
      const head = m[2] ?? '';
      state.set(m[1].toLowerCase(), {
        rel,
        definer: /security\s+definer/i.test(head),
        searchPath: (head.match(/set\s+search_path\s*(?:=|to)\s*([^\s;]+)/i) ?? [])[1] ?? null,
      });
    }
    for (const m of clean.matchAll(
      /alter\s+function\s+journey\.(\w+)\s*\([^)]*\)\s*set\s+search_path\s*(?:=|to)\s*([^\s;]+)/gi,
    )) {
      const cur = state.get(m[1].toLowerCase());
      if (cur) Object.assign(cur, { searchPath: m[2], rel });
    }
  }
  const problems = [];
  for (const [name, s] of state) {
    if (!s.definer) continue;
    if (s.searchPath !== "''")
      problems.push(
        `${s.rel}: SECURITY DEFINER 함수 journey.${name}() 의 search_path가 ${s.searchPath ?? '미설정'} — ''로 고정한다(권한 상승 경로 차단, 헌장 §2 불변식 #5)`,
      );
  }
  return problems;
}

// ── 셀프테스트: 알려진 실패가 RED로 잡히는지(게이트 비공허, CLAUDE.md §4) ──
/** 계약을 전부 지키는 정책 표본. 셀프테스트 기준은 **살아 있는 파일이 아니라 인라인 표본**이다
 *  — 실제 파일을 기준으로 삼으면 그 파일이 바뀔 때 셀프테스트가 조용히 뜻을 바꾼다. */
const POLICY_GOOD =
  `create policy p on journey.foo for select to authenticated using ((select auth.uid()) = user_id and (select journey.is_allowed()));`;

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
      name: '하드 삭제에 DELETE 권한·정책이 있으면 정상',
      fn: () =>
        deleteOpsAreGranted(
          [['sync.ts', `remoteTable: 'trips',\n client.from(x).delete().eq('id', id)`]],
          `grant delete on journey.trips to authenticated;
           create policy trips_delete_own on journey.trips for delete using (true);`,
        ),
      clean: true,
    },
    {
      name: 'DELETE GRANT 누락 검출(오늘 실제로 낸 결함)',
      fn: () =>
        deleteOpsAreGranted(
          [['sync.ts', `remoteTable: 'trips',\n client.from(x).delete().eq('id', id)`]],
          `grant select, insert, update on journey.trips to authenticated;
           create policy trips_delete_own on journey.trips for delete using (true);`,
        ),
      clean: false,
    },
    {
      name: 'DELETE 정책 누락 검출',
      fn: () =>
        deleteOpsAreGranted(
          [['sync.ts', `remoteTable: 'trips',\n client.from(x).delete().eq('id', id)`]],
          `grant delete on journey.trips to authenticated;`,
        ),
      clean: false,
    },
    {
      name: '다른 테이블의 DELETE 권한에 속지 않는다(게이트가 실제로 공허했던 자리)',
      fn: () =>
        deleteOpsAreGranted(
          [['sync.ts', `remoteTable: 'trips',\n client.from(x).delete().eq('id', id)`]],
          `grant select on journey.trips to authenticated;
           grant delete on journey.moments to authenticated;
           create policy trips_delete_own on journey.trips for delete using (true);`,
        ),
      clean: false,
    },
    {
      name: '하드 삭제를 안 하면 검사할 것이 없다',
      fn: () => deleteOpsAreGranted([['sync.ts', `remoteTable: 'trips',`]], ''),
      clean: true,
    },

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
    // ── 정책 모양(2026-07-27) ──
    {
      name: '감싼 정책은 정상',
      fn: () => auditPolicyShape([['x.sql', POLICY_GOOD]]),
      clean: true,
    },
    {
      name: '맨 auth.uid()는 RED',
      fn: () =>
        auditPolicyShape([
          ['x.sql', `create policy p on journey.foo for select to authenticated using (auth.uid() = user_id and (select journey.is_allowed()));`],
        ]),
      clean: false,
    },
    {
      name: '맨 is_allowed()는 RED',
      fn: () =>
        auditPolicyShape([
          ['x.sql', `create policy p on journey.foo for select to authenticated using ((select auth.uid()) = user_id and journey.is_allowed());`],
        ]),
      clean: false,
    },
    {
      name: "'to authenticated' 누락은 RED(역할이 public이 된다)",
      fn: () =>
        auditPolicyShape([
          ['x.sql', `create policy p on journey.foo for select using ((select auth.uid()) = user_id and (select journey.is_allowed()));`],
        ]),
      clean: false,
    },
    {
      name: '초대제 누락은 RED',
      fn: () =>
        auditPolicyShape([
          ['x.sql', `create policy p on journey.foo for select to authenticated using ((select auth.uid()) = user_id);`],
        ]),
      clean: false,
    },
    {
      // 마이그레이션은 추가 전용이다 — 옛 정의를 결함으로 신고하면 그 게이트는 오탐으로 죽는다.
      name: '옛 정의가 파일에 남아 있어도 **최신**이 옳으면 정상(역사 오탐 방지)',
      fn: () =>
        auditPolicyShape([
          ['0001.sql', `create policy p on journey.foo for select using (auth.uid() = user_id);`],
          ['0018.sql', POLICY_GOOD],
        ]),
      clean: true,
    },
    {
      name: '반대로 **최신**이 틀리면 옛것이 옳아도 RED',
      fn: () =>
        auditPolicyShape([
          ['0001.sql', POLICY_GOOD],
          ['0018.sql', `create policy p on journey.foo for select to authenticated using (auth.uid() = user_id and (select journey.is_allowed()));`],
        ]),
      clean: false,
    },
    // ── SECURITY DEFINER search_path(2026-07-27) ──
    {
      name: "search_path=''로 태어난 DEFINER 함수는 정상",
      fn: () => auditDefinerSearchPath([['x.sql', `create or replace function journey.f() returns boolean language sql security definer set search_path = '' as $$ select true $$;`]]),
      clean: true,
    },
    {
      name: 'search_path가 journey,public인 DEFINER 함수는 RED',
      fn: () => auditDefinerSearchPath([['x.sql', `create or replace function journey.f() returns trigger language plpgsql security definer set search_path = journey, public as $$ begin return new; end $$;`]]),
      clean: false,
    },
    {
      name: '나중 alter가 고쳤으면 정상(최종 상태로 판정)',
      fn: () =>
        auditDefinerSearchPath([
          ['0012.sql', `create or replace function journey.f() returns trigger language plpgsql security definer set search_path = journey, public as $$ begin return new; end $$;`],
          ['0018.sql', `alter function journey.f() set search_path = '';`],
        ]),
      clean: true,
    },
    {
      name: 'SECURITY DEFINER가 아니면 대상이 아니다(오탐 방지)',
      fn: () => auditDefinerSearchPath([['x.sql', `create or replace function journey.f() returns trigger language plpgsql set search_path = journey as $$ begin return new; end $$;`]]),
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

const srcFiles = [];
for (const rel of ['src/services/sync.ts', 'src/services/purge.ts']) {
  const abs = join(ROOT, rel);
  if (existsSync(abs)) srcFiles.push([rel, readFileSync(abs, 'utf8')]);
}
const problems = [
  ...auditMigrations(files),
  ...deleteOpsAreGranted(srcFiles, files.map(([, t]) => t).join('\n')),
  ...auditPolicyShape(files),
  ...auditDefinerSearchPath(files),
];
if (problems.length) {
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('check-migration-grants: 서버 계약(권한·초대제·정책 모양·함수 search_path)이 어긋났다.');
  process.exit(1);
}
console.log(
  `check-migration-grants: OK (셀프테스트 ${selfTestCount}건 통과 · 마이그레이션 ${files.length}개 · 근거 있는 제외 ${Object.keys(NO_GRANT_REQUIRED).length}개)`,
);
