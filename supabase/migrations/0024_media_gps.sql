-- 0024_media_gps.sql — **사진이 찍힌 자리도 모든 기기에서 보인다** (2026-08-01 · [user-decided])
--
-- ── 왜 ────────────────────────────────────────────────────────────────────────
-- 사진의 EXIF GPS(`gpsLat`/`gpsLng`)가 **이 기기에만** 있었다. `media` rowmap에 그 필드가
-- 아예 없어 서버로 가지 않았고, `pullMedia`는 `local?.gpsLat ?? null`로 로컬 값을 지켰다.
-- 그래서 폰에서 넣은 사진을 태블릿에서 열면 **그 사진이 찍힌 자리를 알 수 없었다.**
--
-- 사용자 결정(2026-08-01): *"사진 GPS도 서버에 올리자. 당연한 거 아냐? 내 개인앱인데."*
-- 2026-07-27의 결정과 같은 줄기다 — *"핵심은 모든 기기에서 모든 정보를 확인해야 합니다.
-- 서버에 올라가는 순간 클라우드가 정본이 되야 합니다."* 오디오는 0019에서 이 빚을 갚았고,
-- 사진 GPS는 남아 있었다(§7 — 또 형제 하나만 빠져 있었다).
--
-- ── 사생활 계약과의 관계 (중요) ───────────────────────────────────────────────
-- `docs/PRIVACY.md`는 *"앱 내부 저장은 보존, **공유·내보내기 산출물에서는 GPS 제거**"*라고
-- 정한다. 이 마이그레이션은 그 계약을 **바꾸지 않는다**:
--
--   · 서버는 **소유자 RLS로 잠긴 내 계정 전용 저장소**다 → 「앱 내부」에 해당한다(사용자 판단).
--   · R2에 올라가는 **사진 파일 자체는 여전히 EXIF가 벗겨진 canvas 재인코딩본**이다
--     (`check-exif-strip-on-share`가 강제). 좌표는 **파일이 아니라 컬럼**으로 간다.
--   · 그래서 사진을 밖으로 내보내거나 공유해도 **파일에는 위치가 없다.** 오히려 더 안전한
--     자세다 — 좌표는 RLS 뒤에 있고, 나가는 바이트에는 안 실린다.
--
-- ── 무엇 ──────────────────────────────────────────────────────────────────────
--   · `media.gps_lat` / `media.gps_lng` — double precision, NULL 허용(= 위치 없음/미상)
--
-- 값 범위를 제약으로 잠근다. 범위 밖은 계산 결과가 아니라 **결함**이고, 이 앱은 실제로
-- `0,0`(기니만 앞바다)을 사용자 기억에 저장한 적이 있다(M-0057). 0,0 자체는 유효 좌표라
-- DB가 막을 수 없다 — 그 층은 클라이언트(`photoHint`·`exif.ts`)가 이미 막는다.
--
-- 되돌리기: 두 컬럼을 drop 하면 된다. 옛 앱은 이 컬럼을 안 읽고 안 쓴다(무해).

alter table journey.media add column if not exists gps_lat double precision;
alter table journey.media add column if not exists gps_lng double precision;

alter table journey.media drop constraint if exists media_gps_range;
alter table journey.media add constraint media_gps_range check (
  (gps_lat is null or (gps_lat between -90 and 90))
  and (gps_lng is null or (gps_lng between -180 and 180))
);
