-- 0030_journey_videos.sql · 앱에서 720p급으로 줄인 사용자 영상을 사진·소리와 같은 생명주기로 동기화한다.
-- 외부 원본은 앱이 수정/삭제하지 않으며, R2에는 앱 경량본 하나만 저장한다.

create table journey.videos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  moment_id uuid not null,
  trip_id uuid not null,
  storage_path text,
  duration_sec double precision not null check (duration_sec > 0 and duration_sec <= 60.1),
  mime text not null check (mime in ('video/mp4','video/webm')),
  bytes integer not null check (bytes >= 0 and bytes <= 26214400),
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  taken_at timestamptz,
  source text not null default 'user' check (source in ('user','pipeline')),
  version integer not null default 1,
  updated_by_device text,
  client_operation_id uuid,
  base_version integer,
  base_canonical_version text not null default 'legacy',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint videos_id_user_unique unique (id,user_id),
  constraint videos_moment_fk foreign key (moment_id,user_id)
    references journey.moments(id,user_id) on delete cascade
);

comment on table journey.videos is
  '사용자 영상의 경량본 메타데이터. 바이트는 비공개 R2, 포스터는 로컬 파생 캐시. 하드 삭제는 영구삭제 경로만 허용.';

create index videos_moment_idx on journey.videos(moment_id) where deleted_at is null;
create index videos_user_idx on journey.videos(user_id);
create index videos_moment_user_idx on journey.videos(moment_id,user_id);

create trigger videos_set_updated_at before update on journey.videos
  for each row execute function journey.set_updated_at();
create trigger trg_zombie_guard before update on journey.videos
  for each row execute function journey.prevent_zombie_resurrection();
create trigger block_purged_reinsert before insert on journey.videos
  for each row execute function journey.block_purged_reinsert();
create trigger a_sync_write_guard before update on journey.videos
  for each row execute function journey.guard_sync_write();
create trigger a0_canonical_sync_guard before insert or update on journey.videos
  for each row execute function journey.guard_canonical_sync_write();

grant select,insert,update,delete on journey.videos to authenticated;
alter table journey.videos enable row level security;
create policy videos_select_own on journey.videos for select to authenticated
  using ((select auth.uid())=user_id and (select journey.is_allowed()));
create policy videos_insert_own on journey.videos for insert to authenticated
  with check ((select auth.uid())=user_id and (select journey.is_allowed()));
create policy videos_update_own on journey.videos for update to authenticated
  using ((select auth.uid())=user_id and (select journey.is_allowed()))
  with check ((select auth.uid())=user_id and (select journey.is_allowed()));
create policy videos_delete_own on journey.videos for delete to authenticated
  using ((select auth.uid())=user_id and (select journey.is_allowed()));

-- 구형 exact-set RPC는 영상을 모르므로 authenticated 실행권을 걷는다. 새 오버로드만 공개한다.
revoke execute on function journey.publish_canonical_snapshot(
  text,text,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid[]
) from authenticated;

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
  p_purged_ids uuid[],
  p_videos jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_result jsonb;
begin
  if v_user is null or not (select journey.is_allowed()) then
    raise exception 'not_allowed' using errcode='42501';
  end if;
  if jsonb_typeof(p_videos) <> 'array' then
    raise exception 'snapshot_arrays_required' using errcode='22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_videos) v(row_data)
    join unnest(coalesce(p_purged_ids,'{}'::uuid[])) p(id)
      on (v.row_data->>'id')::uuid=p.id
  ) then
    raise exception 'snapshot_purged_overlap' using errcode='22023';
  end if;

  -- 같은 DB 트랜잭션 안에서 기존 6개 도메인 exact-set을 먼저 적용한다. trips 삭제가 FK로
  -- 옛 videos도 제거하며, 아래 insert 실패 시 앞 호출까지 전부 rollback된다.
  v_result := journey.publish_canonical_snapshot(
    p_expected_version,p_next_version,p_operation_id,p_device,p_trips,p_places,p_moments,
    p_media,p_expenses,p_audio,p_purged_ids
  );

  -- 남아 있는 여행·순간의 기존 영상도 exact-set에서 빠질 수 있다. 부모 cascade만 믿으면
  -- 같은 id 재삽입은 PK 충돌하고, 스냅샷에서 빠진 영상은 서버에 잔존한다. 사용자 범위 전부를
  -- 비운 뒤 캡처 배열만 다시 넣어야 「최종본」의 정확집합이 된다.
  delete from journey.videos where user_id=v_user;

  insert into journey.videos(
    id,user_id,moment_id,trip_id,storage_path,duration_sec,mime,bytes,width,height,taken_at,source,
    version,base_version,base_canonical_version,created_at,updated_at,deleted_at,
    client_operation_id,updated_by_device
  )
  select x.id,v_user,x.moment_id,x.trip_id,x.storage_path,x.duration_sec,x.mime,x.bytes,x.width,
    x.height,x.taken_at,coalesce(x.source,'user'),x.version,x.version,p_next_version,x.created_at,
    x.updated_at,x.deleted_at,p_operation_id,p_device
  from jsonb_to_recordset(p_videos) as x(
    id uuid,moment_id uuid,trip_id uuid,storage_path text,duration_sec double precision,mime text,
    bytes integer,width integer,height integer,taken_at timestamptz,source text,version integer,
    created_at timestamptz,updated_at timestamptz,deleted_at timestamptz
  );

  return v_result || jsonb_build_object('videos',jsonb_array_length(p_videos));
end;
$$;

revoke execute on function journey.publish_canonical_snapshot(
  text,text,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid[],jsonb
) from public,anon;
grant execute on function journey.publish_canonical_snapshot(
  text,text,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid[],jsonb
) to authenticated;
