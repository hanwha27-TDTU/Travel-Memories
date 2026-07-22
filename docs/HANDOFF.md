# HANDOFF · Journey Archive

각 작업 종료 시 인계 기록. 최신이 위. 표면 전환(Claude↔Codex) 시 commit+push 후 GitHub에서 재pull하며, 미커밋 변경을 표면 간 이월하지 않는다. (AGENTS.md)

---

## 🔰 인계 요약 (다음 세션/AI 시작점)

> **새 AI(Claude 또는 Codex)는 여기부터 읽는다.** 저장소가 최종 정보원이며, 아래만으로 현재 단계와 다음 행동을 파악할 수 있어야 한다.

**현재 단계**: **Phase 0B 코드 골격 완료.** Gate 0A(감사·문서·에이전트) → v0.2 정밀 병합 → Phase 0B(Vite+TS 골격, 빌드·타입체크·하네스·라이브 렌더 통과)까지 끝. 활성 task 없음(`docs/ACTIVE_TASKS.md`). 브랜치 `claude/travel-log-app-r2xd5f`, origin 동기화됨.

**읽기 순서**:
1. `CLAUDE.md`(Claude) / `AGENTS.md`(Codex) — 어댑터·비타협 원칙·작업 루프
2. `docs/PROJECT_SPEC.md`(최상위) → `docs/LESSONS.md`(교훈)
3. 도메인 계약: `DATA_MODEL` · `SYNC_PROTOCOL` · `SECURITY` · `MEDIA_PIPELINE` · `PRIVACY` · `DEPLOYMENT` · `ARCHITECTURE`
4. `docs/AGENT_REGISTRY.md`(139역할→26에이전트) → `docs/DECISIONS.md` + `docs/ASSUMPTIONS.md`
5. `docs/ROADMAP.md`(Phase 계획) → `docs/ACTIVE_TASKS.md` → 이 HANDOFF
6. v0.2 원본 참조: `docs/reference/v0.2/`

**클론 후 검증**(그대로 실행):
```
npm ci
git config core.hooksPath .githooks   # commit-msg hook 활성
npm run harness                        # Required 게이트 전체 (목록은 scripts/harness.mjs — 손편집 나열 금지, M-0001)
npm run build                          # base=/Travel-Memories/ 정적 빌드
npm run dev                            # 홈 화면 확인 (선택)
```

**다음 작업 후보**:
- (a) **Phase 0B 잔여**: SW 캐시 버저닝 · 배선맵(TERMINALS) 생성기 · camelCase↔snake_case 경계 게이트 · empty-seed 게이트.
- (b) **Phase 1**: 인증(Google, invite-only·소유자 한정) · 여행 CRUD · 소유자 범위 RLS · 오프라인 저장. **Supabase 프로젝트 생성 필요**.

**사용자 대기 열린 결정**: 지도 타일 제공자·예산(A-006) · Supabase 프로젝트 생성 시점(Q4) · Google OAuth 설정(Q5) · ADR-0015 인라인 AI 컬럼 제거 검토.

**협업 규칙**(AGENTS.md): 별도 클론 · `claude/*`·`codex/*` 브랜치 · `main` 직접 push 금지 · 뜨거운 파일 단일 PR 직렬화 · task는 `docs/ACTIVE_TASKS.md`에 등록 · agent 보고서는 `schemas/agent-report.schema.json` 검증(`artifacts/agent-reports/`) · **완료 = 배포 그린 확인**.

---

## HANDOFF-0004 · 적대적 검토 중간 항목 일괄 (TASK-0004)
- 작업 ID: TASK-0004 · 담당: Claude Code · 날짜: 2026-07-22 · 브랜치: `claude/travel-log-app-r2xd5f`
- 목표: HANDOFF-0003 "남은 위험" 중간 항목 6건 해소.
- 변경: ① 스캐너 범위=git 추적 전체(docs/ 제외·사유 명시)+dist, 패턴 추가(sbp_·Google API 키·PEM), `.env` 추적 차단, SECURITY.md 서술을 구현 실체로 정정(엔트로피=미구현·후속 명시) ② `tests/unit/`(router·registry 9케이스) 신설, `pathToRoute` base 주입 순수함수화, 하네스에 `unit-tests` 게이트 — `npm test` RED 해소 ③ `check-domain-wiring` 기대 집합을 손편집 상수에서 DATA_MODEL.md 헤딩 파생으로 교체(셀프테스트 4케이스) ④ base SSOT: index.html 링크 `%BASE_URL%` 파생 + manifest 중복은 `check-base-consistency` 게이트로 대조(셀프테스트 6케이스) ⑤ ci.yml pull_request 트리거 제거(중복 실행)+concurrency 취소 ⑥ PWA 아이콘 PNG 파생 생성(192/512/maskable/apple-touch, `scripts/generate-icons.mjs`, icon.svg=SSOT·산출물 커밋) + index.html manifest/apple-touch 링크(기존엔 manifest 링크 자체가 없어 PWA 설치 불가였음).
- 실행 검사(실제 결과): `npm run harness` 6게이트 전부 PASS · `npm test` 9/9 PASS · `npm run build` 성공, dist/index.html에 base 치환 확인 · PNG 4종 생성·픽셀 확인(512px 시각 확인). (자동층만 통과 표기 — 실기기 PWA 설치·iOS 홈화면 아이콘은 사용자 확인 권장.)
- 남은 위험(선택 항목): 고엔트로피 일반 토큰 탐지 미구현(문서에 후속 명시) · fork PR 받을 경우 ci.yml pull_request 재도입 필요(주석 명시) · maskable 아이콘 safe-zone은 자동 검증 없음(시각 확인만).
- 되돌리기: 이 커밋들 revert.

## HANDOFF-0003 · 적대적 검토 후속 수정 (TASK-0003)
- 작업 ID: TASK-0003 · 담당: Claude Code · 날짜: 2026-07-22 · 브랜치: `claude/travel-log-app-r2xd5f`
- 목표: 적대적 저장소 검토에서 확인된 결함 5건을 우선순위대로 수정.
- 변경: ① `scripts/check-secret-leak.mjs` — matchAll 전수 판정 + 셀프테스트 내장(M-0004, 우회 재현→수정→재현 차단 확인) ② `src/offline/db.ts` — `deletedAt` 인덱스 제거(M-0005) ③ `.github/workflows/deploy-pages.yml` — `vars.*` env 주입 + `docs/DEPLOYMENT.md` 활성화 절차 ④ `index.html` CSP 확장(wss·worker-src blob:·Storage img-src) + `scripts/check-csp.mjs` 게이트 신설·하네스 편입 ⑤ `.githooks/commit-msg` — Revert/Merge 허용 + `[skip actions]`·`skip-checks:` 차단.
- 실행 검사(실제 결과): 시크릿 스캐너 우회 픽스처 exit 1(RED) 확인 · 훅 픽스처 7케이스 전부 기대대로 · `npm run harness`(4게이트) PASS · `npm run build` 성공. (자동층만 통과 표기 — CSP의 실브라우저 동작·Pages 배포는 미검증: 지도/Realtime 미구현 + main 미병합.)
- 남은 위험(미수정, 검토에서 지적됨): 스캐너 커버리지가 SECURITY.md 주장보다 좁음(docs/scripts/.github 미스캔·엔트로피 미구현) · `npm test` 테스트 0개로 RED · base 경로가 vite.config/manifest 2곳 손편집 중복 · `check-domain-wiring` EXPECTED 손편집 사본 · CI 중복 실행(`push: '**'`+PR) · PWA 아이콘 SVG 단독(iOS) · 프로덕션 소스맵 공개.
- 운영 필요(사용자): Settings→Pages→Source="GitHub Actions" 설정 · Supabase 프로비저닝 후 Actions Variables 등록 · main 병합 후에만 배포 발동.
- 되돌리기: 이 커밋들 revert (훅이 이제 Revert 제목을 허용함).

## HANDOFF-0002 · Phase 0B 코드 골격
- 작업 ID: TASK-0002 · 담당: Claude Code · 날짜: 2026-07-22 · 브랜치: `claude/travel-log-app-r2xd5f`
- 목표: Vite+TS 골격이 빌드·타입체크·렌더되고 CI·배포·hook·레지스트리 게이트가 동작(기능 없음).
- 변경 파일: `package.json`·`tsconfig.json`·`vite.config.ts`·`.gitignore`·`.env.example`·`index.html`; `src/`(main·app/router·ui/screens/home·ui/styles/{tokens,app}.css·domain/registry·offline/db·services/supabase/client); `public/`(manifest·icons); `scripts/`(harness·check-secret-leak·check-domain-wiring); `.github/`(ci·deploy-pages·PR 템플릿); `.githooks/commit-msg`.
- DB/Storage 변경: 없음(Supabase 미프로비저닝).
- 보안/개인정보: 번들에 publishable 키만(시크릿 형태 스캔 통과). service_role/secret 부재.
- 실행 검사(실제 결과): `npm run typecheck` PASS · `npm run harness`(typecheck+secret-leak+domain-wiring) PASS · `npm run build` 성공(base 주입 확인) · Playwright 라이브 렌더 콘솔/페이지 에러 0. (자동층만 통과 표기 — 실기기·시각 미검증.)
- 남은 위험: SW 캐시·배선맵 생성기·경계 게이트 미구현; ADR-0015 인라인 AI 컬럼 제거 reviewer 확인 대기; CI/배포 워크플로는 GitHub에서만 실행됨(로컬 미검증).
- 다음 작업: Phase 0B 잔여(SW·게이트) 또는 Phase 1(인증·여행 CRUD·RLS). Supabase 프로젝트 생성 시 A-014 항목 확정.
- 되돌리기: 이 커밋 revert.

## HANDOFF-0001 · Phase 0 설계·에이전트 스캐폴딩
- 작업 ID: TASK-0000 · 담당 도구: Claude Code · 날짜: 2026-07-22
- 브랜치: `claude/travel-log-app-r2xd5f`
- 목표: 설계지시서 §28·§29에 따른 문서·에이전트·Phase 0 계획 스캐폴딩 (기능 구현 없음).
- 변경 파일:
  - 삭제: `index.html`, `css/styles.css`, `js/app.js`, `js/db.js` (기존 MVP — git 히스토리 보존).
  - 신규 문서: `CLAUDE.md`, `AGENTS.md`, `README.md`(개정), `docs/`(PROJECT_SPEC, ARCHITECTURE, DATA_MODEL, SECURITY, PRIVACY, SYNC_PROTOCOL, MEDIA_PIPELINE, DEPLOYMENT, LESSONS, AGENT_REGISTRY, TEST_PLAN, ROADMAP, DECISIONS, ASSUMPTIONS, HANDOFF, CHANGELOG).
  - 신규 에이전트: `.claude/agents/` 통합 10 + 디자인 16 = 26개.
  - `.claude/settings.json`(hook 후보 문서화), `.claude/agents/README.md`(등록부 인덱스).
- DB 변경: 없음. Storage 변경: 없음.
- 보안 영향: 소유자 범위 RLS·시크릿·EXIF PII 정책을 문서로 확정(코드 미구현). hook 후보 분류.
- 개인정보 영향: EXIF GPS 민감 PII 정책 잠정 기록(Phase 4 확정 예정).
- 실행 검사: 에이전트 frontmatter(name/model/tools) 기계 확인. 문서 인벤토리 카운트는 이번 검토에서 드리프트(123 역할·15종 표기, 유령 엔티티 `markers` 등)를 발견하여 정정함. 앱 코드 없음 → 자동 테스트 해당 없음(정직한 완료: 자동 검증층 미적용 단계, 문서 일관성은 육안+grep 검토 수준으로 오버클레임 아님).
- 실패 검사: 없음.
- 남은 위험: Phase 0 코드 골격(Vite 초기화) 미착수. 사용자 확인 대기 항목(사진 저장 모드·인증 방식·지도 제공자·Supabase 프로젝트).
- 다음 작업: Phase 0 코드 골격 — 변경 예정 파일 목록 제시 후 착수.
- 되돌리기: 이 커밋 revert 시 MVP는 git 히스토리에서 복구 가능.
