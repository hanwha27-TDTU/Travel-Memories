# SECURITY · Bugeon Journey

설계지시서 §10·§11 + LESSONS §2. Bugeon Journey는 **다중 사용자**이므로 처음부터 소유자 범위 RLS로 간다. 선행 앱의 anon-write 호환 자세를 물려받지 않는다.

## 핵심 원칙: "RLS 켬 ≠ 격리"

실효 접근 = 다음의 **교집합**: Data-API 스키마 노출 + 테이블 grant(anon/authenticated) + RLS 역할/명령/`USING`/`WITH CHECK` 예측자 + 앱 인증·소유컬럼 + Edge Function 인증·사용 키 + Storage 버킷/공개URL 동작. **읽기전용 SQL로 grant·정책을 확인하고 Supabase security advisor를 돌린 뒤에만** "안전"이라 판단한다. 토글만 보고 결론 금지.

> advisor 경고를 계약 확인 전에 "고치지" 마라 — 의도된 자세일 수 있다.
>
> 🔴 **구체적 사례(2026-07-27).** advisor는 `journey.is_allowed()`·`journey.unpurge_ids()`·
> `journey.block_purged_reinsert()` 셋을 같은 이름의 경고(*"Signed-In Users Can Execute
> SECURITY DEFINER Function"*)로 묶어 내고, 권고문도 셋 다 *"Revoke EXECUTE"*로 같다.
> **그런데 처방은 정반대다:**
>
> | 함수 | 조치 | 회수하면 |
> |---|---|---|
> | `block_purged_reinsert()` | **회수함**(0018). 트리거로만 쓰인다 | 아무 일도 없다 — 트리거 발화는 EXECUTE를 검사하지 않는다(실증함) |
> | `unpurge_ids()` | **유지.** 앱의 복원 좁은 문 | 백업 복원이 서버 원장에 막혀 조용히 무효화된다(M-0032 재발) |
> | `is_allowed()` | **유지.** 정책 18개가 부른다 | 🔴 **RLS 정책 식은 호출자 권한으로 평가된다 → 앱이 자기 데이터를 못 읽는다** |
>
> 경고문이 같다고 조치가 같지 않다. **무엇이 그 함수를 부르는지**를 먼저 보라.

## 공통 RLS (모든 사용자 소유 테이블)

```
SELECT  : (select auth.uid()) = user_id
INSERT  : (select auth.uid()) = user_id  (WITH CHECK)
UPDATE  : USING(기존행.user_id = (select auth.uid())) WITH CHECK(새행.user_id = (select auth.uid()))
DELETE  : (select auth.uid()) = user_id
```

**`(select …)`로 감싸는 것이 계약이다**(0018부터, `check-migration-grants`가 강제). 맨
`auth.uid()`는 **행마다** 재평가되고, 뒤에 AND로 붙는 `journey.is_allowed()`는 테이블을
조회하는 함수라 사진 N장에 조회가 N번 붙는다. 둘 다 STABLE이므로 스칼라 서브쿼리로 감싸면
Postgres가 InitPlan으로 끌어올려 **질의당 1회**만 평가한다 — 술어의 뜻은 바뀌지 않고 평가
횟수만 바뀐다. (advisor `auth_rls_initplan`이 이 형태를 가리킨다.)

정책은 operation별로 분리하고 `TO authenticated`를 명시한다 — **명시가 계약이다.** 빠뜨리면
역할이 `public`이 되어 형제 정책과 어긋난다(0013·0015에서 실제로 6개가 그랬다. anon은
GRANT가 없고 `auth.uid()`가 NULL이라 실害는 없었지만, 이유 없는 비대칭은 결함처럼 보인다). 관계형 테이블(`trip_days`, `moments`, `trip_companions` 등)은 연결된 여행의 소유자도 함께 검증한다. RLS 미검증 테이블은 배포하지 않는다. DELETE는 앱 직접 hard delete를 금지하고 필요한 테이블만 제한한다(tombstone 경로 우선).

## 초대제 접근 잠금 (ADR-0021 — 공유 프로젝트 전역 로그인 보완)

Google 로그인은 공유 프로젝트에서 회계 앱과 전역 공용이라 아무 계정이나 로그인 가능하다. RLS가 사용자 간 데이터를 격리하지만, 개인 기억 앱은 한 겹 더 잠근다: **허용목록에 없는 사용자는 로그인해도 여행 데이터를 읽기/쓰기 불가**.

```
소유자 정책 = ((select auth.uid()) = user_id)  AND  (select journey.is_allowed())
journey.is_allowed() : SECURITY DEFINER, search_path='', JWT email 소문자 = allowed_users.email 존재?
journey.allowed_users : RLS on + 정책 없음 + grant 없음(클라이언트 직접 접근 불가, 함수로만 조회)
```
- 진짜 방어는 **DB(RLS)** 이고, 앱 게이트(`services/auth.ts` `isAllowedUser()` → `home.ts` 자동 로그아웃)는 UX용.
- **초대 추가**: `insert into journey.allowed_users(email) values ('someone@gmail.com');` · **다시 공개**: 정책에서 `and journey.is_allowed()` 제거(후속 migration). 데이터 손실 없음, 회계(`public`) 무영향.
- 검증(비공허): `supabase/tests/rls_invite_only_trips.sql` **INVITE_ONLY_PASS** — 비허용 조회 0·INSERT 차단·email 없는 세션 차단.

## 복합 소유자 FK = DB 계층 방어 (H-02)

RLS만으로 자식 row의 소유권을 보장하지 않는다. 자식 테이블은 `(parent_id, user_id)`가 부모 `(id, user_id)`를 참조하는 **복합 외래키**를 두어 다른 사용자의 부모 ID를 연결할 수 없게 한다(부모에 `UNIQUE(id, user_id)` 필요). 적용 대상·상세는 `docs/DATA_MODEL.md`. 이는 RLS 예측자를 **보완하는 DB 계층 방어**이며 RLS를 대체하지 않는다.

## RLS 완료조건 (H-12 — 정적 검사만으로 통과 금지)

RLS SQL 파일을 읽는 **정적 validator만으로 통과 처리하지 않는다**. 완료조건:

```text
- Supabase local stack 초기화 + migration을 빈 DB에 적용
- 모든 노출 사용자 테이블 RLS 활성 확인
- pgTAP으로 정책·제약·함수 검사
- 공격검사: 익명 클라이언트 · 사용자 A · 사용자 B · 위조 user_id
  · 다른 사용자의 부모 ID · Storage 경로 조작 · UPDATE 후 user_id 변경
  · soft-deleted 행 · view·RPC 권한
- Security Advisor + Performance Advisor 검토
```
view를 만들면 Postgres 버전과 `security_invoker` 설정을 확인해 RLS 우회를 막는다. `SECURITY DEFINER` RPC는 non-exposed private schema·고정 `search_path`·명시적 `auth.uid()` 검증·최소 권한을 적용하고, 가능하면 security invoker 경로를 우선한다.

## 키 관리 (H-13 — publishable/secret 키 체계)

Supabase 신규 키 체계를 채택한다. 브라우저에는 **publishable key만** 노출한다. **secret key와 legacy `service_role` 키는 클라이언트에서 금지**한다.

| 프론트엔드 허용 | 프론트엔드 금지 |
|------|------|
| Supabase URL, **publishable key**(legacy 호환 필요 시 anon key), 공개 지도 style/식별자 | **Supabase secret key**, **legacy service_role key**, DB 비밀번호, 관리자 JWT, 비공개 지도·AI·지오코딩 API 키 |

시크릿을 번들·저장소·로그·리포트에 넣지 않는다. **시크릿 스캔은 키워드가 아니라 자격증명 형태로.** 구현(`scripts/check-secret-leak.mjs`): git 추적 파일 전체(docs/ 제외 — 계약 문서는 차단 형태 자체를 서술함) + 빌드 산출물 대상, JWT는 payload 디코드로 role 판정(anon/publishable 허용), `postgres://` URL·`sb_secret_`/`sbp_` 접두어·Google API 키·PEM 개인키는 형태 패턴, `.env` 계열 추적 자체를 차단, 매 실행 알려진-실패 셀프테스트로 게이트 비공허성 증명(M-0004). **고엔트로피 일반 토큰 탐지는 미구현(후속)** — 새 제공자 키 도입 시 형태 패턴을 같은 커밋에서 추가한다. secret/`service_role` 키로 RLS 오류를 "고치지" 않는다.

## Storage 보안 (버킷 `travel-private`, 비공개)

경로: `travel-private/{user_id}/{trip_id}/{photos|thumbnails|originals|videos|audio}/{media_id}.<ext>`
파일명에 원본 파일명·사용자 이름·장소명·메모를 넣지 않는다.

정책: 인증 사용자만 · 경로 첫 구간 = `auth.uid()` · 자신 경로만 INSERT/SELECT/UPDATE/DELETE · 허용 버킷 외 접근 금지. 비공개 파일은 짧은 만료 Signed URL로 제공.

업로드 검증: 확장자만 믿지 않음 · MIME 검사 · 실제 디코딩 가능 여부 · 최대 파일크기·개수 · 비정상 폭/높이 · 빈 파일 차단 · 경로 서버규칙 일치.

## R2 바이트 저장소 — RLS가 없는 곳의 벽 (ADR-0024)

표시본 바이트를 Cloudflare R2로 옮길 때(`VITE_MEDIA_STORE=r2`), **R2에는 RLS가 없다**. 접근 통제가 DB에서 **토큰 스코프 + Edge Function**으로 이동한다.

| 벽 | 무엇이 지켜주나 | 무너지면 |
|---|---|---|
| **토큰 스코프** | 계정 API 토큰이 **버킷 하나**만 열도록 발급 | 옆 앱(메디컬) 버킷까지 열림 — "코드로 막았다"가 아니라 **열쇠가 안 맞아야** 한다 |
| **Edge Function `media-sign`** | 자격증명이 여기에만. 브라우저는 5분 서명 URL만 받음 | 브라우저에 자격증명이 내려가면 즉시 전면 유출 |
| **서버 생성 객체 키** | 폴더 = 검증된 JWT `sub`, 파일명 = UUID `mediaId`. 클라이언트가 보낸 key/path는 **무시** | 남의 폴더 덮어쓰기·경로 조작 |
| **자체 인증 확인** | 플랫폼 `verify_jwt`에 기대지 않고 매 요청 `/auth/v1/user` 확인 | verify_jwt가 꺼진 채 배포되면 `sub` 위조가 성립 |
| **읽기도 서명(정책 B)** | 버킷 비공개 유지. 공개 개발 URL·`R2_PUBLIC_BASE` **사용 안 함** | URL 유출 = 인증 없는 열람(원칙 #3 위반) |

삭제는 브라우저에 권한을 주지 않는다 — 함수가 서명하고 함수가 실행한다(DEL-CONTRACT 5단계와 동일 위치).
**기계가 못 보는 것**: 외부 콘솔의 실제 설정(버킷 공개 여부·CORS·토큰 범위)은 저장소에서 확인 불가 → 앱 내 R2 가이드의 **검증 사다리 3번(실기기 업로드)**을 릴리스 체크리스트의 사람 단계로 유지한다.

## 삭제 처리 (복구 가능성 우선 — DEL-CONTRACT)

동기화 엔티티 행은 **tombstone 전용**(하드 삭제 금지). Storage 바이트 삭제는 **사용자 확인 + tombstone 전파 후** 별도 단계이며, 고아 파일 스윕으로 정합한다.

1. 삭제 대상 자원 목록 생성 → 2. DB에 삭제 요청 상태 기록 → 3. 관계 데이터 행에 `deleted_at` tombstone 기록(**하드 삭제 아님**) → 4. tombstone 다기기 전파 확인 → 5. **사용자 확인 + tombstone 전파 후** Storage 바이트 삭제(별도 단계) → 6. 고아 파일 스윕으로 정합 → 7. 삭제 완료 기록.
**Storage 삭제 일부 실패해도 DB tombstone/기록을 먼저 완전히 없애지 않는다.** 상세 동기화 계약 `docs/SYNC_PROTOCOL.md`.

## 로그아웃·로컬 계정 경계 (H-14)

로그아웃 후 로컬 사용자 데이터 경계를 명확히 한다.

```text
- 로컬 행과 OPFS 경로를 user_id로 분리(user namespace 분리)
- 앱 시작 시 현재 세션 사용자와 로컬 namespace 일치 확인
- 로그아웃 즉시 이전 사용자 화면·메모리 캐시 잠금(lock)
- 로컬 미동기화 자료가 있으면 삭제 전 명시적 경고
- "로그아웃＋로컬 데이터 유지"와 "로그아웃＋이 장치에서 삭제"를 구분(keep/delete 선택)
- 다른 계정 로그인 후 이전 자료 표시 금지(계정 전환 격리)
```
MVP는 종단간 암호화를 약속하지 않는다. 잠금 해제된 기기·동일 origin XSS에 대한 로컬 데이터 보호 한계는 `docs/PRIVACY.md`에 명시한다.

## 백업 경계 (H-15 — DB backup ≠ Storage bytes)

**Supabase DB 백업은 Storage 객체 바이트를 포함하지 않는다**(R15). "JSON/DB 백업"을 사진까지 포함한 완전 백업이라 부르지 않는다. 미디어는 별도로 다뤄야 한다: manifest＋records＋파생 미디어＋checksum을 포함한 **전체 아카이브**(Phase 6)로 미디어 바이트를 별도 보존한다. 백업 설계는 DB 메타데이터와 Storage 객체를 각각 커버해야 한다.

## 운영 변경 게이트 (파괴적 prod 변경 전)

repo migration 아티팩트 → 영향 테이블/역할/동사/롤백/손실위험 명시 → 승인 → 1회 적용(적용된 migration 수정 금지) → grant·정책·행 read-back → security+performance advisor → 하네스. 파괴적 데이터 작업은 별도 확인.

## Hook / 게이트 후보 (지시문 아닌 강제)

`.claude/settings.json` 및 CI에 구현:
- `check-secret-leak` — 배포 아티팩트에서 자격증명 형태 스캔.
- `check-supabase-sql-safe` — 자동 적용 SQL의 `drop|delete from|truncate|update…set|alter…disable row level security|revoke` 차단.
- `check-rls-present` — 사용자 소유 테이블에 RLS·소유자 정책 존재 확인.
- `check-service-role-in-bundle` — 번들/프론트에 service_role/postgres URL 부재 확인.
- `check-no-hard-delete` — 동기화 엔티티에 하드 삭제(`delete from`) 부재 확인, 삭제는 `deleted_at` tombstone 경로만(DEL-CONTRACT).
- `check-exif-strip-on-share` — 공유·내보내기 산출물에서 EXIF GPS 제거/반올림 강제(내부 저장은 보존).
- `check-storage-immutable` — Storage 업로드가 `upsert:false`인지, 앱이 일반 UPDATE·MOVE 권한을 요구하지 않는지 확인(H-11).
- `check-exif-whitelist` — 저장 EXIF가 whitelist(§H-09)로 제한되고 MakerNote·일련번호 등이 포함되지 않는지 확인.
- `commit-msg` — 커밋 메시지 규약 + `[skip ci]` 류 우회 차단(가장 이른 지점).

## XSS / 입력 방어

사용자 입력을 `innerHTML`로 직접 삽입 금지. 자유 텍스트를 마크업 핸들러에 보간하지 않고 안정 id를 넘겨 핸들러 안에서 조회(MapLibre 팝업, EXIF 파생 캡션, 파일명 포함). 이스케이프 유틸이 여러 개면 컨텍스트 커버리지(HTML 속성/인라인 JS의 single-quote) 교차검증.
