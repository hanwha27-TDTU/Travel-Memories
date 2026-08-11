---
shape: tree
---
# ROADMAP · Bugeon Journey

설계지시서 §27·§28. 각 Phase는 명시적 완료조건을 갖는다. 완료조건 미달은 다음 Phase로 넘어가지 않는다.

## 현재 상태 (2026-08-03 현행화)

> **축: 현재 운영 상태와 이 문서가 맡지 않는 상태 정본**
> **근거: 손목록** — 운영 사실은 생성 등록부·최신 HANDOFF와 대조한다.

### 현재 운영 범위

**Phase 0B~6 출고 완료 — 실사용 가능한 PWA가 운영 중이다**(버전·기능의 정본은 `src/app/changelog.ts`, 최신 상태는 `docs/HANDOFF.md`·`docs/HANDOFF_CODEX.md`). 다기기 동기화(Google OAuth·초대제·journey 스키마)·사진 R2 저장·지도·비용·백업·안드로이드 셸(APK)까지 라이브다. 운영 DB migration은 0028까지 적용.

### 상태 정본과 역사 경계

> 🔴 이 문서는 2026-08-03까지 스캐폴딩 시절("아직 코드 없음")에 멈춰 있었다 — 문서·코드
> 교차검증에서 발견해 현행화했다. 아래 Phase 절들은 **계획의 역사**로 남기되, 각 절 머리에
> 현재 상태를 표시한다. **미완료 과제와 상태는 `docs/BACKLOG.md`만 정본**이며 이 문서에는
> 복제하지 않는다. 완료된 검증·구현의 증거도 BACKLOG 완료 아카이브에서 T-번호로 찾는다.

---

## Phase 0 — 저장소 기반 (S-10: Gate 0A / Phase 0B 분리)

> **축: 읽기중심 감사와 실행 기반 구축**
> **근거: 손목록** — 당시 완료 체크와 저장소 산출물로 대조한다.

v0.2 S-10에 따라 첫 실행에서 문서와 scaffold가 혼재하지 않도록 두 게이트로 나눈다:
- **Gate 0A — 읽기중심 audit·docs·agents.** 코드·의존성·migration·배포 **금지**. 저장소 조사와 문서·레지스트리·에이전트 정의만.
- **Phase 0B — scaffold·CI·hook·Supabase local.** Gate 0A 감사 결과를 반영해 코드 골격을 시작.

### Gate 0A — 완료조건 (이번 세션에서 사실상 완료)
- [x] 저장소 조사 + 현재 코드 ↔ 설계지시서 충돌 식별(기존 MVP 스택 불일치 → 사용자 승인 하에 삭제 후 신규 구조).
- [x] Gate 0A 산출물: `docs/REPOSITORY_AUDIT.md`, `docs/CONFLICT_REPORT.md`, `docs/ACTIVE_TASKS.md`, `schemas/agent-report.schema.json`.
- [x] 핵심 문서 생성/정련: PROJECT_SPEC(S-01~S-04 범위 정련) · ARCHITECTURE · DATA_MODEL · SECURITY · PRIVACY · SYNC_PROTOCOL · MEDIA_PIPELINE · DEPLOYMENT · LESSONS · AGENT_REGISTRY(필수 독립검토 열·공통 실행규칙·호출 원칙) · TEST_PLAN · ROADMAP · DECISIONS · ASSUMPTIONS · HANDOFF · CHANGELOG.
- [x] `CLAUDE.md` · `AGENTS.md`(S-07 report 스키마 검증 · S-08 소유권 · S-09/S-10) 생성·정련.
- [x] 전체 139개 논리 역할 → 26 물리 에이전트(통합 10 + 디자인 16)를 `docs/AGENT_REGISTRY.md`·`.claude/agents/`에 등록.
- [x] hook 후보를 `.claude/settings.json`과 `docs/SECURITY.md`에 분류(차단 모드 미활성).
- [x] 선행 프로젝트 교훈을 `docs/LESSONS.md`에 추출·적용.

> Gate 0A 금지선 준수: dependency 설치·migration 적용·Storage/배포·destructive Git 없음. commit/push/PR은 사용자 승인 후.

### (참고) 원 Phase 0 스캐폴딩 항목 — 이번 작업에서 완료한 것
- [x] 저장소 조사 + 현재 코드 ↔ 설계지시서 충돌 식별(기존 MVP 스택 불일치 → 사용자 승인 하에 삭제 후 신규 구조).
- [x] 핵심 문서 생성: PROJECT_SPEC · ARCHITECTURE · DATA_MODEL · SECURITY · PRIVACY · SYNC_PROTOCOL · MEDIA_PIPELINE · DEPLOYMENT · LESSONS · AGENT_REGISTRY · TEST_PLAN · ROADMAP · DECISIONS · ASSUMPTIONS · HANDOFF · CHANGELOG.
- [x] `CLAUDE.md` · `AGENTS.md` 생성.
- [x] 전체 139개 역할을 `docs/AGENT_REGISTRY.md`에 등록.
- [x] 통합 에이전트 10개 + 디자인 에이전트 16개를 `.claude/agents/`에 생성.
- [x] hook 후보를 `.claude/settings.json`과 `docs/SECURITY.md`에 분류.
- [x] 선행 프로젝트 교훈을 `docs/LESSONS.md`에 추출·적용.

### Phase 0B — scaffold·CI·hook·Supabase local (코드 골격 — 착수)
- [x] Vite + TypeScript 실행 (`package.json`, `vite.config.ts` **base=/Travel-Memories/**, `tsconfig.json`, `index.html`, `src/main.ts`). 빌드·타입체크 통과.
- [x] 기본 화면 1개(홈 빈 상태) 표시 + 라우터 골격(하위경로 인식, 안전 폴백). 라이브 렌더 확인(에러 0).
- [x] 환경변수 구조(`.env.example` — **publishable 키** 자리, service_role 금지).
- [x] CI(GitHub Actions `ci.yml`) + 단일 `harness` 문 + **GitHub Pages 배포 워크플로**(`deploy-pages.yml`, 404 복제·시크릿 스캔).
- [x] `check-secret-leak`·`commit-msg` hook 실동작(`.githooks`, `core.hooksPath` 활성). `check-domain-wiring` 게이트 동작.
- [x] `DOMAIN_REGISTRY`(`src/domain/registry.ts`) + 대칭 게이트 스텁(18 도메인 정합).
- [x] `docs/records/coding-mistakes.md` 실수 원장 운영 시작.
- [x] SW 캐시 버저닝 — `public/sw.js`의 `CACHE='journey-shell-v2'`(판 올림 방식) · OAuth PKCE 실연동 라이브(2026-08-03 교차검증으로 [x] 확인 — 문서만 낡아 있었다).
- [x] 배선맵·경계 게이트 — 원래 구상(`TERMINALS`·empty-seed 게이트)은 그 이름으로 만들지 않았고, 목적은 `src/app/blueprint.ts` SOURCES + `check-blueprint`·`check-schema-parity`(rowmap↔서버 컬럼)·`check-domain-wiring`이 다른 형태로 달성했다(이름이 아니라 행동 기준 — 게이트 헌장 §2-I).
- [x] **강제층(S-09) 구현 완료**(2026-08-03 · T-003) — `.claude/settings.json`에 PreToolUse 훅 2종: `hook-sql-safe`(Supabase execute_sql/apply_migration의 파괴적 SQL 차단, `BEGIN…ROLLBACK`과 이유 있는 `-- sql-safe-ok:`만 예외)와 `hook-secret-guard`(Write/Edit에 자격증명 **형태** 쓰기 차단 — 낱말이 아니라 형태라 계약 문서는 계속 고칠 수 있다). 탐지는 `lib/secret-patterns.mjs` 한 곳이 정본이라 게이트와 갈라지지 않는다. `check-hooks-wired`가 등록·실재·셀프테스트를 대조해 다시 비워지면 RED다.

> (역사) Supabase 프로비저닝·migration·pgTAP·실제 사진/동기화/지도 로직은 Phase 1+로 계획했었다.

## Phase 1 — 인증과 여행 ✅ 출고

> **축: 구현 범위와 종결 근거**
> **근거: 손목록** — 현재 앱·BACKLOG 완료 증거와 대조한다.

### Phase 1 구현 범위

Google OAuth(PKCE)·세션 복구·여행 생성/수정/삭제(tombstone push)·타임라인·소유자 RLS+초대제 공격검사·실연동 다기기 동기화까지 라이브다.

### Phase 1 상태와 근거

출고 완료. 과제 상태와 실기기 검증 증거의 정본은 `docs/BACKLOG.md`다.

## Phase 2 — 순간과 타임라인 ✅ 출고

> **축: 구현 범위와 종결 근거**
> **근거: 손목록** — 현재 앱·BACKLOG 완료 증거와 대조한다.

### Phase 2 구현 범위

순간 생성 · 날짜별 타임라인 · 감정·중요기억 · 오프라인 작성 · 재접속 동기화.

### Phase 2 상태와 근거

출고 완료. 세부 구현·검증 이력은 최신 HANDOFF와 BACKLOG 완료 아카이브가 정본이다.

## Phase 3 — 사진 ✅ 출고

> **축: 구현 범위와 종결 근거**
> **근거: 손목록** — 현재 앱·BACKLOG 완료 증거와 대조한다.

### Phase 3 구현 범위

다중 선택 · EXIF 추출 · 방향 보정 · WebP 압축 · 썸네일 · 대기열 업로드 · 실패 재시도 · 중복검사 · EXIF GPS 개인정보 정책(`check-exif-strip-on-share` 게이트 포함). 저장소는 Cloudflare R2(ADR-0024)다.

### Phase 3 상태와 근거

출고 완료. 과제 상태와 실기기 검증 증거의 정본은 `docs/BACKLOG.md`다.

## Phase 4 — 지도와 장소 ✅ 출고

> **축: 구현 범위와 종결 근거**
> **근거: 손목록** — 현재 앱·BACKLOG 완료 증거와 대조한다.

### Phase 4 구현 범위

지도 표시(MapLibre) · 장소 마커 · 장소 1급 도메인(0022~0023) · 수동 수정 · GeoJSON 내보내기.

### Phase 4 상태와 근거

출고 완료. 세부 구현·검증 이력은 최신 HANDOFF와 BACKLOG 완료 아카이브가 정본이다.

## Phase 5 — 비용과 회고 ✅ 출고

> **축: 구현 범위와 종결 근거**
> **근거: 손목록** — 현재 앱·BACKLOG 완료 증거와 대조한다.

### Phase 5 구현 범위

비용 기록 · 통화·환율 환산 · 통화별 합계 · 대표사진 · 회고.

### Phase 5 상태와 근거

출고 완료. 세부 구현·검증 이력은 최신 HANDOFF와 BACKLOG 완료 아카이브가 정본이다.

## Phase 6 — 백업과 안정화 ✅ 출고

> **축: 구현 범위와 종결 근거**
> **근거: 손목록** — 현재 앱·BACKLOG 완료 증거와 대조한다.

### Phase 6 구현 범위

JSON/ZIP 내보내기·복원(암호화 포함) · 고아파일 검사 · 진단 도구 일습 · 전체 보안검사 · 개발자 정보 화면(ADR-0019 — changelog.ts에서 파생) · 안드로이드 셸(APK)·자동 최신화.

### Phase 6 상태와 근거

출고 완료. 세부 구현·검증 이력은 최신 HANDOFF와 BACKLOG 완료 아카이브가 정본이다.

## Phase 7 — AI 확장 (T-007 · ADR-0060)

> **축: 과거 후보 범위와 종결 결정**
> **근거: 손목록** — T-007 완료 아카이브와 ADR-0060이 결정 근거다.

### Phase 7 과거 후보

AI 요약·태그·검색·OCR·비용추출·로컬 LLM을 MVP 이후 후보로 두었다.

### Phase 7 종결

관측된 필수 불편 없이 개인정보·비용·환각 검증과 새 데이터 생명주기 복잡도를 도입하지 않기로 사용자 결정했다. 구체적 불편이 새로 관측되면 전체 Phase를 되살리지 않고 필요한 기능 하나를 새 과제로 심사한다. AI를 다시 검토하더라도 출력은 사용자 기록과 섞지 않고 `ai_artifacts`에만 두는 비타협 원칙 #2를 유지한다.

## 에이전트 단계별 호출 순서 (§20)

> **축: 공통 실행 단계와 AI 역할 활성 조건**
> **근거: 손목록** — §20 단계 계약과 ADR-0060을 따른다.

### 공통 실행 단계

단계 0(조사·문서화) → 1(제품·데이터 설계) → 2(기반 구현) → 3(핵심 기능) → 4(사진) → 5(오프라인) → 6(보안·적대 검사) → 7(품질·배포).

### AI 역할 활성 조건

AI 에이전트는 ADR-0060에 따라 비실행이며, 새 과제가 승인될 때만 필요한 역할을 다시 심사한다.

## RM-9 이 문서가 못 보는 것

> **축: 현재 운영 사실과 미래 과제의 원리적 경계**
> **근거: 손목록** — 각 사실의 별도 정본을 가리킨다.

### RM-9.1 현재 버전·배포·운영 데이터

이 문서는 현재 앱 버전, 최신 배포 결론, 운영 DB·R2의 실시간 상태를 판정하지 않는다. 버전은 `src/app/changelog.ts`와 생성 등록부, 배포·운영 read-back은 최신 HANDOFF를 따른다.

### RM-9.2 아직 적히지 않은 미래 과제

ROADMAP에 없는 불편이나 아이디어를 자동으로 발견하지 못한다. 실제로 관측된 새 과제의 상태는 `docs/BACKLOG.md` 한 곳에 추가하고, 중요한 결정은 ADR로 남긴다.
