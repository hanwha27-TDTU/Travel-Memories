-- 0019_journey_audio.sql · 오디오 노트(Audio) 서버 메타 테이블.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 왜 이제야 만드는가 (사용자 결정 2026-07-27)
-- ─────────────────────────────────────────────────────────────────────────────
-- 오디오 노트는 v1.14에서 **로컬 전용**으로 태어났다. 그 판단의 근거는
-- `blueprint.ts`의 `localOnlyReason`에 이렇게 적혀 있었다:
--
--   "서버 오디오 테이블이 아직 없다(마이그레이션 + Edge Function 확장자 허용 +
--    FN_VERSION 상향 + 3단 배포가 함께 와야 한다). 그래서 MVP는 ①로컬 + ③백업
--    두 계층으로 간다 — 원본 사진과 같은 계약."
--
-- 사용자가 그 판단을 **뒤집었다**:
--
--   *"당연히 서버동기화를 진행해야죠. 사진과 동일하게... 우리가 오프라인에서도
--     사용하기 위해서 로컬저장소를 이용하고는 있지만 핵심은 모든 기기에서 모든
--     정보를 확인해야 합니다. 따라서 서버에 올라가는 순간 클라우드가 정본이
--     되야 합니다."*
--
-- 그 말이 옳다. **로컬에만 있는 자료는 기능이 아니라 결함**이고, `localOnlyReason`은
-- 정당한 예외가 아니라 **갚아야 할 빚**이었다. 이 마이그레이션이 그 빚의 첫 상환이다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- "클라우드가 정본"을 어떻게 구현하는가 (중요 — 곧이곧대로 옮기면 기억을 잃는다)
-- ─────────────────────────────────────────────────────────────────────────────
-- *"pull할 때 서버가 항상 이긴다"*로 만들면 오프라인에서 적은 것이 다음 동기화에
-- 덮여 사라진다(비타협 원칙 #1 정면 위반). 목표(모든 기기가 같은 것을 본다)는
-- 그 방법이 아니라 **기존 세 규율의 조합**으로 이룬다 — 사진·순간·비용이 이미 그렇다:
--   ① 로컬 변경은 예외 없이 큐 op를 만들어 서버에 도달한다
--   ② 모든 기기는 서버에 있는 것을 전부 pull한다(빈-클라우드 가드는 유지)
--   ③ 충돌은 LWW로 수렴하고, 삭제상태 전이는 **version**으로 판정한다(좀비 차단)
-- 소리에는 ①이 통째로 없었다. 그래서 이 테이블이 필요하다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 형제(journey.media)와 같은 계약 — 다른 점은 하나뿐
-- ─────────────────────────────────────────────────────────────────────────────
-- 사진은 원본을 서버에 두지 않고 **표시본만** 올린다(절약 모드). 소리는 **원본이 곧
-- 유일본**이라 그것을 올린다 — 60초 opus가 ~100KB로 표시본 사진(~300KB)보다 가볍다.
-- 즉 "가공본만 올린다"는 규칙은 사진의 사정이지 소리의 사정이 아니다(§7 — 비대칭은
-- 설계 단계에서 심사하고 이유를 적는다).
--
-- 나머지는 전부 같다: 소유자 RLS + 초대제 · 복합 FK(H-02) · tombstone 전용 ·
-- set_updated_at · 좀비 차단 트리거 · GRANT(M-0020 — RLS만으로는 앱이 접근조차 못 한다).
--
-- 되돌리기:
--   drop table journey.audio cascade;
--   (정책·트리거·인덱스가 함께 사라진다. 로컬 데이터는 그대로 남고, 앱은 다시
--    로컬 전용으로 동작한다 — 큐 op만 쌓이므로 되돌릴 때 syncQueue에서 audio op를 비운다.)

create table journey.audio (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  moment_id uuid not null,
  trip_id uuid not null,
  -- R2 객체 키({user_id}/{여행폴더}/{이름}.{ext}). 업로드 전엔 null.
  -- **바이트가 착지한 키가 곧 진실이다**(sync-offline-dev §1-C) — 다시 계산하지 않고 적어 둔다.
  storage_path text,
  duration_sec integer,
  mime text,
  bytes integer,
  recorded_at timestamptz,
  source text not null default 'user' check (source in ('user', 'pipeline')),
  version integer not null default 1,
  updated_by_device text,
  client_operation_id uuid,
  base_version integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint audio_id_user_unique unique (id, user_id),
  constraint audio_moment_fk foreign key (moment_id, user_id)
    references journey.moments (id, user_id) on delete cascade
);

comment on table journey.audio is
  '오디오 노트(원본이 유일본이라 R2에 그대로 올린다). 하드 삭제 금지 — deleted_at tombstone. (moment_id,user_id) 복합 FK(H-02).';

create index audio_moment_idx on journey.audio (moment_id) where deleted_at is null;

create trigger audio_set_updated_at before update on journey.audio
  for each row execute function journey.set_updated_at();

-- 좀비 차단 — tombstone은 **더 높은 version으로만** 부활한다(클라이언트 mergeDecision의 서버측 쌍둥이).
create trigger trg_zombie_guard before update on journey.audio
  for each row execute function journey.prevent_zombie_resurrection();

-- 🔴 GRANT는 RLS와 **다른 층**이다(M-0020). RLS만 쓰고 이걸 잊으면 정책이 아무리 옳아도
--    앱은 permission denied를 받는다. 실제로 purged_ids가 그 상태로 배포됐다.
grant select, insert, update on journey.audio to authenticated;

alter table journey.audio enable row level security;

-- 정책 모양까지가 계약이다(0018 이후 `check-migration-grants`가 강제):
--   ① `(select …)`로 감싼다 — 맨 호출은 **행마다** 재평가된다(advisor auth_rls_initplan).
--      둘 다 STABLE이라 감싸면 InitPlan으로 끌어올려 질의당 1회. 뜻은 안 바뀌고 횟수만 바뀐다.
--   ② `journey.is_allowed()` 결합 — 초대제. 허용목록 밖 사용자는 자기 행조차 못 읽는다.
--   ③ `to authenticated` — 빠뜨리면 역할이 public이 되어 형제와 어긋난다(0013·0015가 실제로 그랬다).
-- DELETE 정책은 **의도적으로 없다** — tombstone 전용(§0). 영구삭제만 0015의 좁은 문으로 지운다.
create policy audio_select_own on journey.audio
  for select to authenticated
  using ((select auth.uid()) = user_id
     and (select journey.is_allowed()));

create policy audio_insert_own on journey.audio
  for insert to authenticated
  with check ((select auth.uid()) = user_id
          and (select journey.is_allowed()));

create policy audio_update_own on journey.audio
  for update to authenticated
  using ((select auth.uid()) = user_id
     and (select journey.is_allowed()))
  with check ((select auth.uid()) = user_id
          and (select journey.is_allowed()));

-- 영구삭제(휴지통 비우기)는 서버 행을 **실제로 지운다**(ADR-0030 — §0의 유일한 예외).
-- 형제(trips·moments·media·expenses)는 0015에서 이 권한을 받았다. 소리만 빠지면
-- 「휴지통을 비웠는데 소리만 서버에 남는」 비대칭이 생긴다(§7).
grant delete on journey.audio to authenticated;

create policy audio_delete_own on journey.audio
  for delete to authenticated
  using ((select auth.uid()) = user_id
     and (select journey.is_allowed()));
