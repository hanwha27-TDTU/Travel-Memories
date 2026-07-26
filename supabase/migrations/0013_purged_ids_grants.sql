-- 0013_purged_ids_grants.sql — 0012의 원장 테이블에 **역할 권한과 초대제**가 빠져 있었다.
--
-- 증상(사용자 실기기 2026-07-26): 진단 「저장 상태」가 `! 문제 · 확인하지 못했어요 /
-- 영구삭제 원장 조회 실패:` — **콜론 뒤가 비어 있었다.** 빈 메시지가 단서였다.
--
-- 원인 두 가지. 둘 다 0012가 새 테이블을 만들면서 형제 테이블에는 있는 것을 빠뜨린 것이다:
--
--   ① **GRANT 누락.** trips/moments/media/expenses에는 `authenticated`에게 SELECT·INSERT·
--      UPDATE 권한이 있는데 purged_ids에는 **아무 권한도 없었다.** RLS는 "누가 어느 행을"이고
--      GRANT는 "누가 이 테이블에 접근이나 할 수 있는가"다 — 서로 다른 층인데 RLS만 썼다.
--      결과: 앱(`authenticated` 역할)의 모든 요청이 permission denied.
--
--   ② **초대제(`is_allowed()`) 누락.** 헌장 §2.2는 모든 정책이 `auth.uid()` **AND
--      `journey.is_allowed()`**여야 한다고 못박는다. 형제 정책은 전부 그렇게 돼 있는데
--      원장만 소유자 술어뿐이었다.
--
-- 왜 내 검증이 이걸 놓쳤나(기록해 둘 값어치가 있다): 0012 적용 뒤 트리거 실효를 확인했는데,
-- 그 SQL을 **superuser로** 돌렸다. superuser는 GRANT도 RLS도 우회한다 — 앱이 쓰는 역할이
-- 아니다. 헌장 §4는 `set_config('request.jwt.claims', …)`로 **남이 되어 보라**고 적혀 있고,
-- 그대로 했으면 즉시 잡혔다. "검증했다"의 기준은 성공이 아니라 **같은 역할로 확인했는가**다.
--
-- 되돌리기: revoke ... from authenticated; (앱이 원장을 못 읽게 되어 0012 이전 증상으로 복귀)

-- ① 형제 테이블과 같은 층의 권한. **UPDATE·DELETE는 주지 않는다** — 원장을 고치거나 지울 수
--    있으면 좀비 차단(0012의 BEFORE INSERT 트리거)이 통째로 뚫린다. 이 비대칭은 의도다.
grant select, insert on journey.purged_ids to authenticated;

-- ② 초대제 결합. 허용목록 밖 사용자는 로그인해도 원장을 읽지 못한다(형제와 동일).
drop policy if exists purged_ids_owner_select on journey.purged_ids;
create policy purged_ids_owner_select on journey.purged_ids
  for select using (user_id = auth.uid() and journey.is_allowed());

drop policy if exists purged_ids_owner_insert on journey.purged_ids;
create policy purged_ids_owner_insert on journey.purged_ids
  for insert with check (user_id = auth.uid() and journey.is_allowed());

comment on table journey.purged_ids is
  '영구삭제된 id 원장. 내용은 담지 않는다(id·소유자·시각만). ① 다른 기기가 pull에서 읽어 자기 사본을 치운다 ② BEFORE INSERT 트리거가 재삽입을 거부해 좀비를 물리적으로 막는다. UPDATE/DELETE 권한과 정책이 없는 것은 의도다 — 원장을 지울 수 있으면 좀비 차단이 뚫린다.';
