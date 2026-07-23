# Claude Code 최초 실행 프롬프트

아래 작업은 Journey Archive Gate 0A다. 제품 기능, dependency 설치, migration 적용, Storage 생성 또는 배포를 수행하지 마라.

먼저 다음 문서를 전체 읽어라.

```text
JOURNEY_ARCHIVE_MASTER_SPEC_v0.2.md
docs/AGENT_REGISTRY_v0.2.md
```

현재 저장소가 이 문서들을 포함하지 않으면 사용자가 제공한 경로를 기준으로 읽고, 저장소 내 최종 위치를 제안하라.

## 역할

당신은 수석 설계자이자 오케스트레이터다. 현재 저장소 사실을 추정하지 말고 Git과 파일을 직접 조사한다. 모든 secret 값은 출력하지 않는다.

## Gate 0A 허용 범위

```text
- 읽기 중심 저장소 조사
- docs 문서 생성·수정
- CLAUDE.md와 AGENTS.md 생성·정리
- docs/AGENT_REGISTRY.md 생성
- .claude/agents의 10개 통합 agent 정의
- schemas/agent-report.schema.json 생성
- hook 후보와 CI gate 설계 문서화
```

## Gate 0A 금지 범위

```text
- 제품 기능 구현
- npm, pnpm, yarn 또는 bun install
- package dependency 추가·삭제·업데이트
- DB migration 적용 또는 remote project 변경
- Supabase bucket·policy·function 배포
- 기존 src 대규모 이동·재작성
- destructive Git command
- hook 차단 모드 활성화
- commit, push, PR 또는 배포
```

## 조사 순서

```text
- git status, branch, HEAD, remotes와 worktree 확인
- root tree와 추적 파일 조사
- package manager, Node version, build, TypeScript, lint, test, PWA 상태 조사
- 현재 architecture와 module boundary 요약
- Supabase migration, config, policy, function, seed, generated types 조사
- .env 파일의 이름과 key 이름만 확인하고 값은 읽거나 출력하지 않음
- CI, deployment, secret scan, security header 상태 조사
- 기존 CLAUDE.md, AGENTS.md, .claude/agents, hooks 조사
- Journey Archive v0.2와 일치, 충돌, 누락, 더 나은 기존 구현을 구분
```

## 생성할 결과물

```text
docs/REPOSITORY_AUDIT.md
docs/CONFLICT_REPORT.md
docs/PROJECT_SPEC.md
docs/ARCHITECTURE.md
docs/DATA_MODEL.md
docs/SECURITY.md
docs/PRIVACY.md
docs/MEDIA_PIPELINE.md
docs/SYNC_PROTOCOL.md
docs/ASSUMPTIONS.md
docs/DECISIONS.md
docs/ROADMAP.md
docs/AGENT_REGISTRY.md
docs/ACTIVE_TASKS.md
CLAUDE.md
AGENTS.md
.claude/agents/orchestrator.md
.claude/agents/product-ux.md
.claude/agents/frontend.md
.claude/agents/travel-domain.md
.claude/agents/media-pipeline.md
.claude/agents/supabase.md
.claude/agents/offline-sync.md
.claude/agents/security-privacy.md
.claude/agents/qa.md
.claude/agents/reviewer-release.md
schemas/agent-report.schema.json
```

파일이 이미 있으면 덮어쓰기 전에 현재 내용, 충돌과 통합 방식을 보고한다. 기존 문서를 삭제하지 않는다.

## 필수 문서 내용

`docs/REPOSITORY_AUDIT.md`

```text
- 현재 Git 상태
- 기술 stack과 versions
- 디렉터리와 핵심 file
- 실행 가능한 commands
- DB·Storage·Auth 상태
- test와 CI 상태
- unknown과 조사 한계
```

`docs/CONFLICT_REPORT.md`

```text
- 기준서 요구
- 현재 구현
- 충돌 유형
- 데이터·보안·개인정보 영향
- 권고 조치
- 예상 변경 file
- migration 또는 rollback 필요성
```

`docs/ROADMAP.md`

```text
- Gate 0A 완료조건
- Phase 0B task 목록
- dependency graph
- 각 task의 허용 file
- 검사 command
- 승인 gate
```

## 10개 통합 agent

각 `.claude/agents/*.md`는 현재 Claude Code 공식 형식을 따르고 필요한 최소 tools와 permissions만 요청한다. 전체 123개 agent file을 만들지 않는다. 123개 역할은 `docs/AGENT_REGISTRY.md`에 책임 taxonomy로 등록하고 10개 agent에 매핑한다.

## hooks 분류

실제 hook을 활성화하지 말고 다음을 문서에 후보로 분류한다.

```text
- destructive shell 차단
- 활성 task file ownership 검사
- client bundle secret 검사
- 적용된 migration 수정 차단
- post-edit format·lint·typecheck
- stop 시 test·agent report·handoff 검사
```

command hook과 CI를 최종 강제수단으로 보고, LLM 판단 hook만으로 보안을 보장하지 않는다.

## 검증

Gate 0A에서는 파일 생성 후 다음만 수행한다.

```text
- Markdown link와 경로 존재 검사
- JSON Schema 구문검사
- agent frontmatter 구문검사
- git diff --check
- 변경 file 목록과 diff 통계
```

기존 package command가 있고 dependency 설치 없이 안전하게 실행 가능하더라도, 사용자에게 실행 여부와 목적을 먼저 보고한다. 테스트 미실행을 통과로 표시하지 않는다.

## 최종 보고 형식

```text
1. 현재 저장소 요약
2. v0.2 기준서와의 충돌·누락
3. 생성·수정한 file
4. 실행한 검사와 실제 결과
5. 보안·개인정보 영향
6. assumptions와 unresolved items
7. Phase 0B 변경 예정 file
8. 위험과 rollback
9. 다음 승인 gate
```

최종 보고 후 제품 코드를 구현하지 말고 멈춘다.
