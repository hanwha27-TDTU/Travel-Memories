# CLAUDE.md · Bugeon Journey

이 파일은 프로젝트 맥락 제공용이다. **반드시 차단해야 하는 행위는 `.claude/settings.json`의 hooks로 통제할 예정이다**(Phase 0에서 활성화; 현재 `settings.json` hooks는 비어 있음). 이 문서는 판단 기준과 작업 규율을 제공한다. 저장소 자체가 최종 정보원이다.

---

## 북극성 (North Star)

> 사진, 장소, 비용과 짧은 감정을 자동으로 연결하여, **여행 당시의 기억과 여행이 나에게 남긴 의미를 다시 찾아주는** 개인 여행기록 앱.

모든 기능·설계·코드는 한 가지 질문으로 판단한다: **"이게 그 목적을 더 잘 이루는가?"**

## 비타협 원칙 (목적의 일부이지, 목적과 맞바꿀 대상이 아니다)

1. **사용자의 기억을 잃지 않는다.** **내구성 로컬 커밋(Dexie entity+operation atomic commit) 이후 앱 원인 유실은 0**이다(브라우저 축출·사용자의 사이트데이터 삭제는 앱 통제 밖 → 백업·persist()·경고로 완화, `docs/SYNC_PROTOCOL.md`). 원본 사진은 사용자 기기에서 변경/삭제하지 않는다.
2. **사용자 기록과 AI 생성물을 섞지 않는다.** AI 출력은 사용자 필드가 아니라 **`ai_artifacts` 테이블(Phase 7)**에만 저장하고, AI 결과를 사용자 작성글처럼 표시하지 않는다.
3. **개인자료는 기본 비공개.** 여행·사진·GPS·동행인·비용·회고 모두 비공개가 기본. 승인 없는 공유/소셜 기능 없음.
4. **정직한 완료.** 자동 검증층이 통과한 것만 "통과"라 말한다. 시각·픽셀·실기기 상호작용은 "라이브 렌더 미실행 / 사용자 확인 권장"으로 분리 표기한다.
5. **복구 가능성 우선.** 위험한 작업은 사전검증·작업기록·실패복구·재시도·되돌리기·결과확인을 갖춘다.

## 절대 위반 금지 (§0)

- 사용자 원본 자료를 임의로 삭제/덮어쓰지 않는다.
- Supabase `service_role` 키/DB 비밀번호/관리자 JWT를 프론트엔드·번들·저장소·로그·리포트에 넣지 않는다. 클라이언트는 anon/publishable 키만.
- RLS 검증 없이 테이블을 배포하지 않는다.
- 원본 사진을 기본적으로 Supabase에 저장하지 않는다(절약 모드 기본).
- 사진 압축 **전에** 촬영시각·위치정보(EXIF)를 먼저 읽어 별도 저장한다.
- 전체 코드베이스를 이유 없이 재작성하지 않는다.
- 다른 에이전트가 작업 중인 파일을 동시에 수정하지 않는다.
- 자동검사를 통과하지 않은 변경을 완료로 표시하지 않는다.
- 사용자 승인 없이 소셜/공개 공유 기능을 추가하지 않는다.

---

## 기술 스택

TypeScript(strict) · Vite · Vanilla TS 컴포넌트 · Supabase(Auth/Postgres/Storage) · Dexie(IndexedDB) · MapLibre GL JS · GeoJSON · Web Worker+OffscreenCanvas(WebP) · Service Worker · Vitest · Playwright · GitHub Actions.

> 프레임워크는 MVP에서 추가하지 않는다. Vanilla 구조가 유지 불가능하다고 **실제 측정**된 경우에만 기술변경 제안서를 쓴다.

## 순간(Moment) 중심 도메인

`Trip → TripDay → Moment → Media / Place / Expense / Companion / Reflection`
여행을 긴 글 하나로 저장하지 않는다. 상세는 `docs/DATA_MODEL.md`.

---

## 작업 규율 (모델 이식 가능 — Claude Code와 Codex 공통)

품질은 모델이 아니라 규율에서 나온다.

### 0. 코딩 전·중 육하원칙 자문 (Pre-flight 5W1H)

**모든 코드 변경은 착수 전과 진행 중에 여섯 질문에 답할 수 있어야 한다.** 이건 의례가 아니라 결함 예방 장치다 — 답이 막히면 그 지점이 바로 위험이다. 이 프로젝트에선 각 질문이 구체적 관심사에 매핑된다:

- **왜(Why)** — 이게 북극성("기억과 의미를 다시 찾아준다")을 더 잘 이루는가? 아니면 범위 밖인가?
- **무엇을(What)** — 정확한 범위와 완료의 정의는? 무엇을 **안** 바꾸는가(원본 사진·타 에이전트 파일)?
- **어디서(Where)** — 진실원(SSOT)은 어느 파일·문서인가? 이 사실이 이미 어딘가 있어 손편집 중복을 만드는가?
- **언제(When)** — 생명주기·동기화 타이밍(생성/수정/tombstone/복원)·경합(이중 탭·재렌더 중)은? version/updatedAt/read-back 순서가 맞는가?
- **누가(Who)** — 이 데이터의 소유자·RLS 범위는? 어느 에이전트 역할이 검토해야 하는가? 소비 기기인가 생성 기기인가?
- **어떻게(How)** — 구현 경로와 **검증 경로**(어떤 게이트·라이브 렌더로 "현실 확인"할지)는? 실패 시 되돌리기는?

한 질문의 답이 다른 답과 모순되면 멈추고 재설계한다. (예: cascade 삭제에서 "무엇을 함께 지우나(자식 순간·사진)" ↔ "어떻게 되돌리나(정확히 그 자식만 복원)"가 맞물려야 한다.)

### 실행 규율

1. **행동 전 정독, 추측 금지.** SSOT 문서(`docs/`)를 먼저 로드한다.
2. **단일 진실원(SSOT).** 어떤 사실이 2곳 이상에 나오면 하나의 레지스트리를 두고, 파생물은 스크립트로 **재생성**한다. 손편집 중복 자체가 결함이다.
3. **의도가 아니라 현실로 검증.** 정적 게이트가 못 보는 것은 헤드리스 브라우저/실제 DOM 이벤트로 확인한다.
4. **게이트는 비공허하게.** 알려진 실패를 주입해 RED로 잡히는지 확인한 뒤에만 게이트를 신뢰한다. 셀렉터 불일치로 조용히 통과하지 않는지 검사한다.
5. **정직한 완료 보고.** 통과/스킵/실패를 구분해 보고한다. "UI 확인함"을 라이브 렌더 없이 말하지 않는다.
6. **결함 → 결함군 승격.** 버그를 단건으로 고치지 않고 근본형을 한 문장으로 추상화해 모든 형제 위치를 쓸고 게이트를 추가한다.

### 데이터 안전 불변식 (최고 위험 표면 — 상세 `docs/SYNC_PROTOCOL.md`)

- 안정적 `id` + `created_at` + `updated_at`; 동일 id 충돌은 LWW(최신 `updated_at` 우선).
- **하드 삭제 없음** — `deleted_at` tombstone. 오래된 활성 행이 tombstone을 이기지 못한다.
- **빈-클라우드 가드**: 서버가 빈 배열을 줘도 로컬을 덮어쓰지 않는다.
- **정확한 read-back으로 확인**: HTTP 200/성공 토스트가 아니라 같은 레코드를 되읽어 확인한 뒤에만 완료 처리.
- 파이프라인 생성 행(`source=pipeline`)은 소비 기기에서 읽기전용. 로컬에 없다고 tombstone 하지 않는다(오래된 기기가 신선한 클라우드 데이터를 지운다).
- 카메라/EXIF 등 기계 파생 값은 `needs_review`로 시작하고, 재생성이 검토·tombstone된 행을 덮어쓰지 않는다.

## 완료의 정의 (Definition of Done)

구현 완료 → 단위검사 통과 → 통합검사 통과 → 보안검사 통과 → 회귀검사 통과 → 문서 갱신 → 사용자 흐름 확인 → Acceptance 승인. **일부가 아니라 전부** 통과해야 한다.

## Git / 협업

- 지정 브랜치에서 개발한다. 기본 브랜치에 직접 커밋하지 않는다.
- commit: `feat|fix|security|refactor|test|docs|build|chore(scope): 요약`.
- 각 작업 종료 시 `docs/HANDOFF.md`에 인계 기록. 중요한 결정은 `docs/DECISIONS.md`.
- 동시 수정 금지 파일: 동일 DB migration, media pipeline 핵심, 동기화 상태머신, 데이터 형식 정의, Supabase 정책.

## 문서 지도 (SSOT)

`docs/PROJECT_SPEC.md`(요구사항·최상위) · `ARCHITECTURE.md` · `DATA_MODEL.md` · `SECURITY.md` · `PRIVACY.md` · `SYNC_PROTOCOL.md` · `MEDIA_PIPELINE.md` · `DEPLOYMENT.md`(배포 계약) · `AGENT_REGISTRY.md` · `LESSONS.md` · `ROADMAP.md` · `TEST_PLAN.md` · `DECISIONS.md` · `ASSUMPTIONS.md` · `HANDOFF.md` · `CHANGELOG.md` · `REPOSITORY_AUDIT.md` · `CONFLICT_REPORT.md` · `ACTIVE_TASKS.md`. v0.2 원본은 `docs/reference/v0.2/`.
충돌하면 공유 문서(SPEC)가 이긴다. 특정 AI 도구 대화가 아니라 이 문서들이 기준이다.

## 에이전트 운영

139개 논리 역할(`docs/AGENT_REGISTRY.md`)을 통합·디자인 세트로 `.claude/agents/`에 구현(개수는 손으로 세지 않고 `src/app/registry.gen.ts` 자동 집계·`check-registry-gen`이 드리프트 차단). 동시에 다 돌리지 않고 Orchestrator가 필요한 역할만 호출한다. 규칙은 `AGENTS.md`.
