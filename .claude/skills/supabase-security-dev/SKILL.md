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
3. **복합 FK로 소유권 방어(H-02)**: 자식 테이블은 `(parent_id, user_id) → parent(id, user_id)`. 단일 FK면 남의 부모에 자식을 붙일 수 있다.
4. **좀비 방지 트리거**: `prevent_zombie_resurrection` BEFORE UPDATE — tombstone은 **더 높은 version**으로만 부활한다(낮거나 같은 version의 활성 upsert는 거부). 클라이언트 병합 규율(`mergeDecision`)의 서버측 쌍둥이다.
5. **`SECURITY DEFINER` 함수는 `search_path=''` 고정**(권한 상승 경로 차단).
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
| 공유 프로젝트의 Google 로그인이 전역이라 아무 계정이나 자기 기록 생성 가능 | 인증(공유)과 인가(앱별)를 혼동 | `allowed_users` + `is_allowed()`를 **모든 정책에 결합**. 앱 게이트는 UX일 뿐, 진짜 방어는 DB |
| 클라가 서버에 없는 컬럼을 밀어 조용히 깨짐 | 클라↔서버 스키마 드리프트 | `check-schema-parity`(rowmap 필드 ⊆ 서버 컬럼) |
| `SECURITY DEFINER` 함수 search_path 경고 | 권한 상승 경로 | `search_path=''` 고정 |
| 사진 tombstone 후 Storage 객체가 고아로 남음 | 행 삭제와 바이트 삭제 시점 분리 | 소유자 폴더격리 DELETE 정책 + tombstone 반영 후 최선노력 스윕 |
| **새 테이블에 GRANT 누락 → 앱이 permission denied**(M-0020) | RLS와 GRANT를 같은 층으로 오인 + 검증을 superuser로 수행 | `check-migration-grants` 게이트(18번째) + §4에 "superuser 검증은 검증이 아니다" 명문화 |
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
