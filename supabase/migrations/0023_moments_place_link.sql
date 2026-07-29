-- 0023_moments_place_link.sql · 순간이 장소 라이브러리를 **가리킬 수 있게** 한다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 이 컬럼이 하는 일과 **하지 않는 일**
-- ─────────────────────────────────────────────────────────────────────────────
-- 한다: 「이 순간은 라이브러리의 그 장소를 골라 적은 것」을 기록한다. 그래서
--        장소별로 기억을 모아 볼 수 있고, 같은 곳을 다시 갈 때 재사용할 수 있다.
--
-- **하지 않는다**: 순간의 `place_name`/`place_lat`/`place_lng`를 대체하지 않는다.
--        그 세 칸은 **그때 그렇게 기록한 사실**이고 그대로 남는다(0022 설계 결정 1).
--        나중에 라이브러리의 좌표를 고쳤다고 과거 순간의 기록이 조용히 바뀌면, 그건
--        사용자가 쓴 것을 앱이 고쳐 쓴 것이다.
--
-- 🔴 그래서 이 컬럼은 **null 허용**이고 앞으로도 그렇다. 자유 입력 장소(라이브러리에 없는
--    곳·지도에서 직접 찍은 곳)는 링크가 없는 것이 정상이며, 그것은 결함이 아니다.
--    map-place-dev §1 3항: *등록되지 않은 장소를 지원한다. 검색 결과에 의존하는 흐름을
--    만들지 않는다.*
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 왜 `on delete set null`인가 (형제들의 `cascade`와 다르다 — 의도적 비대칭)
-- ─────────────────────────────────────────────────────────────────────────────
-- 형제 자식들(media·expenses·audio)은 부모가 사라지면 **함께 사라진다** — 그 자료는 그
-- 부모의 일부이기 때문이다. 장소 링크는 반대다: 장소를 라이브러리에서 지웠다고 **그 순간의
-- 기억이 사라지면 안 된다.** 순간은 여전히 자기 `place_name`/좌표를 갖고 있다.
--
-- 즉 링크가 끊어져도 **잃는 것은 링크뿐이고 기억은 남는다.** 그것이 이 설계에서 링크를
-- 부가정보로 둔 이유이고, `set null`이 그 뜻을 서버에 못박는다.
--
-- (복합 FK로 거는 이유는 H-02와 같다 — `(place_id,user_id)`여야 남의 장소를 가리킬 수 없다.)
--
-- 되돌리기: alter table journey.moments drop column place_id;

alter table journey.moments
  add column place_id uuid;

alter table journey.moments
  add constraint moments_place_fk foreign key (place_id, user_id)
    references journey.places (id, user_id) on delete set null;

create index moments_place_idx on journey.moments (place_id) where place_id is not null and deleted_at is null;

comment on column journey.moments.place_id is
  '장소 라이브러리 링크(선택). place_name/place_lat/place_lng를 **대체하지 않는다** — 그 세 칸이 기록 당시의 사실이다. 링크가 끊겨도(on delete set null) 순간의 기억은 남는다.';
