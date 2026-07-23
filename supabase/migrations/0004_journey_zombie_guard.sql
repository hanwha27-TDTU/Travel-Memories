-- 0004_journey_zombie_guard.sql · 서버측 좀비데이터 방지(SYNC_PROTOCOL 불변식2 ZOMBIE-GUARD).
-- 계약: docs/SYNC_PROTOCOL.md. 적용된 migration 수정 금지. public(회계) 스키마는 건드리지 않는다.
--
-- 클라이언트 mergeDecision(src/sync/merge.ts)과 동일 규칙을 서버에서도 강제한다:
-- tombstone(deleted_at 있음)을 활성으로 되돌리려면 NEW.version이 OLD.version보다 '진짜로 더 커야'(복원)
-- 하고, 낮거나 같으면 거부(tombstone 유지). 오래된/스큐된 활성 upsert가 삭제를 되살리지 못하게 한다.
-- 적용/검증: 2026-07-23 프로젝트 Travel&Accounting(ihxiywffzmvrwmqvatzt)에 적용, BEGIN..ROLLBACK
-- 트랜잭션 테스트로 같은/낮은 version 부활 거부·높은 version 복원 허용 확인(비공허).

create or replace function journey.prevent_zombie_resurrection()
returns trigger
language plpgsql
set search_path = ''  -- 하드닝: search_path 조작 방지(본문은 OLD/NEW만 참조)
as $$
begin
  -- OLD가 tombstone이고 NEW가 활성으로 부활 시도할 때만 개입
  if OLD.deleted_at is not null and NEW.deleted_at is null then
    -- 진짜 복원(더 높은 version)만 허용. 낮거나 같으면 부활 거부 → 기존 tombstone 보존.
    if NEW.version <= OLD.version then
      return OLD; -- 업데이트 무효화, tombstone 행 그대로 유지
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_zombie_guard on journey.trips;
create trigger trg_zombie_guard
  before update on journey.trips
  for each row execute function journey.prevent_zombie_resurrection();

drop trigger if exists trg_zombie_guard on journey.moments;
create trigger trg_zombie_guard
  before update on journey.moments
  for each row execute function journey.prevent_zombie_resurrection();
