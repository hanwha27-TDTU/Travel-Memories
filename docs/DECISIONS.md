# DECISIONS · Journey Archive (ADR)

추가 전용, 최신이 위. 결정을 기록하는 경우: ≥2 대안 존재, 사용자가 제안/선택/거부, 되돌리기 어려움, 관례에 반하지만 근거 있음.
**정직한 귀속** — 결정유형(`[user-decided]` / `[AI-proposed→user-approved]` / `[AI-autonomous]` / `[user-review-pending]`) × 어느 AI. 일어나지 않은 승인을 기록하지 않는다. (LESSONS §4)

---

## ADR-0012 · SPA 라우팅 + OAuth PKCE + Service Worker 캐시
- 유형: `[AI-autonomous]` · AI: Claude Code · 날짜: 2026-07-22 · (revisable — override 가능)
- history 라우팅 + `404.html`→`index.html` 복제(GitHub Pages 딥링크 대응) + Supabase PKCE OAuth(쿼리 콜백) + Service Worker 캐시 버저닝/`skipWaiting`. 정적 호스팅·하위경로(`base=/Travel-Memories/`) 제약의 귀결. 기본값이며 사용자 검토 시 조정 가능. 상세 `docs/DEPLOYMENT.md`·`docs/ROADMAP.md`.

## ADR-0011 · 삭제 계약(DEL-CONTRACT) — tombstone 전용
- 유형: `[AI-autonomous]` · AI: Claude Code · 날짜: 2026-07-22
- 동기화 엔티티 행은 **tombstone 전용**(`deleted_at`, 하드 삭제 금지). Storage 바이트 삭제는 **사용자 확인 + tombstone 전파 후** 별도 단계이며, 고아 파일 스윕으로 정합한다. 비가역 삭제 경로의 문서 간 상충을 계약으로 고정(`docs/records/coding-mistakes.md` M-0002). 상세 `docs/SECURITY.md`·`docs/SYNC_PROTOCOL.md`.

## ADR-0010 · GitHub Pages 정적 배포를 필수 목표로 확정
- 유형: `[user-decided]` · AI: Claude Code · 날짜: 2026-07-22
- 사용자 "무조건 GitHub로 배포". 정적 호스팅 제약을 설계에 못박음: Vite `base=/Travel-Memories/`, Service Worker scope·라우터 하위경로 대응, 서버 없음 → 백엔드는 클라이언트가 Supabase 직접 호출(anon 키만 번들, service_role 금지), GitHub Actions 빌드→Pages 자동배포. 단일 HTML은 보조 빌드. 상세 `docs/DEPLOYMENT.md`.

## ADR-0009 · 인증 = 소셜 로그인(Google), 매직링크는 무료 대안
- 유형: `[user-decided]` · AI: Claude Code · 날짜: 2026-07-22
- 사용자 "소셜로그인으로 진행". 비용 정정: 이메일 매직링크는 SMS와 달리 전송 비용 없음(무료 SMTP). 그럼에도 소셜(Google)이 무료·무마찰이라 채택. Apple 로그인은 연 $99 개발자 계정 필요 → 보류. ADR-0002(소유자 범위 RLS)와 정합.

## ADR-0008 · 사진 기본 저장 = 절약 모드
- 유형: `[user-decided]` · AI: Claude Code · 날짜: 2026-07-22
- 사용자 "절약 모드". 앱용 압축본+썸네일만 서버 저장, 원본은 기기에만(설계지시서 §9.1 기본값과 일치). 균형/원본보관은 사용자 선택 옵션으로 유지.

## ADR-0007 · 디자인 계열 에이전트 모델 = fable, 그 외 = opus
- 유형: `[user-decided]` · AI: Claude Code · 날짜: 2026-07-22
- 사용자 지시 "설계를 fable5 버전으로 아주 멋지게". 디자인·UX·비주얼 생산 에이전트(125–133, product-ux, frontend)는 `fable`, 총괄·감사·엔지니어링·보안·QA는 `opus`.

## ADR-0006 · 통합 10개 + 디자인 16개 에이전트를 새로 생성
- 유형: `[user-decided]` · AI: Claude Code · 날짜: 2026-07-22
- 사용자 지시 "싹 다 다시 시작". 진행 중이던 디자인 에이전트 2개를 폐기하고, 설계지시서 §28의 통합 10개 + 디자인 제안서의 16개를 전체 재생성. 139개 논리 역할은 `docs/AGENT_REGISTRY.md`에 등록.

## ADR-0005 · 기존 MVP 삭제 후 신규 구조로 재구축
- 유형: `[user-decided]` · AI: Claude Code · 날짜: 2026-07-22
- 사용자 지시 "삭제 후 새로". 순수 HTML/JS + Leaflet MVP를 삭제(git 히스토리 보존)하고 TypeScript+Vite+Supabase+Dexie+MapLibre+PWA 구조로 재구축.

## ADR-0004 · 이번 단계는 기능 구현 없이 문서·에이전트 스캐폴딩만
- 유형: `[user-decided]` · AI: Claude Code · 날짜: 2026-07-22
- 설계지시서 §28·§29 및 사용자의 "추천대로 진행". Phase 0 코드 골격(Vite 초기화)은 파일 목록 제시 후 별도 작업.

## ADR-0003 · 선행 프로젝트 자료는 교훈만 이식
- 유형: `[user-decided]` · AI: Claude Code · 날짜: 2026-07-22
- 사용자 "다른 앱 자료인데 교훈들이 많으니 참고해". dr-bugeon 스킬과 appdevpromptsall.md의 도메인은 이식하지 않고 규율·계약·안티패턴만 `docs/LESSONS.md`로 추출.

## ADR-0002 · 다중 사용자 소유자 범위 RLS를 처음부터
- 유형: `[AI-autonomous]` · AI: Claude Code · 날짜: 2026-07-22
- 근거: Journey Archive는 다중 사용자. 선행 앱의 anon-write 호환 자세를 물려받지 않고 `auth.uid()` 소유자 예측자로 시작(LESSONS §2). 다중 사용자·기본 비공개의 강제 귀결이며 사용자 override 가능. 인증(ADR-0009) 확정으로 블로커 해소.

## ADR-0001 · 정본 기준 문서를 저장소 SSOT로
- 유형: `[user-decided]` · AI: Claude Code · 날짜: 2026-07-22
- 설계지시서 v0.1을 `docs/PROJECT_SPEC.md` 등 저장소 문서로 반영. 특정 AI 대화가 아니라 저장소가 최종 정보원. 충돌 시 공유 문서가 이긴다.

---
## 확인 대기 (사용자 결정 필요)
- 지도 타일 제공자·예산 — A-006 (GitHub Pages 정적 배포 + 무료 티어 호환).
- Supabase 프로젝트 생성 시점 — Q4.
- Google OAuth 클라이언트 설정 시점 — Q5 (Phase 1).
- SPA 라우팅·삭제 계약 기본값 검토(override 가능) — ADR-0011/0012.
