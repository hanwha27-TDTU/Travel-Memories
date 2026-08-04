# Bugeon Journey · 개인 여행기록 앱

> 사진, 장소, 비용과 짧은 감정을 자동으로 연결하여, 여행 당시의 기억과 여행이 나에게 남긴 의미를 다시 찾아주는 **개인 여행기록 앱**.

단순한 여행일기가 아니라, 사진·장소·시간·비용·동행인·감정·회고를 서로 연결해 **장기간 보존**하는 개인 여행기록 데이터베이스입니다. 모바일 중심 웹앱·PWA로 동작하며 **오프라인 우선**으로 기록이 유실되지 않습니다.

## 상태

✅ **Phase 0B~6 출고 완료 — 실사용 중인 비공개 개인 PWA입니다.** 여행·순간·사진·장소·비용·소리,
오프라인 우선 저장, Supabase 다기기 동기화, R2 사진 바이트, JSON/ZIP 백업·복원과 Android 셸까지
운영 중입니다. 현재 버전은 `src/app/changelog.ts`, 미완료 과제는 `docs/BACKLOG.md`가 정본입니다.

Windows 주 개발 저장소는 OneDrive 동기화·재분석 잠금의 영향을 받지 않는
`C:\AppDevelopment\Bugeon_Journey`에 둡니다. 다른 환경에서도 클라우드 동기화 폴더가 아닌
일반 로컬 디렉터리를 권장합니다. 이 경로는 사용자 데이터 위치가 아니라 **소스 저장소 위치**입니다.

## 핵심 원칙

- **최소 입력** — 여행 중 순간기록은 사진 선택 시간 제외 10초 이내.
- **순간(Moment) 중심** — 여행을 긴 글 하나로 저장하지 않고, 식사·관광·이동·대화·감정을 독립된 순간으로 저장.
- **오프라인 우선** — 저장 시 서버 상태와 무관하게 IndexedDB에 먼저 저장 후 동기화.
- **원본 불변** — 기기 원본 사진은 변경하지 않고 앱용 압축본만 생성.
- **기본 비공개** — 여행·사진·GPS·동행인·비용·회고 모두 비공개가 기본.
- **복구 가능성 우선** — 위험한 작업은 사전검증·기록·재시도·되돌리기를 갖춘다.

## 기술 구성 (요약)

| 영역 | 선택 |
|------|------|
| 언어 | TypeScript (strict) |
| 빌드 | Vite |
| UI | Vanilla TypeScript 컴포넌트 |
| 백엔드 | Supabase (Auth · PostgreSQL · Storage) |
| 로컬 DB | Dexie 기반 IndexedDB |
| 지도 | MapLibre GL JS / 위치 GeoJSON |
| 사진 | Web Worker + OffscreenCanvas, WebP |
| 오프라인 | Service Worker + IndexedDB 동기화 대기열 |
| 배포 | GitHub Pages PWA · Android Capacitor 셸(APK) |

## 문서

| 문서 | 내용 |
|------|------|
| [`docs/PROJECT_SPEC.md`](docs/PROJECT_SPEC.md) | 제품 요구사항 (최상위 기준) |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 기술 구조와 계층 경계 |
| [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) | 데이터 모델과 테이블 |
| [`docs/SECURITY.md`](docs/SECURITY.md) | 보안 · RLS 계획 |
| [`docs/PRIVACY.md`](docs/PRIVACY.md) | 개인정보 흐름과 보호 |
| [`docs/SYNC_PROTOCOL.md`](docs/SYNC_PROTOCOL.md) | 오프라인 동기화 프로토콜 |
| [`docs/MEDIA_PIPELINE.md`](docs/MEDIA_PIPELINE.md) | 사진 처리 파이프라인 |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | GitHub Pages 정적 배포 (필수) |
| [`docs/AGENT_REGISTRY.md`](docs/AGENT_REGISTRY.md) | 서브에이전트 등록부 |
| [`docs/LESSONS.md`](docs/LESSONS.md) | 선행 프로젝트에서 얻은 교훈 |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | 단계별 개발 계획 |
| [`docs/TEST_PLAN.md`](docs/TEST_PLAN.md) | 테스트 · 게이트 규율 |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) · [`docs/ASSUMPTIONS.md`](docs/ASSUMPTIONS.md) | 결정 · 가정 기록 |
| [`docs/HANDOFF.md`](docs/HANDOFF.md) | 작업 인계 기록 |
| [`docs/CHANGELOG.md`](docs/CHANGELOG.md) | 변경 이력 |

## 개발 원칙

- 저장소 자체가 최종 정보원이다. 중요한 결정은 `docs/DECISIONS.md`에 기록한다.
- 각 변경은 설계 → 구현 → 자동검사 → 적대적 검토 → 승인 순서를 따른다.
- 자동검사를 통과하지 않은 변경은 완료로 표시하지 않는다.
- Claude Code와 Codex는 위 문서를 공통 기준으로 협업한다.
