-- rls_attack_trips.sql · journey.trips RLS 공격검사 (H-12 — 정적 검사만으로 통과 금지)
-- 실행: execute_sql/psql로 전체 실행. 전부 트랜잭션 안 + ROLLBACK — 실데이터 없음.
-- 실패 시 RAISE EXCEPTION(비정상 종료). 성공 시 결과 'RLS_ATTACK_PASS'.
-- 클레임 전환은 최상위 set_config로 수행(트랜잭션 로컬).

begin;

-- 테스트 사용자 2명 (트랜잭션 내에서만 존재)
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'user-a@test.local', 'x', now(), now(), now()),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'user-b@test.local', 'x', now(), now(), now());

-- ── 사용자 A ──
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}', true);

insert into journey.trips (id, user_id, title)
values ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'A의 제주 여행');

do $$ begin
  if (select count(*) from journey.trips) <> 1 then
    raise exception 'FAIL: A가 자신의 여행을 볼 수 없음';
  end if;
end $$;

-- 공격 1: A가 B 소유로 위조 INSERT → RLS with check 거부되어야 함
do $$ begin
  begin
    insert into journey.trips (user_id, title)
    values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '위조 여행');
    raise exception 'FAIL: user_id 위조 INSERT가 허용됨';
  exception when insufficient_privilege or check_violation then null;
  end;
end $$;

-- ── 사용자 B ──
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated"}', true);

-- 공격 2: B가 A의 여행 조회 → 0행
do $$ begin
  if (select count(*) from journey.trips) <> 0 then
    raise exception 'FAIL: B가 A의 여행을 볼 수 있음 (격리 실패)';
  end if;
end $$;

-- 공격 3: B가 A의 여행 UPDATE 시도 (RLS로 0행 영향이어야 함)
update journey.trips set title = '탈취' where id = '11111111-1111-4111-8111-111111111111';

-- 공격 4: B가 A의 여행 DELETE 시도 (권한+정책 이중 차단)
do $$ begin
  begin
    delete from journey.trips where id = '11111111-1111-4111-8111-111111111111';
    -- DELETE 권한 자체가 없어 예외가 정상. 예외 없이 지나가면 0행 영향인지 아래에서 확인.
  exception when insufficient_privilege then null;
  end;
end $$;

-- ── 다시 사용자 A: 공격 3·4 결과 검증 ──
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}', true);

do $$ begin
  if (select title from journey.trips where id = '11111111-1111-4111-8111-111111111111') <> 'A의 제주 여행' then
    raise exception 'FAIL: B가 A의 여행을 수정함';
  end if;
  if (select count(*) from journey.trips where id = '11111111-1111-4111-8111-111111111111') <> 1 then
    raise exception 'FAIL: B가 A의 여행을 삭제함';
  end if;
end $$;

-- 공격 5: A 자신도 하드 DELETE 불가(권한 없음)여야 함 — tombstone 전용(DEL-CONTRACT)
do $$ begin
  begin
    delete from journey.trips where id = '11111111-1111-4111-8111-111111111111';
    if (select count(*) from journey.trips where id = '11111111-1111-4111-8111-111111111111') <> 1 then
      raise exception 'FAIL: 소유자 하드 DELETE가 허용됨 (DEL-CONTRACT 위반)';
    end if;
  exception when insufficient_privilege then null;
  end;
end $$;

-- 공격 6: anon → 스키마 usage 자체가 없어 접근 불가여야 함
set local role anon;
do $$ begin
  begin
    perform count(*) from journey.trips;
    raise exception 'FAIL: anon이 journey.trips에 접근 가능';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
select 'RLS_ATTACK_PASS' as result;

rollback;
