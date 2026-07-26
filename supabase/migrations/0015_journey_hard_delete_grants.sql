-- 0015_journey_hard_delete_grants.sql — ADR-0030을 **서버에서도** 완성한다.
--
-- 증상(사용자 실기기 2026-07-26): 진단의 [서버에서도 지우기]를 눌렀더니 `3건을 서버로
-- 보냈어요`라고 했는데, 서버를 보니 **원장만 6 → 9로 늘고 행은 하나도 안 지워졌다.**
--
-- 원인: ADR-0030에서 영구삭제를 "tombstone 유지" → "행 하드 삭제"로 바꾸면서
-- **`authenticated`에게 DELETE 권한도, DELETE RLS 정책도 주지 않았다.** 네 테이블 모두
-- SELECT·INSERT·UPDATE만 있었다. `pushPurges`는 원장 기록(INSERT)까지는 성공하고
-- 그 다음 `hardDelete`에서 막혔다.
--
-- **M-0020과 같은 실수의 반복이다.** 그때는 *새 테이블*에 GRANT를 빠뜨렸고, 이번엔
-- *새 연산*에 GRANT를 빠뜨렸다. 근본형이 같다 — **코드에서 하기로 한 일을 서버가 허락하는지
-- 확인하지 않았다.** 게이트(`check-migration-grants`)를 이 형태까지 넓힌다.
--
-- 왜 §0의 "하드 삭제 정책을 주지 않는다"를 깨는가: **깨는 게 아니라 ADR-0030에서 이미 바뀐
-- 결정을 서버가 뒤늦게 따라가는 것이다.** CLAUDE.md §0는 그때 예외를 명시했는데(영구삭제는
-- 2단계 확인을 거친 명시적 의도) DB만 옛 상태로 남아 있었다. 문서와 서버의 드리프트였다.
--
-- 안전은 그대로 유지된다:
--   · 소유자 범위(`auth.uid()`) + 초대제(`is_allowed()`) — 형제 정책과 동일
--   · 앱은 2단계 확인을 거친 영구삭제에서만 DELETE를 부른다
--   · 좀비는 `purged_ids` 원장 + BEFORE INSERT 트리거가 막는다(행을 남길 필요가 없어진 이유)
--
-- `deleted_at is not null` 조건을 **일부러 넣지 않았다**: 어떤 자식이 tombstone이 아닌 채
-- 남으면 삭제가 조용히 0행이 되고 `remainingInFamily` read-back이 영원히 실패해 **빠져나올 수
-- 없는 덫**이 된다. 자료 손실을 막는 층은 이미 세 겹(2단계 확인·원장·트리거)이므로,
-- 탈출 불가능한 덫을 하나 더 놓는 쪽이 더 나쁘다.
--
-- 되돌리기: revoke delete + drop policy → ADR-0027 시절(행 유지) 동작으로 복귀.

grant delete on journey.trips    to authenticated;
grant delete on journey.moments  to authenticated;
grant delete on journey.media    to authenticated;
grant delete on journey.expenses to authenticated;

drop policy if exists trips_delete_own on journey.trips;
create policy trips_delete_own on journey.trips
  for delete using (auth.uid() = user_id and journey.is_allowed());

drop policy if exists moments_delete_own on journey.moments;
create policy moments_delete_own on journey.moments
  for delete using (auth.uid() = user_id and journey.is_allowed());

drop policy if exists media_delete_own on journey.media;
create policy media_delete_own on journey.media
  for delete using (auth.uid() = user_id and journey.is_allowed());

drop policy if exists expenses_delete_own on journey.expenses;
create policy expenses_delete_own on journey.expenses
  for delete using (auth.uid() = user_id and journey.is_allowed());
