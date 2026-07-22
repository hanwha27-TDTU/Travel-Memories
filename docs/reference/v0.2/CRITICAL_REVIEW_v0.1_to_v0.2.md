# Journey Archive 버전 0.1 비판적 검증 보고서

검증 기준일: 2026-07-22  
검증 대상: Journey Archive 통합 설계제안서 및 개발 실행지시서 버전 0.1  
결론: 제품 비전과 기본 원칙은 유지할 가치가 높지만, 그대로 구현 지시로 사용하기에는 브라우저 영속성, 동기화, 삭제, 시간대, 미디어 업로드와 백업 정의에 차단 수준의 결함이 있다.

---

## 1. 유지한 핵심 원칙

| 원칙 | 판단 | 이유 |
|---|---|---|
| Moment 중심 모델 | 유지 | 짧은 기록과 장기 검색을 동시에 지원 |
| 원본 사진 불변 | 유지 | 사용자 원본 보호와 파생본 정책이 명확 |
| 사용자 원문·AI 결과 분리 | 유지·강화 | AI provenance와 확인 상태를 별도 테이블로 이동 |
| offline-first | 유지·수정 | 로컬 우선은 타당하지만 브라우저 저장 한계를 명시해야 함 |
| RLS 우선 | 유지·강화 | 활성화 여부가 아니라 실제 사용자 간 공격검사까지 필요 |
| 실패 항목만 재시도 | 유지·구체화 | operation ID와 불변 Storage path로 멱등성을 설계 |
| 10개 통합 agent | 유지 | 123개 역할을 실제 실행자와 분리하는 것이 합리적 |
| 저장소 문서가 최종 정보원 | 유지 | Claude·Codex 대화 종속 방지 |

---

## 2. 차단 수준 수정사항

| ID | 문제 | 실패 양상 | 수정 결정 |
|---|---|---|---|
| C-01 | “오프라인 기록 유실 0건” 절대 표현 | 사용자가 사이트 데이터를 지우거나 브라우저가 best-effort 저장소를 축출해도 앱 책임처럼 보임 | “내구성 로컬 커밋 후 앱 원인 유실 0건”으로 범위 한정, quota·persist 상태와 백업 경고 추가 |
| C-02 | 사진 500장의 전량 내구성 대기열 전제 | 모바일 origin quota가 부족하면 원본 Blob 스테이징 불가 | selected_non_durable와 staged를 분리하고 preflight·분할 수용·명시적 거부 도입 |
| C-03 | Background Sync 의존 | iOS Safari 등 제한된 환경에서 작업이 실행되지 않음 | 앱 시작·포그라운드·online 이벤트·수동 sync를 기본, Background Sync는 보조 |
| C-04 | `navigator.onLine`을 연결 판단에 사용할 위험 | LAN 또는 captive portal에서도 true일 수 있음 | 실제 Supabase probe＋timeout 사용, onLine은 UI hint만 사용 |
| C-05 | 단일 HTML판의 PWA 기능 기대 | `file://`에서는 service worker와 설치형 PWA 동등성 불가 | 단일 HTML을 제한된 휴대용 archive viewer로 재정의 |
| C-06 | 메타데이터 export와 전체 backup 혼동 | JSON 복원 후 사진이 없는데도 전체 복원이 된 것처럼 보임 | metadata export와 media archive를 명시적으로 분리 |
| C-07 | `updated_at` 중심 sync | 동시 수정, 동일 timestamp, 응답 유실과 tombstone pull에서 누락 | operation receipt, base_version, change sequence, conflict table 추가 |
| C-08 | 삭제 즉시 Storage 제거 | 휴지통 복원 시 미디어 복구 불가 | 일반 삭제는 tombstone, 영구 삭제만 deletion job으로 Storage 제거 |
| C-09 | DB와 Storage를 한 transaction처럼 취급 | 파일만 남거나 DB row만 남는 orphan 발생 | pending row → upload → verify → finalize 상태머신 도입 |
| C-10 | EXIF 시각을 단일 timestamptz로 확정 | timezone 없는 DateTimeOriginal이 잘못된 UTC로 변환 | local raw time, offset, timezone candidate, source, confidence 저장 |

---

## 3. 높은 중요도 수정사항

| ID | 문제 | 수정 결정 |
|---|---|---|
| H-01 | 공통 열 원칙과 실제 schema 불일치 | 모든 사용자 소유 가변 테이블에 공통 열 적용, 예외 명시 |
| H-02 | 자식 row의 user_id와 부모 소유자 불일치 가능 | `(parent_id,user_id)` 복합 FK 사용 |
| H-03 | soft delete와 일반 unique constraint 충돌 | `WHERE deleted_at IS NULL` 부분 고유 인덱스 사용 |
| H-04 | expenses 기본표와 환율 절이 서로 다름 | original_amount·currency·exchange_rate·base_amount로 통합 |
| H-05 | MapLibre와 place search의 경계 불명확 | renderer, tile/style, geocoder, reverse geocoder, timezone resolver 분리 |
| H-06 | 모바일 디코딩 동시성 2 | 큰 Bitmap은 기본 1개, 업로드만 기본 2개 |
| H-07 | WebP 인코딩 성공 가정 | Blob MIME와 magic bytes 검증 후 JPEG 또는 PNG fallback |
| H-08 | MIME·확장자 검사 중심 | magic bytes, 실제 decode, pixel cap, SVG 거부, 손상·폭탄 방어 추가 |
| H-09 | 원본 EXIF 전체 JSON 저장 가능성 | whitelist만 저장하고 MakerNote·일련번호 등 제외 |
| H-10 | 빠른 hash로 중복 확정 가능성 | fingerprint는 후보, 전체 콘텐츠 강한 hash로 확정 |
| H-11 | Storage 객체 UPDATE·upsert 가능성 | immutable path, `upsert:false`, 교체 시 새 media_id |
| H-12 | RLS 정적 validator만 존재 | local Supabase, pgTAP, anon·user A·user B 공격검사 필수 |
| H-13 | legacy key 용어만 사용 | publishable·secret 체계를 반영하고 secret/service_role client 금지 |
| H-14 | 로그아웃 후 로컬 사용자 데이터 경계 누락 | user namespace 분리, 잠금, 유지·삭제 선택, 계정 전환 격리 |
| H-15 | DB backup에 Storage도 포함된다는 오해 가능 | Supabase DB backup은 object bytes 미포함임을 명시 |

---

## 4. 범위와 운영 수정사항

| ID | 문제 | 수정 결정 |
|---|---|---|
| S-01 | 음성입력의 구현 방식 미정 | MVP는 OS dictation 또는 audio note, 앱 내 STT는 후속 |
| S-02 | 자연어검색이 MVP와 2차 범위에 중복 | MVP는 구조화·문자 검색, semantic search는 Phase 7 전후 별도 |
| S-03 | 원본보관 모드가 MVP 복잡도를 크게 증가 | 기본 비활성, 별도 bucket·TUS·비용·restore gate 후 활성 |
| S-04 | 공개 회원가입 기본값 미정 | 개인 앱은 invite-only 또는 signup disabled가 기본 |
| S-05 | GitHub Pages 우선순위가 운영 보안요건보다 앞섬 | 보안 헤더·rollback 가능한 host를 운영 기준, GitHub Pages는 보조 |
| S-06 | 123개 agent가 관리복잡도를 키울 수 있음 | registry taxonomy로 유지, 10개 integrated agent만 실제 생성 |
| S-07 | agent chat output만으로 인계 | JSON Schema로 검증되는 agent report artifact 추가 |
| S-08 | worktree만으로 동시수정 방지 가능하다는 인상 | ACTIVE_TASKS 파일 소유권과 hook·CI 검사 추가 |
| S-09 | CLAUDE.md가 강제수단처럼 보임 | CLAUDE.md는 context, deterministic hook과 CI가 enforcement |
| S-10 | 첫 실행에서 문서와 scaffold가 혼재 | Gate 0A audit·docs·agents, Phase 0B scaffold로 분리 |

---

## 5. 수정 후 핵심 상태 흐름

### 5.1 기록

```text
사용자 저장
→ Dexie entity＋operation atomic commit
→ 로컬 저장 완료
→ server apply operation
→ change sequence 기록
→ pull cursor 반영
```

### 5.2 미디어

```text
selected_non_durable
→ quota 확인
→ staged
→ EXIF·orientation·decode
→ derived_ready
→ pending server row
→ immutable upload
→ remote verify
→ synced
```

### 5.3 삭제

```text
휴지통 tombstone
→ 복원 가능
→ 별도 영구 삭제 확인
→ deletion manifest
→ Storage delete·verify
→ DB finalize
```

### 5.4 백업

```text
metadata JSON·CSV·GeoJSON
≠
manifest＋records＋media＋checksums 전체 archive
```

---

## 6. 남은 의사결정

다음 항목은 저장소 조사 전 확정하면 안 된다.

```text
- 실제 package manager와 Node 지원 버전
- 기존 framework 또는 router 존재 여부
- Supabase project와 migration 적용 상태
- map tile·geocoder provider
- PWA service worker 생성 방식
- HEIC 변환 library와 license
- runtime validation library
- production hosting provider
- full archive streaming implementation
- 앱의 단일 사용자 운영 기간
```

이 항목은 `docs/ASSUMPTIONS.md`에 임시값을 두고, 변경 시 `docs/DECISIONS.md`에 ADR을 남긴다.

---

## 7. 최종 판정

| 평가축 | 버전 0.1 | 버전 0.2 |
|---|---|---|
| 제품 방향 | 적절 | 유지 |
| 구현 가능성 | 일부 과장·모호 | 상태머신과 gate로 구체화 |
| 오프라인 내구성 | 절대보장 표현 | 통제 가능한 범위로 한정 |
| 다기기 동기화 | 불충분 | operation＋version＋cursor |
| 사진 대량처리 | 메모리·quota 위험 | staged 상태와 bounded concurrency |
| DB·Storage 정합성 | 부분 실패 정의 부족 | pending·verify·deletion job |
| 보안 | 원칙은 강함 | 복합 FK, 두 사용자 테스트, key 체계 보강 |
| 백업 | media 경계 불명 | 전체 archive를 별도 정의 |
| agent 운영 | 역할은 풍부하나 과대 | 10개 실행 agent와 검증 report |

버전 0.2는 바로 제품 구현을 시작하라는 명령이 아니다. 첫 실행은 Gate 0A 저장소 감사와 문서화까지만 수행하고, 실제 scaffold와 migration은 감사 결과를 반영한 Phase 0B에서 시작한다.
