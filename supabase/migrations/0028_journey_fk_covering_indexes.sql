-- 0028 · journey FK 커버링 인덱스 10건
--
-- 왜: Supabase advisor `unindexed_foreign_keys`가 journey 스키마에서 10건을 가리켰다
--     (HANDOFF-0053부터 「별도 보완 항목」으로 남아 있던 것). FK 자체는 H-02 복합 FK
--     계약대로 옳고, 없던 것은 참조 검사·cascade가 쓸 커버링 인덱스뿐이다.
--
-- 왜 부분(partial) 인덱스가 아닌가(§7 — 의도적 비대칭에는 이유를 적는다):
--     기존 `*_moment_idx`·`moments_trip_idx`·`moments_place_idx`는 전부
--     `WHERE deleted_at IS NULL` 부분 인덱스다. 화면 질의(살아 있는 자식)에는 옳지만,
--     FK 참조 검사와 cascade는 tombstone 행까지 봐야 하므로 그 술어가 함의되지 않아
--     쓸 수 없다. 그래서 여기 인덱스는 술어 없이 만들고, 기존 부분 인덱스는
--     화면 질의용으로 그대로 둔다(서로 대체가 아니라 용도가 다르다).
--     `*_id_user_unique (id, user_id)`도 user_id가 선행 컬럼이 아니라 user_id FK를 못 덮는다.
--
-- 덮는 FK (운영에서 읽은 실제 컬럼 순서 기준):
--     trips_user_id_fkey(user_id) · moments_user_id_fkey(user_id)
--     moments_trip_fk(trip_id,user_id) · moments_place_fk(place_id,user_id)
--     media_user_id_fkey(user_id) · media_moment_fk(moment_id,user_id)
--     expenses_user_id_fkey(user_id) · expenses_moment_fk(moment_id,user_id)
--     audio_user_id_fkey(user_id) · audio_moment_fk(moment_id,user_id)
--     (places·purged_ids·sync_meta의 user_id FK는 기존 인덱스가 이미 덮는다 — 대상 아님)
--
-- 데이터 변경: 없음(인덱스만). 되돌리기: drop index journey.<이름> 10건.

create index if not exists trips_user_idx           on journey.trips    (user_id);
create index if not exists moments_user_idx         on journey.moments  (user_id);
create index if not exists moments_trip_user_idx    on journey.moments  (trip_id, user_id);
create index if not exists moments_place_user_idx   on journey.moments  (place_id, user_id);
create index if not exists media_user_idx           on journey.media    (user_id);
create index if not exists media_moment_user_idx    on journey.media    (moment_id, user_id);
create index if not exists expenses_user_idx        on journey.expenses (user_id);
create index if not exists expenses_moment_user_idx on journey.expenses (moment_id, user_id);
create index if not exists audio_user_idx           on journey.audio    (user_id);
create index if not exists audio_moment_user_idx    on journey.audio    (moment_id, user_id);
