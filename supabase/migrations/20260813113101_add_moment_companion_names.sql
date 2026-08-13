-- 순간에 직접 귀속되는 자유 입력 동행인 이름. 독립 Companion 도메인은 아직 구현하지 않으므로
-- 이번 열은 사람 대장/관계 테이블을 가장하지 않는다. 옛 행은 빈 문자열로 안전하게 백필한다.
alter table journey.moments
  add column if not exists companion_names text not null default '';

comment on column journey.moments.companion_names is
  '이 순간을 함께한 사람 이름 자유 입력. 쉼표 구분 가능; 독립 companion 대장이 아님.';

-- canonical 정확집합 게시가 moments를 delete→insert하므로 열만 추가하면 게시 순간 값이
-- default('')로 사라진다. 현재 활성 12인자(video 포함) 함수가 내부에서 부르는 11인자 기반
-- 함수를 같은 signature로 교체해 새 필드도 정확집합에 포함한다. 0030에서 회수한 11인자
-- authenticated 실행권은 다시 열지 않는다.
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
    id,user_id,trip_id,occurred_at,tz_offset_min,title,note,emotion,companion_names,
    place_name,place_lat,place_lng,place_id,version,base_version,base_canonical_version,
    created_at,updated_at,deleted_at,client_operation_id,updated_by_device
  )
  select x.id,v_user,x.trip_id,x.occurred_at,x.tz_offset_min,x.title,x.note,x.emotion,
    coalesce(x.companion_names,''),x.place_name,x.place_lat,x.place_lng,x.place_id,x.version,
    x.version,p_next_version,x.created_at,x.updated_at,x.deleted_at,p_operation_id,p_device
  from jsonb_to_recordset(p_moments) as x(
    id uuid,trip_id uuid,occurred_at timestamptz,tz_offset_min integer,title text,note text,
    emotion text,companion_names text,place_name text,place_lat double precision,
    place_lng double precision,place_id uuid,version integer,created_at timestamptz,
    updated_at timestamptz,deleted_at timestamptz
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

revoke all on function journey.publish_canonical_snapshot(
  text,text,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid[]
) from public, anon, authenticated;
