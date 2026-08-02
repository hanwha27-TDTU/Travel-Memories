-- stale_sync_write_guard.sql · 0026의 stale-write 차단 비공허 검증.
-- 실행: 최신 migration 적용 DB의 SQL Editor/psql. 전부 transaction 안에서 실행하고 rollback한다.

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values (
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'stale-guard@test.local',
  'x', now(), now(), now()
);

insert into journey.allowed_users (email)
values ('stale-guard@test.local');

insert into journey.trips (
  id, user_id, title, version, base_version, client_operation_id, created_at, updated_at
) values (
  'cccccccc-0000-4000-8000-000000000001',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  '서버 최신 v3',
  3,
  2,
  'cccccccc-0000-4000-8000-000000000003',
  now() - interval '1 day',
  now()
);

-- 복구/후속 migration 역할은 동기화 프로토콜 필드를 몰라도 막히지 않아야 한다.
update journey.trips
set updated_by_device = 'recovery-admin-bypass'
where id = 'cccccccc-0000-4000-8000-000000000001';

do $$
begin
  if current_user = 'authenticated' then
    raise exception 'FAIL: 관리자 bypass 검사를 authenticated 역할로 실행함';
  end if;
  if (select updated_by_device from journey.trips
      where id = 'cccccccc-0000-4000-8000-000000000001') <> 'recovery-admin-bypass' then
    raise exception 'FAIL: 복구/관리자 UPDATE가 sync guard에 막힘';
  end if;
end $$;

-- 실제 Data API와 같은 authenticated + JWT + RLS 경로에서 검증한다.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","email":"stale-guard@test.local","role":"authenticated"}',
  true
);

do $$
declare
  before_at timestamptz;
  after_at timestamptz;
  got_title text;
  got_version integer;
  trigger_count integer;
begin
  select count(*) into trigger_count
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'journey'
    and c.relname = any(array['trips','moments','media','expenses','audio','places'])
    and t.tgname = 'a_sync_write_guard'
    and not t.tgisinternal;
  if trigger_count <> 6 then
    raise exception 'FAIL: stale-write guard가 6개 도메인 모두에 없음(현재 %개)', trigger_count;
  end if;

  select updated_at into before_at
  from journey.trips where id = 'cccccccc-0000-4000-8000-000000000001';

  -- 오래된 기기 v2: version이든 내용이든 서버를 덮지 못해야 한다.
  update journey.trips
  set title = '오래된 기기 v2',
      version = 2,
      base_version = 2,
      client_operation_id = 'cccccccc-0000-4000-8000-000000000002',
      updated_at = before_at - interval '1 hour'
  where id = 'cccccccc-0000-4000-8000-000000000001';

  select title, version, updated_at into got_title, got_version, after_at
  from journey.trips where id = 'cccccccc-0000-4000-8000-000000000001';
  if got_title <> '서버 최신 v3' or got_version <> 3 or after_at <> before_at then
    raise exception 'FAIL: stale write가 서버 최신본 또는 서버 시각을 바꿈';
  end if;

  -- 더 최신인 같은 상태 변경은 허용하고 version은 절대 되감지 않는다.
  update journey.trips
  set title = '새 기기 최신 변경',
      version = 2,
      base_version = 3,
      client_operation_id = 'cccccccc-0000-4000-8000-000000000004',
      updated_at = before_at + interval '1 hour'
  where id = 'cccccccc-0000-4000-8000-000000000001';

  select title, version into got_title, got_version
  from journey.trips where id = 'cccccccc-0000-4000-8000-000000000001';
  if got_title <> '새 기기 최신 변경' or got_version <> 4 then
    raise exception 'FAIL: 최신 LWW 쓰기 허용 또는 version 단조증가 실패';
  end if;

  -- 기준선이 맞으면 기기 시계가 느려도 경합이 없다. base_version이 시계보다 우선한다.
  update journey.trips
  set title = '느린 시계의 정상 변경',
      version = 5,
      base_version = 4,
      client_operation_id = 'cccccccc-0000-4000-8000-000000000007',
      updated_at = before_at - interval '1 day'
  where id = 'cccccccc-0000-4000-8000-000000000001';
  select title, version into got_title, got_version
  from journey.trips where id = 'cccccccc-0000-4000-8000-000000000001';
  if got_title <> '느린 시계의 정상 변경' or got_version <> 5 then
    raise exception 'FAIL: 일치하는 base_version 쓰기가 기기 시계 때문에 거절됨';
  end if;

  -- 같은 operation 재시도는 payload가 달라도 no-op이어야 한다.
  update journey.trips
  set title = '중복 재시도가 바꾸면 안 됨', updated_at = now() + interval '1 day'
  where id = 'cccccccc-0000-4000-8000-000000000001';
  select title into got_title
  from journey.trips where id = 'cccccccc-0000-4000-8000-000000000001';
  if got_title <> '느린 시계의 정상 변경' then
    raise exception 'FAIL: 같은 operation id 재시도가 행을 다시 씀';
  end if;

  -- 삭제 전이는 시각이 아니라 version: 같은 version 삭제는 거부, 더 높은 version은 허용.
  update journey.trips
  set deleted_at = now(), version = 5,
      base_version = 5,
      client_operation_id = 'cccccccc-0000-4000-8000-000000000005',
      updated_at = now() + interval '2 days'
  where id = 'cccccccc-0000-4000-8000-000000000001';
  if (select deleted_at from journey.trips where id = 'cccccccc-0000-4000-8000-000000000001') is not null then
    raise exception 'FAIL: 같은 version tombstone이 허용됨';
  end if;

  update journey.trips
  set deleted_at = now(), version = 6,
      base_version = 5,
      client_operation_id = 'cccccccc-0000-4000-8000-000000000006',
      updated_at = now() + interval '2 days'
  where id = 'cccccccc-0000-4000-8000-000000000001';
  if (select deleted_at from journey.trips where id = 'cccccccc-0000-4000-8000-000000000001') is null then
    raise exception 'FAIL: 더 높은 version tombstone이 막힘';
  end if;

  raise notice 'STALE_SYNC_WRITE_GUARD_PASS';
end $$;

rollback;
