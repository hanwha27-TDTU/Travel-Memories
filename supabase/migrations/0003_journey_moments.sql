-- 0003_journey_moments.sql · 순간(Moment) 서버 테이블 + 소유자 RLS + 초대제.
-- 계약: docs/DATA_MODEL.md · docs/SECURITY.md(H-02 복합 FK, ADR-0021 초대제). 적용된 migration 수정 금지.
-- public(회계) 스키마는 건드리지 않는다.

create table journey.moments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  trip_id uuid not null,
  occurred_at timestamptz,
  title text not null,
  note text not null default '',
  emotion text not null default '',
  place_name text not null default '',
  -- 동기화 메타 (docs/SYNC_PROTOCOL.md)
  version integer not null default 1,
  updated_by_device text,
  client_operation_id uuid,
  base_version integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint moments_id_user_unique unique (id, user_id),
  -- H-02 DB 계층 방어: 다른 사용자의 여행 id에 순간을 붙일 수 없다(부모 trips의 UNIQUE(id,user_id) 참조).
  constraint moments_trip_fk foreign key (trip_id, user_id)
    references journey.trips (id, user_id) on delete cascade
);

comment on table journey.moments is
  '순간(Moment). 하드 삭제 금지 — deleted_at tombstone(DEL-CONTRACT). (trip_id,user_id) 복합 FK로 소유권 방어(H-02).';

-- 부모 여행별 조회 인덱스(자식 FK 조회·타임라인).
create index moments_trip_idx on journey.moments (trip_id) where deleted_at is null;

-- updated_at 서버시각 갱신(기존 함수 재사용).
create trigger moments_set_updated_at
  before update on journey.moments
  for each row execute function journey.set_updated_at();

-- 권한: SELECT/INSERT/UPDATE만(하드 DELETE 불가 — tombstone 전용).
grant select, insert, update on journey.moments to authenticated;

-- RLS: 소유자 범위 + 초대제(is_allowed), operation별 분리, TO authenticated.
alter table journey.moments enable row level security;

create policy moments_select_own on journey.moments
  for select to authenticated
  using (auth.uid() = user_id and journey.is_allowed());

create policy moments_insert_own on journey.moments
  for insert to authenticated
  with check (auth.uid() = user_id and journey.is_allowed());

create policy moments_update_own on journey.moments
  for update to authenticated
  using (auth.uid() = user_id and journey.is_allowed())
  with check (auth.uid() = user_id and journey.is_allowed());
