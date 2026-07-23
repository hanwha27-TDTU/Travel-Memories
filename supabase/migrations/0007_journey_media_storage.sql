-- 0007_journey_media_storage.sql · journey-media Storage 버킷(비공개) + 소유자 폴더 격리 RLS.
-- 경로 규약: '{user_id}/{media_id}.webp' → 첫 폴더가 소유자 uid여야 접근. DELETE 정책 없음
-- (tombstone 후 고아 스윕으로 정리, DEL-CONTRACT). 계약: SECURITY·PRIVACY.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('journey-media', 'journey-media', false, 10485760, array['image/webp','image/jpeg','image/png'])
on conflict (id) do nothing;

create policy journey_media_select_own on storage.objects for select to authenticated
  using (bucket_id='journey-media' and (storage.foldername(name))[1]=auth.uid()::text and journey.is_allowed());
create policy journey_media_insert_own on storage.objects for insert to authenticated
  with check (bucket_id='journey-media' and (storage.foldername(name))[1]=auth.uid()::text and journey.is_allowed());
create policy journey_media_update_own on storage.objects for update to authenticated
  using (bucket_id='journey-media' and (storage.foldername(name))[1]=auth.uid()::text and journey.is_allowed())
  with check (bucket_id='journey-media' and (storage.foldername(name))[1]=auth.uid()::text and journey.is_allowed());
