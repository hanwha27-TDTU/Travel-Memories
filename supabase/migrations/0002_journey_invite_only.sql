-- 0002_journey_invite_only.sql · 초대제 접근 잠금 (owner allowlist)
-- 목적: 공유 프로젝트의 Google 로그인은 열려 있으나(회계 앱과 공용), journey(여행)
--       데이터는 "허용된 이메일"만 읽기/쓰기 가능하도록 DB 레벨에서 강제한다.
--       앱 UI 게이트와 이중 방어. public(회계) 스키마는 건드리지 않는다.
-- 되돌리기(다시 공개): 아래 세 정책의 `and journey.is_allowed()` 조건을 제거하는
--       후속 migration을 추가하면 된다(데이터 손실 없음). 초대 추가는 allowed_users에 insert.
-- 계약: docs/SECURITY.md · docs/PRIVACY.md · ADR-0021. 적용된 migration 수정 금지.

-- 허용 사용자 목록 (초대 이메일). 소문자 정규화하여 보관.
create table if not exists journey.allowed_users (
  email text primary key,
  note text,
  created_at timestamptz not null default now()
);

-- 클라이언트 직접 접근 차단: RLS on + 정책 없음 + grant 없음.
-- 허용 여부 검사는 오직 SECURITY DEFINER 함수(journey.is_allowed)로만 수행한다.
alter table journey.allowed_users enable row level security;
revoke all on table journey.allowed_users from anon, authenticated;

-- 소유자 시드.
insert into journey.allowed_users (email, note)
values ('hanwha27@gmail.com', 'owner')
on conflict (email) do nothing;

-- 현재 로그인 사용자의 이메일이 허용목록에 있는가? (JWT email 클레임 기준, 소문자 비교)
-- SECURITY DEFINER: allowed_users의 RLS를 우회해 소유자 권한으로 조회.
create or replace function journey.is_allowed()
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1
    from journey.allowed_users a
    where a.email = lower(coalesce((auth.jwt() ->> 'email'), ''))
  );
$$;

revoke all on function journey.is_allowed() from public;
grant execute on function journey.is_allowed() to authenticated;

-- 기존 소유자 범위 정책에 "허용된 사용자" 조건을 결합한다.
--   (auth.uid() = user_id)  AND  journey.is_allowed()
-- → 허용목록에 없는 사용자는 로그인해도 자기 행조차 읽기/쓰기 불가.
drop policy if exists trips_select_own on journey.trips;
create policy trips_select_own on journey.trips
  for select to authenticated
  using (auth.uid() = user_id and journey.is_allowed());

drop policy if exists trips_insert_own on journey.trips;
create policy trips_insert_own on journey.trips
  for insert to authenticated
  with check (auth.uid() = user_id and journey.is_allowed());

drop policy if exists trips_update_own on journey.trips;
create policy trips_update_own on journey.trips
  for update to authenticated
  using (auth.uid() = user_id and journey.is_allowed())
  with check (auth.uid() = user_id and journey.is_allowed());

-- DELETE 정책/권한은 여전히 없음(tombstone 전용, DEL-CONTRACT 유지).
