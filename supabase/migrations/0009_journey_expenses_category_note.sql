-- 0009_journey_expenses_category_note.sql · 비용 분류·메모 컬럼(클라 LocalExpense 무손실 동기화).
-- 추가 전용. public(회계) 불가침. 적용된 migration 수정 금지.
alter table journey.expenses
  add column if not exists category text not null default '',
  add column if not exists note text not null default '';
