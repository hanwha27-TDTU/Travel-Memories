# ASSUMPTIONS · Bugeon Journey

> 설계지시서 §0 원칙: "불명확한 사항이 있어도 개발을 중단하지 말고, 가장 보수적이고 복구 가능한 기본값을 선택한 뒤 이 문서에 기록한다."
> 각 가정은 확정되면 `docs/DECISIONS.md`로 승격하고 여기서는 상태를 갱신한다.

| ID | 가정 / 기본값 | 근거 | 상태 |
|----|----------------|------|------|
| A-001 | 저장소는 "Bugeon Journey" 신규 구조(TypeScript + Vite + Supabase + Dexie + MapLibre + PWA)로 재구축한다. | 설계지시서 v0.1 §5, §16 | 사용자 승인됨 |
| A-002 | 기존 순수 HTML/JS MVP(index.html, css/, js/)는 **삭제**한다. git 히스토리에는 보존되어 복구 가능. | 사용자 지시("삭제 후 새로"), §0 "원본 임의 삭제 금지"는 사용자 자료(여행기록)에 대한 것이며 프로토타입 코드에는 미적용 | 사용자 승인됨 |
| A-003 | 이번 단계는 **기능 구현 없이** 문서·에이전트 스캐폴딩(Gate 0A)만 수행한다. Phase 0B(Vite·CI·hook·Supabase local)는 별도. | §28·§29 / v0.2 S-10 | Gate 0A 완료 |
| A-004 | 서브에이전트는 통합 10개 + 디자인 확장 16개(레지스트리 124~139)를 생성한다. 전체 139개 역할은 `docs/AGENT_REGISTRY.md`에 등록. | §18~20 + 디자인 에이전트 제안서 | 사용자 승인됨 |
| A-005 | **디자인·UX·비주얼 계열 에이전트는 `fable` 모델**(claude-fable-5)로, 엔지니어링·보안·QA·인프라 계열은 `opus`로 지정한다. | 사용자 지시("설계를 fable5 버전으로 아주 멋지게") | 사용자 승인됨 |
| A-006 | 지도 타일 제공자는 코드에 고정하지 않고 환경변수로 교체 가능하게 한다. 기본 후보는 데모 단계에서 OpenStreetMap/공개 스타일, 운영은 사용량 약관 준수 제공자. | §13.3 | 잠정 |
| A-007 | 사진 기본 저장 정책은 **태블릿 감상 모드**(1600px WebP를 비공개 클라우드 정본으로 저장). 입력 원본 복사본은 서버 read-back 전까지만 IndexedDB에 두고 확인 뒤 정리한다. | 사용자 결정 2026-08-04 · ADR-0046 | **사용자 확정** |
| A-008 | 인증 1차 방식은 **소셜 로그인(Google)**. 이메일 매직링크(무료, 무 SMS비용)는 대안으로 유지. Apple 로그인은 연 $99 개발자 계정 필요 → 보류. | §3.1 · 사용자 지시 | **사용자 확정** |
| A-009 | 기본 언어는 한국어(ko), 다국어 키 구조는 열어둔다. 통화·시간대는 여행별 현지값 저장. | §5, §6, §14 | 잠정 |
| A-010 | 반복 강제 규칙(비밀키 노출 금지, RLS 미검증 배포 금지 등)은 지시문뿐 아니라 Claude Code **hooks**로 통제한다. 후보는 `.claude/settings.json`과 SECURITY 문서에 기록. | §0, §29 | 진행 중 |
| A-011 | 참고 자료(dr-bugeon 스킬, appdevpromptsall.md)는 **다른 앱**의 것이므로 도메인은 이식하지 않고 **교훈만** `docs/LESSONS.md`로 추출·적용한다. | 사용자 지시 | 진행 중 |
| A-012 | **GitHub Pages 정적 배포가 필수 목표.** Vite `base=/Travel-Memories/`, SW scope·라우터 하위경로 대응, 백엔드는 클라이언트→Supabase 직접 호출(publishable 키만 번들). 헤더호스트 병행 미러(ADR-0013). | 사용자 지시 | **사용자 확정** |
| A-013 | v0.2 정밀 병합 채택(ADR-0014~0017): 복합FK·부분인덱스·sync 원장 테이블·deletion_jobs·EXIF 시각/whitelist·publishable 키·pgTAP 2사용자 테스트·불변 Storage·TUS 등. **인라인 AI 컬럼 제거→`ai_artifacts`는 표 구조 변경이라 구현 전 reviewer-release 확인 필요.** | v0.2 리뷰 + 사용자 병합 승인 | 확정(구현 전 검토 1건) |
| A-014 | **저장소 조사(Gate 0A) 전 확정 금지 항목**(v0.2 §6): package manager·Node 버전, 기존 framework/router 유무, Supabase project·migration 상태, PWA SW 생성방식, HEIC 변환 lib+license, runtime validation lib, full archive streaming 구현, 단일 사용자 운영기간. → REPOSITORY_AUDIT/Phase 0B에서 확정. | v0.2 §6 | 미확정 |
| A-015 | 설정 화면에 **개발자 정보** 필수 포함(개발자·버전·최초 개발일 2026-07-22·코드 최종 수정·업데이트 이력). 개발자 표기는 **"김부건 (Kim Bugeon) · Tashkent State Medical University"로 확정**(2026-08-03 사용자 확정 — 잠정값을 그대로 채택). 버전·이력은 `package.json`·`CHANGELOG.md`에서 **파생**(손편집 금지, M-0001). 상세 PROJECT_SPEC §4. | 사용자 지시(2026-07-22) · 표기 확정(2026-08-03) | **사용자 확정** |

## 확인이 필요한 열린 질문 (사용자) — 2026-08-03 교차검증으로 현행화
- ~~Q1: 사진 저장 기본 모드~~ → 절약 모드 확정(A-007).
- ~~Q2: 인증 방식~~ → 소셜 로그인(Google) 확정(A-008).
- ~~Q3: 지도 타일 제공자~~ → **해결** — 지도 화면 출고(MapLibre). 타일 제공자 계약은 `.claude/skills/map-place-dev/SKILL.md`가 정본.
- ~~Q4: Supabase 프로젝트~~ → **공유 프로젝트 Travel&Accounting + journey 스키마 분리로 확정(ADR-0020).** migration 적용·RLS 공격검사 통과 완료.
- ~~Q5: Google OAuth 클라이언트 설정~~ → **해결** — PKCE 실연동 라이브(초대제 allowlist).
- ~~Q7: Exposed schemas·GitHub Variables~~ → **해결** — journey 노출·Variables 설정 완료, 실제 작동 중.
- ~~Q6: 개발자 정보 표기값 확인~~ → **해결(2026-08-03 사용자 확정)** — "김부건 (Kim Bugeon) · Tashkent State Medical University"를 확정값으로 채택. 화면은 이미 출고돼 있고(`changelog.ts`의 `DEVELOPER`가 정본), 값이 같으므로 코드 변경은 없다(A-015).

> ✅ **열린 질문이 없다.** 새 질문이 생기면 여기에 추가하고, 미완료 과제는 `docs/BACKLOG.md`가 정본이다.
