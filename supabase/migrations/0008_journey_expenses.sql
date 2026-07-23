-- 0008_journey_expenses.sql · 비용(Expense) 서버 테이블. 순간에 딸린 지출. 원금액 불변(H-04).
-- 계약: DATA_MODEL·SECURITY(H-02)·SYNC_PROTOCOL(tombstone·ZOMBIE-GUARD). public 불가침.

create table journey.expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  moment_id uuid not null,
  trip_id uuid not null,
  original_amount numeric not null check (original_amount > 0),
  original_currency text not null,
  version integer not null default 1,
  updated_by_device text,
  client_operation_id uuid,
  base_version integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint expenses_id_user_unique unique (id, user_id),
  constraint expenses_moment_fk foreign key (moment_id, user_id)
    references journey.moments (id, user_id) on delete cascade
);
comment on table journey.expenses is
  '비용(Expense). 원금액 불변(H-04). 하드 삭제 금지 — deleted_at tombstone. (moment_id,user_id) 복합 FK(H-02).';
create index expenses_moment_idx on journey.expenses (moment_id) where deleted_at is null;
create trigger expenses_set_updated_at before update on journey.expenses
  for each row execute function journey.set_updated_at();
create trigger trg_zombie_guard before update on journey.expenses
  for each row execute function journey.prevent_zombie_resurrection();
grant select, insert, update on journey.expenses to authenticated;
alter table journey.expenses enable row level security;
create policy expenses_select_own on journey.expenses for select to authenticated
  using (auth.uid() = user_id and journey.is_allowed());
create policy expenses_insert_own on journey.expenses for insert to authenticated
  with check (auth.uid() = user_id and journey.is_allowed());
create policy expenses_update_own on journey.expenses for update to authenticated
  using (auth.uid() = user_id and journey.is_allowed())
  with check (auth.uid() = user_id and journey.is_allowed());
