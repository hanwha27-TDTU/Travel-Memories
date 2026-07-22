-- 0001_trips.sql · Journey Archive thin slice
-- 계약: docs/DATA_MODEL.md(공통 열·tombstone·UNIQUE(id,user_id)) · docs/SECURITY.md(소유자 RLS)
-- 적용: Supabase 프로젝트 생성 후 apply_migration. 적용된 migration은 수정 금지.

create table public.trips (
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

comment on table public.trips is 'Journey Archive 여행. 하드 삭제 금지 — deleted_at tombstone(DEL-CONTRACT).';

-- updated_at 서버 시각 갱신 (LWW는 서버 시각 read-back 기준 — SYNC_PROTOCOL 불변식 1)
create or replace function public.set_updated_at()
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
  before update on public.trips
  for each row execute function public.set_updated_at();

-- RLS: 소유자 범위, operation별 분리, TO authenticated 명시 (SECURITY.md)
alter table public.trips enable row level security;

create policy trips_select_own on public.trips
  for select to authenticated
  using (auth.uid() = user_id);

create policy trips_insert_own on public.trips
  for insert to authenticated
  with check (auth.uid() = user_id);

create policy trips_update_own on public.trips
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- DELETE 정책 없음 = 클라이언트 하드 삭제 불가(RLS default deny).
-- 삭제는 tombstone(update deleted_at)만 가능 — check-no-hard-delete와 이중 방어.

-- anon은 정책이 없어 기본 거부되지만, 명시적으로 권한도 회수(이중 방어)
revoke all on public.trips from anon;
