# CHANGELOG · Journey Archive

[Keep a Changelog] 형식. 최신이 위. 이 파일은 손편집이 아니라 릴리스 시 갱신하며, 열거 가능한 사실(카운트 등)은 파생·게이트로 잠근다(LESSONS §7).

## [Unreleased] — Phase 0~1

### Phase 1 — 동기화 push/pull 구현 (2026-07-22)
- 인증(`services/auth.ts`): Google OAuth(PKCE) 로그인·로그아웃·세션·상태구독.
- 동기화(`services/sync.ts`): 대기열 push(멱등 upsert + **정확한 read-back** + LWW 서버시각 반영) + pull 병합(**빈-클라우드 가드**, 교체 아님). 네트워크는 `TripsRemote` 포트 뒤로 격리.
- 순수 결정(`sync/merge.ts`): mergeDecision(LWW+tombstone 우선)·isEmptyCloudAnomaly·classifyError — 단위테스트 15케이스로 게이트 잠금.
- UI: Google 로그인/로그아웃/수동 동기화 버튼, 동기화 상태 표시. 저장·로그인·온라인 복귀 시 자동 동기화.
- 검증: 하네스 6게이트·26 유닛테스트·빌드 통과, 로컬 모드 렌더 회귀 에러 0. **실 Google 로그인→journey.trips push는 대시보드 설정(스키마 노출·OAuth)+실기기 로그인 필요 — 이 환경에서 미검증(정직한 완료).**

### Phase 1 thin slice — trips 로컬층 (2026-07-22)
- 여행 생성·목록 실동작: 내구성 로컬 커밋(Dexie entity+operation 원자 트랜잭션) + 정확한 read-back.
- 브라우저 왕복 검증: 생성→새로고침→IndexedDB 영속·대기열 정합·에러 0.
- **서버층 적용(ADR-0020)**: 공유 프로젝트 Travel&Accounting의 `journey` 스키마 분리 — `journey.trips` migration 적용, RLS 공격검사 6종 실행 **RLS_ATTACK_PASS**(위조 INSERT·타인 조회/수정/삭제·소유자 하드삭제·anon 차단), advisor journey 0건. 클라이언트 `db.schema=journey`.
- trip rowmap(toRow/fromRow) 경계 + 왕복 단위테스트.


### 적대적 검토 중간 항목 일괄 (2026-07-22, TASK-0004)
- **security**: 스캐너 범위를 git 추적 전체(+dist)로 확대, `sbp_`·Google API 키·PEM 개인키 패턴과 `.env` 추적 차단 추가. SECURITY.md 서술을 구현 실체와 일치시킴(엔트로피 탐지=후속).
- **test**: `tests/unit/`(router·registry) 신설 + 하네스 `unit-tests` 게이트 — 테스트 0개로 `npm test`가 RED이던 상태 해소.
- **refactor(gates)**: `check-domain-wiring` 기대 집합을 손편집 상수 → DATA_MODEL.md 헤딩 파생으로(SSOT). `check-base-consistency` 신설 — BASE(vite.config SSOT)↔manifest↔index.html 정합. 모든 게이트에 셀프테스트 내장.
- **build**: index.html base 링크를 `%BASE_URL%` 파생으로, ci.yml pull_request 중복 트리거 제거 + concurrency 취소.
- **feat(pwa)**: manifest 링크·apple-touch-icon을 index.html에 추가(기존엔 manifest 미연결로 설치 불가), icon.svg에서 PNG 192/512/maskable/180 파생 생성(`scripts/generate-icons.mjs`).

### 적대적 검토 후속 수정 (2026-07-22)
- **security**: `check-secret-leak` 첫-매치 우회(M-0004) 정정 — `matchAll` 전수 판정 + 알려진-실패 주입 셀프테스트 내장(매 실행 검증).
- **fix**: Dexie `deletedAt` 인덱스 제거(M-0005) — IndexedDB는 null 인덱스 키 불가, tombstone 계약과 양립하도록 스키마 v1 정정.
- **build**: `deploy-pages.yml`에 클라이언트 설정 주입(`vars.*`) 추가, Pages 활성화 절차·Variables 사용 근거를 `DEPLOYMENT.md`에 명문화.
- **security**: CSP를 스택 계약으로 확장(wss Realtime·worker-src blob: MapLibre·Storage img-src·object-src 'none') + `check-csp` 게이트(셀프테스트 내장) 하네스 편입.
- **chore**: `commit-msg` 훅 — `Revert`/`Reapply`/`Merge` 등 git 생성 제목 허용(롤백 전략과 충돌 해소), `[skip actions]`·`skip-checks:` 트레일러 차단 추가.

### Phase 0B 코드 골격 (2026-07-22)
- Vite + TypeScript(strict) 골격: 빌드·타입체크 통과, 홈(빈 상태) 1화면 렌더(에러 0).
- `base=/Travel-Memories/`, history 라우터(안전 폴백), PWA manifest(하위경로 scope).
- 단일 `harness`(typecheck·check-secret-leak·check-domain-wiring), `.githooks/commit-msg` 활성.
- CI(`ci.yml`) + GitHub Pages 배포 워크플로(`deploy-pages.yml`, 404 복제·시크릿 스캔).
- `DOMAIN_REGISTRY`(18 도메인), Dexie 스키마 스텁, Supabase publishable 클라이언트(PKCE) 스텁.

### v0.2 정밀 병합 (2026-07-22)
- 외부 v0.2 비판적 검증 채택(ADR-0013~0017): sync 원장(operation receipt·base_version·단조 커서·conflict table), deletion_jobs 상태머신, 복합 소유자 FK, 부분 고유 인덱스, EXIF 시각(local+offset+tz)·whitelist, 불변 Storage·TUS, publishable/secret 키 체계, pgTAP 2사용자 RLS 테스트, DB백업 Storage 미포함 명시.
- 유실범위 명확화("내구성 로컬 커밋 후 앱 원인 유실 0"), 디코딩 동시성 1, WebP magic-byte 검증.
- `ai_generations`→`ai_artifacts`, 인라인 AI 컬럼 제거(구현 전 검토).
- Gate 0A/Phase 0B 분리, agent-report JSON Schema, ACTIVE_TASKS 소유권, 독립검토 매핑.
- 신규: `docs/DEPLOYMENT.md`, `REPOSITORY_AUDIT.md`, `CONFLICT_REPORT.md`, `ACTIVE_TASKS.md`, `schemas/agent-report.schema.json`, `docs/reference/v0.2/`(원본 5종).

### 초기 스캐폴딩
### Added
- 프로젝트 기준 문서 세트(`docs/`, DEPLOYMENT 포함) + `CLAUDE.md` · `AGENTS.md`.
- 개발 에이전트 팀: 통합 10개 + 디자인 16개(`.claude/agents/`), 139개 논리 역할 등록부(`docs/AGENT_REGISTRY.md`).
- 선행 프로젝트 교훈 추출(`docs/LESSONS.md`).
- hook 후보 문서화(`.claude/settings.json`, `docs/SECURITY.md`).

### Changed
- 프로젝트를 "Journey Archive"로 재정의: 순수 HTML/JS → TypeScript+Vite+Supabase+Dexie+MapLibre+PWA.

### Removed
- 초기 순수 HTML/JS MVP(`index.html`, `css/`, `js/`) — git 히스토리 보존.
