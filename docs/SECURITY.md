# SECURITY · Journey Archive

설계지시서 §10·§11 + LESSONS §2. Journey Archive는 **다중 사용자**이므로 처음부터 소유자 범위 RLS로 간다. 선행 앱의 anon-write 호환 자세를 물려받지 않는다.

## 핵심 원칙: "RLS 켬 ≠ 격리"

실효 접근 = 다음의 **교집합**: Data-API 스키마 노출 + 테이블 grant(anon/authenticated) + RLS 역할/명령/`USING`/`WITH CHECK` 예측자 + 앱 인증·소유컬럼 + Edge Function 인증·사용 키 + Storage 버킷/공개URL 동작. **읽기전용 SQL로 grant·정책을 확인하고 Supabase security advisor를 돌린 뒤에만** "안전"이라 판단한다. 토글만 보고 결론 금지.

> advisor 경고를 계약 확인 전에 "고치지" 마라 — 의도된 자세일 수 있다.

## 공통 RLS (모든 사용자 소유 테이블)

```
SELECT  : auth.uid() = user_id
INSERT  : auth.uid() = user_id  (WITH CHECK)
UPDATE  : USING(기존행.user_id = auth.uid()) WITH CHECK(새행.user_id = auth.uid())
DELETE  : auth.uid() = user_id
```
관계형 테이블(`trip_days`, `moments`, `trip_companions` 등)은 연결된 여행의 소유자도 함께 검증한다. RLS 미검증 테이블은 배포하지 않는다.

## 키 관리

| 프론트엔드 허용 | 프론트엔드 금지 |
|------|------|
| Supabase URL, publishable/anon key | service_role key, DB 비밀번호, 관리자 JWT, 비공개 외부 API 키 |

시크릿을 번들·저장소·로그·리포트에 넣지 않는다. **시크릿 스캔은 키워드가 아니라 자격증명 형태로**(JWT 디코드해 `service_role` 확인, `postgres://`·CDN 시크릿을 엔트로피로). `service_role` 키로 RLS 오류를 "고치지" 않는다.

## Storage 보안 (버킷 `travel-private`, 비공개)

경로: `travel-private/{user_id}/{trip_id}/{photos|thumbnails|originals|videos|audio}/{media_id}.<ext>`
파일명에 원본 파일명·사용자 이름·장소명·메모를 넣지 않는다.

정책: 인증 사용자만 · 경로 첫 구간 = `auth.uid()` · 자신 경로만 INSERT/SELECT/UPDATE/DELETE · 허용 버킷 외 접근 금지. 비공개 파일은 짧은 만료 Signed URL로 제공.

업로드 검증: 확장자만 믿지 않음 · MIME 검사 · 실제 디코딩 가능 여부 · 최대 파일크기·개수 · 비정상 폭/높이 · 빈 파일 차단 · 경로 서버규칙 일치.

## 삭제 처리 (복구 가능성 우선 — DEL-CONTRACT)

동기화 엔티티 행은 **tombstone 전용**(하드 삭제 금지). Storage 바이트 삭제는 **사용자 확인 + tombstone 전파 후** 별도 단계이며, 고아 파일 스윕으로 정합한다.

1. 삭제 대상 자원 목록 생성 → 2. DB에 삭제 요청 상태 기록 → 3. 관계 데이터 행에 `deleted_at` tombstone 기록(**하드 삭제 아님**) → 4. tombstone 다기기 전파 확인 → 5. **사용자 확인 + tombstone 전파 후** Storage 바이트 삭제(별도 단계) → 6. 고아 파일 스윕으로 정합 → 7. 삭제 완료 기록.
**Storage 삭제 일부 실패해도 DB tombstone/기록을 먼저 완전히 없애지 않는다.** 상세 동기화 계약 `docs/SYNC_PROTOCOL.md`.

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
- `commit-msg` — 커밋 메시지 규약 + `[skip ci]` 류 우회 차단(가장 이른 지점).

## XSS / 입력 방어

사용자 입력을 `innerHTML`로 직접 삽입 금지. 자유 텍스트를 마크업 핸들러에 보간하지 않고 안정 id를 넘겨 핸들러 안에서 조회(MapLibre 팝업, EXIF 파생 캡션, 파일명 포함). 이스케이프 유틸이 여러 개면 컨텍스트 커버리지(HTML 속성/인라인 JS의 single-quote) 교차검증.
