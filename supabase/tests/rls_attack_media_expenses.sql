-- rls_attack_media_expenses.sql · journey.media·expenses RLS + H-02 복합 FK + ZOMBIE-GUARD 공격검사.
-- 전부 트랜잭션 안 + ROLLBACK. 실패 시 RAISE EXCEPTION. 성공 시 'MEDIA_EXPENSE_RLS_ZOMBIE_PASS'.
-- 실행: Supabase SQL Editor 또는 MCP execute_sql. 2026-07-23 프로젝트 Travel&Accounting에서 통과 확인.

begin;
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000','authenticated','authenticated','mx-a@test.local','x',now(),now(),now()),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','00000000-0000-0000-0000-000000000000','authenticated','authenticated','mx-b@test.local','x',now(),now(),now());
insert into journey.allowed_users(email) values ('mx-a@test.local'),('mx-b@test.local');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","email":"mx-a@test.local","role":"authenticated"}',true);
insert into journey.trips(id,user_id,title) values ('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','A여행');
insert into journey.moments(id,user_id,trip_id,title) values ('22222222-2222-4222-8222-222222222222','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','A순간');
insert into journey.media(id,user_id,moment_id,trip_id,storage_path) values ('33333333-3333-4333-8333-333333333333','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/33333333.webp');
insert into journey.expenses(id,user_id,moment_id,trip_id,original_amount,original_currency) values ('44444444-4444-4444-8444-444444444444','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111',15000,'KRW');
do $$ begin
  if (select count(*) from journey.media)<>1 then raise exception 'FAIL: A media 못봄'; end if;
  if (select count(*) from journey.expenses)<>1 then raise exception 'FAIL: A expense 못봄'; end if;
end $$;
-- H-02: 없는 순간에 media 부착 → 복합 FK 위반
do $$ begin begin
  insert into journey.media(user_id,moment_id,trip_id) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',gen_random_uuid(),'11111111-1111-4111-8111-111111111111');
  raise exception 'FAIL: 없는 순간에 media 부착됨';
exception when foreign_key_violation then null; end; end $$;

-- B 격리 공격
select set_config('request.jwt.claims','{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","email":"mx-b@test.local","role":"authenticated"}',true);
do $$ begin
  if (select count(*) from journey.media)<>0 then raise exception 'FAIL: B가 A media 조회'; end if;
  if (select count(*) from journey.expenses)<>0 then raise exception 'FAIL: B가 A expense 조회'; end if;
end $$;
do $$ begin begin
  insert into journey.media(user_id,moment_id,trip_id) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111');
  raise exception 'FAIL: B가 A순간에 media 부착(H-02)';
exception when foreign_key_violation or insufficient_privilege or check_violation then null; end; end $$;
do $$ begin begin
  insert into journey.expenses(user_id,moment_id,trip_id,original_amount,original_currency) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111',1,'KRW');
  raise exception 'FAIL: expense user_id 위조';
exception when insufficient_privilege or check_violation or foreign_key_violation then null; end; end $$;

-- ZOMBIE-GUARD(media): 같은/낮은 version 부활 거부, 높은 version 복원
select set_config('request.jwt.claims','{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","email":"mx-a@test.local","role":"authenticated"}',true);
update journey.media set deleted_at=now(), version=3 where id='33333333-3333-4333-8333-333333333333';
update journey.media set deleted_at=null, version=3 where id='33333333-3333-4333-8333-333333333333';
do $$ begin if (select deleted_at from journey.media where id='33333333-3333-4333-8333-333333333333') is null then raise exception 'FAIL: media 같은 version 부활(좀비!)'; end if; end $$;
update journey.media set deleted_at=null, version=5 where id='33333333-3333-4333-8333-333333333333';
do $$ begin if (select deleted_at from journey.media where id='33333333-3333-4333-8333-333333333333') is not null then raise exception 'FAIL: media 높은 version 복원 막힘'; end if; end $$;

select 'MEDIA_EXPENSE_RLS_ZOMBIE_PASS' as result;
rollback;
