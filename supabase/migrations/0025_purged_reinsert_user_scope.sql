-- 0025_purged_reinsert_user_scope.sql · 좀비 재삽입 차단을 **소유자 범위로 좁힌다** (M-16).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 무엇이 문제였나 (전수감사 2026-08-01 · M-16)
-- ─────────────────────────────────────────────────────────────────────────────
-- 0012의 `block_purged_reinsert()`는 재삽입을 막을 때 **id만** 본다:
--     if exists (select 1 from journey.purged_ids p where p.id = new.id) ...
-- 그런데 `journey.purged_ids`는 여러 사용자의 원장을 **한 표에 함께** 담는다(user_id 컬럼 보유).
-- 그래서 사용자 A가 어떤 id를 영구삭제하면, **사용자 B**가 (초대제 안에서) 같은 id로 행을
-- 넣으려 할 때도 트리거가 조용히 `return null`로 **버린다** — B의 기억이 A의 삭제에 막힌다.
--
-- 실제로 부딪힐 확률: uuid 충돌은 사실상 0이라 **오늘 당장의 데이터 손실은 아니다.** 그러나
-- 이것은 계약의 결함이다 — 「좀비 차단」은 *같은 소유자*의 재삽입을 막는 것이지, 남의 삭제가
-- 내 삽입을 막는 것이 아니다. 방어는 정확히 자기 사정권에서만 작동해야 한다(§7 · M-0059의
-- 근본형: 판정이 자기 전제 밖에서 반대로 작동한다).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 어떻게 고치나 (한 곳만 — 6개 트리거가 이 함수 하나를 공유한다)
-- ─────────────────────────────────────────────────────────────────────────────
-- 조건에 `and p.user_id = new.user_id`를 더한다. 이 함수는 trips·moments·media·expenses·
-- audio·places **여섯 표**의 BEFORE INSERT 트리거가 전부 공유하므로(§7 구조적 강제 — 규칙은
-- 한 곳에만 산다), 함수를 고치면 여섯 형제가 **자동으로** 함께 고쳐진다. 트리거 재생성 불필요.
--
-- 안전 전제(확인함 · §9 4단계): 여섯 표 모두 `user_id uuid not null`을 갖는다
-- (0001·0003·0006·0019·0022). 그래서 new.user_id는 항상 존재하고, 비교가 NULL로 새지 않는다.
--
-- 되돌리기: 조건에서 `and p.user_id = new.user_id`를 제거하는 후속 migration을 추가하면
-- 옛 동작(id-only)으로 돌아간다. 데이터 손실 없음.
-- 계약: docs/SYNC_PROTOCOL.md · ADR-0030. 적용된 migration(0012) 수정 금지 — 함수만 갱신.

-- search_path는 ''로 고정한다(권한 상승 경로 차단 · 헌장 §2 불변식 #5). 0012는 journey,public을
-- 썼지만 이 함수 본문은 참조를 전부 스키마 한정(journey.purged_ids)하므로 ''로 좁혀도 안전하다.
create or replace function journey.block_purged_reinsert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- 🔴 소유자 범위로 좁힌다(M-16): 내가 지운 것만 내 재삽입을 막는다. 남의 원장은 무관하다.
  if exists (
    select 1 from journey.purged_ids p
    where p.id = new.id and p.user_id = new.user_id
  ) then
    -- 조용히 무시한다(예외 대신). 밀린 편집을 가진 기기가 오류로 막히면 나머지 동기화까지
    -- 멈추는데, 그 기기의 다른 기억은 죄가 없다. 이 행만 버리고 계속 간다.
    return null;
  end if;
  return new;
end $$;
