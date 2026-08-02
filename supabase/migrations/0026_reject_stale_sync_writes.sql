-- 0026_reject_stale_sync_writes.sql · 오래된 기기의 무조건 upsert 차단.
--
-- 문제: 클라이언트는 push 뒤 pull 순서이고, ON CONFLICT upsert에는 최신성 조건이 없었다.
-- 서버 v3보다 오래된 로컬 v2가 들어오면 UPDATE 트리거가 updated_at을 현재 서버 시각으로
-- 바꿔 버려, 이어지는 pull에서도 방금 덮어쓴 옛 내용이 최신처럼 승리했다.
--
-- 이 트리거는 set_updated_at보다 먼저 원본 NEW.updated_at을 검사한다. PostgreSQL은 같은
-- timing/event의 트리거를 이름순으로 실행하므로 이름을 `a_...`로 고정한다.
-- base_version을 보낸 새 클라이언트는 낙관적 동시성으로, 옛 클라이언트는 updated_at LWW로 판정한다.
--
-- 롤백(데이터 변경 없음): 아래 여섯 테이블에서 `a_sync_write_guard`를 drop한 뒤
-- `drop function journey.guard_sync_write();`를 실행한다. 운영 적용 전 DB 스냅샷을 남기고,
-- 신형 클라이언트가 모든 활성 기기에 배포됐음을 확인한 뒤 적용한다(혼재 배포 금지).

create or replace function journey.guard_sync_write()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- 이 계약은 Data API의 사용자 동기화 쓰기에만 적용한다. postgres/service_role/SECURITY DEFINER
  -- 복구 함수까지 막으면 후속 migration과 재해복구 UPDATE가 조건 필드를 모르는 순간 조용히
  -- 무효화된다. 관리 경로는 RLS 우회 권한과 별개로 명시적으로 통과시킨다.
  if current_user <> 'authenticated' then
    return NEW;
  end if;

  -- 같은 작업의 네트워크 재시도는 이미 착지한 성공이다. 행을 다시 써서 서버 시각을
  -- 앞으로 밀지 않는다. 클라이언트 read-back이 operation id로 성공을 확인한다.
  if NEW.client_operation_id is not null
     and NEW.client_operation_id = OLD.client_operation_id then
    return null;
  end if;

  -- 새 클라이언트는 마지막으로 본 서버 version을 base_version으로 보낸다. 기준선이 일치하면
  -- 기기 시계가 서버보다 느려도 경합이 없으므로 허용하고, 불일치하면 시각과 무관하게 거부한다.
  -- NULL은 migration 이전 클라이언트의 점진적 전환을 위한 호환 경로다.
  if NEW.base_version is not null then
    if NEW.base_version <> OLD.version then
      return null;
    end if;

    -- 활성↔tombstone은 여전히 한 단계 높은 세대만 허용한다(동률 삭제/부활 차단).
    if (NEW.deleted_at is null) <> (OLD.deleted_at is null)
       and NEW.version <= OLD.version then
      return null;
    end if;

    NEW.version := greatest(NEW.version, OLD.version + 1);
    return NEW;
  end if;

  -- 여기부터는 base_version을 모르는 옛 클라이언트 호환 경로다.
  -- 활성↔tombstone 전이는 벽시계가 아니라 세대로만 판정한다.
  if (NEW.deleted_at is null) <> (OLD.deleted_at is null) then
    if NEW.version <= OLD.version then
      return null;
    end if;
    return NEW;
  end if;

  -- 같은 삭제상태는 updated_at LWW. 오래된 기기 시각이면 내용과 version이 어떻든 거부한다.
  if NEW.updated_at < OLD.updated_at then
    return null;
  end if;

  -- 같은 순간에는 더 높은 version만 새 변경으로 인정한다. 첫 writer가 안정적으로 이긴다.
  if NEW.updated_at = OLD.updated_at and NEW.version <= OLD.version then
    return null;
  end if;

  -- updated_at은 LWW, version은 삭제 전이의 세대다. 같은 상태의 최신 쓰기가 낮은 version을
  -- 들고 왔더라도 서버 version을 되감지 않고 한 단계 전진시킨다.
  NEW.version := greatest(NEW.version, OLD.version + 1);
  return NEW;
end;
$$;

-- 트리거 전용 함수는 Data API에서 직접 부를 이유가 없다.
revoke execute on function journey.guard_sync_write() from public, anon, authenticated;

drop trigger if exists a_sync_write_guard on journey.trips;
create trigger a_sync_write_guard before update on journey.trips
  for each row execute function journey.guard_sync_write();

drop trigger if exists a_sync_write_guard on journey.moments;
create trigger a_sync_write_guard before update on journey.moments
  for each row execute function journey.guard_sync_write();

drop trigger if exists a_sync_write_guard on journey.media;
create trigger a_sync_write_guard before update on journey.media
  for each row execute function journey.guard_sync_write();

drop trigger if exists a_sync_write_guard on journey.expenses;
create trigger a_sync_write_guard before update on journey.expenses
  for each row execute function journey.guard_sync_write();

drop trigger if exists a_sync_write_guard on journey.audio;
create trigger a_sync_write_guard before update on journey.audio
  for each row execute function journey.guard_sync_write();

drop trigger if exists a_sync_write_guard on journey.places;
create trigger a_sync_write_guard before update on journey.places
  for each row execute function journey.guard_sync_write();

comment on function journey.guard_sync_write() is
  'Rejects stale sync upserts before set_updated_at using base_version OCC; legacy null-base writes fall back to version/LWW.';
