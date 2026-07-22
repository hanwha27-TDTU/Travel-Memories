# CHANGELOG · Journey Archive

[Keep a Changelog] 형식. 최신이 위. 이 파일은 손편집이 아니라 릴리스 시 갱신하며, 열거 가능한 사실(카운트 등)은 파생·게이트로 잠근다(LESSONS §7).

## [Unreleased] — Phase 0

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
