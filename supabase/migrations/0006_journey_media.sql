-- 0006_journey_media.sql · 사진(Media) 서버 메타 테이블. 원본 blob은 서버에 두지 않는다(절약 모드) —
-- 표시본(≤1600 WebP)만 Storage(journey-media 버킷)에 올리고, 이 테이블은 그 메타+경로를 담는다.
-- 계약: DATA_MODEL·SECURITY(H-02 복합 FK)·SYNC_PROTOCOL(tombstone·LWW·ZOMBIE-GUARD). public 불가침.

create table journey.media (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  moment_id uuid not null,
  trip_id uuid not null,
  storage_path text,            -- journey-media 버킷 내 표시본 경로({user_id}/{id}.webp). 업로드 전엔 null 가능.
  width integer,
  height integer,
  taken_at timestamptz,         -- EXIF 촬영시각
  bytes_display integer,
  source text not null default 'user' check (source in ('user', 'pipeline')),
  version integer not null default 1,
  updated_by_device text,
  client_operation_id uuid,
  base_version integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint media_id_user_unique unique (id, user_id),
  constraint media_moment_fk foreign key (moment_id, user_id)
    references journey.moments (id, user_id) on delete cascade
);
comment on table journey.media is
  '사진 메타(표시본은 Storage journey-media). 하드 삭제 금지 — deleted_at tombstone. (moment_id,user_id) 복합 FK(H-02).';
create index media_moment_idx on journey.media (moment_id) where deleted_at is null;
create trigger media_set_updated_at before update on journey.media
  for each row execute function journey.set_updated_at();
create trigger trg_zombie_guard before update on journey.media
  for each row execute function journey.prevent_zombie_resurrection();
grant select, insert, update on journey.media to authenticated;
alter table journey.media enable row level security;
create policy media_select_own on journey.media for select to authenticated
  using (auth.uid() = user_id and journey.is_allowed());
create policy media_insert_own on journey.media for insert to authenticated
  with check (auth.uid() = user_id and journey.is_allowed());
create policy media_update_own on journey.media for update to authenticated
  using (auth.uid() = user_id and journey.is_allowed())
  with check (auth.uid() = user_id and journey.is_allowed());
