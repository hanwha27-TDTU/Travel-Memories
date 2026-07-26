-- 0014_retire_journey_media_bucket.sql — 옛 사진 저장소를 **못 쓰게 막는다**(사용자 지시 2026-07-26).
--
-- 배경: 사진 바이트를 R2로 이관 완료했다. 8장을 옮기고 **새 저장소에서 8장 모두 확인한 뒤**
-- 옛 파일을 정리했고, 서버 실측으로 객체 0개를 확인했다. v0.86에서 앱의 Supabase Storage
-- 경로도 제거했다(`mediaStoreKind`·`VITE_MEDIA_STORE`·`supabaseBlobStore` 전부).
--
-- 남은 것은 **버킷과 정책뿐**이었다 — 코드가 없을 뿐 쓰기는 여전히 *가능한* 상태.
-- 사용자 지시: "supabase 관련 버킷도 흔적도 없애버리고."
--
-- 왜 코드 제거만으로 부족한가: 코드는 규율이고 접근 차단은 **구조**다(CLAUDE.md §7 2층).
-- 정책이 남아 있으면 옛 캐시 빌드나 실수로 만든 클라이언트가 여전히 쓸 수 있고, 그렇게 들어간
-- 사진은 앱이 더 이상 그 저장소를 보지 않으므로 **영영 보이지 않는다.**
--
-- 지우기 전 확인한 것(§0 "삭제 전에 대상을 본다"):
--   · 객체 수 0 · public = false
--   · 정책 4개가 **전부 `bucket_id = 'journey-media'` 한정** → 같은 프로젝트를 쓰는 회계 앱과
--     공유되는 정책이 없다. 이 프로젝트의 유일한 버킷이기도 하다.
--
-- 버킷 행 자체는 여기서 못 지운다: Supabase가 `storage.protect_delete()` 트리거로
-- **SQL 직접 삭제를 막는다**("Use the Storage API instead" — 고아 객체 사고 방지). 대시보드나
-- Storage API로만 지울 수 있고, 그건 사용자 몫이다(service_role 키는 쓰지 않는다 — §0).
--
-- 그래도 목적은 달성된다: **RLS는 기본 거부**이므로 정책이 없으면 `authenticated`도 `anon`도
-- 이 버킷을 읽거나 쓸 수 없다. 버킷은 껍데기로 남고 아무도 들어가지 못한다.
--
-- 되돌리기: 0006의 정책 4종을 다시 만들면 된다. 객체는 이미 0이므로 잃는 자료가 없다.

drop policy if exists journey_media_select_own on storage.objects;
drop policy if exists journey_media_insert_own on storage.objects;
drop policy if exists journey_media_update_own on storage.objects;
drop policy if exists journey_media_delete_own on storage.objects;
