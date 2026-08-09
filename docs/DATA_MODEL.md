---
shape: prose-debt
---
# DATA MODEL · Bugeon Journey

설계지시서 §8 + MASTER_SPEC_v0.2 §10~§12 기준.

> 🔴 **이 문서는 「목표 데이터 모델」이다 — 실제 배포 스키마는 `supabase/migrations/*.sql`이 정본**
> (2026-08-01 감사 · D-09·D-17). 권위 순서상 코드/마이그레이션이 이긴다. 목표와 실제의 차이:
> - **구현된 사용자 테이블(운영·저장소 migration 0029까지)**: `trips · moments · media · expenses ·
>   audio(0019) · places(0022) · purged_ids(0012) · allowed_users`. 0026은 `base_version` OCC,
>   0027은 `sync_meta`와 여섯 표의 `base_canonical_version`, 0028은 FK 커버링 인덱스,
>   0029는 `media.sort_order`(한 순간 안에서 사용자가 정한 사진 자리 — NULL은 「아직 안 정함」)를 추가한다.
> - **미구현(목표만)**: `trip_days · companions · trip_companions · reflections · tags ·
>   moment_tags · ai_artifacts(Phase 7) · user_devices · client_operations · sync_changes ·
>   sync_conflicts · deletion_jobs`. AI·확장 도메인은 `blueprint.ts`가 `implemented:false`로
>   정직하게 추적하고 설계 개요 화면에 로드맵으로 표시한다.
> - **`media`의 실제 컬럼**은 아래 표보다 좁다 — `exif_whitelist` jsonb는 **없다**(D-09).
>   대신 `gps_lat·gps_lng`(0024)·`taken_at` 개별 컬럼만 서버로 간다(whitelist 목적은 결과적으로
>   더 보수적으로 달성 — EXIF JSON을 아예 안 올린다). `expenses`의 환율 열(H-04)도 nullable
>   미구현(`db.ts:113`에 근거 기재 — 로컬 MVP는 원금액만 저장).

## 공통 열 (H-01 — 모든 사용자 소유 가변 테이블)

모든 사용자 소유 가변 테이블은 다음 공통 열을 갖는다. 원칙과 실제 schema가 어긋나지 않도록 예외를 명시한다.

| 열 | 형식 | 규칙 |
|------|------|------|
| id | uuid | 오프라인 생성을 위해 클라이언트 생성 허용 |
| user_id | uuid | `auth.users.id`, not null |
| created_at | timestamptz | 서버 기본값, 클라이언트 임의 변경 금지 |
| updated_at | timestamptz | 서버 트리거 관리 |
| version | bigint | 1부터 시작, 서버에서 증가 |
| deleted_at | timestamptz | tombstone, nullable |
| updated_by_device_id | uuid | 동기화 메타데이터, 인증수단 아님 |
| last_operation_id | uuid | 마지막 성공 클라이언트 operation |

`deleted_at`은 여러 기기 동기화 완료 전까지 삭제 사실을 전달하는 **tombstone**이다. 클라이언트는 `created_at`/`updated_at`/`version`을 신뢰원으로 제공하지 않는다. UPDATE 트리거는 `user_id` 변경을 차단하고 `updated_at`·`version`을 설정한다.

여섯 동기화 표는 `base_canonical_version text not null default 'legacy'`도 가진다
(migration 0027, 운영 적용). 이는 사용자 내용이 아니라 **마지막으로 본 최종본 세대**이며,
authenticated 직접 쓰기가 다른 세대의 정확집합을 오염시키지 못하게 하는 fence다.

**예외**: `profiles`(1:1, `deleted_at` 대신 `account_state`, `updated_by_device_id`/`last_operation_id` 없음), `client_operations`·`sync_changes`·`sync_conflicts`·`deletion_jobs`·`user_devices`(동기화 제어/원장 계열 — 공통 열 대신 각자 상태·시퀀스 열).

### sync_meta (migration 0027 · 운영 적용)

사용자당 한 행(`UNIQUE(user_id)`)인 동기화 제어 테이블이다. `canonical_version`(text),
`canonical_operation_id`(uuid, nullable), `canonical_device_id`(text, nullable), `created_at`, `updated_at`을
가진다. 앱은 SELECT만 가능하고 메타 생성/전진은 좁은 SECURITY DEFINER RPC만 수행한다.
백업 대상이 아니며, 로컬 대응 store `syncState`도 사용자 기억이 아니라 재개·세대 감지용 제어 상태라
내보내기/복원에서 명시적으로 제외한다.

## 복합 소유자 FK (H-02)

자식 테이블은 단순 `parent_id` FK만 두지 않는다. 가능한 경우 `(parent_id, user_id)`가 부모 `(id, user_id)`를 참조하는 **복합 외래키**를 사용하여 다른 사용자의 부모 ID를 연결할 수 없게 한다. 이를 위해 부모에 `UNIQUE(id, user_id)`를 둔다. 적용 대상: `trip_days`, `moments`, `expenses`, `media_assets`, `reflections`, `trip_companions`, `moment_tags`. 이는 RLS를 보완하는 **DB 계층 방어**다(`docs/SECURITY.md` H-02).

## 부분 고유 인덱스 (H-03 — soft delete와 고유성)

soft delete가 있는 고유조건은 일반 고유제약이 아니라 **활성 행 기준 부분 고유 인덱스**를 사용한다.

```sql
create unique index trip_days_unique_active
on trip_days (trip_id, local_date)
where deleted_at is null;
```

같은 패턴을 다른 soft-delete 고유성에도 적용한다: `tags`(사용자별 `normalized_name`), `moment_tags`(활성 `moment_id`+`tag_id`), `trip_companions`(활성 `trip_id`+`companion_id`).

> **DOMAIN_REGISTRY (대칭성 SSOT)** — 아래 엔티티는 모두 형제다. 각 도메인 × 생명주기 노드(normalize·dedupe·toRow·fromRow·merge·hash·trash·sync·export)는 연결(✅)이거나 파생된 사유의 명시적 제외(⛔)여야 하며, 침묵 공백은 대칭 위반(❌)이다. 신규 엔티티는 레지스트리에 등록하고 모든 노드를 배선하거나 게이트로 강제(Phase 0 예정)한다. (LESSONS §3)

엔티티: `profiles`, `trips`, `trip_days`, `moments`, `places`, `media_assets`, `expenses`, `companions`, `trip_companions`, `reflections`, `tags`, `moment_tags`, `client_operations`, `user_devices`, `sync_changes`, `sync_conflicts`, `deletion_jobs`, `ai_artifacts`.

⛔ 제외: `profiles`(사용자 1:1 프로필, 도메인 아님), `client_operations`(멱등성 원장), `trip_companions`/`moment_tags`(조인 테이블 — 부모와 함께 동기화), `user_devices`(장치 표식 — 동기화 제어), `sync_changes`(단조 변경 피드/pull cursor 원장), `sync_conflicts`(충돌 스냅샷 원장), `deletion_jobs`(영구삭제 상태머신 원장), `ai_artifacts`(Phase 7 — AI provenance, MVP 미생성). 전체 대칭 매트릭스(엔티티×생명주기 노드)는 Phase 0에서 `DOMAIN_REGISTRY` SSOT로 생성한다.

순간 중심 구조: `Trip → TripDay → Moment → (Media / Place / Expense / Companion / Reflection)`.

---

## profiles
| 필드 | 형식 | 설명 |
|------|------|------|
| id | uuid | `auth.users.id`와 동일 |
| display_name | text | 표시 이름 |
| locale | text | 기본 언어 |
| timezone | text | 기본 시간대 |
| settings | jsonb | 사용자 설정 |
| created_at / updated_at | timestamptz | |

## trips
| 필드 | 형식 | 설명 |
|------|------|------|
| id | uuid | 여행 ID |
| user_id | uuid | 소유자 |
| title | text | 여행명 |
| start_date / end_date | date | 기간 |
| status | text | planned · active · completed · archived |
| country_codes | text[] | 국가 코드 |
| cities | text[] | 도시 |
| summary | text | 사용자 작성 요약 |
| cover_media_id | uuid | 대표사진 |
| budget_amount | numeric | 예산 |
| budget_currency | text | 예산 통화 |
| version | integer | 동기화 버전 |
| created_at / updated_at / deleted_at | timestamptz | |

## trip_days
`(trip_id, local_date) WHERE deleted_at IS NULL`은 고유 (H-03 부분 고유 인덱스).
| 필드 | 형식 | 설명 |
|------|------|------|
| id | uuid | |
| user_id / trip_id | uuid | |
| local_date | date | 현지 날짜 |
| representative_timezone | text | 해당 날짜 대표 IANA 시간대, nullable |
| title | text | 하루 제목 |
| user_summary | text | **사용자 원문** |
| 공통 열 | | id·user_id·created_at·updated_at·version·deleted_at·updated_by_device_id·last_operation_id |

> AI 요약은 이 테이블에 직접 쓰지 않고 `ai_artifacts`(Phase 7)에 저장한다.

## moments
| 필드 | 형식 | 설명 |
|------|------|------|
| id | uuid | |
| user_id / trip_id | uuid | |
| trip_day_id | uuid | nullable |
| place_id | uuid | 대표 장소, nullable |
| occurred_local | timestamp without time zone | **사용자에게 보이는 현지 원시시각** (C-10) |
| occurred_at | timestamptz | **신뢰 가능한 UTC 환산이 있을 때만** (nullable) |
| utc_offset_minutes | smallint | 알려진 오프셋 |
| timezone | text | IANA 시간대 후보 |
| time_source | text | manual · exif · file · current_location · inferred |
| time_confidence | text | exact · offset_known · timezone_inferred · local_only |
| title | text | 순간 제목 |
| user_note | text | **사용자 원문** |
| emotion_score | smallint | 1~5 |
| is_highlight | boolean | 대표 기억 |
| source | text | manual · photo_import · location |
| 공통 열 | | id·user_id·created_at·updated_at·version·deleted_at·updated_by_device_id·last_operation_id |

> **C-10 시간 정책**: 단일 `captured_at`/`occurred_at timestamptz`로 확정하지 않는다. `occurred_at`이 null이어도 `occurred_local`로 기록을 보존한다. 타임라인 정렬은 확정 UTC와 현지 원시시각을 구분한다. AI 요약은 이 테이블에 쓰지 않고 `ai_artifacts`(Phase 7)에 저장한다.

> **장소 링크 이름 계약(ADR-0053)**: `place_id`가 있으면 순간의 장소 표시명과 `places.name`은
> 한 값으로 유지한다. 어느 화면에서 이름을 바꿔도 직접 연결된 순간들에 원자 전파한다. 순간의
> 당시 좌표는 역사적 사실이므로 대장 좌표 변경으로 덮지 않는다. `place_id`가 없는 이름-only
> 순간은 이름만으로 자동 연결하지 않는다.

## places
| 필드 | 형식 | 설명 |
|------|------|------|
| id | uuid | |
| user_id | uuid | |
| name | text | 장소명 |
| category | text | 식당·관광지·숙소 등 |
| latitude / longitude | double precision | 좌표 |
| address / city / country_code | text | |
| external_place_id | text | 외부 지도 ID |
| source | text | exif · current_location · manual |
| confidence | numeric | 자동추정 신뢰도 (needs_review 판단) |
| created_at / updated_at | | |

> 장소 중복 통합·집계·병합의 identity 키는 **안정 id**여야 한다. 장소명/도시 문자열로 dedup 금지(LESSONS §1).

## media_assets
바이트는 **DB 행에 넣지 않는다** — Storage 경로만.
| 필드 | 형식 | 설명 |
|------|------|------|
| id | uuid | |
| user_id / trip_id | uuid | |
| moment_id | uuid | nullable |
| media_type | text | MVP는 image |
| server_state | text | pending · uploaded · verified · deletion_pending · failed (C-09 서버 상태 — 클라이언트 작업상태와 분리) |
| storage_bucket / storage_path | text | 앱용 버킷·파일 |
| thumbnail_path | text | 썸네일 |
| original_storage_bucket / original_storage_path | text | 후속 기능 (원본 보관) |
| original_filename | text | 표시용 원본명 |
| original_mime_type | text | 원본 MIME 후보 |
| original_size | bigint | 원본 크기 |
| original_width / original_height | integer | 원본 규격 |
| stored_mime_type | text | **실제 검증된** 저장 MIME |
| stored_size | bigint | 저장 크기 |
| thumbnail_size | bigint | 썸네일 크기 |
| width / height | integer | 저장 규격 |
| captured_local | timestamp without time zone | **EXIF 원시시각** (C-10) |
| captured_at | timestamptz | 확정 또는 신뢰 가능한 UTC (nullable) |
| utc_offset_minutes | smallint | EXIF 또는 사용자 확인 |
| timezone | text | IANA 후보 |
| time_source | text | exif_offset · exif_local · gps_inferred · manual |
| time_confidence | text | exact · offset_known · timezone_inferred · local_only |
| latitude / longitude | double precision | **EXIF GPS = 민감 PII** |
| orientation_original | smallint | 원본 EXIF 방향 |
| content_hash | text | **원본 전체 콘텐츠 강한 해시** (H-10 확정용) |
| hash_algorithm | text | 예: sha256-v1 |
| derived_hash | text | 파생본 해시 |
| fingerprint | text | **1차 중복 후보만** (H-10 확정 아님) |
| exif_whitelist | jsonb | **허용된 EXIF만** (H-09 — MakerNote·일련번호 제외) |
| is_original_retained | boolean | 기본 false |
| 공통 열 | | id·user_id·created_at·updated_at·version·deleted_at·updated_by_device_id·last_operation_id |

> **H-09 EXIF whitelist**: 원본 EXIF 전체 JSON을 저장하지 않는다. `exif_whitelist`에는 허용 필드만 담고 MakerNote·기기 일련번호·얼굴영역 등은 제외한다(`docs/PRIVACY.md`·`docs/MEDIA_PIPELINE.md` §EXIF).
> **H-10 중복**: `fingerprint`(파일크기+원시시각+폭+높이)는 후보일 뿐이며, `content_hash`(강한 전체 콘텐츠 해시 + `hash_algorithm`)로만 완전 중복을 확정한다.

## expenses
| 필드 | 형식 | 설명 |
|------|------|------|
| id | uuid | |
| user_id / trip_id | uuid | |
| moment_id / place_id | uuid | nullable |
| transaction_type | text | expense · refund |
| original_amount | numeric(18,4) | **양수 원금액 (불변)** |
| original_currency | text | ISO 4217 |
| exchange_rate | numeric(20,10) | nullable |
| base_amount | numeric(18,4) | nullable |
| base_currency | text | nullable |
| rate_date | date | nullable |
| rate_source | text | nullable |
| category | text | 숙박·교통·식사·카페·관광·쇼핑·통신·보험·의료·기타 |
| payment_method | text | |
| incurred_local | timestamp without time zone | 현지시각 |
| incurred_at | timestamptz | 확정 UTC, nullable |
| note | text | 사용자 메모 |
| receipt_media_id | uuid | 영수증 사진, nullable |
| 공통 열 | | id·user_id·created_at·updated_at·version·deleted_at·updated_by_device_id·last_operation_id |

> **H-04**: 환율 관련 열(`exchange_rate, base_amount, base_currency, rate_date, rate_source`)은 별도 절이 아니라 **테이블 자체**에 통합한다. 원금액(`original_amount`)은 환율 값으로 덮어쓰지 않으며, 환율이 없어도 저장한다.

## companions / trip_companions
| companions | id, user_id, name, relationship, note |
| trip_companions | trip_id, companion_id, user_id (다대다) |

## reflections
| 필드 | 형식 | 설명 |
|------|------|------|
| id | uuid | |
| user_id / trip_id | uuid | |
| best_moment / unexpected / meaningful_person / learning / revisit / next_improvement / one_sentence | text | 회고 질문별 답 |
| 공통 열 | | id·user_id·created_at·updated_at·version·deleted_at·… |

활성 회고는 여행당 하나(H-03 부분 고유 인덱스). **AI 초안은 이 테이블이 아니라 별도 `ai_artifacts`(Phase 7)에 둔다.**

## tags / moment_tags
태그는 독립 테이블 + 다대다(`moment_tags`). `tags`는 사용자별 `normalized_name`이 활성 고유, `moment_tags`는 활성 `moment_id`+`tag_id` 조합 고유(H-03).

## user_devices (장치 표식 · ⛔ 동기화 제어)
장치 ID는 동기화 표식이며 **보안 인증요소나 하드웨어 지문이 아니다**.
| 필드 | 형식 | 설명 |
|------|------|------|
| id | uuid | 앱이 생성한 장치 식별자 |
| user_id | uuid | 소유자 |
| label | text | 사용자 지정 장치명 |
| app_instance_id | uuid | 재설치 구분 |
| last_seen_at | timestamptz | 마지막 서버 접촉 |
| revoked_at | timestamptz | 장치 폐기 |
| created_at | timestamptz | 생성 |

## client_operations (멱등성 원장 · C-07)
`(user_id, operation_id)`은 고유. 재전송 시 기존 결과를 반환한다.
| 필드 | 형식 | 설명 |
|------|------|------|
| operation_id | uuid | 클라이언트 작업 ID |
| user_id | uuid | |
| device_id | uuid | 장치 |
| entity_type | text | 대상 종류 |
| entity_id | uuid | 대상 ID |
| operation_type | text | insert · update · delete · finalize_upload |
| base_version | bigint | **클라이언트가 읽은 버전** (충돌 감지 기준) |
| payload_hash | text | 민감 원문 대신 검증 해시 |
| status | text | processing · applied · conflict · rejected |
| result_version | bigint | 성공 버전 |
| error_code | text | 안정적 오류 코드 |
| created_at | timestamptz | 서버 수신 |
| processed_at | timestamptz | 처리 완료 |

## sync_changes (단조 변경 피드 · C-07 · ⛔ pull cursor 원장)
클라이언트는 테이블별 `updated_at` 추측 대신 `sequence > last_cursor`로 페이지를 받는다. tombstone이 필요한 삭제는 원본 행 또는 변경 피드에서 확인 가능해야 한다. MVP에서는 변경 로그를 자동 정리하지 않는다.
| 필드 | 형식 | 설명 |
|------|------|------|
| sequence | bigint identity | **pull cursor에 쓰는 단조 증가 값** |
| user_id | uuid | 소유자 |
| entity_type | text | 대상 |
| entity_id | uuid | 대상 |
| operation_type | text | upsert · delete |
| entity_version | bigint | 결과 버전 |
| operation_id | uuid | 원인 operation |
| changed_at | timestamptz | 서버시각 |

## sync_conflicts (충돌 원장 · C-07 · ⛔)
충돌 스냅샷은 해당 사용자만 접근하며 **로그로 출력하지 않는다**.
| 필드 | 형식 | 설명 |
|------|------|------|
| id | uuid | 충돌 |
| user_id | uuid | 소유자 |
| entity_type / entity_id | text / uuid | 대상 |
| local_operation_id | uuid | 로컬 operation |
| base_version | bigint | 기준 버전 |
| server_version | bigint | 현재 서버 버전 |
| local_candidate | jsonb | 필요한 필드만 |
| server_snapshot | jsonb | 필요한 필드만 |
| status | text | open · resolved_local · resolved_server · merged |
| resolved_at | timestamptz | 해결 |
| created_at | timestamptz | 생성 |

## deletion_jobs (영구삭제 상태머신 · C-08/C-09 · ⛔)
| 필드 | 형식 | 설명 |
|------|------|------|
| id | uuid | 삭제 작업 |
| user_id | uuid | 소유자 |
| entity_type | text | trip · media · account |
| entity_id | uuid | 대상 |
| state | text | requested · enumerating · deleting_storage · verifying · finalizing_db · completed · failed · cancelled |
| storage_manifest | jsonb | 삭제할 버킷·경로와 결과 |
| attempts | integer | 재시도 |
| next_retry_at | timestamptz | 다음 시도 |
| error_code | text | 오류코드 |
| requested_at / completed_at | timestamptz | 요청·완료 |

## ai_artifacts (계획 · Phase 7)
> v0.1의 `ai_generations`를 v0.2 명칭 `ai_artifacts`로 채택. AI 출처(provenance)를 사용자 기록과 **분리 저장**한다(PROJECT_SPEC §7). AI 결과를 사용자 원문 필드에 넣지 않고 이 테이블에 근거 기록 ID·입력 스냅샷 해시와 함께 남긴다. Phase 7에서만 생성한다.
| 필드 | 형식 | 설명 |
|------|------|------|
| id | uuid | AI 결과 |
| user_id | uuid | 소유자 |
| artifact_type | text | daily_summary · trip_summary · tags · caption · ocr |
| target_type | text | 대상 종류(moment · trip_day · reflection 등) |
| target_id | uuid | 대상 레코드 |
| output_json | jsonb | AI 출력 |
| provider | text | 제공자 |
| model | text | 사용 모델 |
| prompt_version | text | 프롬프트 버전 |
| source_record_ids | uuid[] | AI가 사용한 근거 기록 ID(출처) |
| source_snapshot_hash | text | 입력 스냅샷 해시 |
| generated_at | timestamptz | 생성 시각 |
| user_confirmed | boolean | 사용자 확인 여부 |
| user_edited | boolean | 사용자 편집 여부 |
| deleted_at | timestamptz | 삭제 |

## 제약과 인덱스 (MASTER_SPEC §12)
필수 제약은 애플리케이션 검증만으로 대체하지 않는다: trips(날짜 순서·status 허용값), moments(emotion_score 1~5·오프셋 범위·시간 신뢰도), places(위경도·confidence 범위), media_assets(양수 크기·규격·상태 허용값·verified 시 storage_path 필수), expenses(original_amount>0·통화 형식·환율>0), 공통(version≥1), 관계(동일 user_id 복합 FK), soft delete(활성 행 기준 부분 고유 인덱스).

## 동기화 메타 (각 기록)
`version`(bigint), `updated_at`, `updated_by_device_id`, `last_operation_id`, `base_version`. 단순 `updated_at`만으로 모든 충돌을 덮어쓰지 않는다 — 서버는 `base_version`을 현재 `version`과 비교해 일치 시에만 적용하고, 변경은 `sync_changes`에 단조 `sequence`로 기록한다(C-07). 상세 규칙 `docs/SYNC_PROTOCOL.md`.

## 경계 규칙
- 메모리 표현은 camelCase, DB 행은 snake_case. 둘은 `toRow`/`fromRow` 경계 함수 안에서만 만난다(LESSONS §1). 경계 게이트 필요.
- 사용자 기록 필드(`user_note`, `user_summary`, 회고 답)와 AI 산출물(`ai_artifacts.output_json`)을 **같은 필드에 저장하지 않는다** — AI는 별도 `ai_artifacts` 테이블에만 둔다.
- 실제 기록은 DB/Storage에만 저장 — 앱 소스 상수/seed 배열/번들 JSON에 넣지 않는다(seed는 비어 있고 게이트로 강제(Phase 0 예정)).
