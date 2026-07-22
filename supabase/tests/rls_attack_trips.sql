-- rls_attack_trips.sql · trips RLS 공격검사 (H-12 — 정적 검사만으로 통과 금지)
-- 실행: 프로젝트에 0001_trips.sql 적용 후 execute_sql/psql로 전체 실행.
-- 전부 트랜잭션 안에서 수행하고 ROLLBACK — 실데이터를 남기지 않는다.
-- 실패 시 RAISE EXCEPTION으로 비정상 종료(성공 시 마지막 SELECT가 'RLS_ATTACK_PASS').

begin;

-- 테스트 사용자 2명 (auth.users에 직접 삽입 — 테스트 트랜잭션 내에서만 존재)
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'user-a@test.local', 'x', now(), now(), now()),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'user-b@test.local', 'x', now(), now(), now());

-- ── 사용자 A로 여행 생성 ──
set local role authenticated;
set local request.jwt.claims to '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}';

insert into public.trips (id, user_id, title)
values ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'A의 제주 여행');

do $$
begin
  if (select count(*) from public.trips) <> 1 then
    raise exception 'FAIL: A가 자신의 여행을 볼 수 없음';
  end if;
end $$;

-- 공격 1: A가 B 소유로 위조 INSERT (user_id 위조) → 거부되어야 함
do $$
begin
  begin
    insert into public.trips (user_id, title)
    values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '위조 여행');
    raise exception 'FAIL: user_id 위조 INSERT가 허용됨';
  exception when insufficient_privilege or check_violation then
    null; -- 기대: RLS with check 거부
  end;
end $$;

-- ── 사용자 B로 전환 ──
set local request.jwt.claims to '{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated"}';

-- 공격 2: B가 A의 여행 조회 → 0행이어야 함
do $$
begin
  if (select count(*) from public.trips) <> 0 then
    raise exception 'FAIL: B가 A의 여행을 볼 수 있음 (격리 실패)';
  end if;
end $$;

-- 공격 3: B가 A의 여행 UPDATE → 0행 영향이어야 함
update public.trips set title = '탈취' where id = '11111111-1111-4111-8111-111111111111';
do $$
begin
  if found then null; end if; -- update는 위에서 실행됨
  set local request.jwt.claims to '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}';
  if (select title from public.trips where id = '11111111-1111-4111-8111-111111111111') <> 'A의 제주 여행' then
    raise exception 'FAIL: B가 A의 여행을 수정함';
  end if;
  set local request.jwt.claims to '{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated"}';
end $$;

-- 공격 4: B가 A의 여행 DELETE → DELETE 정책 없음, 0행 영향이어야 함
delete from public.trips where id = '11111111-1111-4111-8111-111111111111';
do $$
begin
  set local request.jwt.claims to '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}';
  if (select count(*) from public.trips where id = '11111111-1111-4111-8111-111111111111') <> 1 then
    raise exception 'FAIL: DELETE가 허용됨 (tombstone 전용 위반)';
  end if;
end $$;

-- 공격 5: A 자신도 하드 DELETE 불가(정책 없음)여야 함
set local request.jwt.claims to '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}';
delete from public.trips where id = '11111111-1111-4111-8111-111111111111';
do $$
begin
  if (select count(*) from public.trips where id = '11111111-1111-4111-8111-111111111111') <> 1 then
    raise exception 'FAIL: 소유자 하드 DELETE가 허용됨 (DEL-CONTRACT 위반)';
  end if;
end $$;

-- 공격 6: anon 역할 조회 → 권한/정책 없음으로 실패 또는 0행이어야 함
set local role anon;
do $$
begin
  begin
    if (select count(*) from public.trips) <> 0 then
      raise exception 'FAIL: anon이 여행을 볼 수 있음';
    end if;
  exception when insufficient_privilege then
    null; -- 기대: 권한 자체가 없음(revoke)
  end;
end $$;

reset role;
select 'RLS_ATTACK_PASS' as result;

rollback;
