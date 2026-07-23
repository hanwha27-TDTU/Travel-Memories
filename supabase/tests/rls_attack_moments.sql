-- rls_attack_moments.sql · journey.moments RLS + H-02 복합 FK 공격검사.
-- 전부 트랜잭션 안 + ROLLBACK. 실패 시 RAISE EXCEPTION. 성공 시 'MOMENTS_RLS_PASS'.

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'user-a@test.local', 'x', now(), now(), now()),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'user-b@test.local', 'x', now(), now(), now());
insert into journey.allowed_users (email) values ('user-a@test.local'), ('user-b@test.local');

-- ── A: 자기 여행에 순간 생성, 조회됨 ──
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","email":"user-a@test.local","role":"authenticated"}', true);
insert into journey.trips (id, user_id, title)
values ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'A여행');
insert into journey.moments (id, user_id, trip_id, title)
values ('22222222-2222-4222-8222-222222222222', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'A순간');
do $$ begin
  if (select count(*) from journey.moments) <> 1 then raise exception 'FAIL: A가 자기 순간 못봄'; end if;
end $$;

-- 공격 1: 존재하지 않는 trip에 부착 → 복합 FK 위반
do $$ begin begin
  insert into journey.moments (user_id, trip_id, title)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', gen_random_uuid(), 'x');
  raise exception 'FAIL: 없는 trip에 순간 부착됨';
exception when foreign_key_violation then null; end; end $$;

-- ── B ──
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","email":"user-b@test.local","role":"authenticated"}', true);

-- 공격 2: B가 A의 순간 조회 → 0행
do $$ begin
  if (select count(*) from journey.moments) <> 0 then raise exception 'FAIL: B가 A순간 조회(격리 실패)'; end if;
end $$;

-- 공격 3: B가 A여행에 순간 부착 → 복합 FK (trip,B) 불일치로 차단(H-02)
do $$ begin begin
  insert into journey.moments (user_id, trip_id, title)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111', 'steal');
  raise exception 'FAIL: B가 A여행에 순간 부착(H-02 위반)';
exception when foreign_key_violation or insufficient_privilege or check_violation then null; end; end $$;

-- 공격 4: B가 user_id=A로 위조 INSERT → RLS with check 차단
do $$ begin begin
  insert into journey.moments (user_id, trip_id, title)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'forge');
  raise exception 'FAIL: user_id 위조 허용';
exception when insufficient_privilege or check_violation or foreign_key_violation then null; end; end $$;

reset role;
select 'MOMENTS_RLS_PASS' as result;

rollback;
