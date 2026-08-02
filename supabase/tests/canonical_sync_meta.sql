-- canonical_sync_meta.sql · 0027 canonical 세대/RLS/원자 교체 공격검사.
-- 최신 migration 적용 DB에서 실행한다. 전부 transaction 안이며 마지막에 rollback한다.

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','00000000-0000-0000-0000-000000000000','authenticated','authenticated','canonical-a@test.local','x',now(),now(),now()),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','00000000-0000-0000-0000-000000000000','authenticated','authenticated','canonical-b@test.local','x',now(),now(),now());
insert into journey.allowed_users(email) values ('canonical-a@test.local'),('canonical-b@test.local');

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","email":"canonical-a@test.local","role":"authenticated"}',
  true
);

do $$
declare
  got jsonb;
  trigger_count integer;
begin
  select journey.ensure_sync_meta() into got;
  if got->>'canonical_version' <> 'legacy' then
    raise exception 'FAIL: 첫 canonical 기준선이 legacy가 아님';
  end if;

  select count(*) into trigger_count
  from pg_trigger t
  join pg_class c on c.oid=t.tgrelid
  join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='journey'
    and c.relname=any(array['trips','places','moments','media','expenses','audio'])
    and t.tgname='a0_canonical_sync_guard'
    and not t.tgisinternal;
  if trigger_count <> 6 then
    raise exception 'FAIL: canonical fence가 6개 도메인 모두에 없음(현재 %개)',trigger_count;
  end if;

  begin
    update journey.sync_meta set canonical_version='forged';
    raise exception 'FAIL: authenticated가 sync_meta를 직접 UPDATE함';
  exception when insufficient_privilege then null;
  end;

  -- operation id는 응답 유실 뒤 같은 게시를 성공으로 되읽는 멱등 키라 NULL일 수 없다.
  begin
    perform journey.publish_canonical_snapshot(
      'legacy','33333333-3333-4333-8333-333333333333',null,'test-device#dddddddd',
      '[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'{}'::uuid[]
    );
    raise exception 'FAIL: NULL canonical operation id를 받음';
  exception when invalid_parameter_value then null;
  end;

  -- 한 id를 행과 영구삭제 원장에 동시에 넣으면 소비 기기가 막 게시한 행을 다시 지운다.
  begin
    perform journey.publish_canonical_snapshot(
      'legacy','33333333-3333-4333-8333-333333333333',
      'dddddddd-0000-4000-8000-000000000020','test-device#dddddddd',
      '[{"id":"dddddddd-0000-4000-8000-000000000404","title":"모순 입력","start_date":"2026-08-01","time_zone":"Asia/Seoul","end_date":null,"status":"active","version":1,"created_at":"2026-08-01T00:00:00Z","updated_at":"2026-08-02T00:00:00Z","deleted_at":null}]'::jsonb,
      '[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,
      array['dddddddd-0000-4000-8000-000000000404']::uuid[]
    );
    raise exception 'FAIL: canonical 행/영구삭제 원장 id 겹침을 받음';
  exception when invalid_parameter_value then null;
  end;

  if (select canonical_version from journey.sync_meta) <> 'legacy'
     or exists(select 1 from journey.trips)
     or exists(select 1 from journey.purged_ids) then
    raise exception 'FAIL: 거부한 canonical 입력이 서버 상태를 바꿈';
  end if;
end $$;

insert into journey.trips(
  id,user_id,title,status,version,base_version,base_canonical_version,client_operation_id,created_at,updated_at
) values (
  'dddddddd-0000-4000-8000-000000000001','dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  '교체 전 서버 행','active',1,0,'legacy','dddddddd-0000-4000-8000-000000000011',now(),now()
);

select journey.publish_canonical_snapshot(
  'legacy',
  '11111111-1111-4111-8111-111111111111',
  'dddddddd-0000-4000-8000-000000000012',
  'test-device#dddddddd',
  '[{"id":"dddddddd-0000-4000-8000-000000000002","title":"이 기기의 최종본","start_date":"2026-08-01","time_zone":"Asia/Seoul","end_date":null,"status":"active","version":4,"created_at":"2026-08-01T00:00:00Z","updated_at":"2026-08-02T00:00:00Z","deleted_at":null}]'::jsonb,
  '[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,
  array['dddddddd-0000-4000-8000-000000000099']::uuid[]
);

do $$
begin
  if (select canonical_version from journey.sync_meta) <> '11111111-1111-4111-8111-111111111111' then
    raise exception 'FAIL: canonical_version read-back 불일치';
  end if;
  if (select count(*) from journey.trips) <> 1
     or (select title from journey.trips) <> '이 기기의 최종본' then
    raise exception 'FAIL: 서버 표가 로컬 스냅샷 정확집합으로 교체되지 않음';
  end if;
  if (select base_canonical_version from journey.trips) <> '11111111-1111-4111-8111-111111111111' then
    raise exception 'FAIL: 교체 행에 새 canonical fence가 찍히지 않음';
  end if;
  if (select count(*) from journey.purged_ids) <> 1 then
    raise exception 'FAIL: 영구삭제 원장이 정확히 교체되지 않음';
  end if;
end $$;

-- 옛 기기의 UPDATE와 INSERT는 둘 다 예외 없이 no-op이어야 한다.
update journey.trips
set title='옛 기기 덮어쓰기',base_version=4,base_canonical_version='legacy',
    version=5,client_operation_id='dddddddd-0000-4000-8000-000000000013'
where id='dddddddd-0000-4000-8000-000000000002';

insert into journey.trips(
  id,user_id,title,status,version,base_version,base_canonical_version,client_operation_id
) values (
  'dddddddd-0000-4000-8000-000000000003','dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  '옛 기기 로컬 전용 부활','active',1,0,'legacy','dddddddd-0000-4000-8000-000000000014'
);

do $$ begin
  if (select title from journey.trips where id='dddddddd-0000-4000-8000-000000000002') <> '이 기기의 최종본'
     or exists(select 1 from journey.trips where id='dddddddd-0000-4000-8000-000000000003') then
    raise exception 'FAIL: 옛 canonical 세대 쓰기가 최종본을 바꿈';
  end if;
end $$;

-- 같은 operation 재시도는 이미 착지한 성공이다.
select journey.publish_canonical_snapshot(
  'legacy','11111111-1111-4111-8111-111111111111',
  'dddddddd-0000-4000-8000-000000000012','test-device#dddddddd',
  '[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'{}'::uuid[]
);

-- 잘못된 예상 세대는 어떤 행도 건드리지 않는다(CAS).
do $$ begin
  begin
    perform journey.publish_canonical_snapshot(
      'legacy','22222222-2222-4222-8222-222222222222',
      'dddddddd-0000-4000-8000-000000000015','conflict-device',
      '[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'{}'::uuid[]
    );
    raise exception 'FAIL: stale expected canonical 세대가 허용됨';
  exception when serialization_failure then null;
  end;
  if (select count(*) from journey.trips) <> 1 then
    raise exception 'FAIL: CAS 실패가 기존 최종본을 바꿈';
  end if;
end $$;

-- 함수 중간 FK 실패도 전체 롤백되어야 한다(원자성 이음매 검사).
do $$ begin
  begin
    perform journey.publish_canonical_snapshot(
      '11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333',
      'dddddddd-0000-4000-8000-000000000016','atomic-device',
      '[]'::jsonb,'[]'::jsonb,
      '[{"id":"dddddddd-0000-4000-8000-000000000020","trip_id":"dddddddd-0000-4000-8000-000000000404","title":"고아","note":"","emotion":"","place_name":"","version":1,"created_at":"2026-08-01T00:00:00Z","updated_at":"2026-08-01T00:00:00Z"}]'::jsonb,
      '[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'{}'::uuid[]
    );
    raise exception 'FAIL: FK가 깨진 canonical 스냅샷이 허용됨';
  exception when foreign_key_violation then null;
  end;
  if (select canonical_version from journey.sync_meta) <> '11111111-1111-4111-8111-111111111111'
     or (select count(*) from journey.trips) <> 1 then
    raise exception 'FAIL: 함수 중간 실패가 부분 교체를 남김';
  end if;
end $$;

-- 다른 사용자는 A의 메타를 볼 수 없다.
select set_config(
  'request.jwt.claims',
  '{"sub":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","email":"canonical-b@test.local","role":"authenticated"}',
  true
);
do $$ begin
  if (select count(*) from journey.sync_meta) <> 0 then
    raise exception 'FAIL: 다른 사용자의 canonical 메타가 보임';
  end if;
end $$;

reset role;
select 'CANONICAL_SYNC_META_PASS' as result;
rollback;
