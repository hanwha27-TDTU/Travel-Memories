---
name: supabase-security-dev
description: Supabase·보안·RLS 개발 프롬프트 — supabase/migrations/*.sql·supabase/tests/*.sql·services/auth.ts·services/supabase/client.ts를 만들거나 수정하기 전에 반드시 로드한다. 스키마 격리·소유자 RLS·초대제·좀비 트리거·키 관리 계약과 마이그레이션/공격검사 레시피를 담은 작업 헌장. 테이블 추가, RLS 정책, Storage 버킷, 인증 변경 시 사용.
---

# Supabase·보안 개발 프롬프트 (Supabase & Security Dev Charter)

여기서의 실수는 **남의 데이터가 새거나, 내 데이터가 지워지는** 결과로 나온다.
정책의 정본은 `docs/SECURITY.md`·`docs/PRIVACY.md`(무엇이어야 하는가)이고, 이 문서는 **작업 헌장**(안전하게 적용하는 법)이다.

## 0. 파일 지도

| 위치 | 역할 |
|---|---|
| `supabase/migrations/NNNN_*.sql` | 스키마·RLS·트리거. **추가 전용**(과거 파일 수정 금지) |
| `supabase/tests/*.sql` | RLS 공격검사(격리·초대제·H-02 위조·좀비 차단) — `BEGIN … ROLLBACK` |
| `src/services/supabase/client.ts` | 클라이언트 — **`db.schema='journey'` 고정** |
| `src/services/auth.ts` | Google OAuth(PKCE) + 초대제 앱 게이트 |
| `supabase/functions/media-sign/index.ts` | **R2 바이트의 유일한 출입구**(SigV4 presign). R2 자격증명이 존재하는 유일한 장소 |
| `src/services/r2.ts` | 그 함수를 부르는 브라우저 어댑터 — **자격증명 없음**, 5분 URL만 받는다 |

## 1. 절대 금지 (§0 비타협)

1. **프론트엔드에 publishable(anon) 키만.** `service_role`·secret 키·DB 비밀번호·관리자 JWT를 번들·저장소·로그·리포트에 **절대** 넣지 않는다.
2. **RLS 오류를 secret 키로 "고치지" 않는다.** 정책이 막으면 정책을 고친다.
3. **RLS 검증 없이 테이블을 배포하지 않는다.**
4. **하드 삭제 정책을 주지 않는다** — tombstone 전용(DEL-CONTRACT). Storage 바이트 삭제만 소유자 폴더격리 DELETE로 별도 허용.

## 2. 불변 계약

1. **한 지붕 여러 가족 — 스키마 격리**: 이 프로젝트는 회계 앱과 Supabase 프로젝트를 공유한다(ADR-0020). 벽은 셋으로 선다: ①클라이언트가 자기 스키마만 노출(`db.schema`) ②각 테이블 소유자 범위 RLS ③앱별 Storage 버킷 + 버킷 RLS. **스키마 간 FK·뷰로 새지 않게 한다.**
2. **소유자 범위 RLS + 초대제**: 모든 정책은 `auth.uid()` 소유자 술어 **AND `journey.is_allowed()`**(허용목록). 허용목록 밖 사용자는 로그인해도 자기 행조차 못 읽는다.
   **모양까지가 계약이다**(0018부터 `check-migration-grants`가 강제):
   ```sql
   create policy foo_select_own on journey.foo
     for select to authenticated                                  -- ③ 역할 명시
     using ((select auth.uid()) = user_id                          -- ① InitPlan
        and (select journey.is_allowed()));                        -- ② 초대제 + InitPlan
   ```
   - ① **`(select …)`로 감싼다.** 맨 호출은 **행마다** 재평가된다. 둘 다 STABLE이라 감싸면
     Postgres가 InitPlan으로 끌어올려 질의당 1회만 평가한다 — **뜻은 안 바뀌고 횟수만 바뀐다.**
     `is_allowed()`는 테이블을 조회하는 함수라, 안 감싸면 사진 N장에 조회가 N번 붙는다
     (advisor `auth_rls_initplan`이 이 자리를 가리킨다).
   - ③ **`to authenticated`를 빠뜨리지 마라.** 역할이 `public`이 되어 형제와 어긋난다.
     0013·0015가 실제로 6개를 빠뜨렸고 2026-07-27까지 몰랐다(anon은 GRANT가 없고
     `auth.uid()`가 NULL이라 실害는 없었다 — 그래서 더 오래 갔다).
   - **`alter policy`가 아니라 `drop` + `create`로 바꾼다.** 게이트가 `create policy` 본문
     텍스트를 진실원으로 삼으므로, `alter`로 고치면 게이트가 보는 것은 옛 정의로 남고
     그 자리는 **검사되지 않는 자리**가 된다.
3. **복합 FK로 소유권 방어(H-02)**: 자식 테이블은 `(parent_id, user_id) → parent(id, user_id)`. 단일 FK면 남의 부모에 자식을 붙일 수 있다.
4. **좀비·stale-write 방지 트리거**: `prevent_zombie_resurrection`은 tombstone을 더 높은 version으로만 부활시킨다. migration 0026의 `a_sync_write_guard`는 authenticated 쓰기에 한해 `base_version = OLD.version`을 요구하고 `set_updated_at`보다 먼저 stale UPDATE를 no-op으로 만든다. **관리·복구 역할은 통과시킨다** — 앱의 조건부 쓰기 계약으로 후속 migration까지 묶지 않는다. 클라이언트는 operation-id read-back으로 no-op을 성공과 구분한다.
   - migration 0027의 `a0_canonical_sync_guard`는 같은 여섯 표에서 authenticated INSERT/UPDATE의 `base_canonical_version`을 사용자 `sync_meta`와 대조하고 0026 guard보다 먼저 돈다. `sync_meta`는 SELECT만 직접 열고, generation 전진은 `auth.uid()`·초대제·CAS·payload user 범위를 직접 검증하는 `publish_canonical_snapshot` 좁은 문 하나로만 한다. 정확집합 delete/insert와 메타 전진은 **한 DB transaction**이어야 한다.
5. **`SECURITY DEFINER` 함수는 `search_path=''` 고정**(권한 상승 경로 차단).
   본문 참조는 전부 스키마 한정(`journey.…`·`auth.uid()`)으로 쓴다 — 경로가 비므로 한정하지
   않은 이름은 못 찾는다. **이 조항은 처음부터 있었는데 `block_purged_reinsert()`(0012)와
   `unpurge_ids()`(0017)가 `journey, public`으로 태어났고 2026-07-27 건강진단까지 몰랐다.**
   조항만 있고 기계 검사가 없던 자리였다 → 이제 `check-migration-grants`가 최종 상태로 판정한다.

5-B. **노출 스키마의 함수는 REST 표면이다 — 그런데 advisor 경고가 같아도 처방은 정반대다.**
   (번호를 `5-B`로 둔 것은 의도다 — 뒤 항목을 밀면 `§2.7`(R2 4중벽)을 가리키는 다른 문서의
   참조가 조용히 어긋난다.)
   `journey`는 노출 스키마라 그 안의 함수가 `/rest/v1/rpc/<name>`으로 보인다. advisor는
   셋을 같은 경고로 묶지만:

   | 함수 | 무엇이 부르는가 | 조치 |
   |---|---|---|
   | `block_purged_reinsert()` | **트리거만** | **EXECUTE 회수**(0018). Postgres는 트리거 함수의 EXECUTE를 **트리거 생성 시점에만** 검사하므로 회수해도 발화는 멀쩡하다(`BEGIN…ROLLBACK`으로 실증함) |
   | `unpurge_ids(uuid[])` | **앱**(복원 좁은 문) | **유지.** 회수하면 백업 복원이 원장에 막혀 조용히 무효화된다(M-0032 재발) |
   | `is_allowed()` | **정책 18개** | 🔴 **절대 회수 금지.** RLS 정책 식은 **호출자 권한**으로 평가된다 → 회수하면 앱이 자기 데이터를 못 읽는다 |

   > **advisor의 권고문을 그대로 따르지 마라 — 무엇이 그 함수를 부르는지부터 보라.**
   > 셋 다 권고문은 *"Revoke EXECUTE"*로 똑같다. 하나는 옳고, 하나는 기억을 잃게 하고,
   > 하나는 앱을 죽인다. (`docs/SECURITY.md` 상단에 같은 표가 있다 — 그쪽이 정본.)
6. **GPS는 동기화하지 않는다**(PRIVACY). 원본 사진도 서버에 올리지 않는다(절약 모드).
7. **R2에는 RLS가 없다(ADR-0024)**: 벽이 넷으로 바뀐다 — ①토큰이 **버킷 하나**만 열도록 스코프 ②자격증명은 함수 시크릿에만 ③**객체 키를 서버가 생성**(폴더=검증된 `sub`, 클라이언트가 보낸 key/path는 무시) ④인증은 `verify_jwt` 설정에 기대지 않고 매 요청 `/auth/v1/user`로 실제 확인. 읽기도 서명(정책 B) — **공개 개발 URL·`R2_PUBLIC_BASE`를 쓰지 않는다.**
8. **목록 조회의 prefix도 서버가 만든다**(2026-07-26 추가). 위 ③은 *한 객체*를 다루는 op(put/get/delete)만 상정하고 쓰여 있었고, **여러 객체를 훑는 op에는 규칙이 없었다** — 이 기능을 만들며 드러난 구멍이다. 단건 op에서는 키를 서버가 만들어 남의 폴더를 못 가리키지만, 목록은 **prefix 하나로 버킷 전체가 열린다**. 그래서:
   - `prefix`는 **반드시 `${검증된 sub}/`**. 클라이언트가 보낸 prefix·delimiter·bucket 값은 **읽지 않는다**(무시가 아니라 아예 파싱하지 않는다 — 파싱하면 언젠가 쓰게 된다).
   - 서명 URL을 브라우저에 **주지 않는다.** 목록 URL은 그 자체가 "이 접두사 아래 전부"를 뜻하므로 유출 시 단건 URL보다 손해가 크다. 함수가 호출하고 **파싱된 결과만** 돌려준다(delete와 같은 이유).
   - 응답에 **전체 키를 담지 않는다** — `{uid}/`를 떼고 mediaId만 준다. 화면은 어차피 앞 8자리만 쓴다(진단 §6 개인정보 규율).
   - **잘렸으면 잘렸다고 말한다.** 페이지 상한에 걸렸는데 `truncated`를 안 주면 "전부 봤다"로 읽히고, 그 위에서 "고아 0건"이라 판정하면 **거짓말이 된다**(비타협 원칙 #4).

## 3. 마이그레이션 적용 레시피 (되돌릴 수 있게)

1. **먼저 읽는다**: `list_tables`로 현재 구조 확인. 추측으로 쓰지 않는다.
2. 파일은 **추가 전용** `NNNN_설명.sql`. 과거 마이그레이션을 수정하지 않는다.
3. 새 테이블이면 한 세트로: 테이블 + **`grant … to authenticated`** + **소유자 RLS 4종(select/insert/update)** + `is_allowed()` 결합 + 복합 FK + `set_updated_at` 트리거 + 좀비 트리거.
   - **GRANT를 RLS와 헷갈리지 마라(M-0020).** 둘은 **다른 층**이다: GRANT는 *"이 역할이 이 테이블에 접근이나 할 수 있는가"*, RLS는 *"그중 어느 행을 볼 수 있는가"*. RLS만 쓰고 GRANT를 잊으면 정책이 아무리 옳아도 앱은 `permission denied`를 받는다. 실제로 `purged_ids`가 그 상태로 배포됐고, 진단 화면이 통째로 빨갛게 뜨고 **영구삭제가 서버에 반영되지 않았다.**
   - 게이트 `check-migration-grants`가 이제 이걸 막는다(새 테이블에 GRANT·`is_allowed()`가 없으면 RED). 제외하려면 `NO_GRANT_REQUIRED`에 **근거를 적는다.**
4. **적용 전에 공격검사를 쓴다**(§4). 정책보다 테스트를 먼저 쓰면 빠뜨린 술어가 드러난다.
   **더 좋은 방법: 마이그레이션 자체를 트랜잭션 안에서 먼저 돌린다**(2026-07-27에 이렇게 했다).
   ```sql
   begin;
     <마이그레이션 DDL 전체>
     set local role authenticated;   -- 앱이 쓰는 역할로 내려간다
     select set_config('request.jwt.claims','{"sub":"…","email":"…"}', true);
     <§4 공격검사 전 항목>
   rollback;                          -- 프로덕션 무변경
   ```
   **적용 후가 아니라 적용 전에** 같은 상태를 만들어 볼 수 있다는 게 핵심이다. 되돌릴 일이
   생기기 전에 되돌린다. (임시 테이블로 결과를 모을 거면 `grant all on <temp> to anon,
   authenticated` — 역할을 바꾼 뒤엔 자기 임시 테이블에도 못 쓴다. 실제로 한 번 걸렸다.)
5. 적용 후: **advisor 확인**(신규 이슈 0) + **프로덕션 행 수 무변경** 확인.
6. 클라이언트 쪽 `rowmap.ts`와 `check-schema-parity`의 `ROW_TO_TABLE`을 같은 변경에서 맞춘다.

## 4. RLS 공격검사 레시피 (이게 "검증했다"의 기준)

**문서를 읽고 통과라 하지 않는다. 실제로 남이 되어 보고 막히는지 확인한다.**

> 🔴 **superuser로 확인한 것은 검증이 아니다(M-0020).** MCP·SQL 편집기의 기본 역할은 GRANT도 RLS도 **우회한다** — 앱이 쓰는 역할이 아니다. 실제로 `purged_ids` 배포 후 트리거 실효를 superuser로 확인해 "통과"라 보고했는데, 앱은 그 테이블에 접근조차 못 하는 상태였다. **아래처럼 `set local role authenticated` + 실제 JWT 클레임으로 돌린 것만 검증이다.**
>
> 픽스처 주의: `is_allowed()`는 JWT의 **email**을 허용목록과 대조한다. 가짜 이메일을 쓰면 0건이 나오고 그걸 결함으로 오진하게 된다 — 이메일은 손으로 적지 말고 `select email from journey.allowed_users limit 1`로 **읽어서** 쓴다(실제로 이 오진을 한 번 했다).

```sql
BEGIN;
-- 사용자 A로 가장
select set_config('request.jwt.claims', '{"sub":"<A-uuid>","email":"a@x"}', true);
insert into journey.<table> (...) values (...);          -- 성공해야
-- 사용자 B로 전환
select set_config('request.jwt.claims', '{"sub":"<B-uuid>","email":"b@x"}', true);
select count(*) from journey.<table>;                     -- 0 이어야(격리)
update journey.<table> set ... ;                          -- 0 rows(강탈 차단)
insert into journey.<table> (user_id, ...) values ('<A-uuid>', ...);  -- 거부(위조 차단)
-- 허용목록 밖 사용자
select set_config('request.jwt.claims', '{"sub":"<C-uuid>","email":"stranger@x"}', true);
select count(*) from journey.<table>;                     -- 0 이어야(초대제)
ROLLBACK;   -- 프로덕션 무변경
```

확인해야 할 항목: **격리** · **강탈 차단** · **위조 차단(user_id 조작)** · **없는 부모에 자식 부착 차단(H-02)** · **초대제** · **좀비 부활 차단** · **anon 전면 차단**.

## 5. 과거 결함·위험 등록부

| 사례 | 근본형 | 대응 |
|---|---|---|
| **일반 merge로는 사용자가 정한 전체 최종본을 유지할 수 없음**(M-0090) | RLS/OCC는 행 하나의 권한·최신성만 지키며, 다른 기기의 로컬 전용 행이 어느 전체집합에 속하는지는 표현하지 못함 | 0027 `sync_meta` generation + 여섯 표 authenticated generation fence + CAS/멱등/정확집합 원자 RPC. owner+초대제 SELECT만 직접 허용, operation/meta read-back. 신형 앱 전기기→스냅샷→0026→0027 순 배포 |
| **앱의 무조건 upsert가 최신 서버 행을 덮을 수 있었음**(M-0084) | RLS는 "누가"를 막았지만 "마지막으로 본 판이 맞는가"를 검사하지 않았다. 반대로 첫 guard는 모든 역할을 막아 복구 UPDATE까지 조용히 무효화할 뻔했다 | 0026을 **authenticated 전용** OCC guard로 한정 + 관리자 bypass와 authenticated stale 차단을 같은 transaction SQL에서 반대 검사 + 신형 앱 전기기 선배포 후 migration 적용 |
| 공유 프로젝트의 Google 로그인이 전역이라 아무 계정이나 자기 기록 생성 가능 | 인증(공유)과 인가(앱별)를 혼동 | `allowed_users` + `is_allowed()`를 **모든 정책에 결합**. 앱 게이트는 UX일 뿐, 진짜 방어는 DB |
| 클라가 서버에 없는 컬럼을 밀어 조용히 깨짐 | 클라↔서버 스키마 드리프트 | `check-schema-parity`(rowmap 필드 ⊆ 서버 컬럼) |
| `SECURITY DEFINER` 함수 search_path 경고 | 권한 상승 경로 | `search_path=''` 고정 |
| 사진 tombstone 후 Storage 객체가 고아로 남음 | 행 삭제와 바이트 삭제 시점 분리 | 소유자 폴더격리 DELETE 정책 + tombstone 반영 후 최선노력 스윕 |
| **Storage 버킷은 SQL로 못 지운다**(2026-07-26) | `storage.protect_delete()` 트리거가 `delete from storage.buckets`를 막는다("Use the Storage API instead" — 고아 객체 사고 방지). 마이그레이션 **전체가 롤백**된다 | 버킷 행 삭제는 대시보드/Storage API(사용자 몫 — service_role 키는 안 쓴다). **정책 4종을 drop하면 목적은 달성된다** — RLS는 기본 거부라 정책이 없으면 아무도 못 읽고 못 쓴다. 껍데기만 남는다 |
| **새 테이블에 GRANT 누락 → 앱이 permission denied**(M-0020) | RLS와 GRANT를 같은 층으로 오인 + 검증을 superuser로 수행 | `check-migration-grants` 게이트(18번째) + §4에 "superuser 검증은 검증이 아니다" 명문화 |
| **차단 트리거를 만들며 정당한 예외의 문을 안 냄**(M-0032) | 거부 규칙을 설계할 때 **막을 대상**만 생각했다. 0013은 `purged_ids`에 UPDATE·DELETE를 의도적으로 withhold했고 그 판단은 옳았는데, *"그럼 사용자의 복원은 어느 문으로 들어오나"*를 묻지 않았다 → **없는 문은 조용히 막는다**(오류·로그·토스트 없이 기억이 사라짐) | `0017`의 **좁은 문** 패턴: 이름 있는 `SECURITY DEFINER` 함수 하나만 열고 ①`user_id = auth.uid()`로 자기 행만 ②`is_allowed()` 통과 필수 ③**명시한 id만**(전체 비우기 없음) ④**테이블 권한은 그대로 안 준다**. 그리고 거부 상태 자체를 **런타임 지표**로 만든다 |
| **불변식 #5(`search_path=''`)를 헌장에 적어 두고 함수 둘이 벗어난 채 배포**(건강진단 2026-07-27) | **조항 1층만 있는 규칙은 드리프트한다.** 실害는 없었다(참조가 전부 스키마 한정이었다) — 그래서 더 오래 갔다. 무해한 이탈일수록 오래 산다 | `0018`이 `alter function … set search_path = ''`로 복구 + `check-migration-grants`의 `auditDefinerSearchPath`가 3층을 놓는다 |
| **정책 6개만 역할이 `public`**(0013·0015가 `to authenticated`를 빠뜨림) | 형제 12개는 좁혀져 있었다 — §7의 최빈 형태. anon은 GRANT가 없어 실害 0이라 아무도 안 봤다 | `0018`에서 18개 전부 재작성 + 게이트가 `to authenticated` 누락을 RED |
| **RLS 정책이 행마다 `is_allowed()`를 재평가**(advisor `auth_rls_initplan` 18건) | 정책을 *옳게* 쓰는 것과 *효율적으로* 쓰는 것을 다른 문제로 취급했다. 행이 11개일 땐 안 보인다 | `(select …)` InitPlan 형태를 **계약으로 승격**(§2 불변식 #2) + 게이트가 맨 호출을 RED |
| **공유 프로젝트 백업 복원이 프로젝트 단위** | 한 앱 복원 = 다른 앱도 롤백 | ADR-0020에 위험으로 문서화. **복구 전 상호 확인 필수**. (메디컬 합류 시 재검토 — `docs/STORAGE_R2_PROPOSAL.md`) |

## 6. 검증 레시피 (정직한 완료)

자동층: `npm run harness` — **`check-secret-leak`**(자격증명 형태 스캔·JWT payload 디코드로 role 판정)·**`check-schema-parity`**·`check-csp`

서버층(Supabase MCP):
- 공격검사 SQL을 `BEGIN … ROLLBACK`으로 실행 → 위 §4 항목 전부 통과
- `get_advisors` 신규 이슈 0
- 프로덕션 행 수·테스트 유저 무변경 확인

**정직한 경계**: 이 샌드박스는 `*.supabase.co`를 차단한다 → **앱 런타임 인증·동기화 왕복은 실기기 몫**. 서버 정책은 SQL로 검증되지만 "앱에서 로그인해 확인함"이라고 쓰지 말 것.

## 7. 변경 후 의무

- `changelog.ts` +0.01 · `researchLog.ts` · `docs/HANDOFF.md`(마이그레이션 번호·검증 결과) · 새 교훈은 **이 문서 §5에 행 추가**
- 정책·계약 자체가 바뀌면 `docs/SECURITY.md`·`docs/PRIVACY.md`를 갱신(그쪽이 정본)
- 되돌리기 경로를 기록한다(어떤 마이그레이션을 어떻게 무를지)

---

## Edge Function 규율 (2026-07-26 · media-sign v4에서 역산)

### 1. 권한 검증은 **역할을 흉내내서** 한다 — superuser는 다 통과한다

`journey.purged_ids`에 RLS는 있는데 **GRANT가 없어** 영구삭제가 사용자 브라우저에서만
실패했다(M-0020). 내가 superuser로 검증했기 때문이다. **하루에 두 번 같은 실수를 했다**(M-0024).

```sql
set local role authenticated;
set local request.jwt.claims = '{"sub":"<실제 uuid>","email":"<allowed_users에 있는 값>"}';
-- 여기서 실제로 SELECT/INSERT/UPDATE/DELETE를 돌린다
```
> 이걸 안 하면 **당신은 통과하고 사용자는 실패한다.** `check-migration-grants`가 정적으로도 막지만,
> 게이트는 코드를 보고 이건 **서버의 실제 응답**을 본다. 둘 다 필요하다.

### 2. 함수는 **자기 판(version)과 능력을 밝혀야** 한다

클라이언트가 새 응답 필드를 기대하는데 서버에 **옛 함수가 배포돼 있으면** 앱은 알 방법이 없어
`typeof d.x === 'number' ? d.x : 0` 같은 방어 코드를 쓰게 된다 — **그 순간 "0개"와 "모른다"가
구분되지 않는다.** 실제로 그렇게 짰다.

- `capabilities` op이 `{version, ops, serverTime}`을 준다(비밀 없음 → **인증 전에** 답한다.
  인증이 깨진 상황에서도 "서버 판이 낡았나"를 구분할 수 있어야 하므로).
- 클라이언트는 기대 판(`EXPECTED_FN_VERSION`)과 비교해 **화면에 「낡음」이라고 말한다.**
- `check-edge-fn-ops`가 `FN_OPS` 선언 ↔ 실제 `op ===` 분기를 **양방향** 대조한다
  (구현하고 선언 안 함 / 선언만 하고 구현 안 함 둘 다).

> **연산을 추가하면 `FN_OPS`와 `FN_VERSION`을 같은 커밋에서 올린다.** 안 올리면 화면이 낡음을 못 본다.

### 3. 삭제는 **되읽어** 확인한다 — 성공 응답은 완료가 아니다

`pushPurges`의 바이트 삭제가 "최선노력"이라 실패하면 `console.error`만 찍고 op을 지웠다.
재시도 기회가 영영 없고 실패가 어디에도 안 남아, 사용자는 콘솔을 직접 열어야 했다(M-0029).

- `deleteMany`는 지운 뒤 **목록을 다시 읽어** `stillThere`를 돌려준다. 못 읽었으면
  `verified: false` — **확인하지 못한 것을 성공으로 적지 않는다.**
- 조회 실패는 `0`이 아니라 **`known: false`**로 둔다(§8 모르는 것은 확인 불가).

### 4. 시야를 넓히되 **키는 돌려주지 않는다**

목록은 `prefix = 검증된 sub`로 고정이라 앱이 자기 폴더 밖을 못 본다. 그 한정을 말하지 않아
사용자가 콘솔을 반복해서 열었다. 해법은 경계를 허무는 게 아니라 **개수 하나**를 주는 것이다:

- `outside`(내 것이 아닌 최상위 폴더 + 최상위 파일 수) — **키는 응답에 안 담는다.**
- `multipart`(미완료 멀티파트 조각 수) — 객체 목록에도 대시보드에도 **안 보이면서 용량을 먹는다.**
  "다 지웠는데 왜 용량이 남지?"에 답할 수 있는 유일한 재료다.
- `abortMultipart`는 **내 폴더 아래 조각만** 중단한다(`key.startsWith(prefix)`가 방어선).

> 요청 본문의 `prefix`/`delimiter`/`bucket`은 **여전히 읽지 않는다.** 파싱해 두면 언젠가 쓰게 되고,
> 그 순간 버킷 전체가 열린다.

### 5. **불변식을 완화해야 할 때** — 무엇을 지키는 규칙인지부터 분리한다 (2026-07-27 · v5)

사용자가 *"폴더명은 여행 제목으로"*를 요구했다. 그런데 이 함수의 불변식 #2는 **"객체 키는
서버가 만든다 — 클라이언트는 mediaId만 보낸다"**였고, 함수는 여행 제목도 촬영시각도 모른다
(DB를 안 본다). 요구와 불변식이 정면으로 부딪혔다.

**잘못된 두 반응**: ① "보안 때문에 안 됩니다"로 끝낸다 ② 검증을 풀고 클라가 준 키를 그냥 쓴다.

**한 일 — 규칙을 두 조각으로 쪼갰다:**

| 조각 | 실제로 무엇을 지키나 | 판정 |
|---|---|---|
| 첫 칸이 **검증된 sub**다 | 남의 폴더 접근 차단 = **인가 그 자체** | 절대 못 놓는다 |
| 키 **전체**를 서버가 만든다 | 위를 달성하는 *한 가지 방법*일 뿐 | 대체 가능 |

그래서 첫 칸은 서버가 계속 붙이고, **안쪽 이름만** 앱에 넘기되 `safeRest()`로 모양을 못박았다
(깊이 2 이하 · `.`/`..` 금지 · 제어문자·백슬래시 금지 · `.webp`만). 남는 위험은 *"앱이 자기
폴더 안에서 틀린 이름을 쓴다"*뿐이고 **그건 보안이 아니라 정합의 문제**다 — 그쪽은 진단의
사진 대조가 잡는다.

> **완화한 만큼 다른 곳을 조인다.** 같은 커밋에서 `deleteMany`를 더 좁혔다: 예전엔 id로 키를
> 재구성해 지웠는데, 이제 **자기가 목록에서 본 키만** 지운다. 클라이언트가 준 문자열은 삭제
> 대상이 되지 않는다. 순 효과는 **완화가 아니라 강화**였다.

**자문 세 줄**:
1. 이 불변식이 막는 **구체적 공격**은 무엇인가? (막연히 "안전"이면 그건 불변식이 아니라 습관이다)
2. 그 공격을 막는 **다른 방법**이 있는가?
3. 완화한 대신 **어디를 조였는가?** 답이 없으면 순 손실이다.

### 6. 배포는 **순서와 되받기**가 계약이다 (2026-07-27)

**순서 — 계약을 넓히는 쪽을 먼저 배포한다.**
`media-sign` v5는 `path`와 `mediaId`를 **둘 다** 받고, 앱 v1.05는 `path`만 보낸다.

| 조합 | 결과 |
|---|---|
| 새 앱 + **옛 함수** | 함수가 `path`를 모른다 → `bad_media_id` → **업로드가 통째로 실패** |
| 옛 앱 + **새 함수** | 정상(새 함수가 옛 형식도 받는다) |

→ **함수 먼저, 앱 나중.** 그리고 서비스워커가 옛 앱을 잠시 살려 두므로 **새 함수는 한동안
옛 형식도 받아야 한다** — "옛 앱은 곧 사라진다"는 가정은 캐시 앞에서 틀린다.

**되받기 — 배포 응답을 믿지 않는다.**
이 파일은 **보안 경계 그 자체**이고 배포는 파일 전체를 옮겨 적는 일이라 조용히 깨질 수 있다.

```
① 저장소(GitHub)에 먼저 push       ← 바이트 정본을 만든다. 실패하면 여기서 복사해 붙인다
② 배포
③ get_edge_function 으로 되받아 대조 ← 200 응답이 아니라 **소스**를 본다
④ FN_VERSION / EXPECTED_FN_VERSION  ← 그래도 어긋나면 앱이 화면에서 말한다(런타임 층)
```

> ③이 없으면 "배포했다"까지만 알고 "무엇이 배포됐는지"는 모른다. 데이터 안전의 read-back과
> 같은 규율이다 — **성공 응답은 완료가 아니다.**

