-- 0010_journey_media_storage_delete.sql · journey-media Storage 고아 스윕용 DELETE 정책.
-- DEL-CONTRACT(0007) 이행: 사진 tombstone 후 소유 기기가 표시본 객체를 정리한다.
-- 소유자 폴더 격리 + 초대제 — select/insert/update 정책과 동일 범위. 남의 폴더 객체는 못 지운다.

create policy journey_media_delete_own on storage.objects for delete to authenticated
  using (bucket_id='journey-media' and (storage.foldername(name))[1]=auth.uid()::text and journey.is_allowed());
