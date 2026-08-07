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

> 🔴 **상태: 아래 목록은 「목표 데이터 모델」이고 실제 구현은 10개다**(2026-08-02 실측 · D-03).
> 권위 순서상 코드가 이긴다 — `src/offline/db.ts`가 정본. **실제 store 10개**:
> `localTrips, localMoments, localMedia, localExpenses, localAudio(v7), localPlaces(v8),
> syncQueue, localFxRates(v5), purgedIds(v6), syncState(v9)`.
> 미구현(계획): `local_trip_days · local_companions · local_reflections · local_tags ·
> failed_operations · drafts · cached_thumbnails · app_state`(전부 미착수 — Phase 5·7).
> `localAudio·localFxRates·purgedIds`는 이후 Phase에서 실제로 추가됐는데 이 목록엔 없었다.

`local_trips, local_trip_days, local_moments, local_places, local_media, local_expenses, local_companions, local_reflections, local_tags, sync_queue, failed_operations, drafts, cached_thumbnails, app_state`.

> 조인 테이블(`trip_companions`, `moment_tags`)은 부모 도메인과 함께 동기화되어 별도 store가 없다(⛔ 명시적 제외). `companions`·`tags` 자체는 `local_companions`·`local_tags`로 동기화한다.

## 동기화 상태 머신

`local_only → queued → processing → compressing → ready_to_upload → uploading → metadata_saving → verifying → synced`
실패 상태: `retryable_failed · permanent_failed · conflict · cancelled`.

## 재시도 (지수 백오프)

1회 실패 → 5초 · 2회 → 15초 · 3회 → 60초 · 4회 → 5분 · 5회 이상 → 최대 15분 cap + 사용자 주의 표시. 각 대기에 jitter를 적용하고 서버 `Retry-After`를 우선한다.
  - **구현**: `sync/merge.ts`의 `retryDelayMs()`·`isRetryDue()`, 기록은 `SyncQueueItem.nextRetryAt`.
    2026-07-27까지 이 계약은 **문서에만 있었다** — `markFail`이 `attempts`를 증가만 시키고 아무도
    읽지 않아, 실패한 op이 `autoSync` 트리거(`online`·`visibilitychange`·5분 주기)마다 **즉시**
    재시도됐다. 사진 크기에서는 무해했지만 계약은 어긋나 있었다.
  - `Retry-After` 우선은 **아직 미구현**이다(서버가 아직 그 헤더를 주지 않는다). 구현하면 여기에 적는다.
네트워크 재연결·앱 재실행·수동 동기화가 **기본 복구경로**. Background Sync는 보조수단.

오류별 처리: 네트워크·408·429·5xx = 재시도 / 401 = 세션 갱신 1회 후 재시도 / 403 = 자동 반복 금지 / 409 = 충돌 흐름 / 413 = 영구 실패 또는 재압축 / 400·검증 실패 = 영구 실패(사용자 수정) / 취소 = 재시도 금지.

## 연결 감지 (C-04 — onLine은 UI 힌트만)

`navigator.onLine`은 **UI 힌트로만** 사용한다. LAN 연결이나 captive portal에서도 `true`일 수 있어 서버 접근을 보장하지 않는다. 실제 동기화 전에는 **짧은 timeout을 가진 Supabase probe**로 실제 연결을 확인한다. 저장 버튼은 온라인 여부로 비활성화하지 않는다(로컬 커밋은 항상 가능).

## 서버 쓰기·pull 모델 (C-07 — operation receipt + base_version + change sequence + conflict table)

> 🔴 **상태: 목표 프로토콜 대부분 미구현(2026-08-02 실측).** 이 절이 말하는
> `apply_client_operation` RPC · `client_operations` · `sync_changes`(단조 cursor) ·
> `sync_conflicts` · `deletion_jobs`는 **어느 적용된 마이그레이션에도 없다.** 사용자별
> `sync_meta.canonical_version`과 정확집합 RPC는 migration 0027에 구현되어 있다.
> **운영 실측(2026-08-03)은 0027까지 적용 완료**다. v1.58 클라이언트와 migration 0026은 첫 안전층을 구현한다:
> 직접 upsert에 `base_version` OCC를 걸고, `client_operation_id`+version(+바이트 경로)의 정확한
> read-back 뒤에만 큐를 제거한다. 충돌은 서버 승자를 로컬+큐에 원자 반영하거나 로컬을 서버
> version에 재기반화해 재시도한다. 사진·소리는 기존 R2 키를 먼저 덮지 않고 operation별 새 키에
> 격리하며, DB 승인 뒤에만 그 경로를 publish한다(M-0087). v1.60의 canonical 교체는 아래 별도 모드이며,
> change-log·receipt·conflict table은 여전히 후속이다.
> `SyncQueueItem.state`도 9단계 상태머신이 아니라 실사용
> **3개**(`local_only · retryable_failed · permanent_failed`)다. 아래는 서버 프로토콜을 갖추게
> 될 때의 목표 설계다 — 맥락 없이 들어온 AI는 이 RPC들이 이미 있다고 가정하지 말 것.

### 구현된 두 모드 (v1.60 · migration 0027 운영 적용 완료)

**일반 병합**
```text
runSync 시작 → ensure_sync_meta + 로컬 syncState 세대 대조
→ 같은 세대(또는 최초 legacy 기준선)면 repair/reconcile/push/pull
→ 로컬 전용 항목도 클라우드에 upsert해 다른 기기로 전파
```

**「이 기기 → 클라우드 최종본」 게시**
```text
두 단계 사용자 확인
→ 여섯 Dexie 표 + 큐 id + purged_ids를 한 transaction으로 캡처
→ 사진·소리를 operation별 불변 R2 staging 경로에 업로드
→ publish_canonical_snapshot(expected_version, next_version, operation_id, 전체 payload)
→ 서버 한 transaction: 사용자 정확집합 교체 + purged 원장 + sync_meta CAS
→ operation/meta read-back
→ 캡처 당시 큐만 제거 + 여섯 로컬 표의 baseCanonicalVersion 및 사진·소리 승인 경로 전진
→ 옛 R2 경로 최선노력 정리
```
네트워크 실패 시 `syncState.pendingCanonical`의 `uploading → publishing → read-back → local-commit`
단계에서 재개한다. RPC 응답 유실은 operation id read-back으로 성공을 확정한다. 캡처 뒤 로컬 사진·소리가
바뀌었으면 낡은 pending/staging을 폐기하고 **새 스냅샷으로 다시 시작**한다.

**다른 기기의 새 세대 소비**
```text
runSync의 어떤 로컬 repair/push보다 먼저 canonical_version 변경 감지
→ 서버 여섯 표(updated_at desc, 전체 페이지) + purged_ids(id 안정 정렬, 전체 페이지) 조회
→ 사진·소리 바이트를 전부 먼저 다운로드
→ 메타 세대를 다시 읽어 스냅샷 안정성 확인
→ 여섯 로컬 표 + 큐 + purged_ids + syncState를 한 Dexie transaction으로 정확 교체
→ 그 runSync는 pushed=0으로 즉시 종료(병합 결과 재업로드 금지)
```
첫 설치에서 메타가 `legacy`면 로컬을 지우지 않고 기준선만 찍는다. 반대로 로컬 상태가 없는데 서버가
이미 non-legacy면 새/오래된 기기로 보고 클라우드 최종본을 적용한다. canonical은 사용자가 명시적으로
선택한 파괴적 범위이므로 일반 모드의 빈-클라우드 가드를 적용하지 않는다. 대신 **모든 바이트 다운로드와
세대 재확인 전에는 로컬 교체를 시작하지 않는다.**

**앱 선배포 전환 경계(v1.63 · M-0093).** 서버 migration보다 앱을 먼저 배포하는 계약이면 새 RPC가
아직 없는 시간도 정상 전환 상태다. 다만 `ensure_sync_meta()`의 PostgREST `PGRST202`는 migration 미적용뿐
아니라 함수 signature/schema cache 지연일 수도 있다. 그래서 먼저 `sync_meta`를 owner RLS로 직접 SELECT한다.
실제 세대를 읽으면 canonical 경로를 계속하고, 표/capability까지 확인할 수 없으며 이 기기의 canonical 상태가
absent/`legacy`이고 `pendingCanonical`도 없을 때만 **서버 read-only pull**로 낮춘다. 이 실행은 로컬 큐를
보존하고 repair/backfill/reconcile, 모든 push, purge·unpurge 원장 변경, DB upsert/DELETE, media 고아
tombstone/R2 삭제를 전부 건너뛴다. 이미 non-legacy 세대를 소비했거나 게시가 미완료인 기기는 멈춘다.
권한·네트워크·빈 응답 등 다른 실패도 기능 미배포로 반올림하지 않는다. 운영 0026·0027은 2026-08-03에
암호화 스냅샷→0026/SQL 검사→0027/SQL 검사→행수·해시 read-back
순서로 적용했고, PC 라이브 동기화는 여행 5건·올림 0·내림 0으로 끝났다. 실제 2기기 canonical generation
왕복과 authenticated R2 PUT/GET/정리는 아직 별도 검증 대상이다. 첫 수정의 일반-sync fallback은
`pushUnpurges`·`pushPurges`·media 고아 스윕이 canonical CAS를 우회할 수 있어 재해복구 감사에서 출고 전 폐기했다.

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

### 현재 도메인 실행 계획 — 병렬이 기본, FK만 직렬

실행 계획의 코드 SSOT는 `src/services/syncPlan.ts`다. 일반 동기화의 single-flight는 유지하되,
한 실행 안에서 독립 도메인을 줄 세우지 않는다.

```text
push:  [여행 ∥ 장소]
          ↓ moments의 trip/place 복합 FK
       [순간]
          ↓ media/expenses/audio의 moment 복합 FK
       [사진 ∥ 비용 ∥ 소리]

pull:  [여행 ∥ 장소 ∥ 순간 ∥ 사진 ∥ 비용 ∥ 소리]
```

- `unpurge → entity push → purge → 원장 적용 → pull → 원본 정리 → 필요 시 후행 push`의 바깥
  상태 전이는 그대로 직렬이다. 앞 단계가 다음 단계의 허용 조건·입력·read-back 증거를 만들기 때문이다.
- pull 여섯 결과는 서로의 입력이 아니고 로컬/서버 FK 생성도 하지 않으므로 한 단계에서 시작한다.
- 단계 내부는 `Promise.allSettled`로 **모든 형제를 정산한 뒤** 실패한다. 한 형제의 조기 reject 뒤에
  다른 서버 쓰기가 계속되는 상태로 다음 실행을 열지 않는다.
- 도메인 내부의 큐 항목은 이 변경에서 병렬화하지 않는다. 같은 엔티티의 연속 operation과 R2
  업로드/read-back이 서로의 기준선을 사용하며, 무제한 동시 업로드는 모바일 메모리·대역폭 상한도
  아직 측정하지 않았기 때문이다.
- `check-sync-parallelism`과 `syncParallelism.test.ts`가 그룹·직렬 사유·시작/합류 순서를 잠근다.

## 불변식 (절대 위반 금지 — LESSONS §1)

1. **안정 id + created_at + updated_at + 서버 기준 version.** 동일 id의 쓰기는 마지막으로 본 `base_version`이 현재 서버 version과 일치할 때만 받는다(0026, 운영 적용 완료). 불일치면 행·서버시각을 바꾸지 않고 read-back으로 승자를 다시 판정한다. 같은 삭제 상태의 충돌은 정규화한 `updated_at` LWW, 삭제 상태 전이는 version으로 판정한다.
2. **하드 삭제 없음.** `deleted_at` tombstone. **fence는 활성 행에만** 적용, tombstone은 항상 병합까지 통과. `if (row.deletedAt) return false`를 타임스탬프 비교 **앞에** 둔다.
   - **좀비 절대 방지(ZOMBIE-GUARD, v0.29 구현 `src/sync/merge.ts`)**: 병합은 **version 기반 tombstone 우위**로 한다. 삭제상태가 다른 전이(활성↔tombstone)는 **오직 version으로만** 판정하고 **벽시계(`updated_at`)로는 부활시키지 않는다**(시계 스큐가 좀비의 근본원인). 활성 사본이 tombstone을 이기려면 **진짜 복원**(version이 tombstone보다 큼)이어야 하고, version 동률이면 **삭제가 이긴다**. 이 규칙은 **지연 pull·오래된 백업 복원**이 삭제된 데이터를 되살리지 못하게 잠근다. 적대적 유닛(`tests/unit/merge.test.ts` — 옛 시각-우선 로직 주입 시 RED)으로 비공허 검증. 서버는 기존 `prevent_zombie_resurrection`과 운영 적용된 0026 OCC guard가 같은 규칙을 지킨다.
3. **두 동기화 모드를 절대 섞지 않는다.** ① 일반 병합 동기화(`canonical_version` 일치 후 LWW 병합·로컬 전용 전파) ② 카노니컬 정확집합 교체(이 기기를 새 기준선으로 선언하거나 새 기준선을 소비). 세대 변경을 소비한 실행은 어떤 upsert도 하지 않는다.
4. **빈-클라우드 가드.** 클라우드가 0행(로컬엔 데이터)이면 이상 상황 — `_cloudEmptyAnomaly` 뒤에서만 로컬 교체. 절대 자동 wipe 금지.
5. **정확한 read-back으로 확인.** HTTP 200 / 성공 토스트 / upsert 표현 / 후속 집계 동기화는 확인이 아니다. 같은 레코드를 되읽어 **내 `client_operation_id` + 서버 version**이 확인된 뒤에만 큐를 제거한다. 사진·소리는 storage path도 같아야 한다. 부분 필드(제목·금액·좌표) 하나만 같은 것은 내 쓰기가 착지했다는 증거가 아니다.
   - **외부 바이트도 같은 조건부 쓰기다(M-0087).** DB OCC보다 R2 PUT이 먼저이므로 기존 `storagePath`에 덮어쓰지 않는다. operation별 불변 키에 올리고 read-back이 그 path를 승인하면 로컬 경로를 전진·옛 키 정리, 거절이면 새 작업 키만 정리한다. 삭제 실패는 기억 손실보다 고아 사본을 택한다.
6. **부분 슬라이스를 전체집합 판단에 넣지 않는다.** 삭제/부재/전체교체 판단은 완전한 id 집합 필요. 멤버십(`select=id`, 저렴)과 내용(`select=* where updated_at≥wm`)을 분리 조회. 델타 슬라이스만 넣으면 오래된 로컬 행이 "클라우드에 없음"으로 유실.
7. **`false`/`null` 과적재 금지.** "실패"와 "무해한 무변경/대기"에 같은 값 반환 금지 — 구분된 센티넬/객체(`'held'` 등). 특히 상태 UI 연결 함수.
8. **쓰기 능력 ↔ 동기화 자세 일치.** 로컬 변형 가능 도메인은 (1) 실제 업로드 경로 + (2) 병합(교체 아님) 새로고침을 **함께** 갖는다. 하나만 두면 다음 새로고침이 로컬을 덮어쓴다.
9. **파이프라인 행(`source=pipeline`)은 소비 기기에서 읽기전용.** 로컬 부재 = "이 기기가 오래됨"이지 "사용자 삭제" 아님. 로컬 부재로 tombstone 금지.
10. **카노니컬 저장 = 재개 가능한 두 트랜잭션+read-back.** Dexie `pendingCanonical`에 전체 메타 스냅샷·캡처 큐 id·단계(uploading/publishing/read-back/local-commit)를 기록한다. 서버는 `publish_canonical_snapshot` 한 transaction으로 정확집합+메타를 전진한다. operation/meta read-back 뒤에만 로컬 세대·큐를 전진시키며, 각 단계의 실패는 재개하거나 staging을 폐기한다.

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
