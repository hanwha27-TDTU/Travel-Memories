-- 0012_journey_purged_ids.sql — 영구삭제 = **자료를 실제로 지운다**(ADR-0030).
--
-- 사용자 결정(2026-07-26): "의도를 가지고 삭제하는건데 서버에 왜 살려두나요? 자료를..
-- 2번 이상 클릭으로 삭제한거라면 영원히 복구가 안되도록 기록줄까지도 삭제시켜야 되는게
-- 맞는거 아닌가요? … 사정모르는 다른기기가 서버에 올리는 속터지는 행위는 안하지 않을까?"
--
-- 옳다. ADR-0025/0027이 행을 남긴 **유일한 이유는 좀비 방지**였다. 그런데 그건
-- "행을 남긴다"가 아니라 **"서버가 재삽입을 거부한다"**로 푸는 게 옳다.
-- 그러면 자료를 살려둘 이유가 사라진다.
--
-- 구조:
--   ① purged_ids — **id만** 담는 원장. 제목·메모·좌표·금액은 전부 사라진다.
--   ② BEFORE INSERT 트리거 — 원장에 있는 id는 서버가 **물리적으로 거부**한다.
--   ③ 다른 기기는 pull에서 이 원장을 읽어 자기 사본을 치운다(행이 없으니 원장이 그 역할).
--
-- §0 "하드 삭제 없음"과의 관계: 그 조항의 목적은 좀비 차단이었다. 원장+트리거가 그 목적을
-- **더 강하게** 달성하므로, 영구삭제(2단계 확인을 거친 명시적 의도)에 한해 하드 삭제를 허용한다.
-- 일반 삭제(휴지통행)는 **여전히 tombstone 전용**이다.
--
-- 되돌리기: 트리거·테이블을 drop하면 옛 동작으로 돌아간다(단, 이미 지워진 행은 복구 불가 —
-- 그게 이 기능의 목적이다).

create table if not exists journey.purged_ids (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  purged_at timestamptz not null default now()
);

alter table journey.purged_ids enable row level security;

drop policy if exists purged_ids_owner_select on journey.purged_ids;
create policy purged_ids_owner_select on journey.purged_ids
  for select using (user_id = auth.uid());

drop policy if exists purged_ids_owner_insert on journey.purged_ids;
create policy purged_ids_owner_insert on journey.purged_ids
  for insert with check (user_id = auth.uid());

-- update/delete 정책은 **일부러 없다** — 원장을 지울 수 있으면 좀비 차단이 뚫린다.

create index if not exists purged_ids_user_idx on journey.purged_ids (user_id, purged_at desc);

-- ② 되살리기 물리적 차단.
create or replace function journey.block_purged_reinsert()
returns trigger language plpgsql security definer set search_path = journey, public as $$
begin
  if exists (select 1 from journey.purged_ids p where p.id = new.id) then
    -- 조용히 무시한다(예외 대신). 밀린 편집을 가진 기기가 오류로 막히면 나머지 동기화까지
    -- 멈추는데, 그 기기의 다른 기억은 죄가 없다. 이 행만 버리고 계속 간다.
    return null;
  end if;
  return new;
end $$;

drop trigger if exists block_purged_reinsert on journey.trips;
create trigger block_purged_reinsert before insert on journey.trips
  for each row execute function journey.block_purged_reinsert();

drop trigger if exists block_purged_reinsert on journey.moments;
create trigger block_purged_reinsert before insert on journey.moments
  for each row execute function journey.block_purged_reinsert();

drop trigger if exists block_purged_reinsert on journey.media;
create trigger block_purged_reinsert before insert on journey.media
  for each row execute function journey.block_purged_reinsert();

drop trigger if exists block_purged_reinsert on journey.expenses;
create trigger block_purged_reinsert before insert on journey.expenses
  for each row execute function journey.block_purged_reinsert();

comment on table journey.purged_ids is
  '영구삭제된 id 원장. 내용은 담지 않는다(id·소유자·시각만). ① 다른 기기가 pull에서 읽어 자기 사본을 치운다 ② BEFORE INSERT 트리거가 재삽입을 거부해 좀비를 물리적으로 막는다.';

-- 옛 표식 컬럼 제거(0011) — 행 자체가 사라지므로 쓰이지 않는다.
alter table journey.trips    drop column if exists purged_at;
alter table journey.moments  drop column if exists purged_at;
alter table journey.media    drop column if exists purged_at;
alter table journey.expenses drop column if exists purged_at;
