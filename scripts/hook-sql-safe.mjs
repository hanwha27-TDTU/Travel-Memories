// hook-sql-safe.mjs — PreToolUse(Supabase execute_sql|apply_migration): 파괴적 SQL을 막는다.
//
// 왜(헌법 §0 · docs/SECURITY.md 「Hook / 게이트 후보」): 운영 DB에 직접 SQL을 보낼 수 있는
// 경로가 열려 있다. 조사는 읽기 전용이어야 하고, 파괴적 변경은 **사람이 정한 절차**
// (백업 → BEGIN…ROLLBACK 사전검증 → 적용 → read-back)를 거쳐야 한다.
// 지시문은 맥락이고 강제는 훅이다(S-09) — 이 훅이 그 강제층이다.
//
// 계약:
//  · 입력: stdin JSON `{tool_name, tool_input:{query}}`
//  · exit 0 = 통과 · exit 2 = 차단(stderr가 Claude에게 전달된다)
//  · **정당한 예외 두 가지**를 연다(이유 없는 예외는 결함 · §7):
//      ① `BEGIN … ROLLBACK`으로 감싼 사전검증 — 이 저장소의 표준 절차다
//         (supabase-security-dev §3.4). 운영에 아무것도 남기지 않는다.
//      ② `-- sql-safe-ok: <이유>` 주석 — **이유가 있어야** 통과한다. 빈 이유는 거부.
//  · **판정 불가는 차단하지 않는다**(훅이 깨져 모든 조사가 막히면 더 큰 사고 · §2-D).
//    다만 파괴 동사가 확실히 보이면 막는다 — 그쪽이 되돌릴 수 없는 방향이다.

const DESTRUCTIVE = [
  { name: 'DROP TABLE/SCHEMA/FUNCTION/POLICY/TRIGGER', re: /\bdrop\s+(table|schema|function|policy|trigger|index|type|view)\b/gi },
  { name: 'TRUNCATE', re: /\btruncate\b/gi },
  { name: 'DELETE FROM', re: /\bdelete\s+from\b/gi },
  { name: 'RLS 비활성화', re: /\bdisable\s+row\s+level\s+security\b/gi },
  { name: 'REVOKE', re: /\brevoke\b/gi },
  { name: 'ALTER TABLE … DROP COLUMN', re: /\balter\s+table\b[\s\S]{0,200}?\bdrop\s+column\b/gi },
  // 🔴 **WHERE 없는 UPDATE**(T-024 · 2026-08-12). 이 목록에 `UPDATE`가 없어서, 사용자의 모든
  //    여행 제목을 한 줄로 비우거나 `deleted_at`을 전부 찍는 문장이 **그대로 통과**했다.
  //    `DELETE FROM`은 막으면서 「내용만 지우는 UPDATE」를 통과시키는 것은 대칭이 아니다(§7) —
  //    사용자에게는 둘 다 「기억이 사라졌다」로 보인다.
  //
  //    WHERE가 **있는** UPDATE는 막지 않는다. 그건 이 저장소의 일상 작업이고, 전부 막으면
  //    사람이 `sql-safe-ok`를 습관적으로 붙이게 되어 그 표식이 죽는다(오탐도 결함 · §11 ③).
];

/** SQL 주석을 걷어낸 본문(주석 안의 낱말을 파괴 동사로 오탐하지 않게 — 오탐도 결함). */
export function stripSqlComments(sql) {
  return String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

/** `BEGIN … ROLLBACK`으로 감싼 사전검증인가(운영 무변경 · 표준 절차). */
export function isRollbackWrapped(sql) {
  const body = stripSqlComments(sql).trim().toLowerCase();
  if (!/^begin\s*;/.test(body)) return false;
  if (!/\brollback\s*;?\s*$/.test(body)) return false;
  // 중간에 commit이 있으면 사전검증이 아니다(그 시점에 확정된다).
  return !/\bcommit\b/.test(body);
}

/** `-- sql-safe-ok: <이유>` — 이유가 **비어 있지 않아야** 통과(이유 없는 예외는 결함). */
export function hasReasonedOverride(sql) {
  const m = /--\s*sql-safe-ok\s*:\s*(\S.*)/i.exec(String(sql));
  return Boolean(m && m[1].trim().length >= 4);
}

/** 파괴적 구문을 모두 찾아 이름 배열로. 통과 사유가 있으면 빈 배열. */
export function findDestructiveSql(sql) {
  if (typeof sql !== 'string' || !sql.trim()) return [];
  if (isRollbackWrapped(sql) || hasReasonedOverride(sql)) return [];
  const body = stripSqlComments(sql);
  const hits = [];
  for (const d of DESTRUCTIVE) {
    if (new RegExp(d.re.source, d.re.flags).test(body)) hits.push(d.name);
  }
  if (hasWhereLessUpdate(body)) hits.push('WHERE 없는 UPDATE');
  return hits;
}

/**
 * WHERE 없는 `UPDATE`를 **문장 단위로** 찾는다 (T-024 · 2026-08-12).
 *
 * **정규식 하나로 풀지 않는다.** 전방탐색을 겹친 한 줄 정규식으로도 되지만, 문장을 `;`로
 * 갈라 각각 「update로 시작하고 where가 없다」만 보면 **읽는 사람이 무엇을 막는지 한눈에**
 * 알고, 다음 사람이 고칠 때 겁내지 않는다. 방어 코드가 읽히지 않으면 결국 꺼진다.
 *
 * 🔴 곁가지로 남긴다: 이 훅을 `node scripts/hook-sql-safe.mjs --selftest`로 부르면 **멈춘다.**
 * 훅 프로토콜상 stdin에서 JSON을 기다리기 때문이지 검사가 느린 게 아니다. 셀프테스트는
 * `check-hooks-wired`처럼 **모듈을 import해 `selfTest()`를 직접** 부른다.
 *
 * WHERE가 **있는** UPDATE는 막지 않는다 — 일상 작업이고, 전부 막으면 사람이
 * `sql-safe-ok`를 습관으로 붙여 그 표식이 죽는다(오탐도 결함 · §11 ③).
 */
export function hasWhereLessUpdate(body) {
  for (const stmt of String(body).split(';')) {
    const t = stmt.trim();
    if (!/^update\b/i.test(t)) continue;
    if (!/\bset\b/i.test(t)) continue;
    if (!/\bwhere\b/i.test(t)) return true;
  }
  return false;
}

// ── 셀프테스트: 알려진 실패를 주입해 잡히는지 + 정상이 통과하는지 양쪽 확인(§2-B) ──
export function selfTest() {
  const must = (sql, why) => {
    if (findDestructiveSql(sql).length === 0) throw new Error(`SELF-TEST 실패(차단 못 함): ${why}`);
  };
  const pass = (sql, why) => {
    if (findDestructiveSql(sql).length !== 0) throw new Error(`SELF-TEST 실패(오탐): ${why}`);
  };
  // 차단해야 하는 것
  must('delete from journey.trips where id = 1;', 'DELETE FROM');
  must('DROP TABLE journey.media;', 'DROP TABLE');
  must('truncate journey.moments;', 'TRUNCATE');
  must('alter table journey.trips disable row level security;', 'RLS 비활성화');
  must('revoke select on journey.trips from authenticated;', 'REVOKE');
  // 통과해야 하는 것 — 이 세션에서 실제로 돌린 모양들
  pass('select count(*) from journey.trips;', '읽기 전용 SELECT');
  pass('create index if not exists trips_user_idx on journey.trips (user_id);', '부가 DDL');
  pass('begin;\ncreate index x on journey.trips (user_id);\nrollback;', 'BEGIN…ROLLBACK 사전검증');
  pass('-- 이 쿼리는 delete from 을 설명만 한다\nselect 1;', '주석 안의 낱말(오탐 방지)');
  pass('delete from journey.tmp; -- sql-safe-ok: 사용자 승인된 정리, 백업·read-back 완료', '이유 있는 예외');
  // 이유 없는 예외는 통과시키면 안 된다
  must('delete from journey.tmp; -- sql-safe-ok:', '이유 없는 override');
  // 🔴 T-024 — WHERE 없는 UPDATE는 DELETE와 같은 무게로 막는다. 사용자에게는 둘 다 유실이다.
  must('update journey.trips set title = %s;', 'WHERE 없는 UPDATE');
  must('UPDATE journey.media SET deleted_at = now();', 'WHERE 없는 UPDATE');
  // 🔴 그리고 **오탐하지 않는다** — WHERE 있는 UPDATE는 일상 작업이다. 전부 막으면
  //    사람이 override를 습관으로 붙이고, 그 순간 이 훅은 죽는다(§11 ③).
  pass('update journey.trips set title = %s where id = %s;', 'WHERE 있는 UPDATE는 통과');
  pass('UPDATE journey.media SET deleted_at = now() WHERE trip_id = %s;', 'WHERE 있는 대량 수정도 통과');
  // BEGIN으로 시작해도 COMMIT이 있으면 사전검증이 아니다
  must('begin; delete from journey.trips; commit;', 'COMMIT이 있는 트랜잭션');
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  selfTest();
  const input = JSON.parse(await readStdin());
  const q = input?.tool_input?.query ?? '';
  const hits = findDestructiveSql(q);
  if (hits.length === 0) return;
  console.error(
    `🔴 SQL 차단 — 파괴적 구문이 감지됐습니다: ${hits.join(', ')}\n` +
      `  도구: ${input?.tool_name ?? '(불명)'}\n` +
      `  헌법 §0·SYNC_PROTOCOL: 삭제는 tombstone 경로만이고, 운영 변경은 백업 → BEGIN…ROLLBACK\n` +
      `  사전검증 → 적용 → read-back 절차를 거칩니다. 조사는 읽기 전용이어야 합니다.\n` +
      `  · 사전검증이라면 전체를 'begin; … rollback;'으로 감싸세요.\n` +
      `  · 사용자가 승인한 정당한 작업이라면 '-- sql-safe-ok: <이유>'를 적으세요(이유 필수).`,
  );
  process.exit(2);
}

if (process.argv[1] && process.argv[1].endsWith('hook-sql-safe.mjs')) {
  main().catch((e) => {
    console.error(`hook-sql-safe: 검사 실패(통과 처리) — ${e instanceof Error ? e.message : String(e)}`);
    process.exit(0);
  });
}
