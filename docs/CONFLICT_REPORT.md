---
shape: prose-debt
---
# CONFLICT REPORT · Bugeon Journey (v0.1 baseline ↔ v0.2 spec)

문서 버전: Gate 0A  
기준일: 2026-07-22  
기준서: `docs/reference/v0.2/CRITICAL_REVIEW_v0.1_to_v0.2.md`, `AGENT_REGISTRY_v0.2.md`, `CLAUDE_INITIAL_EXECUTION_PROMPT_v0.2.md`  
v0.1 baseline = 현재 저장소 문서(`docs/`). v0.2 = 리비전 기준서.

> 대부분의 C/H(차단·높음) 항목은 `DATA_MODEL`/`SYNC_PROTOCOL`/`MEDIA_PIPELINE`/`SECURITY`/`PRIVACY` 등 **기술 문서 소관**으로, 병행 작업(다른 에이전트)에서 반영된다. 본 보고서는 그 목록과 **거버넌스·범위(S) 및 레지스트리** 항목의 해소를 기록한다.

## 1. 범위·운영 수정사항 (S) — 본 세션에서 해소

| ID | 기준서 요구 | 현재(v0.1) 상태 | 충돌 유형 | 해소(반영 문서) |
|---|---|---|---|---|
| S-01 | 음성입력 MVP = OS dictation/audio note, 앱 내 STT는 후속 | "한 줄 기록 문자/음성"만, 구현방식 미정 | 범위 모호 | PROJECT_SPEC §3 MVP 주석 반영 |
| S-02 | MVP=구조화·문자 검색, semantic search=Phase 7 | 자연어검색이 MVP·2차에 중복 | 범위 중복 | PROJECT_SPEC §3(2차→Phase 7 명시) |
| S-03 | 원본보관 모드 기본 비활성(별도 bucket·TUS·비용·restore gate 후) | 원본보관 복잡도 미반영 | 범위·복잡도 | PROJECT_SPEC §3(절약 모드가 기본과 정합) |
| S-04 | 공개 회원가입 비활성/invite-only 기본, 소셜 로그인은 소유자 계정 한정 | 기본값 미정 | 보안·범위 | PROJECT_SPEC §3 |
| S-05 | GitHub Pages는 보조, 보안헤더·rollback 가능 host가 운영 기준 | GitHub Pages 우선(사용자 결정) | 운영 우선순위 | **보호된 분기 참조(§3)** — DEPLOYMENT.md 미변경 |
| S-06 | 123 역할 taxonomy 유지, 통합 agent만 실제 생성 | 이미 통합 10 + 디자인 16 구현 | 정합(초과 충족) | AGENT_REGISTRY(유지) |
| S-07 | agent chat output만으로 인계 금지, JSON Schema 검증 report artifact | 출력계약 JSON은 있으나 스키마·경로 미정 | 계약 미흡 | AGENTS.md §18.1 + `schemas/agent-report.schema.json` |
| S-08 | worktree만으로 동시수정 방지 불가 → ACTIVE_TASKS 소유권 + hook·CI | worktree/직렬화 언급만 | 동시성 강제 미흡 | AGENTS.md + `docs/ACTIVE_TASKS.md` |
| S-09 | CLAUDE.md=context, deterministic hook+CI=enforcement | 대부분 반영됨 | 정합 | AGENTS.md(재확인) |
| S-10 | Gate 0A(audit·docs·agents) / Phase 0B(scaffold) 분리 | Phase 0에 문서+scaffold 혼재 | 단계 혼재 | ROADMAP(Gate 0A/0B 분리) |

## 2. 차단(C)·높음(H) 수정사항 — 기술 문서 소관 (참조)
C-01~C-10(오프라인 유실 표현·quota·Background Sync·onLine·단일HTML·backup 경계·updated_at sync·삭제 tombstone·orphan 상태머신·EXIF timezone)과 H-01~H-15(공통 열·복합 FK·부분 고유 인덱스·환율·MapLibre 경계·디코딩 동시성·WebP fallback·magic bytes·EXIF whitelist·강한 hash·immutable path·pgTAP 공격검사·key 체계·로그아웃 격리·DB backup≠object)는 `DATA_MODEL`/`SYNC_PROTOCOL`/`MEDIA_PIPELINE`/`SECURITY`/`PRIVACY`/`ARCHITECTURE` 소관. 상세는 기준서 §2·§3, 반영 여부는 해당 문서와 병행 작업의 CONFLICT 후속 갱신 참조. **본 세션에서는 해당 파일을 편집하지 않았다.**

## 3. 데이터·보안·개인정보 영향
- S-03/S-04/S-05는 개인정보·보안 강화 방향(원본 노출 축소, 공개가입 차단, rollback 가능 host)이며 데이터 손실 위험 없음.
- 레지스트리 변경은 문서 전용이며 런타임/데이터 영향 없음.

## 4. 보호된 분기 (USER 결정 — 되돌리지 않음)
1. **디자인 팀 139/26 유지.** v0.2는 123→10만 정의하나, 본 저장소는 **139 논리 역할 → 26 물리 에이전트(통합 10 + 디자인 16, 레지스트리 124–139)**로 확장. 이는 사용자 결정이며 v0.2에 대한 상위 집합(초과 충족)으로 유지한다. 디자인 에이전트의 `fable` 모델 배정도 유지.
2. **GitHub Pages 배포 결정 유지(S-05 pending).** v0.2는 GitHub Pages를 보조로 낮추자고 권고하나, 배포 host 결정은 사용자 소관이며 `docs/DEPLOYMENT.md`에서 별도 처리한다. 본 세션은 DEPLOYMENT.md를 변경하지 않는다.

## 5. 권고 조치·예상 변경 file·migration/rollback
- 권고: S 항목은 본 세션에서 문서 반영 완료. C/H 항목은 Phase 0B 코드 골격 이전에 기술 문서에서 상태머신·스키마로 확정.
- 예상 변경 file(Phase 0B): `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/**`, `.env.example`, `.github/workflows/**`, `supabase/migrations/**`, `.claude/settings.json`(hook 실동작).
- migration/rollback: 현재 migration 없음 → 본 변경은 문서 전용이라 rollback은 git revert로 충분. DB/Storage 변경 없음.
