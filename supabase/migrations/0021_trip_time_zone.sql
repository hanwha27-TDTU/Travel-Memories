-- 0021_trip_time_zone.sql — **그 자리의 시계**(2026-07-29 · M-0049)
--
-- 왜: 순간의 시각과 Day 그룹이 *보는 기기*의 시간대로 계산되고 있었다. 베트남에서 저녁 7시에
-- 기록한 순간이 한국에서 21:08로 보이고, 자정 근처면 Day 묶음까지 하루 밀린다. 그리고 EXIF
-- 벽시계를 *넣는 기기*의 시간대로 해석해 **절대시각 자체가 틀어지는** 저장 결함도 있었다.
--
-- 무엇: 여행에 **IANA 시간대 id**(DST까지 브라우저 tzdata가 처리한다), 순간에 **오프셋 예외**.
--   · `trips.time_zone`      — 예 'Asia/Ho_Chi_Minh'. NULL/'' = 미지정(추측으로 채우지 않는다)
--   · `moments.tz_offset_min` — 분. NULL이면 여행 시간대에서 파생. EXIF OffsetTimeOriginal이
--                               알려줬거나 사용자가 고친 순간에만 채워진다
--
-- 정렬·LWW·동기화는 **계속 절대시각**(`occurred_at`)으로 한다 — 표시만 이 값을 지난다.
-- 섞으면 M-0034(같은 순간을 두 표기로) 재발이다.
--
-- 되돌리기: 두 컬럼을 drop 하면 된다. 앱은 없는 값을 「미지정」으로 읽으므로 옛 판과 호환된다.

alter table journey.trips   add column if not exists time_zone text;
alter table journey.moments add column if not exists tz_offset_min integer;

-- 분 단위 오프셋의 현실 범위(UTC-12:00 ~ UTC+14:00). 범위 밖 값은 계산 결과가 아니라 결함이다.
alter table journey.moments drop constraint if exists moments_tz_offset_min_range;
alter table journey.moments add constraint moments_tz_offset_min_range
  check (tz_offset_min is null or (tz_offset_min between -720 and 840));
