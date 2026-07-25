-- 0011_journey_purged_at.sql — 영구삭제(휴지통 비우기)를 **모든 기기에 전파**하기 위한 표식.
--
-- 왜(ADR-0027, 사용자 지적 2026-07-26):
--   "다른 기기에서 휴지통을 비웠으면 연동기기에서도 사라져 있어야 되는 거 아닌가요?"
-- 맞다. ADR-0025는 영구삭제를 **기기별**로 뒀고, 그래서 한 기기에서 비워도 다른 기기 휴지통엔
-- 그대로 남았다. 1인 사용 앱에서 '영구'가 이 기기만을 뜻하면 그건 영구삭제가 아니라 숨김이다.
--
-- 왜 행을 하드 삭제하지 않는가:
--   ADR-0025가 B안(서버 행 하드 삭제)을 기각한 근거 — "그 사실을 모르는 다른 기기가 자기 사본을
--   다시 올려 좀비를 만든다" — 는 지금도 유효하다. 당시 잘못은 거기서 멈춘 것이었다:
--   **"서버 행을 지우지 않는다"와 "다른 기기에 알리지 않는다"는 별개인데** 한 묶음으로 처리했다.
--   행은 tombstone으로 남기고 **의도만 컬럼에 실어** 보내면 둘 다 얻는다.
--   CLAUDE.md §0 "하드 삭제 없음 — deleted_at tombstone"도 그대로 지켜진다.
--
-- 쓰기 규율(중요):
--   클라이언트의 toRow()는 이 컬럼을 **절대 담지 않는다.** 담으면 평범한 upsert가 다른 기기의
--   영구삭제를 null로 덮어써 지운 것이 되살아난다. 쓰기는 전용 경로(pushPurges)만 한다.
--
-- 되돌리기: alter table ... drop column purged_at; (파생 표식이라 사용자 데이터 손실 없음)

alter table journey.trips    add column if not exists purged_at timestamptz;
alter table journey.moments  add column if not exists purged_at timestamptz;
alter table journey.media    add column if not exists purged_at timestamptz;
alter table journey.expenses add column if not exists purged_at timestamptz;

comment on column journey.trips.purged_at is
  '사용자가 어느 기기에서 휴지통을 비운 시각. 설정되면 모든 기기가 다음 동기화에서 로컬 사본과 사진 바이트를 치운다. 행 자체는 tombstone으로 남긴다(하드 삭제 금지).';
comment on column journey.moments.purged_at  is '같음 — journey.trips.purged_at 참조.';
comment on column journey.media.purged_at    is '같음 — journey.trips.purged_at 참조.';
comment on column journey.expenses.purged_at is '같음 — journey.trips.purged_at 참조.';
