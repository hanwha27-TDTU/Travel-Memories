-- 0018_rls_initplan_and_fn_hygiene.sql — 건강진단(2026-07-27)에서 나온 서버측 3건.
--
-- 셋 다 **지금은 무해**하다. 그래서 오히려 적어 둘 값어치가 있다 — 무해한 것을 왜 고치나?
-- 답: 이 셋의 수리비는 **지금이 가장 싸다.** 행이 11개일 때도 마이그레이션 하나, 사진이
-- 수천 장일 때도 마이그레이션 하나인데, 그때는 실측·롤백·재검증 부담이 따라붙는다.
--
--   ① `auth_rls_initplan`(advisor WARN 18건) — 정책 18개가 행마다 `auth.uid()`와
--      `journey.is_allowed()`를 **다시 평가**한다. 후자는 테이블을 조회하는 함수다.
--      사진 N장을 pull하면 함수 호출이 N번 붙는다(지금 N=9라 안 보인다).
--   ② **문서와 코드가 어긋나 있었다** — 헌장 `supabase-security-dev` §2 불변식 #5는
--      *"`SECURITY DEFINER` 함수는 `search_path=''` 고정"*이라고 못박는데,
--      `block_purged_reinsert()`와 `unpurge_ids()`는 `'journey, public'`이었다.
--      두 함수 모두 참조를 이미 스키마로 한정하고 있어 실害는 없었지만, **불변식이
--      깨진 채로 있으면 다음 사람이 그것을 기준으로 삼는다.**
--   ③ `block_purged_reinsert()`가 `anon`에게 EXECUTE로 열려 있어 `/rest/v1/rpc/`에
--      **이름이 보인다**(journey가 노출 스키마라서). 트리거 함수라 직접 호출은 Postgres가
--      거부하므로 실害는 없다. 좀비 차단 장치의 이름을 미인증자에게 보일 이유도 없다.
--
-- 함께 고치는 **형제 비대칭**(§7): DELETE 정책 4종과 purged_ids 정책 2종만 역할이
-- `public`이었다(0013·0015가 `to authenticated`를 빠뜨렸다). anon은 GRANT가 없고
-- `auth.uid()`가 NULL이라 실害는 없지만, 형제 12개는 `authenticated`로 좁혀져 있다.
-- **이유 없는 비대칭은 결함처럼 보이고, 다음 사람이 선의로 반대 방향으로 통일한다.**
--
-- 왜 `(select …)`가 같은 뜻인가(안전성 근거):
--   `auth.uid()`와 `journey.is_allowed()`는 둘 다 STABLE이다 — 한 질의 안에서 값이 변하지
--   않는다. 스칼라 서브쿼리로 감싸면 Postgres가 **InitPlan으로 끌어올려 질의당 1회**만
--   평가한다. 술어의 진리값은 바뀌지 않는다. 바뀌는 것은 평가 횟수뿐이다.
--
-- 왜 `alter policy`가 아니라 **drop + create**인가(게이트 정합):
--   `check-migration-grants`는 `create policy` **본문 텍스트**를 진실원으로 삼아 초대제
--   결합(`is_allowed()`)을 검사한다. `alter policy`로 바꾸면 게이트가 보는 텍스트는 옛
--   정의로 남고, 그 뒤로 이 자리는 **검사되지 않는 자리**가 된다(공허해진다).
--
-- 되돌리기: 이 파일의 정책을 `(select …)` 없이, `to authenticated` 없이 재생성하면 0017
--   시점으로 돌아간다. 함수 둘은 `set search_path to 'journey','public'`, 권한은
--   `grant execute on function journey.block_purged_reinsert() to anon, authenticated;`.
--   (되돌릴 일은 없어야 한다 — 술어의 뜻이 바뀌지 않으므로.)

-- ── ① + 형제 비대칭: 소유자 RLS 18종을 InitPlan 형태로 재작성 ─────────────────────
--
-- 술어는 형제 전부에서 **글자 그대로 같다**: (select auth.uid()) = user_id
--                                          and (select journey.is_allowed())
-- 이 대칭이 곧 검사 가능성이다 — 하나만 다르면 눈에 띈다.

-- trips
drop policy if exists trips_select_own on journey.trips;
create policy trips_select_own on journey.trips
  for select to authenticated
  using ((select auth.uid()) = user_id and (select journey.is_allowed()));

drop policy if exists trips_insert_own on journey.trips;
create policy trips_insert_own on journey.trips
  for insert to authenticated
  with check ((select auth.uid()) = user_id and (select journey.is_allowed()));

drop policy if exists trips_update_own on journey.trips;
create policy trips_update_own on journey.trips
  for update to authenticated
  using ((select auth.uid()) = user_id and (select journey.is_allowed()))
  with check ((select auth.uid()) = user_id and (select journey.is_allowed()));

drop policy if exists trips_delete_own on journey.trips;
create policy trips_delete_own on journey.trips
  for delete to authenticated
  using ((select auth.uid()) = user_id and (select journey.is_allowed()));

-- moments
drop policy if exists moments_select_own on journey.moments;
create policy moments_select_own on journey.moments
  for select to authenticated
  using ((select auth.uid()) = user_id and (select journey.is_allowed()));

drop policy if exists moments_insert_own on journey.moments;
create policy moments_insert_own on journey.moments
  for insert to authenticated
  with check ((select auth.uid()) = user_id and (select journey.is_allowed()));

drop policy if exists moments_update_own on journey.moments;
create policy moments_update_own on journey.moments
  for update to authenticated
  using ((select auth.uid()) = user_id and (select journey.is_allowed()))
  with check ((select auth.uid()) = user_id and (select journey.is_allowed()));

drop policy if exists moments_delete_own on journey.moments;
create policy moments_delete_own on journey.moments
  for delete to authenticated
  using ((select auth.uid()) = user_id and (select journey.is_allowed()));

-- media
drop policy if exists media_select_own on journey.media;
create policy media_select_own on journey.media
  for select to authenticated
  using ((select auth.uid()) = user_id and (select journey.is_allowed()));

drop policy if exists media_insert_own on journey.media;
create policy media_insert_own on journey.media
  for insert to authenticated
  with check ((select auth.uid()) = user_id and (select journey.is_allowed()));

drop policy if exists media_update_own on journey.media;
create policy media_update_own on journey.media
  for update to authenticated
  using ((select auth.uid()) = user_id and (select journey.is_allowed()))
  with check ((select auth.uid()) = user_id and (select journey.is_allowed()));

drop policy if exists media_delete_own on journey.media;
create policy media_delete_own on journey.media
  for delete to authenticated
  using ((select auth.uid()) = user_id and (select journey.is_allowed()));

-- expenses
drop policy if exists expenses_select_own on journey.expenses;
create policy expenses_select_own on journey.expenses
  for select to authenticated
  using ((select auth.uid()) = user_id and (select journey.is_allowed()));

drop policy if exists expenses_insert_own on journey.expenses;
create policy expenses_insert_own on journey.expenses
  for insert to authenticated
  with check ((select auth.uid()) = user_id and (select journey.is_allowed()));

drop policy if exists expenses_update_own on journey.expenses;
create policy expenses_update_own on journey.expenses
  for update to authenticated
  using ((select auth.uid()) = user_id and (select journey.is_allowed()))
  with check ((select auth.uid()) = user_id and (select journey.is_allowed()));

drop policy if exists expenses_delete_own on journey.expenses;
create policy expenses_delete_own on journey.expenses
  for delete to authenticated
  using ((select auth.uid()) = user_id and (select journey.is_allowed()));

-- purged_ids — **UPDATE·DELETE 정책이 없는 것은 여전히 의도다**(0013). 원장을 고치거나
-- 지울 수 있으면 좀비 차단이 통째로 뚫린다. 복원은 0017의 `unpurge_ids()` 좁은 문으로만.
drop policy if exists purged_ids_owner_select on journey.purged_ids;
create policy purged_ids_owner_select on journey.purged_ids
  for select to authenticated
  using ((select auth.uid()) = user_id and (select journey.is_allowed()));

drop policy if exists purged_ids_owner_insert on journey.purged_ids;
create policy purged_ids_owner_insert on journey.purged_ids
  for insert to authenticated
  with check ((select auth.uid()) = user_id and (select journey.is_allowed()));

-- ── ② 불변식 #5 복구: SECURITY DEFINER 함수의 search_path 고정 ────────────────────
--
-- 두 함수의 참조는 이미 전부 스키마 한정(`journey.…`·`auth.uid()`)이라 본문 변경이 없다.
-- 바뀌는 것은 탐색 경로뿐이며, `public`이 경로에서 빠지므로 그 스키마에 객체를 만들 수 있는
-- 누군가가 이름을 가로챌 여지가 구조적으로 사라진다.
-- (`is_allowed()`는 처음부터 `''`였다 — 이 둘만 형제에서 벗어나 있었다.)
alter function journey.block_purged_reinsert() set search_path = '';
alter function journey.unpurge_ids(uuid[]) set search_path = '';

-- ── ③ 트리거 함수를 REST 표면에서 내린다 ─────────────────────────────────────────
--
-- 실증(적용 전 BEGIN…ROLLBACK, `set local role authenticated`): 회수 후에도
--   · 원장에 없는 id 삽입 → 1행(트리거가 정상 통과시킨다)
--   · 원장에 있는 id 삽입 → 0행(좀비 차단 유지)
-- Postgres는 트리거 함수의 EXECUTE 권한을 **트리거 생성 시점에** 검사하고 발화 때마다
-- 검사하지 않는다. 그래서 회수해도 트리거는 죽지 않는다.
--
-- 🔴 `journey.is_allowed()`에는 **절대 같은 짓을 하지 않는다.** RLS 정책 식은 호출자
--    권한으로 평가되므로 `authenticated`의 EXECUTE를 회수하면 정책 18개가 전부 실패한다
--    — 즉 앱이 자기 데이터를 못 읽는다. 같은 advisor 경고가 뜨지만 **처방이 정반대다.**
revoke execute on function journey.block_purged_reinsert() from anon, authenticated, public;

comment on function journey.block_purged_reinsert() is
  '영구삭제 원장에 있는 id의 재삽입을 조용히 버리는 BEFORE INSERT 트리거 함수. 트리거로만 쓰이므로 EXECUTE는 회수돼 있다(REST 표면 축소, 0018). 트리거 발화에는 EXECUTE 권한이 필요하지 않다.';
