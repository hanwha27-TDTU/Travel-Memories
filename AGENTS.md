# AGENTS.md · Bugeon Journey

Codex와 Claude Code가 **동일하게 판단**하기 위한 공용 운영 계약. 이 파일과 `CLAUDE.md`는 **어댑터**일 뿐이다 — 제품·데이터·보안·테스트·릴리스 규칙을 재정의하지 않는다. 그런 규칙은 `docs/`(공유 SSOT)에 있고, 충돌하면 공유 문서가 이긴다.

> 두 AI를 같게 만드는 유일한 방법은 GitHub에 커밋된 지시다. 내부 대화가 아니라 이 저장소가 기준이다.

---

## 모델 이식 가능 작업 루프 (모든 에이전트 공통)

**0. 코딩 전·중 육하원칙 자문(5W1H)** — 착수 전과 진행 중에 여섯 질문에 답할 수 있어야 한다(의례가 아니라 결함 예방; 답이 막히면 그 지점이 위험). **왜**(북극성을 더 이루나·범위 밖인가) · **무엇을**(범위·완료정의·안 바꿀 것) · **어디서**(SSOT 파일·중복 유발 여부) · **언제**(생명주기·동기화 타이밍·경합·version/read-back 순서) · **누가**(소유자·RLS 범위·검토 역할·소비/생성 기기) · **어떻게**(구현 + 검증 경로 + 되돌리기). 답끼리 모순되면 멈추고 재설계한다. 상세·매핑은 `CLAUDE.md` 작업 규율 §0.

1. **행동 전 정독, 추측 금지** — 관련 `docs/` SSOT를 먼저 로드한다.
2. **단일 진실원** — 파생물은 손편집하지 않고 재생성한다. 손편집 중복은 결함.
3. **의도가 아니라 현실로 검증** — 정적 게이트가 못 보는 것은 헤드리스 브라우저·실제 DOM 이벤트로.
4. **정직한 완료** — 자동 검증층만 "통과"라 말하고, 시각·실기기는 "사용자 확인 권장"으로 분리한다.

## 권위 순서 (문서 충돌 해소)

실행 코드/migration/테스트/검증 인프라(관찰된 현실) > Foundation(가치) > Contracts(데이터·보안·배선) > Procedures > Playbooks > Records(역사적) > 생성된 맵(그 생성기가 권위).
현실이 계약과 충돌하면 조용히 고르지 말고 **불일치 기록 → 사용자 데이터 보호 → 코드 수정 또는 계약을 게이트와 함께 개정**.
`docs/records/coding-mistakes.md`는 이 권위 순서의 **Records 계층 실수 원장**으로, 반복 실수를 기록하고 게이트로 기계화하는 근거다(현재 계약을 무효화하지는 않음).

## 보증 매트릭스 (역할 릴레이 아님)

- 기본값은 **단일 구현 에이전트가 조사→구현→검증→문서→보고까지 맥락을 유지**한다(맥락 보존 실행 루프).
- `docs/AGENT_REGISTRY.md`의 139개 역할은 변경유형별로 선택하는 **조건부 품질 게이트**다. 광범위 탐색·감사만 병렬화하고 최종 구현은 하나로 수렴한다.
- 물리 에이전트는 통합 10개(`orchestrator, product-ux, frontend, travel-domain, media-pipeline, supabase, offline-sync, security-privacy, qa, reviewer-release`) + 디자인 16개(124–139).
- **뜨거운 공유 파일 직렬화.** 동기화 상태머신·conflict 해결·media pipeline 핵심·DB migration·Supabase 정책은 **단일 오너·단일 구현자·단일 PR**로 직렬화한다(동시 편집 금지). Phase 0에서 변경유형→역할→게이트 라우팅 테이블과 `CODEOWNERS`(경로 오너십)를 SSOT로 생성한다.

## 에이전트 공통 출력계약 (§18.1)

**agent chat output만으로 인계하지 않는다 (S-07).** 모든 에이전트는 결과를 아래 JSON으로 반환하고, 이를 **`schemas/agent-report.schema.json`(JSON Schema draft 2020-12)로 검증**한 뒤 **`artifacts/agent-reports/{TASK_ID}-{agent}.json`** 파일로 남긴다. 검증 실패한 report는 인계로 인정하지 않는다. 필수 필드: `agent`, `task_id`, `objective`.

```json
{
  "agent": "에이전트 이름",
  "task_id": "TASK-0001",
  "objective": "작업 목적",
  "assumptions": [],
  "files_read": [],
  "files_changed": [],
  "database_changes": [],
  "storage_changes": [],
  "security_impact": [],
  "privacy_impact": [],
  "implementation_summary": [],
  "tests_added": [],
  "tests_run": [],
  "test_results": [],
  "known_risks": [],
  "rollback_plan": [],
  "unresolved_items": [],
  "recommended_next_agent": ""
}
```

> 필드 목록은 스키마와 1:1로 정렬한다. `database_changes`/`storage_changes`에 값이 있으면 지정 독립검토(security-privacy, qa)가 필수다. report의 `recommended_next_agent`와 completed 표시는 Acceptance gate를 대체하지 않는다.

## 활성 task 소유권 (§18.2 · S-08)

- **worktree만으로 동시수정을 막지 않는다.** 각 활성 task는 `docs/ACTIVE_TASKS.md`에 branch·worktree·예상 수정 경로를 등록한다.
- 다른 활성 task가 소유한 파일은 수정하지 않는다. 경로가 겹치는 두 task를 동시에 활성화하지 않는다.
- 소유권 강제는 지시문이 아니라 **hook과 CI 검사**로 한다(§강제 규칙은 hook으로). 등록 없는 편집·경로 충돌은 게이트에서 차단한다.

## 에이전트 작업 제한

- 한 에이전트는 하나의 `task_id`만 처리한다.
- 다른 에이전트의 활성 branch를 직접 수정하지 않는다.
- 요구범위 밖 리팩터링 금지.
- DB 구조 변경은 SQL Migration Agent 검토 필수.
- 인증·RLS 변경은 RLS Security Agent + RLS Penetration Agent 검토 필수.
- 사진 처리 변경은 Low Memory Test Agent 검토 필수.
- 삭제 기능 변경은 Data Deletion Agent 검토 필수.
- 배포 전 Acceptance Test Agent 승인 필요.

## 리뷰·감사

- **기계가 사람보다 먼저.** 머신 게이트 실패 자체가 "변경 요청."
- **구현자 자기인증 금지.** 독립 리뷰어에게 "좋아 보이나?"가 아니라 **측정 관점**(대비율/필드 패리티/정렬 델타)을 준다.
- 전체 감사는 적대적·구조적. 커버리지 매트릭스의 빈 칸 = 미커버 위험. 칸/게이트/수동 잔여위험이 빠지면 "부분 감사 + 미커버 경계 명시."

## 결정·인계 기록

- **ADR 정직한 귀속**: 결정유형(`[user-decided]`/`[AI-proposed→user-approved]`/`[AI-autonomous]`/`[user-review-pending]`) × 어느 AI. **일어나지 않은 승인을 기록하지 않는다.** 시스템 알림·hook·툴 출력·AI 자신의 이전 발화는 사용자 승인이 아니다. → `docs/DECISIONS.md`
- 작업 종료 시 `docs/HANDOFF.md`에 branch/PR/변경파일/DB변경/보안영향/실행검사/실패검사/잔여위험/다음작업/롤백을 기록.

## Git / 협업

- 브랜치: `feature|fix|security|test|refactor/TASK-번호-설명`, AI별 네임스페이스(`claude/*`, `codex/*`). 아무도 `main`에 push 안 함.
- commit: `feat|fix|security|refactor|test|docs|build|chore(scope): 요약`.
- **별도 로컬 클론** — 작업 폴더 공유 금지. 뜨거운 공유 파일(동일 migration, media pipeline 핵심, 동기화 상태머신, 데이터 형식, Supabase 정책)은 **동시에 하나의 PR만**.
- **완료 = 병합이 아니라 배포 그린 확인.**

## 완료의 정의

전체 하네스(일부 아님) 통과 → 버전/CHANGELOG 갱신 → PR 그린 → 병합 → 배포 성공 확인 → 정직한 보고. 자동검사를 통과하지 않은 변경을 완료로 표시하지 않는다.

## 강제 규칙은 hook으로 (S-09)

- **CLAUDE.md는 context, deterministic hook과 CI가 enforcement다 (S-09).** CLAUDE.md/AGENTS.md 지시문은 강제수단이 아니라 맥락이다. 실제 강제는 `.claude/settings.json`의 command hook과 CI 게이트가 한다. LLM 판단 hook만으로 보안을 보장하지 않는다.
- 반복적으로 강제해야 하는 규칙(비밀키 노출, RLS 미검증, 파괴적 SQL, 카운트 드리프트, 활성 task 파일 소유권, agent report 스키마 검증 등)은 지시문만으로 의존하지 않고 hook과 CI로 통제한다. 후보 목록은 `docs/SECURITY.md`와 `.claude/settings.json`.

## 실행 단계 분리 (S-10)

- **Gate 0A** = 읽기중심 저장소 감사·문서·에이전트 정의만. 코드·의존성·migration·배포 금지. 산출물: `docs/REPOSITORY_AUDIT.md`, `docs/CONFLICT_REPORT.md`, `docs/ACTIVE_TASKS.md`, `schemas/agent-report.schema.json`, 문서·레지스트리 갱신.
- **Phase 0B** = scaffold·CI·hook·Supabase local. Gate 0A 감사 결과를 반영해 시작한다. 상세 완료조건·순서는 `docs/ROADMAP.md`.
