# CHANGELOG · Journey Archive

[Keep a Changelog] 형식. 최신이 위. 이 파일은 손편집이 아니라 릴리스 시 갱신하며, 열거 가능한 사실(카운트 등)은 파생·게이트로 잠근다(LESSONS §7).

## [Unreleased] — Phase 0

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
