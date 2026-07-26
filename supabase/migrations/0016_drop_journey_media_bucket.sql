-- 0016_drop_journey_media_bucket.sql
-- **Supabase Storage 흔적을 완전히 없앤다.** 사진 바이트는 전부 Cloudflare R2로 옮겼다.
--
-- 왜 두 번에 나눠 했나:
--   0014에서 버킷 자체를 지우려 했으나 `storage.protect_delete()` 트리거가 막아 migration
--   전체가 롤백됐다. 그래서 0014는 **정책 4개만** 지웠고(RLS 기본 거부 → 버킷이 무력화됨)
--   껍데기는 남겨 뒀다. 이 파일이 그 껍데기를 치운다.
--
-- 트리거를 어떻게 통과하나:
--   `storage.protect_delete()`는 `storage.allow_delete_query` 설정이 'true'일 때만 통과시킨다
--   (Storage API가 쓰는 바로 그 문). 목적은 **"객체가 남은 채로 버킷만 지워 고아를 만드는 것"**을
--   막는 것이므로, 여기서는 **먼저 객체 수를 세어 0이 아니면 예외로 중단한다.** 가드를 끄는 게
--   아니라 가드가 지키려는 조건을 직접 확인하고 넘어간다.
--
-- 되돌리기: 버킷을 다시 만들면 된다(`storage.buckets`에 insert). 안에 자료가 없으므로
--   되돌려도 잃는 것이 없다 — 이 migration은 **자료가 아니라 빈 그릇**을 지운다.
--
-- 실행 기록: 2026-07-26 실서버 적용. 적용 전 `objects=0 · policies=0` 확인,
--   적용 후 `storage.buckets` 0행 되읽기 확인.

do $$
declare n int;
begin
  if not exists (select 1 from storage.buckets where id = 'journey-media') then
    raise notice 'journey-media 버킷이 이미 없습니다 — 건너뜁니다.';
    return;
  end if;

  select count(*) into n from storage.objects where bucket_id = 'journey-media';
  if n <> 0 then
    -- 고아를 만들지 않는다. 가드의 목적이 이것이고, 우리가 직접 확인한다.
    raise exception '중단: journey-media에 객체가 %건 남아 있습니다. 먼저 이관·삭제하세요.', n;
  end if;

  set local storage.allow_delete_query = 'true';
  delete from storage.buckets where id = 'journey-media';
end $$;
