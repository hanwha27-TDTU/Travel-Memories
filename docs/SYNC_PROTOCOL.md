# SYNC PROTOCOL · Bugeon Journey

오프라인 우선 동기화 계약. **최고 위험·비가역 표면.** 동기화 코드를 쓰기 전에 이 계약을 확정하고 신성하게 다룬다. (설계지시서 §12 + LESSONS §1)

## 오프라인 우선 원칙

저장 버튼 → **Dexie entity＋operation atomic commit(내구성 로컬 커밋) → 즉시 저장 완료 표시 → 동기화 대기열 등록 → 네트워크 가능 시 Supabase 반영.** 오프라인 기록은 서버 연결 실패로 유실되면 안 된다.

### 내구성 범위 (C-01 — "유실 0건"의 정확한 한정)

절대 표현 "오프라인 기록 유실 0건"을 쓰지 않는다. 정확한 계약은 **"내구성 로컬 커밋(Dexie entity＋operation atomic commit) 이후 앱 원인 유실 0건"**이다.

- 브라우저 origin 저장소에는 quota와 **eviction(축출)** 정책이 있고, 사용자가 사이트 데이터를 지우면 IndexedDB·OPFS도 삭제될 수 있다(best-effort 저장소는 축출될 수 있음 — MDN Storage quotas and eviction criteria).
- `navigator.storage.persist()`를 가능한 환경에서 요청하되 **브라우저가 거부할 수 있으며**, 그 결과(persisted 여부)를 과장 없이 표시한다. 대량 선택 전 `navigator.storage.estimate()`로 여유를 확인한다.
- 사이트 데이터 삭제·브라우저 축출·기기 분실은 앱이 통제할 수 없는 손실이므로 **메타데이터 백업을 권장**하고 그 위험을 사용자에게 안내한다.
- 앱이 닫히기 전까지 브라우저가 들고 있는 원본 `File` 참조만 있는 항목은 내구성 저장이 아니다(미디어 `selected_non_durable`). 이 상태를 저장 완료로 표시하지 않는다.

## 로컬 저장소 (Dexie)

`local_trips, local_trip_days, local_moments, local_places, local_media, local_expenses, local_companions, local_reflections, local_tags, sync_queue, failed_operations, drafts, cached_thumbnails, app_state`.

> 조인 테이블(`trip_companions`, `moment_tags`)은 부모 도메인과 함께 동기화되어 별도 store가 없다(⛔ 명시적 제외). `companions`·`tags` 자체는 `local_companions`·`local_tags`로 동기화한다.

## 동기화 상태 머신

`local_only → queued → processing → compressing → ready_to_upload → uploading → metadata_saving → verifying → synced`
실패 상태: `retryable_failed · permanent_failed · conflict · cancelled`.

## 재시도 (지수 백오프)

1회 실패 → 5초 · 2회 → 15초 · 3회 → 60초 · 4회 → 5분 · 5회 이상 → 최대 15분 cap + 사용자 주의 표시. 각 대기에 jitter를 적용하고 서버 `Retry-After`를 우선한다.
네트워크 재연결·앱 재실행·수동 동기화가 **기본 복구경로**. Background Sync는 보조수단.

오류별 처리: 네트워크·408·429·5xx = 재시도 / 401 = 세션 갱신 1회 후 재시도 / 403 = 자동 반복 금지 / 409 = 충돌 흐름 / 413 = 영구 실패 또는 재압축 / 400·검증 실패 = 영구 실패(사용자 수정) / 취소 = 재시도 금지.

## 연결 감지 (C-04 — onLine은 UI 힌트만)

`navigator.onLine`은 **UI 힌트로만** 사용한다. LAN 연결이나 captive portal에서도 `true`일 수 있어 서버 접근을 보장하지 않는다. 실제 동기화 전에는 **짧은 timeout을 가진 Supabase probe**로 실제 연결을 확인한다. 저장 버튼은 온라인 여부로 비활성화하지 않는다(로컬 커밋은 항상 가능).

## 서버 쓰기·pull 모델 (C-07 — operation receipt + base_version + change sequence + conflict table)

`updated_at`만으로 덮어쓰기 순서를 결정하지 않는다. 모든 앱 쓰기는 `operation_id`, `entity_id`, `base_version`을 가진다.

**서버 쓰기 (apply_client_operation)**
```text
클라이언트 operation 생성
→ 로컬 커밋
→ 서버 apply_client_operation 호출
→ 이미 처리된 operation이면 저장된 결과 반환(operation receipt · 멱등)
→ 현재 version과 base_version 비교
→ 일치하면 같은 DB transaction에서 행 갱신 + version 증가 + client_operations·sync_changes 기록
→ 불일치하면 conflict 반환 → sync_conflicts에 스냅샷 기록
```

**서버 pull (단조 cursor)**
```text
마지막 sync cursor 읽기
→ sync_changes에서 sequence > last_cursor 페이지 조회
→ 각 변경 엔티티 fetch 또는 tombstone 적용
→ 로컬 transaction 커밋
→ 성공한 마지막 sequence를 cursor로 저장
```
테이블별 `updated_at` 추측 대신 **`sync_changes.sequence` 단조 cursor**로 페이지를 받는다. 커서가 서버 보존범위보다 오래되면 전체 재동기화. 관련 테이블: `client_operations`(operation receipt·`base_version`), `sync_changes`(단조 변경 피드), `sync_conflicts`(충돌 스냅샷 — 로그 금지). 상세 스키마 `docs/DATA_MODEL.md`.

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

> **삭제 계약(DEL-CONTRACT)**: 동기화 엔티티 행은 **tombstone 전용**(`deleted_at`, 하드 삭제 금지). Storage 바이트 삭제는 **사용자 확인 + tombstone 전파 후** 별도 단계이며, 고아 파일 스윕으로 정합한다. 상세 `docs/SECURITY.md` 삭제 처리. 아래 상태 흐름은 이 계약을 **정련(refine)**한 것으로 서로 일관해야 한다.

## 상태 흐름 (MASTER_SPEC §5·§15 — 기록·미디어·삭제)

### 기록 동기화
```text
사용자 저장
→ Dexie entity＋operation atomic commit (local_committed)
→ 로컬 저장 완료
→ queued → processing
→ server apply_client_operation
→ applied → change sequence(sync_changes) 기록
→ pull cursor 반영 → synced
실패: retryable_failed · permanent_failed · conflict · cancelled · tombstoned
```

### 미디어 쓰기 (C-09 — DB·Storage 상태머신)
DB와 Storage를 하나의 transaction처럼 취급하지 않는다. orphan(파일만 또는 DB row만)을 막는 순서:
```text
selected_non_durable
→ (quota preflight) staged
→ EXIF·orientation·decode → derived_ready
→ pending DB 행(media_assets.server_state=pending)
→ 불변 Storage 경로 immutable upload (upsert:false)
→ 원격 존재·크기·MIME verify (uploaded)
→ finalize (server_state=verified · synced)
```
파일 업로드만 성공하고 DB 완료가 실패하면 **pending 행과 동일 operation으로 재개**한다. DB pending 생성이 실패하면 업로드하지 않는다. (상세 `docs/MEDIA_PIPELINE.md`)

### 삭제 (C-08/C-09 — 복원 가능 → 영구삭제)
```text
휴지통 tombstone(deleted_at 기록) → 동기화 → 복원 가능
→ 사용자의 별도 영구 삭제 확인
→ deletion_jobs manifest 고정(삭제 대상 DB 행·Storage 경로 열거)
→ Storage delete → 항목별 결과 기록 → 남은 객체 재검사(verify)
→ DB finalize(관계 행 정리) → sync_changes 기록 → completed
```
일반 삭제는 즉시 Storage를 제거하지 않는다(휴지통 tombstone, 복원 가능). 일부 Storage 삭제가 실패하면 **DB 식별정보를 먼저 완전히 제거하지 않는다**. 삭제 재시도는 **동일 `deletion_jobs`**로 수행한다.

## Egress 최적화 (fail-safe)

"불확실하면 전체 pull." 무변경 스킵 프로브는 `max(updated_at)+count` 서명이 클라우드·로컬 정확히 일치할 때만 스킵. 스킵 로직을 위해 테이블을 중앙 열거하지 않는다(신규 도메인이 조용히 누락).

## 검증 (TEST_PLAN 연계)

오프라인 생성·수정, 재연결 자동 동기화, 동일 작업 재전송(멱등), 두 기기 동일 메모 수정, 한 기기 삭제/다른 기기 수정, 일부만 업로드 성공, DB 성공 후 파일 실패, 파일 성공 후 DB 실패 — 모두 브라우저 왕복 테스트로 데이터/tombstone/read-back을 단언한다.

명명된 동기화 게이트 후보(Phase 0에서 활성화 예정 — 현재는 계약 명세, 활성 주장 아님): `check-empty-cloud-guard`(빈-클라우드 가드), `check-no-delta-in-fullset-decision`(부분 슬라이스로 전체집합 판단 금지), `check-no-hard-delete`(tombstone 전용, 하드 삭제 금지), `check-readback-before-success`(정확한 read-back 후에만 완료 전진).
