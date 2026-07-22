# ACTIVE TASKS · Journey Archive

활성 task 소유권 등록부 (S-08). 동시 수정 방지는 **worktree만으로 보장하지 않는다** — 각 활성 task가 여기에 branch·worktree·예상 수정 경로를 등록하고, hook과 CI가 소유권 충돌을 검사한다. 다른 활성 task가 소유한 파일은 수정하지 않는다.

## 규칙
- 한 에이전트 = 한 `task_id`. task 시작 전 여기에 행을 추가한다.
- `예상 경로`는 glob 또는 경로 목록. 겹치는 경로를 가진 두 task를 동시에 활성화하지 않는다.
- 뜨거운 공유 파일(동기화 상태머신·conflict 해결·media pipeline 핵심·DB migration·Supabase 정책)은 단일 오너·단일 PR로 직렬화.
- 결과 artifact는 `artifacts/agent-reports/{TASK_ID}-{agent}.json` (schemas/agent-report.schema.json 검증).
- task 완료 시 상태를 `done`으로 바꾸고 병합 후 행을 아카이브한다.

## 활성 task

| task_id | 에이전트 | branch | worktree | 예상 경로 | 상태 |
|---|---|---|---|---|---|
| TASK-0000 | orchestrator | `claude/travel-log-app-r2xd5f` | `/home/user/Travel-Memories` | `docs/AGENT_REGISTRY.md`, `docs/PROJECT_SPEC.md`, `docs/ROADMAP.md`, `docs/CONFLICT_REPORT.md`, `docs/REPOSITORY_AUDIT.md`, `docs/ACTIVE_TASKS.md`, `AGENTS.md`, `.claude/agents/README.md`, `schemas/agent-report.schema.json` | 진행 중 |

> TASK-0000 = Gate 0A: v0.2 설계 리비전을 거버넌스/레지스트리 문서에 병합(읽기중심·문서 전용). 코드/의존성/migration/배포 없음.

## 완료 task (아카이브)

_(없음)_
