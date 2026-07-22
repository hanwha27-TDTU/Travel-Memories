# DECISIONS · Bugeon Journey (ADR)

추가 전용, 최신이 위. 결정을 기록하는 경우: ≥2 대안 존재, 사용자가 제안/선택/거부, 되돌리기 어려움, 관례에 반하지만 근거 있음.
**정직한 귀속** — 결정유형(`[user-decided]` / `[AI-proposed→user-approved]` / `[AI-autonomous]` / `[user-review-pending]`) × 어느 AI. 일어나지 않은 승인을 기록하지 않는다. (LESSONS §4)

---

## ADR-0020 · Supabase 공유 프로젝트 + journey 스키마 분리
- 유형: `[user-decided]` · AI: Claude Code · 날짜: 2026-07-22
- 무료 한도(2개)로 신규 프로젝트 불가 → 사용자가 기존 News&Accounting을 **Travel&Accounting**(`ihxiywffzmvrwmqvatzt`, ap-south-1 뭄바이)으로 개명해 공유 결정. 분리: 회계 앱 = `public` 스키마(불가침) / 여행 앱 = **`journey` 스키마 전용**(클라이언트 `db.schema='journey'`).
- 적용 완료: `journey.trips` migration + RLS 공격검사 6종 **RLS_ATTACK_PASS**(위조 INSERT·타인 조회/수정/삭제·소유자 하드삭제·anon 전부 차단, ROLLBACK). advisor에서 journey 지적 0건.
- **문서화된 공유 위험**: 무료 쿼터 공유(DB 500MB·Storage 1GB·egress 5GB — 사진이 Storage 먼저 소진), Auth 설정 프로젝트 전역(Google provider·redirect·signup), **백업 복원 프로젝트 단위**(한 앱 복원 = 다른 앱도 롤백 — 복구 전 상호 확인 필수), pause/upgrade 공동 영향, 뭄바이 리전 지연(~100ms대).
- 잔여 수동 1단계: 대시보드 Settings → Data API → Exposed schemas에 `journey` 추가(Q7).

## ADR-0019 · 설정 화면에 개발자 정보 필수 포함
- 유형: `[user-decided]` · AI: Claude Code · 날짜: 2026-07-22
- 사용자 지시("앱 설계시 개발자 정보도 꼭 추가"). 선행 앱(dr-bugeon)의 개발자 정보 화면 준거: 개발자·버전·최초 개발일·코드 최종 수정·업데이트 이력(펼치기). **버전·이력은 package.json·CHANGELOG에서 파생 생성**(손편집 금지, M-0001 규율) — 하드코딩 시 게이트 차단. 표기값(이름·소속)은 A-015 잠정, 구현 전 확인(Q6). 구현 Phase 5~6(설정 화면). 명세 PROJECT_SPEC §4.

## ADR-0018 · Phase 0B 스택 = npm · Vite · TS strict · history 라우팅
- 유형: `[AI-autonomous]`(관례적 기본값, override 가능) · AI: Claude Code · 날짜: 2026-07-22
- 패키지 매니저 **npm**(보편성), 빌드 **Vite**, **TypeScript strict**. 라우팅은 ADR-0012대로 **history + 404 복제**로 착수(해시 아님). Supabase 클라이언트는 **PKCE** 옵션으로 초기화(실 연동 Phase 1). 골격은 빌드·타입체크·하네스·라이브 렌더 통과.

## ADR-0017 · v0.2 sync 모델 = operation receipt + base_version + 단조 커서 + conflict table
- 유형: `[AI-proposed→user-approved]`(사용자 "정밀 병합" 승인) · AI: Claude Code · 날짜: 2026-07-22
- 동기화가 `updated_at`-LWW 중심에서 **operation receipt(멱등) + `base_version` 비교 + `sync_changes.sequence` 단조 pull 커서 + `sync_conflicts` 테이블**로 이동(C-07). LWW는 불변식 내 tiebreaker로만 잔존. 신규 운영 테이블 `user_devices`·`sync_changes`·`sync_conflicts`·`deletion_jobs` 추가. 상세 `docs/SYNC_PROTOCOL.md`·`docs/DATA_MODEL.md`.

## ADR-0016 · v0.2 거버넌스·범위 정련 (S-01~S-10)
- 유형: `[AI-proposed→user-approved]` / 일부 `[user-decided]` · AI: Claude Code · 날짜: 2026-07-22
- S-01 음성=OS 받아쓰기(앱내 STT 후속) · S-02 MVP=키워드 검색, semantic=Phase 7 · S-03 원본보관 기본 비활성 · S-04 공개 회원가입 비활성/invite-only, 소셜은 소유자 한정 · S-07 agent report는 `schemas/agent-report.schema.json` 검증 + `artifacts/agent-reports/`에 저장 · S-08 `docs/ACTIVE_TASKS.md` 소유권 + hook/CI 강제 · S-09 CLAUDE/AGENTS=맥락, hook+CI=강제 · S-10 Gate 0A(감사·문서·에이전트) / Phase 0B(스캐폴드) 분리.

## ADR-0015 · AI 출력은 `ai_artifacts`에만 (인라인 AI 컬럼 제거) — 리뷰어 확인 필요
- 유형: `[AI-proposed→user-approved]`(표 구조 변경은 reviewer-release/사용자 확인 대기) · AI: Claude Code · 날짜: 2026-07-22
- `ai_generations`→**`ai_artifacts`**(v0.2 명) 리네임. `trip_days.ai_summary/ai_confirmed`, `moments.ai_summary/ai_confirmed`, `reflections.ai_draft` 등 **인라인 AI 컬럼을 제거**하고 AI 출력은 `ai_artifacts`에만 저장(비타협 원칙 2 강화). MVP 표 형태를 바꾸므로 구현 전 reviewer-release 확인. `client_operations.operation_type` `upload`→`finalize_upload`, `version` bigint 표준화도 포함.

## ADR-0014 · v0.2 기술 하드닝 채택
- 유형: `[AI-proposed→user-approved]`(사용자 "정밀 병합" 승인) · AI: Claude Code · 날짜: 2026-07-22
- 복합 소유자 FK `(parent_id,user_id)`(H-02) · soft-delete 부분 고유 인덱스(H-03) · 내구성 유실범위 한정(C-01) · onLine은 힌트, 실연결=Supabase probe(C-04) · deletion_jobs 상태머신·pending→verify 미디어 흐름(C-08/09) · EXIF 시각=local+offset+tz+source+confidence(C-10) · WebP magic-byte 검증·JPEG/PNG fallback(H-07) · 입력검증 magic bytes·pixel cap·SVG 거부(H-08) · 강한 콘텐츠 해시로 중복 확정(H-10) · 불변 Storage `upsert:false`(H-11) · >6MB TUS 재개 업로드 · EXIF whitelist(H-09) · publishable/secret 키 체계, 프론트=publishable만(H-13) · RLS 완료조건=local Supabase+pgTAP+익명/A/B 공격검사(H-12) · DB 백업은 Storage 바이트 미포함(H-15) · 지도 어댑터 분리(H-05) · 디코딩 동시성 1(H-06).

## ADR-0013 · 배포 = GitHub Pages 주 + 헤더호스트 병행 미러 (S-05)
- 유형: `[user-decided]` · AI: Claude Code · 날짜: 2026-07-22
- 사용자 "GitHub 주 + 헤더호스트 병행". GitHub Pages를 주 배포로 유지(필수 요건)하되 커스텀 보안헤더 한계는 CSP meta + git revert 롤백으로 완화, 후속으로 Cloudflare Pages/Netlify 미러(보안 응답헤더·즉시 롤백) 옵션. 상세 `docs/DEPLOYMENT.md`.

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
- 근거: Bugeon Journey는 다중 사용자. 선행 앱의 anon-write 호환 자세를 물려받지 않고 `auth.uid()` 소유자 예측자로 시작(LESSONS §2). 다중 사용자·기본 비공개의 강제 귀결이며 사용자 override 가능. 인증(ADR-0009) 확정으로 블로커 해소.

## ADR-0001 · 정본 기준 문서를 저장소 SSOT로
- 유형: `[user-decided]` · AI: Claude Code · 날짜: 2026-07-22
- 설계지시서 v0.1을 `docs/PROJECT_SPEC.md` 등 저장소 문서로 반영. 특정 AI 대화가 아니라 저장소가 최종 정보원. 충돌 시 공유 문서가 이긴다.

---
## 확인 대기 (사용자 결정 필요)
- 지도 타일 제공자·예산 — A-006 (GitHub Pages 정적 배포 + 무료 티어 호환).
- Supabase 프로젝트 생성 시점 — Q4.
- Google OAuth 클라이언트 설정 시점 — Q5 (Phase 1).
- SPA 라우팅·삭제 계약 기본값 검토(override 가능) — ADR-0011/0012.
