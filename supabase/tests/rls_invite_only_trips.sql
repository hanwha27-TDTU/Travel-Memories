-- rls_invite_only_trips.sql · 초대제 잠금 공격검사 (ADR-0021 — 정적 검사만으로 통과 금지)
-- 실행: execute_sql/psql로 전체 실행. 전부 트랜잭션 안 + ROLLBACK — 실데이터 없음.
-- 실패 시 RAISE EXCEPTION(비정상 종료). 성공 시 결과 'INVITE_ONLY_PASS'.
-- 핵심: 허용목록에 없는 사용자는 로그인해도 자기 행조차 읽기/쓰기 불가.

begin;

-- 테스트 사용자 2명: allow=허용목록 포함, deny=미포함
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'allow@test.local', 'x', now(), now(), now()),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'deny@test.local',  'x', now(), now(), now());

insert into journey.allowed_users (email) values ('allow@test.local');  -- deny@는 일부러 제외

-- 미리 두 사용자 소유의 행을 심어둔다(service role, RLS 우회).
insert into journey.trips (user_id, title) values
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '허용자 여행'),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '비허용자 여행');

-- ── 허용 사용자: 자기 행이 보이고 INSERT 된다 ──
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","email":"allow@test.local","role":"authenticated"}', true);
do $$ begin
  if (select count(*) from journey.trips) <> 1 then
    raise exception 'FAIL: 허용 사용자가 자기 행을 못 봄';
  end if;
end $$;
insert into journey.trips (user_id, title)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '허용자 새 여행');  -- 성공해야 함

-- ── 비허용 사용자: 자기 행조차 0건, INSERT는 차단 ──
select set_config('request.jwt.claims', '{"sub":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","email":"deny@test.local","role":"authenticated"}', true);
do $$ begin
  if (select count(*) from journey.trips) <> 0 then
    raise exception 'FAIL: 비허용 사용자가 데이터를 볼 수 있음';
  end if;
end $$;
do $$ begin
  begin
    insert into journey.trips (user_id, title)
    values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '차단 시도');
    raise exception 'FAIL: 비허용 사용자의 INSERT가 허용됨';
  exception when insufficient_privilege or check_violation then null;
  end;
end $$;

-- ── email 클레임 자체가 없는 경우도 차단 ──
select set_config('request.jwt.claims', '{"sub":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","role":"authenticated"}', true);
do $$ begin
  if (select count(*) from journey.trips) <> 0 then
    raise exception 'FAIL: email 없는 세션이 데이터를 볼 수 있음';
  end if;
end $$;

reset role;
select 'INVITE_ONLY_PASS' as result;

rollback;
