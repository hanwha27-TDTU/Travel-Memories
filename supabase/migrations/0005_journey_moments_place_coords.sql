-- 0005_journey_moments_place_coords.sql · 순간 좌표 동기화 컬럼(클라 LocalMoment 정합).
-- 계약: DATA_MODEL·SYNC_PROTOCOL. 적용된 migration 수정 금지. public(회계) 불가침.
alter table journey.moments
  add column if not exists place_lat double precision,
  add column if not exists place_lng double precision;
