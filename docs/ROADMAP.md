# ROADMAP · Journey Archive

설계지시서 §27·§28. 각 Phase는 명시적 완료조건을 갖는다. 완료조건 미달은 다음 Phase로 넘어가지 않는다.

## 현재 상태

**Phase 0 진행 중 — 설계·스캐폴딩.** 문서(`docs/`)와 에이전트 팀(`.claude/agents/`) 구성 완료 단계. 아직 제품 기능·앱 골격 코드는 없다.

---

## Phase 0 — 저장소 기반 (진행 중)

### 이번 작업(문서·에이전트 스캐폴딩)에서 완료한 것
- [x] 저장소 조사 + 현재 코드 ↔ 설계지시서 충돌 식별(기존 MVP 스택 불일치 → 사용자 승인 하에 삭제 후 신규 구조).
- [x] 핵심 문서 생성: PROJECT_SPEC · ARCHITECTURE · DATA_MODEL · SECURITY · PRIVACY · SYNC_PROTOCOL · MEDIA_PIPELINE · DEPLOYMENT · LESSONS · AGENT_REGISTRY · TEST_PLAN · ROADMAP · DECISIONS · ASSUMPTIONS · HANDOFF · CHANGELOG.
- [x] `CLAUDE.md` · `AGENTS.md` 생성.
- [x] 전체 139개 역할을 `docs/AGENT_REGISTRY.md`에 등록.
- [x] 통합 에이전트 10개 + 디자인 에이전트 16개를 `.claude/agents/`에 생성.
- [x] hook 후보를 `.claude/settings.json`과 `docs/SECURITY.md`에 분류.
- [x] 선행 프로젝트 교훈을 `docs/LESSONS.md`에 추출·적용.

### Phase 0 남은 완료조건 (다음 작업 — 코드 골격)
- [ ] Vite + TypeScript 실행 (`package.json`, `vite.config.ts` **base=/Travel-Memories/**, `tsconfig.json`, `index.html`, `src/main.ts`).
- [ ] 기본 화면 1개 표시 + 라우터 골격(하위경로 인식).
- [ ] 환경변수 구조(`.env.example` — Supabase URL/anon key 자리, service_role 금지).
- [ ] CI 기본검사(GitHub Actions) + 단일 `harness` 문 스텁 + **GitHub Pages 빌드→배포 워크플로**(`docs/DEPLOYMENT.md`).
- [ ] `check-secret-leak` · `check-supabase-sql-safe` · `commit-msg` hook 실동작.
- [ ] `DOMAIN_REGISTRY` + 대칭 게이트 스텁, `TERMINALS` + 배선맵 생성기 스텁.
- [ ] `docs/records/coding-mistakes.md` 실수 원장 운영 시작.
- [ ] SPA 라우팅 확정(history+404 복제) + OAuth PKCE + SW 캐시 버저닝.
- [ ] camelCase↔snake_case 경계 게이트 + empty-seed 게이트.
- [ ] `check-secret-leak`·`commit-msg` hook을 코드 골격보다 먼저.

> Phase 0 코드 골격은 별도 작업으로 진행하며, 시작 전 변경 예정 파일 목록을 사용자에게 제시한다.

## Phase 1 — 인증과 여행
**소셜 로그인(Google OAuth)** · 세션 복구 · 여행 CRUD · **소유자 범위 RLS 공격검사 통과** · IndexedDB 로컬 저장. (Supabase Auth에 Google OAuth 클라이언트 연동, Pages 도메인 CORS 등록.)

## Phase 2 — 순간과 타임라인
순간 생성 · 날짜별 타임라인 · 감정·중요기억 · 오프라인 작성 · 재접속 동기화.

## Phase 3 — 사진
다중 선택 · EXIF 추출 · 방향 보정 · WebP 압축 · 썸네일 · 대기열 업로드 · 실패 재시도 · 중복검사 · **EXIF GPS 개인정보 정책 확정(공유 시 GPS 제거 게이트 `check-exif-strip-on-share` 포함)**.

## Phase 4 — 지도와 장소
지도 표시 · 장소 마커 · 자동 위치 후보 · 수동 수정 · GeoJSON 내보내기.

## Phase 5 — 비용과 회고
비용 기록 · 통화별 합계 · 여행 회고 · 대표사진 · 여행 완료처리.

## Phase 6 — 백업과 안정화
JSON 내보내기·복원 · CSV·GeoJSON · 고아파일 검사 · 대량사진 검사 · 저메모리 검사 · 전체 보안검사.

## Phase 7 — AI 확장 (MVP 완료 후, 별도 branch)
AI 요약·태그·검색·OCR·비용추출·로컬 LLM. 핵심 기능이 안정된 뒤에만 활성화.

## 에이전트 단계별 호출 순서 (§20)
단계 0(조사·문서화) → 1(제품·데이터 설계) → 2(기반 구현) → 3(핵심 기능) → 4(사진) → 5(오프라인) → 6(보안·적대 검사) → 7(품질·배포). AI 에이전트는 MVP 안정화 후.
