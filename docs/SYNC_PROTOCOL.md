# SYNC PROTOCOL · Journey Archive

오프라인 우선 동기화 계약. **최고 위험·비가역 표면.** 동기화 코드를 쓰기 전에 이 계약을 확정하고 신성하게 다룬다. (설계지시서 §12 + LESSONS §1)

## 오프라인 우선 원칙

저장 버튼 → **IndexedDB(Dexie) 로컬 저장 → 즉시 저장 완료 표시 → 동기화 대기열 등록 → 네트워크 가능 시 Supabase 반영.** 오프라인 기록은 서버 연결 실패로 유실되면 안 된다.

## 로컬 저장소 (Dexie)

`local_trips, local_trip_days, local_moments, local_places, local_media, local_expenses, local_companions, local_reflections, local_tags, sync_queue, failed_operations, drafts, cached_thumbnails, app_state`.

> 조인 테이블(`trip_companions`, `moment_tags`)은 부모 도메인과 함께 동기화되어 별도 store가 없다(⛔ 명시적 제외). `companions`·`tags` 자체는 `local_companions`·`local_tags`로 동기화한다.

## 동기화 상태 머신

`local_only → queued → processing → compressing → ready_to_upload → uploading → metadata_saving → verifying → synced`
실패 상태: `retryable_failed · permanent_failed · conflict · cancelled`.

## 재시도 (지수 백오프)

1회 실패 → 5초 · 2회 → 15초 · 3회 → 60초 · 4회 → 5분 · 5회 이상 → 사용자 확인 대기.
네트워크 재연결·앱 재실행·수동 동기화가 **기본 복구경로**. Background Sync는 보조수단.

## 불변식 (절대 위반 금지 — LESSONS §1)

1. **안정 id + created_at + updated_at.** 동일 id 충돌은 LWW(최신 `updated_at` 우선), 단 서버 시각 read-back으로 반영해 빠른 클라이언트 시계가 다른 기기의 최신 편집을 덮지 않게 한다.
2. **하드 삭제 없음.** `deleted_at` tombstone. **fence는 활성 행에만** 적용, tombstone은 항상 병합까지 통과. `if (row.deletedAt) return false`를 타임스탬프 비교 **앞에** 둔다.
3. **두 동기화 모드를 절대 섞지 않는다.** ① 일반 병합 동기화(`canonical_version` 읽고 LWW 병합) ② 카노니컬 교체(이 기기를 새 기준선으로 선언). 혼합은 다른 기기를 오염시킨다.
4. **빈-클라우드 가드.** 클라우드가 0행(로컬엔 데이터)이면 이상 상황 — `_cloudEmptyAnomaly` 뒤에서만 로컬 교체. 절대 자동 wipe 금지.
5. **정확한 read-back으로 확인.** HTTP 200 / 성공 토스트 / upsert 표현 / 후속 집계 동기화는 확인이 아니다. 같은 레코드를 되읽어 count+payload 일치 확인 후에만 완료 전진. 모든 도메인의 쓰기+read-back 성공 후에만 성공 토스트.
6. **부분 슬라이스를 전체집합 판단에 넣지 않는다.** 삭제/부재/전체교체 판단은 완전한 id 집합 필요. 멤버십(`select=id`, 저렴)과 내용(`select=* where updated_at≥wm`)을 분리 조회. 델타 슬라이스만 넣으면 오래된 로컬 행이 "클라우드에 없음"으로 유실.
7. **`false`/`null` 과적재 금지.** "실패"와 "무해한 무변경/대기"에 같은 값 반환 금지 — 구분된 센티넬/객체(`'held'` 등). 특히 상태 UI 연결 함수.
8. **쓰기 능력 ↔ 동기화 자세 일치.** 로컬 변형 가능 도메인은 (1) 실제 업로드 경로 + (2) 병합(교체 아님) 새로고침을 **함께** 갖는다. 하나만 두면 다음 새로고침이 로컬을 덮어쓴다.
9. **파이프라인 행(`source=pipeline`)은 소비 기기에서 읽기전용.** 로컬 부재 = "이 기기가 오래됨"이지 "사용자 삭제" 아님. 로컬 부재로 tombstone 금지.
10. **카노니컬 저장 = 재개 가능 트랜잭션.** `pendingCanonicalVersion` + 단계(uploading/read-back/meta-saving) 기록. 데이터 쓰기 **및** 정확한 read-back 후에만 카노니컬 전진. 각 단계에 네트워크 실패를 주입해 거짓 완료가 없음을 증명.

## 충돌 해결 (§12.4)

| 데이터 | 처리 |
|--------|------|
| 사진 | 불변 파일, 중복검사 |
| 비용 | 버전 비교, 충돌 시 사용자 선택 |
| 사용자 메모 | 양쪽 보존 + 병합 화면 |
| 감정·별점 | 마지막 명시적 수정 우선 |
| 장소 | 좌표와 장소명 별도 비교 |
| 삭제 | tombstone이 일반 수정보다 우선하되 복원 가능 |
| AI 결과 | 재생성 가능 — 사용자 원문보다 우선하지 않음 |

> **삭제 계약(DEL-CONTRACT)**: 동기화 엔티티 행은 **tombstone 전용**(`deleted_at`, 하드 삭제 금지). Storage 바이트 삭제는 **사용자 확인 + tombstone 전파 후** 별도 단계이며, 고아 파일 스윕으로 정합한다. 상세 `docs/SECURITY.md` 삭제 처리.

## Egress 최적화 (fail-safe)

"불확실하면 전체 pull." 무변경 스킵 프로브는 `max(updated_at)+count` 서명이 클라우드·로컬 정확히 일치할 때만 스킵. 스킵 로직을 위해 테이블을 중앙 열거하지 않는다(신규 도메인이 조용히 누락).

## 검증 (TEST_PLAN 연계)

오프라인 생성·수정, 재연결 자동 동기화, 동일 작업 재전송(멱등), 두 기기 동일 메모 수정, 한 기기 삭제/다른 기기 수정, 일부만 업로드 성공, DB 성공 후 파일 실패, 파일 성공 후 DB 실패 — 모두 브라우저 왕복 테스트로 데이터/tombstone/read-back을 단언한다.

명명된 동기화 게이트 후보(Phase 0에서 활성화 예정 — 현재는 계약 명세, 활성 주장 아님): `check-empty-cloud-guard`(빈-클라우드 가드), `check-no-delta-in-fullset-decision`(부분 슬라이스로 전체집합 판단 금지), `check-no-hard-delete`(tombstone 전용, 하드 삭제 금지), `check-readback-before-success`(정확한 read-back 후에만 완료 전진).
