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
_(현재 활성 task 없음 — Phase 1 착수 시 등록)_

## 완료 task (아카이브)

- **TASK-0000** · Gate 0A — v0.2 설계 리비전을 거버넌스/레지스트리 문서에 병합(문서 전용). 완료.
- **TASK-0002** · Phase 0B 코드 골격 — Vite+TS 골격·CI·배포·hook·레지스트리 게이트. 빌드·타입체크·하네스·라이브 렌더 통과. 완료.
