# HANDOFF · Bugeon Journey

각 작업 종료 시 인계 기록. 최신이 위. 표면 전환(Claude↔Codex) 시 commit+push 후 GitHub에서 재pull하며, 미커밋 변경을 표면 간 이월하지 않는다. (AGENTS.md)

---

## 🔰 인계 요약 (다음 세션/AI 시작점)

> **새 AI(Claude 또는 Codex)는 여기부터 읽는다.** 저장소가 최종 정보원이며, 아래만으로 현재 단계와 다음 행동을 파악할 수 있어야 한다.

**현재 단계**: **Phase 1 — 동기화 push/pull 코드 구현 완료(실 연동 대기).** trips 로컬층 + journey 스키마(RLS 공격검사 통과) 위에, 인증(Google OAuth PKCE)·동기화(push 멱등 upsert+read-back+LWW, pull 빈-클라우드 가드 병합)를 구현. 순수 결정로직 15 유닛테스트로 잠금. **미검증(정직)**: 실 Google 로그인→journey.trips 실 push는 (a)대시보드 Exposed schemas에 journey 추가 (b)Google OAuth provider+redirect 허용목록 (c)GitHub Variables 설정 후, 두 브라우저/기기로 수동 검증 필요(이 샌드박스는 *.supabase.co 차단으로 불가). 브랜치 `claude/travel-log-app-r2xd5f`, origin 동기화됨.

**Phase 3f(2026-07-23)**: 사진 편집기 전면 개선(v0.24). ① 성능: `bakeToCanvas`가 기하 중간 캔버스를 원본 전체 해상도로 만들던 것을 필요 배율로 프리스케일(12MP급에서 프레임당 수십 MB 할당 제거) + 드래그 중 저해상(FAST_MAX 420)→손 떼면 고해상(900) 2단계 미리보기 + 그레인 고정 시드(mulberry32, 미리보기 어른거림 제거·저장 재현성). ② UX: 미리보기 상단 sticky·액션바 하단 sticky(보면서 조절), 슬라이더 값 표시+라벨 더블탭 개별 초기화, 프리셋 aria-pressed 활성 표시(수동 조정 시 해제), 👁 원본 비교(홀드, 기하 유지·색/효과/잡티 제외), 두 손가락 핀치 줌(🔍 슬라이더 연동), 적용 중… 진행 표시, Esc 닫기+편집 존재 시 confirm 보호, 배치 추가 시 "⏭ 남은 N장 모두 원본"(action='skipAll' — 장당 편집기 강제 통과 제거). ③ 결함 수정: 자유 크롭 서/북 핸들을 경계 밖으로 끌면 반대 변이 늘어나던 클램프 결함 → `resizeFreeCrop` 순수함수로 추출(변 좌표 기준 클램프, 유닛 5) · 뷰어 사진 탭 시 닫힘 방지 + Esc 리스너 누수 수정. 검증: harness 6게이트 PASS · 유닛 90/90 · 라이브(Playwright/Chromium, dist 서빙) 17/17 PASS(값 표시·프리셋 해제·비교 홀드 픽셀 왕복·Esc confirm·배치 2장·뷰어) · 콘솔 에러 0. 실기기 터치(핀치·더블탭)는 사용자 확인 권장.

**Phase 4b(2026-07-23)**: 장소 검색(지오코딩). Nominatim(무료·키 불필요, 구글맵은 키·결제라 제외). `services/geocode.ts`(순수 URL·파서, 유닛 6). `LocalMoment.placeLat/placeLng`+rowmap. 생성·편집 폼 공통 `buildPlaceField`(🔍검색→결과 선택→좌표 저장, 결과는 textContent 안전). 지도 좌표 우선순위: 장소 좌표→사진 GPS. CSP에 nominatim.openstreetmap.org. **후속**: moment 서버 sync 시 place_lat/place_lng 컬럼 마이그레이션 필요. 라이브 검증: Playwright 자체 서빙+Nominatim 목킹으로 검색→선택→저장→지도표시(세션 후반 로컬서버 불안정 우회).

**Phase 3e(2026-07-23)**: 저장된 사진 재편집(비파괴). 뷰어 `✎ 편집` → `openPhotoEditor(원본Blob, {initialState})` → `reeditMediaLocalFirst`(원본·EXIF 불변, 표시본·썸네일 재생성, version+1). `LocalMedia.editState`(순수값)로 이어서 편집·백업 포함. 라이브 검증: 회전 재편집 시 치수 스왑·원본 크기 불변·editState 저장, 콘솔 에러 0. (참고: 이 세션 후반 vite preview 기동 불안정 → dist 정적 서버로 검증.)

**Phase 4(2026-07-23)**: 지도와 장소. ADR-0023(A-006 OSM 래스터 기본·교체가능, CSP에 tile.openstreetmap.org). `domain/place/geojson.ts`(순수, 유닛 4)·`ui/screens/mapView.ts`(여행 🗺 지도 → MapLibre 동적import·마커·DOM 팝업·장소목록 대체·GeoJSON 내보내기). tripDetail 히어로에 지도 버튼·refresh에서 locatedPoints 계산(사진 EXIF GPS). 라이브 검증: 빈상태·장소목록·강등폴백·GeoJSON, 앱 콘솔 에러 0. 실 타일 지도는 사용자 실기기 몫. 남은 Phase 5: 회고(Reflection)·대표사진.

**Phase 5a(2026-07-23)**: 비용(Expense) 기록. `LocalExpense`(Dexie v4)·`domain/expense/format.ts`(순수, 유닛 9)·`services/expenses.ts`(로컬 전용, 동기화 후속). tripDetail에 금액+통화 입력·money chip·통화별 합계·인라인 편집. 순간/여행 삭제·복원·영구삭제·백업에 비용 cascade 통합. 라이브 검증: 생성·다통화·편집·백업 왕복, 콘솔 에러 0. 남은 Phase 5: 회고(Reflection)·대표사진. Phase 4(지도)는 미착수. **PR #12 병합됨 → 이 브랜치는 main에서 새로 뜬 상태.**

**Phase 3d(2026-07-23)**: 데이터 관리 허브 — 홈 `📦 데이터 관리` → 백업·복원·휴지통·가이드(가이드 버튼을 이 안으로 이동). 백업/복원은 `src/services/backup.ts`(사진 base64 포함 JSON, 복원은 mergeDecision+빈-데이터 가드 병합, 손 병합 없음). 휴지통은 `trips.ts`(listDeletedTrips·restoreTripFromTrash·purgeTripPermanently). 라이브 검증: 백업→초기화→가져오기 왕복(사진 썸네일 렌더 포함) + 휴지통 복원, 콘솔 에러 0. 정직: 영구삭제 서버 전파는 동기화 실연동 후속.

**Phase 3c(2026-07-23)**: 여행 삭제(cascade tombstone + 실행취소) — Trip 생명주기 대칭성 회복. 공용 실행취소 토스트를 `src/ui/toast.ts`로 분리(body 부착·화면 전환 유지). **가이드 화면**(홈 `📖 가이드` → 2열 모달 [연결·설정]/[개발·설계], `src/ui/screens/guide.ts`) 추가 — 콘텐츠는 이 저장소 실제 사실(harness 6게이트·26 에이전트·비타협 원칙)로 구성, 손 스냅샷이라 레지스트리 파생 게이트는 후속. 라이브 검증(Playwright/Chromium): 생성→편집→삭제→실행취소→cascade 복원 전 과정 + 가이드 렌더, 콘솔 에러 0.

**Phase 3b(2026-07-23)**: 순간 편집·삭제 + 사진 개별 삭제 구현. 하드 삭제 없음(§0) — `deletedAt` tombstone + 5초 실행취소(§5). 순간 삭제 시 사진 cascade tombstone(undo가 함께 복원), 미디어는 로컬 전용이라 sync 큐 op 없음. 편집으로 그간 미사용이던 `note`·`occurredAt` 사용 가능. 서비스: `updateMomentLocalFirst`/`softDeleteMomentLocalFirst`/`restoreMomentLocalFirst`(moments.ts), `softDeleteMediaLocalFirst`/`restoreMediaLocalFirst`(media.ts). **연역적 발견(미구현·후속)**: Trip은 여전히 삭제(tombstone) 없이 보관만 존재 — 엔티티 생명주기 대칭성 결손. **미검증(정직)**: 실기기 라이브 상호작용 미실행.

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
