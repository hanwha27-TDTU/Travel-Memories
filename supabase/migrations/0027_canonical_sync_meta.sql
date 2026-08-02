-- 0027_canonical_sync_meta.sql · 일반 병합과 「이 기기 최종본」을 분리한다.
--
-- canonical_version은 사용자가 명시적으로 선택한 클라우드 최종본의 세대다. 일반 동기화는
-- 같은 세대 안에서만 병합하고, 세대가 바뀐 소비 기기는 push하지 않고 클라우드만 반영한다.
-- 최종본 게시 자체는 이 파일의 SECURITY DEFINER 함수 한 번으로 6개 표+영구삭제 원장을
-- 원자 교체한다. R2는 작업별 불변 키에 먼저 올리고, DB 커밋 뒤 옛 키를 정리한다.
--
-- 배포 순서: 신형 앱을 모든 활성 기기에 배포·확인 → DB 스냅샷 → 0026 → 0027 →
-- authenticated read-back. 첫 canonical 교체 뒤에는 base_canonical_version이 없는 구형 앱의
-- INSERT/UPDATE도 거부된다. 운영 적용 전까지 이 파일은 저장소 계약일 뿐이다.

create table journey.sync_meta (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  canonical_version text not null default 'legacy',
  canonical_operation_id uuid,
  canonical_device_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table journey.sync_meta is
  '사용자별 동기화 최종본 세대. canonical_version 변경은 publish_canonical_snapshot()만 수행한다.';

create trigger sync_meta_set_updated_at before update on journey.sync_meta
  for each row execute function journey.set_updated_at();

alter table journey.sync_meta enable row level security;

create policy sync_meta_select_own on journey.sync_meta
  for select to authenticated
  using ((select auth.uid()) = user_id
     and (select journey.is_allowed()));

-- 직접 INSERT/UPDATE는 주지 않는다. 생성과 세대 전환은 아래의 좁은 함수만 수행한다.
grant select on journey.sync_meta to authenticated;

alter table journey.trips add column base_canonical_version text not null default 'legacy';
alter table journey.places add column base_canonical_version text not null default 'legacy';
alter table journey.moments add column base_canonical_version text not null default 'legacy';
alter table journey.media add column base_canonical_version text not null default 'legacy';
alter table journey.expenses add column base_canonical_version text not null default 'legacy';
alter table journey.audio add column base_canonical_version text not null default 'legacy';

-- 현재 세대를 모르는 기기의 쓰기를 막는 공용 fence. migration 직후 legacy 세대에서는 옛 앱을
-- 잠시 허용하지만, 첫 canonical 교체 뒤 NULL/legacy 쓰기는 INSERT와 UPDATE 모두 거부한다.
create or replace function journey.guard_canonical_sync_write()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_canonical text;
begin
  if current_user <> 'authenticated' then
    return NEW;
  end if;

  select m.canonical_version into v_canonical
  from journey.sync_meta m
  where m.user_id = NEW.user_id;
  v_canonical := coalesce(v_canonical, 'legacy');

  if NEW.base_canonical_version is null then
    if v_canonical = 'legacy' then
      NEW.base_canonical_version := 'legacy';
      return NEW;
    end if;
    return null;
  end if;

  if NEW.base_canonical_version <> v_canonical then
    return null;
  end if;
  return NEW;
end;
$$;

revoke execute on function journey.guard_canonical_sync_write() from public, anon, authenticated;

-- a_sync_write_guard(0026)보다 먼저 실행되도록 a0 이름을 쓴다. INSERT에도 걸어 구형 앱이
-- 최종본에서 사라진 로컬 전용 항목을 새 행으로 되살리는 길까지 막는다.
drop trigger if exists a0_canonical_sync_guard on journey.trips;
create trigger a0_canonical_sync_guard before insert or update on journey.trips
  for each row execute function journey.guard_canonical_sync_write();
drop trigger if exists a0_canonical_sync_guard on journey.places;
create trigger a0_canonical_sync_guard before insert or update on journey.places
  for each row execute function journey.guard_canonical_sync_write();
drop trigger if exists a0_canonical_sync_guard on journey.moments;
create trigger a0_canonical_sync_guard before insert or update on journey.moments
  for each row execute function journey.guard_canonical_sync_write();
drop trigger if exists a0_canonical_sync_guard on journey.media;
create trigger a0_canonical_sync_guard before insert or update on journey.media
  for each row execute function journey.guard_canonical_sync_write();
drop trigger if exists a0_canonical_sync_guard on journey.expenses;
create trigger a0_canonical_sync_guard before insert or update on journey.expenses
  for each row execute function journey.guard_canonical_sync_write();
drop trigger if exists a0_canonical_sync_guard on journey.audio;
create trigger a0_canonical_sync_guard before insert or update on journey.audio
  for each row execute function journey.guard_canonical_sync_write();

-- 메타가 아직 없는 사용자는 legacy 기준선을 만든 뒤 되읽는다. 앱이 테이블 INSERT 권한을
-- 가질 필요가 없도록 함수가 정확히 auth.uid() 한 행만 만든다.
create or replace function journey.ensure_sync_meta()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_meta journey.sync_meta%rowtype;
begin
  if v_user is null or not (select journey.is_allowed()) then
    raise exception 'not_allowed' using errcode = '42501';
  end if;

  insert into journey.sync_meta(user_id) values (v_user)
  on conflict (user_id) do nothing;

  select * into strict v_meta from journey.sync_meta where user_id = v_user;
  return jsonb_build_object(
    'canonical_version', v_meta.canonical_version,
    'canonical_operation_id', v_meta.canonical_operation_id,
    'canonical_device_id', v_meta.canonical_device_id,
    'updated_at', v_meta.updated_at
  );
end;
$$;

revoke execute on function journey.ensure_sync_meta() from public, anon;
grant execute on function journey.ensure_sync_meta() to authenticated;

-- 6개 표와 영구삭제 원장을 한 트랜잭션으로 정확히 교체한다. 클라이언트가 user_id를 보내도
-- 사용하지 않고 검증된 auth.uid()로 덮는다. 예상 세대(CAS)가 다르면 어떤 행도 바꾸지 않는다.
create or replace function journey.publish_canonical_snapshot(
  p_expected_version text,
  p_next_version text,
  p_operation_id uuid,
  p_device text,
  p_trips jsonb,
  p_places jsonb,
  p_moments jsonb,
  p_media jsonb,
  p_expenses jsonb,
  p_audio jsonb,
  p_purged_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_current text;
  v_operation uuid;
begin
  if v_user is null or not (select journey.is_allowed()) then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if p_expected_version is null or p_next_version is null or p_expected_version = p_next_version then
    raise exception 'invalid_canonical_version' using errcode = '22023';
  end if;
  perform p_next_version::uuid;
  -- operation id는 응답 유실 재시도의 멱등 키다. NULL을 허용하면 첫 게시 자체는 성공하지만
  -- NULL = NULL이 true가 아니어서 같은 요청을 성공으로 되읽을 수 없다.
  if p_operation_id is null then
    raise exception 'operation_id_required' using errcode = '22023';
  end if;
  if p_device is null or btrim(p_device) = '' then
    raise exception 'device_required' using errcode = '22023';
  end if;
  if jsonb_typeof(p_trips) <> 'array'
     or jsonb_typeof(p_places) <> 'array'
     or jsonb_typeof(p_moments) <> 'array'
     or jsonb_typeof(p_media) <> 'array'
     or jsonb_typeof(p_expenses) <> 'array'
     or jsonb_typeof(p_audio) <> 'array' then
    raise exception 'snapshot_arrays_required' using errcode = '22023';
  end if;

  -- 영구삭제 원장은 entity 종류를 따로 저장하지 않는 전역 id fence다. 같은 id가 스냅샷에도
  -- 있으면 소비 기기는 막 게시한 행을 다시 지우게 된다. 클라이언트도 검사하지만, exact-set의
  -- 최종 경계인 RPC가 파괴적 DELETE 전에 모순 입력을 직접 거부해야 한다.
  if exists (
    select 1
    from jsonb_array_elements(
      p_trips || p_places || p_moments || p_media || p_expenses || p_audio
    ) as entity(row_data)
    join unnest(coalesce(p_purged_ids, '{}'::uuid[])) as purged(id)
      on (entity.row_data->>'id')::uuid = purged.id
  ) then
    raise exception 'snapshot_purged_overlap' using errcode = '22023';
  end if;

  insert into journey.sync_meta(user_id) values (v_user)
  on conflict (user_id) do nothing;

  select canonical_version, canonical_operation_id
    into v_current, v_operation
  from journey.sync_meta
  where user_id = v_user
  for update;

  -- 응답 유실 뒤 같은 작업을 재호출하면 이미 착지한 성공으로 판정한다.
  if v_current = p_next_version and v_operation = p_operation_id then
    return jsonb_build_object(
      'canonical_version', v_current,
      'canonical_operation_id', v_operation,
      'idempotent', true
    );
  end if;
  if v_current <> p_expected_version then
    raise exception 'canonical_conflict expected %, actual %', p_expected_version, v_current
      using errcode = '40001';
  end if;

  -- 기존 원장이 새 최종본 행 삽입을 막지 않게 먼저 비운다. 새 원장은 행 삽입 뒤 적는다.
  delete from journey.purged_ids where user_id = v_user;
  delete from journey.expenses where user_id = v_user;
  delete from journey.audio where user_id = v_user;
  delete from journey.media where user_id = v_user;
  delete from journey.moments where user_id = v_user;
  delete from journey.places where user_id = v_user;
  delete from journey.trips where user_id = v_user;

  insert into journey.trips(
    id,user_id,title,start_date,time_zone,end_date,status,version,base_version,
    base_canonical_version,created_at,updated_at,deleted_at,client_operation_id,updated_by_device
  )
  select x.id,v_user,x.title,x.start_date,x.time_zone,x.end_date,x.status,x.version,x.version,
    p_next_version,x.created_at,x.updated_at,x.deleted_at,p_operation_id,p_device
  from jsonb_to_recordset(p_trips) as x(
    id uuid,title text,start_date date,time_zone text,end_date date,status text,version integer,
    created_at timestamptz,updated_at timestamptz,deleted_at timestamptz
  );

  insert into journey.places(
    id,user_id,name,formatted_address,provider,provider_place_id,country_code,country,region,city,
    district,postcode,category,memo,longitude,latitude,precision,span_meters,map_picked,source,
    version,base_version,base_canonical_version,created_at,updated_at,deleted_at,
    client_operation_id,updated_by_device
  )
  select x.id,v_user,x.name,x.formatted_address,x.provider,x.provider_place_id,x.country_code,
    x.country,x.region,x.city,x.district,x.postcode,x.category,x.memo,x.longitude,x.latitude,
    x.precision,x.span_meters,x.map_picked,coalesce(x.source,'user'),x.version,x.version,
    p_next_version,x.created_at,x.updated_at,x.deleted_at,p_operation_id,p_device
  from jsonb_to_recordset(p_places) as x(
    id uuid,name text,formatted_address text,provider text,provider_place_id text,country_code text,
    country text,region text,city text,district text,postcode text,category text,memo text,
    longitude double precision,latitude double precision,precision text,span_meters integer,
    map_picked boolean,source text,version integer,created_at timestamptz,updated_at timestamptz,
    deleted_at timestamptz
  );

  insert into journey.moments(
    id,user_id,trip_id,occurred_at,tz_offset_min,title,note,emotion,place_name,place_lat,place_lng,
    place_id,version,base_version,base_canonical_version,created_at,updated_at,deleted_at,
    client_operation_id,updated_by_device
  )
  select x.id,v_user,x.trip_id,x.occurred_at,x.tz_offset_min,x.title,x.note,x.emotion,
    x.place_name,x.place_lat,x.place_lng,x.place_id,x.version,x.version,p_next_version,
    x.created_at,x.updated_at,x.deleted_at,p_operation_id,p_device
  from jsonb_to_recordset(p_moments) as x(
    id uuid,trip_id uuid,occurred_at timestamptz,tz_offset_min integer,title text,note text,
    emotion text,place_name text,place_lat double precision,place_lng double precision,
    place_id uuid,version integer,created_at timestamptz,updated_at timestamptz,deleted_at timestamptz
  );

  insert into journey.media(
    id,user_id,moment_id,trip_id,storage_path,gps_lat,gps_lng,width,height,taken_at,bytes_display,
    source,version,base_version,base_canonical_version,created_at,updated_at,deleted_at,
    client_operation_id,updated_by_device
  )
  select x.id,v_user,x.moment_id,x.trip_id,x.storage_path,x.gps_lat,x.gps_lng,x.width,x.height,
    x.taken_at,x.bytes_display,coalesce(x.source,'user'),x.version,x.version,p_next_version,
    x.created_at,x.updated_at,x.deleted_at,p_operation_id,p_device
  from jsonb_to_recordset(p_media) as x(
    id uuid,moment_id uuid,trip_id uuid,storage_path text,gps_lat double precision,
    gps_lng double precision,width integer,height integer,taken_at timestamptz,bytes_display integer,
    source text,version integer,created_at timestamptz,updated_at timestamptz,deleted_at timestamptz
  );

  insert into journey.expenses(
    id,user_id,moment_id,trip_id,original_amount,original_currency,category,note,version,base_version,
    base_canonical_version,created_at,updated_at,deleted_at,client_operation_id,updated_by_device
  )
  select x.id,v_user,x.moment_id,x.trip_id,x.original_amount,x.original_currency,x.category,x.note,
    x.version,x.version,p_next_version,x.created_at,x.updated_at,x.deleted_at,p_operation_id,p_device
  from jsonb_to_recordset(p_expenses) as x(
    id uuid,moment_id uuid,trip_id uuid,original_amount numeric,original_currency text,category text,
    note text,version integer,created_at timestamptz,updated_at timestamptz,deleted_at timestamptz
  );

  insert into journey.audio(
    id,user_id,moment_id,trip_id,storage_path,duration_sec,mime,bytes,recorded_at,source,version,
    base_version,base_canonical_version,created_at,updated_at,deleted_at,client_operation_id,
    updated_by_device
  )
  select x.id,v_user,x.moment_id,x.trip_id,x.storage_path,x.duration_sec,x.mime,x.bytes,
    x.recorded_at,coalesce(x.source,'user'),x.version,x.version,p_next_version,x.created_at,
    x.updated_at,x.deleted_at,p_operation_id,p_device
  from jsonb_to_recordset(p_audio) as x(
    id uuid,moment_id uuid,trip_id uuid,storage_path text,duration_sec integer,mime text,bytes integer,
    recorded_at timestamptz,source text,version integer,created_at timestamptz,
    updated_at timestamptz,deleted_at timestamptz
  );

  insert into journey.purged_ids(id,user_id,purged_at)
  select p.id,v_user,now() from unnest(coalesce(p_purged_ids,'{}'::uuid[])) as p(id);

  update journey.sync_meta
  set canonical_version = p_next_version,
      canonical_operation_id = p_operation_id,
      canonical_device_id = p_device,
      updated_at = now()
  where user_id = v_user;

  return jsonb_build_object(
    'canonical_version', p_next_version,
    'canonical_operation_id', p_operation_id,
    'idempotent', false,
    'trips', jsonb_array_length(p_trips),
    'places', jsonb_array_length(p_places),
    'moments', jsonb_array_length(p_moments),
    'media', jsonb_array_length(p_media),
    'expenses', jsonb_array_length(p_expenses),
    'audio', jsonb_array_length(p_audio),
    'purged_ids', cardinality(coalesce(p_purged_ids,'{}'::uuid[]))
  );
end;
$$;

revoke execute on function journey.publish_canonical_snapshot(
  text,text,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid[]
) from public, anon;
grant execute on function journey.publish_canonical_snapshot(
  text,text,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid[]
) to authenticated;
