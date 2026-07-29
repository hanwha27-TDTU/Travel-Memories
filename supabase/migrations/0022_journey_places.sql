-- 0022_journey_places.sql · **장소를 독립 도메인으로 승격**한다(사용자 결정 2026-07-30).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 왜 (그리고 왜 이것이 정확도 문제와 별개인지 — 정직하게)
-- ─────────────────────────────────────────────────────────────────────────────
-- 사용자 신고는 「기본맵이 부정확하다」였고, 그 원인은 A단계(확대수준·정밀도 표시)와
-- B단계(제공자 라우팅)에서 고쳤다. **이 표는 정확도를 고치지 않는다.** 정확도는 *검색*
-- 단계의 문제이고 이 표는 *저장·재사용·공간질의*의 문제다.
--
-- 그래도 만드는 이유는 사용자가 셋 다 하기로 정했기 때문이고, 그 판단에는 근거가 있다:
-- 지금은 장소가 순간에 **문자열 세 칸**(이름·위도·경도)으로 흩어져 있다. 그래서
--   · 같은 카페를 열 번 가면 열 번 다시 검색해야 하고,
--   · 「이 근처에서 뭘 했더라」를 물을 수 없고,
--   · 좌표를 고쳐도 그 장소를 쓴 다른 순간은 모른다.
-- 장소가 **1급 시민**이 되면 셋 다 답이 생긴다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 🔴 설계 결정 1 — 순간의 기존 장소 필드를 **건드리지 않는다**
-- ─────────────────────────────────────────────────────────────────────────────
-- `moments.place_name/place_lat/place_lng`는 **그대로 남는다.** 이 표를 참조하도록
-- 옮기지 않는다. 두 가지 이유가 있고 둘 다 비타협 원칙 #1이다:
--
--  ① **기존 기억을 옮기는 마이그레이션은 그 자체가 최고 위험 연산이다.** 옮길 이유가
--     "더 정규화된 모양"뿐이라면 치를 값이 아니다.
--  ② **순간에 적힌 장소는 그때 그렇게 기록한 사실이다.** 나중에 장소 라이브러리의 좌표를
--     고쳤다고 과거 순간의 기록이 조용히 바뀌면, 그건 사용자가 쓴 것을 앱이 고쳐 쓴 것이다
--     (원칙 #2의 정신 — 사용자 기록과 파생물을 섞지 않는다).
--
-- 대신 `moments.place_id`를 **선택적 링크**로 더한다(0023). 있으면 "이 순간은 그 장소를
-- 골라 적은 것"이고, 없으면 지금까지처럼 자유 입력이다. 링크는 묶어 보기·재사용을 위한
-- 것이지 진실의 출처를 옮기는 것이 아니다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 🔴 설계 결정 2 — 좌표 순서를 **틀릴 수 없게** 만든다(§7 2층: 구조적 강제)
-- ─────────────────────────────────────────────────────────────────────────────
-- PostGIS의 가장 흔한 사고는 경도·위도를 뒤집는 것이다(`ST_MakePoint(경도, 위도)`).
-- 이 앱은 이미 그 함정을 한 번 겪었다 — 얀덱스 지도만 `ll=경도,위도` 순서라서
-- `verify-editor-live`에 **전용 검사**가 있다.
--
-- 그래서 `location`을 클라이언트가 쓰지 않는다. **생성 컬럼**으로 두어 longitude/latitude
-- 에서 서버가 항상 유도한다. 앱이 뒤집어 보낼 **방법 자체가 없다** — 조항이나 검사가 아니라
-- 구조가 막는다. (그래서 rowmap에도 `location`이 없고, `check-schema-parity`가 조용하다.)
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 형제(trips·moments·media·expenses·audio)의 계약을 **한 줄씩** 물려받는다
-- ─────────────────────────────────────────────────────────────────────────────
-- M-0033·0020의 교훈: **새것은 형제의 계약을 알고 태어나지 않는다.** 형제 목록을 훑었다:
--   · 소유자 RLS + 초대제 `is_allowed()`   → 아래 정책 3종 + delete 정책
--   · `(select …)` 감싸기(initplan)        → 0018 이후 `check-migration-grants`가 강제
--   · GRANT 4종(M-0020 — RLS와 다른 층)     → select/insert/update + delete
--   · tombstone 전용(§0) + 영구삭제 좁은 문 → delete 정책은 ADR-0030 경로 전용
--   · `set_updated_at` 트리거               → 있음
--   · `prevent_zombie_resurrection`         → 있음
--   · `block_purged_reinsert`               → **있음(0020의 실수를 반복하지 않는다)**
--   · `(id,user_id)` 유니크                  → 복합 FK의 대상이 되기 위해 필요(0023이 쓴다)
--
-- 🔴 **의도적 비대칭 — 장소는 여행의 자식이 아니다.** 형제 넷은 전부 `(moment_id,user_id)`
--    또는 `(trip_id,user_id)` 복합 FK를 갖고 부모가 지워지면 함께 지워진다. 장소는 다르다:
--    **한 장소는 여러 여행에 걸친다.** 작년 여행을 지웠다고 그 카페를 잊어야 할 이유가 없다.
--    그래서 장소는 **사용자 소유**이고 여행 cascade의 대상이 아니다. 이유를 여기 적어 두는
--    것은 §7의 요구다 — 안 적으면 다음 사람이 "형제들처럼" 고치고 그 순간 조용히 깨진다.
--
-- 되돌리기:
--   drop table journey.places cascade;
--   (정책·트리거·인덱스가 함께 사라진다. 로컬 데이터는 남고 앱은 로컬 장소 라이브러리로
--    동작한다 — 되돌릴 때 syncQueue에서 place op를 비운다.)

-- PostGIS. Supabase는 확장을 `extensions` 스키마에 둔다(public 오염 방지).
-- 이미 켜져 있으면 아무 일도 하지 않는다.
create extension if not exists postgis with schema extensions;

create table journey.places (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  -- 사용자가 부르는 이름. **자유 입력이다** — 검색 결과에 없는 곳도 기록해야 하기 때문에
  -- (map-place-dev §1 3항: 등록되지 않은 장소를 지원한다).
  name text not null,
  formatted_address text,

  -- 어느 지오코더가 준 답인가 + 그 제공자의 **안정 식별자**.
  -- `place_id`류의 내부 행 번호가 아니라 원본 id를 적는다(OSM은 `way/12345`).
  -- 지도에서 직접 찍은 곳은 둘 다 null이다 — 그것도 사실이다.
  provider text,
  provider_place_id text,

  -- 행정 조각. 주소 **문자열만** 저장하면 안 된다: 표기는 행정구역 개편·언어에 따라
  -- 바뀌지만 "어느 시·구였는가"는 기억의 일부다.
  country_code text,
  country text,
  region text,
  city text,
  district text,
  postcode text,

  category text,
  memo text,

  -- 🔴 **좌표의 진실원은 이 둘이다.** location은 여기서 유도된다(위 설계 결정 2).
  longitude double precision not null,
  latitude double precision not null,

  -- 이 좌표가 무엇을 가리키는가(건물/길/동네/…)와 그 대략 범위(m).
  -- 앱의 `domain/place/precision.ts`와 **같은 어휘**다. 모르면 null — 반올림하지 않는다(§8).
  precision text check (precision in ('point', 'street', 'area', 'settlement', 'region', 'unknown')),
  span_meters integer,

  -- 사용자가 지도에서 직접 찍어 확정했는가. **검색 좌표보다 강한 진실**이다
  -- (map-place-dev §1 2항 — 지도로 찍은 좌표는 이름과 독립이고 사용자가 최종 확정한 값이다).
  map_picked boolean not null default false,

  source text not null default 'user' check (source in ('user', 'pipeline')),
  version integer not null default 1,
  updated_by_device text,
  client_operation_id uuid,
  base_version integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  -- 복합 FK의 대상이 되기 위한 유니크(H-02) — 0023의 moments.place_id가 이것을 참조한다.
  constraint places_id_user_unique unique (id, user_id),

  -- 좌표는 실제 지구 위에 있어야 한다. 깨진 값이 들어오면 공간 인덱스가 통째로 무의미해진다.
  constraint places_lng_range check (longitude >= -180 and longitude <= 180),
  constraint places_lat_range check (latitude >= -90 and latitude <= 90)
);

-- 🔴 생성 컬럼 — 앱은 이 값을 **쓰지 않고 쓸 수도 없다.** 경도·위도 순서를 서버가 한 번만
-- 정하므로 클라이언트가 뒤집는 사고가 원리적으로 불가능하다(위 설계 결정 2).
alter table journey.places
  add column location extensions.geography(Point, 4326)
  generated always as (
    extensions.st_setsrid(extensions.st_makepoint(longitude, latitude), 4326)::extensions.geography
  ) stored;

comment on table journey.places is
  '사용자의 장소 라이브러리. 여행의 자식이 아니라 **사용자 소유**다(한 장소는 여러 여행에 걸친다). 하드 삭제 금지 — deleted_at tombstone. location은 longitude/latitude에서 유도되는 생성 컬럼(좌표 순서 사고 차단).';

-- 공간 인덱스 — 「이 근처에서 뭘 했더라」·가까운 순 정렬·화면 안 장소 조회가 이걸 쓴다.
-- tombstone은 제외한다(지운 장소를 근처 검색이 되살려 보여주면 안 된다).
create index places_location_idx on journey.places using gist (location) where deleted_at is null;

-- 같은 제공자의 같은 장소를 두 번 담지 않는다. **활성 행에만** 건다 —
-- 지웠다가 다시 담는 것은 정상 흐름이고, tombstone이 그걸 막으면 안 된다.
create unique index places_provider_unique
  on journey.places (user_id, provider, provider_place_id)
  where provider_place_id is not null and deleted_at is null;

create index places_user_updated_idx on journey.places (user_id, updated_at);

create trigger places_set_updated_at before update on journey.places
  for each row execute function journey.set_updated_at();

-- 좀비 차단 — tombstone은 **더 높은 version으로만** 부활한다(클라이언트 mergeDecision의 서버측 쌍둥이).
create trigger trg_zombie_guard before update on journey.places
  for each row execute function journey.prevent_zombie_resurrection();

-- 🔴 영구삭제 원장에 있는 id의 **재삽입 차단**. 0020에서 이 줄이 빠져 소리가 형제의 규율
-- 밖에서 태어났다 — 그 실수를 여기서 반복하지 않는다(§7 「형제가 나에게 걸 규칙」).
create trigger block_purged_reinsert before insert on journey.places
  for each row execute function journey.block_purged_reinsert();

-- 🔴 GRANT는 RLS와 **다른 층**이다(M-0020). RLS만 쓰고 이걸 잊으면 정책이 아무리 옳아도
--    앱은 permission denied를 받는다.
grant select, insert, update on journey.places to authenticated;

alter table journey.places enable row level security;

-- 정책 모양까지가 계약이다(`check-migration-grants`가 강제):
--   ① `(select …)`로 감싼다 — 맨 호출은 행마다 재평가된다(advisor auth_rls_initplan).
--   ② `journey.is_allowed()` 결합 — 초대제.
--   ③ `to authenticated` — 빠뜨리면 역할이 public이 되어 형제와 어긋난다.
create policy places_select_own on journey.places
  for select to authenticated
  using ((select auth.uid()) = user_id
     and (select journey.is_allowed()));

create policy places_insert_own on journey.places
  for insert to authenticated
  with check ((select auth.uid()) = user_id
          and (select journey.is_allowed()));

create policy places_update_own on journey.places
  for update to authenticated
  using ((select auth.uid()) = user_id
     and (select journey.is_allowed()))
  with check ((select auth.uid()) = user_id
          and (select journey.is_allowed()));

-- 영구삭제(휴지통 비우기)는 서버 행을 **실제로 지운다**(ADR-0030 — §0의 유일한 예외).
-- 형제 다섯이 전부 이 권한을 갖는다. 장소만 빠지면 「휴지통을 비웠는데 장소만 서버에
-- 남는」 비대칭이 생긴다(§7).
grant delete on journey.places to authenticated;

create policy places_delete_own on journey.places
  for delete to authenticated
  using ((select auth.uid()) = user_id
     and (select journey.is_allowed()));
