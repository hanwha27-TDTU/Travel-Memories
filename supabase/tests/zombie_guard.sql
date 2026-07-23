-- zombie_guard.sql · 서버측 ZOMBIE-GUARD 트리거 비공허 검증(0004).
-- BEGIN..ROLLBACK로 프로덕션 데이터를 건드리지 않고 검증한다.
-- 실행: Supabase SQL Editor 또는 MCP execute_sql. 실패 시 RAISE EXCEPTION로 중단(=RED).
-- 통과 기준: 같은/낮은 version 활성 부활은 거부(tombstone 유지), 높은 version(진짜 복원)만 활성화.

begin;
do $$
declare uid uuid; d timestamptz;
begin
  select user_id into uid from journey.trips limit 1;
  insert into journey.trips(id,user_id,title,version,deleted_at,created_at,updated_at)
    values('99999999-9999-9999-9999-999999999999',uid,'zg-test',3,now(),now(),now());

  -- 같은 version 부활 시도 → 거부
  update journey.trips set deleted_at=null, version=3, updated_at=now()
    where id='99999999-9999-9999-9999-999999999999';
  select deleted_at into d from journey.trips where id='99999999-9999-9999-9999-999999999999';
  if d is null then raise exception 'FAIL: 같은 version 부활 허용됨(좀비!)'; end if;

  -- 낮은 version 부활 시도 → 거부
  update journey.trips set deleted_at=null, version=2, updated_at=now()
    where id='99999999-9999-9999-9999-999999999999';
  select deleted_at into d from journey.trips where id='99999999-9999-9999-9999-999999999999';
  if d is null then raise exception 'FAIL: 낮은 version 부활 허용됨(좀비!)'; end if;

  -- 높은 version(진짜 복원) → 활성화
  update journey.trips set deleted_at=null, version=4, updated_at=now()
    where id='99999999-9999-9999-9999-999999999999';
  select deleted_at into d from journey.trips where id='99999999-9999-9999-9999-999999999999';
  if d is not null then raise exception 'FAIL: 높은 version 복원이 막힘'; end if;

  raise notice 'ZOMBIE-GUARD OK: 같은/낮은 version 거부, 높은 version만 복원';
end $$;
rollback;
