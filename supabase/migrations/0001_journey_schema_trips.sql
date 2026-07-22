-- 0001_journey_schema_trips.sql · Journey Archive thin slice
-- 공유 프로젝트(Travel&Accounting) 내 스키마 분리(ADR-0020):
--   회계 앱 = public 스키마(불가침) · 여행 앱 = journey 스키마 전용.
-- 이 마이그레이션은 journey 스키마만 생성하며 public의 어떤 객체도 건드리지 않는다.
-- 계약: docs/DATA_MODEL.md · docs/SECURITY.md(소유자 RLS). 적용된 migration 수정 금지.

create schema if not exists journey;

-- anon에는 스키마 접근 자체를 주지 않는다. authenticated만 사용.
grant usage on schema journey to authenticated;

create table journey.trips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  start_date date,
  end_date date,
  status text not null default 'planned'
    check (status in ('planned', 'active', 'completed', 'archived')),
  country_codes text[] not null default '{}',
  cities text[] not null default '{}',
  summary text,
  cover_media_id uuid,
  budget_amount numeric,
  budget_currency text,
  -- 동기화 메타 (docs/SYNC_PROTOCOL.md)
  version integer not null default 1,
  updated_by_device text,
  client_operation_id uuid,
  base_version integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  -- 복합 소유자 FK의 부모측 요건 (H-02): 자식 테이블이 (trip_id,user_id)로 참조
  constraint trips_id_user_unique unique (id, user_id)
);

comment on table journey.trips is 'Journey Archive 여행. 하드 삭제 금지 — deleted_at tombstone(DEL-CONTRACT).';

-- updated_at 서버 시각 갱신 (LWW는 서버 시각 read-back 기준 — SYNC_PROTOCOL 불변식 1)
create or replace function journey.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trips_set_updated_at
  before update on journey.trips
  for each row execute function journey.set_updated_at();

-- 테이블 권한: authenticated에 SELECT/INSERT/UPDATE만. DELETE 권한 자체를 주지 않음
-- (DELETE 정책 없음과 이중 방어 — tombstone 전용, DEL-CONTRACT).
grant select, insert, update on journey.trips to authenticated;

-- RLS: 소유자 범위, operation별 분리, TO authenticated 명시 (SECURITY.md)
alter table journey.trips enable row level security;

create policy trips_select_own on journey.trips
  for select to authenticated
  using (auth.uid() = user_id);

create policy trips_insert_own on journey.trips
  for insert to authenticated
  with check (auth.uid() = user_id);

create policy trips_update_own on journey.trips
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- DELETE 정책 없음 + DELETE grant 없음 = 클라이언트 하드 삭제 불가.
