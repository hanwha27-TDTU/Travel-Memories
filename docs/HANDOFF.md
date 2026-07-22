# HANDOFF · Journey Archive

각 작업 종료 시 인계 기록. 최신이 위. 표면 전환(Claude↔Codex) 시 commit+push 후 GitHub에서 재pull하며, 미커밋 변경을 표면 간 이월하지 않는다. (AGENTS.md)

---

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
