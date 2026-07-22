# DECISIONS · Journey Archive (ADR)

추가 전용, 최신이 위. 결정을 기록하는 경우: ≥2 대안 존재, 사용자가 제안/선택/거부, 되돌리기 어려움, 관례에 반하지만 근거 있음.
**정직한 귀속** — 결정유형(`[user-decided]` / `[AI-proposed→user-approved]` / `[AI-autonomous]` / `[user-review-pending]`) × 어느 AI. 일어나지 않은 승인을 기록하지 않는다. (LESSONS §4)

---

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
- 유형: `[AI-proposed→user-review-pending]` · AI: Claude Code · 날짜: 2026-07-22
- 근거: Journey Archive는 다중 사용자. 선행 앱의 anon-write 호환 자세를 물려받지 않고 `auth.uid()` 소유자 예측자로 시작(LESSONS §2). 사용자 최종 확인 대기(인증 방식 Q와 연동).

## ADR-0001 · 정본 기준 문서를 저장소 SSOT로
- 유형: `[user-decided]` · AI: Claude Code · 날짜: 2026-07-22
- 설계지시서 v0.1을 `docs/PROJECT_SPEC.md` 등 저장소 문서로 반영. 특정 AI 대화가 아니라 저장소가 최종 정보원. 충돌 시 공유 문서가 이긴다.

---
## 확인 대기 (사용자 결정 필요)
- 사진 저장 기본 모드(절약/균형/원본보관) — `docs/ASSUMPTIONS.md` A-007.
- 인증 방식(매직링크/비밀번호/소셜) — A-008, ADR-0002 연동.
- 지도 타일 제공자·예산 — A-006.
- Supabase 프로젝트 생성 시점.
