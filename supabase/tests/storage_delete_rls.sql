-- storage_delete_rls.sql · journey-media DELETE 정책(0010) 소유자 격리 검증.
-- BEGIN..ROLLBACK — 프로덕션 무변경. 고아 스윕(DEL-CONTRACT)이 남의 객체를 못 지움을 확인.
--
-- 실행: Supabase MCP execute_sql 또는 psql. 기대: 정책 존재 + 소유자 격리 술어(owner=true, other=false).

begin;

-- 1) DELETE 정책이 존재하고 소유자 폴더 격리 + 초대제 범위인지(select/insert/update와 동일 구조).
select
  count(*) filter (
    where policyname='journey_media_delete_own' and cmd='DELETE'
      and qual like '%storage.foldername(name))[1] = (auth.uid())::text%'
      and qual like '%journey.is_allowed()%'
  ) = 1 as delete_policy_owner_scoped
from pg_policies
where schemaname='storage' and tablename='objects';

-- 2) 술어 자체 검증: 남의 폴더 객체는 DELETE 대상이 될 수 없다.
select
  ((storage.foldername('aaaa-uid/media1.webp'))[1] = 'aaaa-uid') as owner_can_delete_own,      -- true
  ((storage.foldername('aaaa-uid/media1.webp'))[1] = 'bbbb-uid') as other_cannot_delete_owners; -- false

rollback;
