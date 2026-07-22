# DATA MODEL · Journey Archive

설계지시서 §8 기준. 모든 사용자 소유 테이블은 원칙적으로 `user_id`, `created_at`, `updated_at`, `version`, `deleted_at`을 갖는다. `deleted_at`은 여러 기기 동기화 완료 전까지 삭제 사실을 전달하는 **tombstone**이다.

> **DOMAIN_REGISTRY (대칭성 SSOT)** — 아래 엔티티는 모두 형제다. 각 도메인 × 생명주기 노드(normalize·dedupe·toRow·fromRow·merge·hash·trash·sync·export)는 연결(✅)이거나 파생된 사유의 명시적 제외(⛔)여야 하며, 침묵 공백은 대칭 위반(❌)이다. 신규 엔티티는 레지스트리에 등록하고 모든 노드를 배선하거나 게이트로 강제(Phase 0 예정)한다. (LESSONS §3)

엔티티: `profiles`, `trips`, `trip_days`, `moments`, `places`, `media_assets`, `expenses`, `companions`, `trip_companions`, `reflections`, `tags`, `moment_tags`, `client_operations`.

⛔ 제외: `profiles`(사용자 1:1 프로필, 도메인 아님), `client_operations`(멱등성 원장), `trip_companions`/`moment_tags`(조인 테이블 — 부모와 함께 동기화). 전체 대칭 매트릭스(엔티티×생명주기 노드)는 Phase 0에서 `DOMAIN_REGISTRY` SSOT로 생성한다.

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
`trip_id + local_date`는 고유.
| 필드 | 형식 | 설명 |
|------|------|------|
| id | uuid | |
| user_id / trip_id | uuid | |
| local_date | date | 현지 날짜 |
| timezone | text | 해당 날짜 시간대 |
| title | text | 하루 제목 |
| user_summary | text | 사용자 요약 |
| ai_summary | text | AI 생성 요약 (별도 필드) |
| ai_confirmed | boolean | 사용자 확인 |
| version | integer | |

## moments
| 필드 | 형식 | 설명 |
|------|------|------|
| id | uuid | |
| user_id / trip_id / trip_day_id | uuid | |
| place_id | uuid | 대표 장소 |
| occurred_at | timestamptz | 발생시각 |
| timezone | text | 현지 시간대 |
| title | text | 순간 제목 |
| user_note | text | **사용자 원문** |
| emotion_score | smallint | 1~5 |
| is_highlight | boolean | 대표 기억 |
| source | text | manual · photo_import · location |
| ai_summary | text | **AI 요약 (사용자 원문과 분리)** |
| ai_confirmed | boolean | |
| version / deleted_at | | |

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
| user_id / trip_id / moment_id | uuid | |
| media_type | text | image · video · audio |
| storage_path | text | 앱용 파일 |
| thumbnail_path | text | 썸네일 |
| original_storage_path | text | 선택적 원본 |
| original_filename / original_mime_type | text | |
| original_size / stored_size | bigint | |
| stored_mime_type | text | |
| width / height | integer | 저장 크기 |
| captured_at | timestamptz | **압축 전 EXIF에서 읽음** |
| latitude / longitude | double precision | **EXIF GPS = 민감 PII** |
| hash | text | 중복검사 |
| exif_json | jsonb | 필요한 EXIF |
| upload_state | text | 업로드 상태 |
| is_original_retained | boolean | 원본 보관 여부 |
| version | integer | |

## expenses
| 필드 | 형식 | 설명 |
|------|------|------|
| id | uuid | |
| user_id / trip_id / moment_id / place_id | uuid | |
| amount | numeric | 금액 (원금액 불변) |
| currency | text | 통화 |
| category | text | 숙박·교통·식사·카페·관광·쇼핑·통신·보험·의료·기타 |
| payment_method | text | |
| incurred_at | timestamptz | |
| note | text | |
| receipt_media_id | uuid | 영수증 사진 |

통화 처리는 원금액을 덮어쓰지 않는다: `original_amount, original_currency, exchange_rate, base_amount, base_currency, rate_date, rate_source` (환율 없어도 저장 가능).

## companions / trip_companions
| companions | id, user_id, name, relationship, note |
| trip_companions | trip_id, companion_id, user_id (다대다) |

## reflections
| 필드 | 형식 | 설명 |
|------|------|------|
| id | uuid | |
| user_id / trip_id | uuid | |
| best_moment / unexpected / meaningful_person / learning / revisit / next_improvement / one_sentence | text | 회고 질문별 답 |
| ai_draft | jsonb | **AI 초안 (분리)** |
| user_confirmed | boolean | |

## tags / moment_tags
태그는 독립 테이블 + 다대다(`moment_tags`).

## client_operations (멱등성)
| 필드 | 형식 | 설명 |
|------|------|------|
| operation_id | uuid | 클라이언트 작업 ID (고유 — 재전송 중복 방지) |
| user_id | uuid | |
| entity_type | text | 대상 종류 |
| entity_id | uuid | |
| operation_type | text | insert · update · delete · upload |
| payload_hash | text | 작업 검증 |
| processed_at | timestamptz | 서버 처리시각 |

## ai_generations (계획 · Phase 7)
AI 출처(provenance)를 사용자 기록과 **분리 저장**한다(MVP 이후, PROJECT_SPEC §7). AI 결과를 사용자 원문 필드에 넣지 않고 이 테이블에 원본 기록 ID와 함께 남긴다.
| 필드 | 형식 | 설명 |
|------|------|------|
| id | uuid | |
| user_id | uuid | 소유자 |
| entity_type | text | 대상 종류(moment · trip_day · reflection 등) |
| entity_id | uuid | 대상 레코드 |
| user_text | text | AI 입력이 된 사용자 원문 스냅샷 |
| ai_output | text | AI 생성 결과 |
| ai_model | text | 사용 모델 |
| prompt_version | text | 프롬프트 버전 |
| generated_at | timestamptz | 생성 시각 |
| source_record_ids | uuid[] | AI가 사용한 원본 기록 ID(출처) |
| user_confirmed | boolean | 사용자 확인 여부 |
| user_edited | boolean | 사용자 편집 여부 |

## 동기화 메타 (각 기록)
`version`, `updated_at`, `updated_by_device`, `client_operation_id`, `base_version`. 단순 `updated_at`만으로 모든 충돌을 덮어쓰지 않는다. 상세 규칙 `docs/SYNC_PROTOCOL.md`.

## 경계 규칙
- 메모리 표현은 camelCase, DB 행은 snake_case. 둘은 `toRow`/`fromRow` 경계 함수 안에서만 만난다(LESSONS §1). 경계 게이트 필요.
- 사용자 기록 필드(`user_note`, `user_summary`)와 AI 필드(`ai_summary`, `ai_draft`)를 **같은 필드에 저장하지 않는다**.
- 실제 기록은 DB/Storage에만 저장 — 앱 소스 상수/seed 배열/번들 JSON에 넣지 않는다(seed는 비어 있고 게이트로 강제(Phase 0 예정)).
