---
shape: prose
shape_reason: v0.2 원본 사료 — 당시 상태를 그대로 보존한다. 손대면 사료가 아니다.
---
# Journey Archive Agent Registry

문서 버전: 0.2  
기준일: 2026-07-22  
상태: 123개 책임 역할을 10개 통합 실행 agent에 매핑한 등록부

123개 항목은 동시 실행 단위가 아니라 책임 누락 방지를 위한 taxonomy다. 실제 `.claude/agents/`에는 우선 10개 통합 agent만 생성한다. 특정 작업에서 필요한 역할은 해당 통합 agent 내부 책임으로 활성화한다.

## 통합 agent

| agent | 1차 책임 | 필수 경계 |
|---|---|---|
| orchestrator | 저장소 조사, 요구분해, 범위, 의존성, 결정·인계 | 제품 코드 직접 구현은 예외적이며 task 소유권을 먼저 배정 |
| product-ux | 제품목표, 사용자 흐름, IA, 접근성, i18n | DB·보안 결정을 단독 확정하지 않음 |
| frontend | UI, 상태, 라우팅, PWA, 브라우저 호환 | UI에서 Supabase·Dexie 직접 호출 금지 |
| travel-domain | 여행·순간·장소·비용·회고·검색·백업 도메인 | AI 역할은 Phase 7 전 비활성 |
| media-pipeline | intake, EXIF, orientation, hash, 압축, thumbnail, 메모리 | qa 저메모리검사와 security 개인정보검토 필수 |
| supabase | DB, migration, Auth, RLS, Storage, Edge, 비용 | RLS·secret 변경은 security 검토 필수 |
| offline-sync | Dexie, OPFS, queue, connectivity, retry, conflict, cursor | 서버 schema 변경은 supabase와 공동 검토 |
| security-privacy | threat model, secret, RLS 침투, upload, XSS, 삭제, 개인정보 | 기능 소유 agent와 분리된 적대 검토 |
| qa | unit, integration, E2E, mobile, failure, batch, memory, acceptance | 완료 판정은 증거와 재현 명령 필요 |
| reviewer-release | 코드·아키텍처·의존성·build·release·rollback·문서 | 미통과 검사나 미해결 차단 위험이 있으면 release 금지 |

## 공통 실행 규칙

```text
- 한 agent는 한 task_id만 처리한다.
- docs/ACTIVE_TASKS.md에 branch, worktree와 예상 수정 경로를 등록한다.
- 다른 활성 task가 소유한 파일을 수정하지 않는다.
- 요구범위 밖 리팩터링을 하지 않는다.
- 결과는 artifacts/agent-reports/{TASK_ID}-{agent}.json으로 남긴다.
- DB, RLS, media, 삭제와 배포에는 지정된 독립 검토자가 필요하다.
- AI 역할 65~74는 Phase 7 전 실행하지 않는다.
```

## 중앙 관리

| 번호 | 역할 | 책임 | 통합 agent | 필수 독립 검토 |
|---:|---|---|---|---|
| 1 | Orchestrator Agent | 작업분배, 순서관리, 결과통합 | orchestrator | reviewer-release |
| 2 | Requirement Analyst | 요구사항을 기능·비기능 기준으로 변환 | orchestrator | reviewer-release |
| 3 | Task Planner | 작업분해, 의존관계, 완료조건 설정 | orchestrator | reviewer-release |
| 4 | Solution Architect | 전체 기술구조와 경계 설계 | orchestrator | reviewer-release |
| 5 | Context Manager | 기존 코드·규칙·문서 맥락 유지 | orchestrator | reviewer-release |
| 6 | Decision Log Agent | 설계결정과 이유 기록 | orchestrator | reviewer-release |
| 7 | Scope Guard Agent | 범위확대와 불필요한 기능 차단 | orchestrator | reviewer-release |

## 제품·화면설계

| 번호 | 역할 | 책임 | 통합 agent | 필수 독립 검토 |
|---:|---|---|---|---|
| 8 | Product Manager Agent | 제품목표, MVP, 우선순위 | product-ux | reviewer-release |
| 9 | User Flow Agent | 사용자 흐름 설계 | product-ux | reviewer-release |
| 10 | Information Architecture Agent | 화면과 정보관계 설계 | product-ux | reviewer-release |
| 11 | UX Friction Auditor | 입력 단계와 클릭 수 축소 | product-ux | reviewer-release |
| 12 | UI Design System Agent | 색상, 간격, 글꼴, 컴포넌트 규칙 | product-ux | reviewer-release |
| 13 | Responsive UI Agent | 휴대전화·태블릿·PC 대응 | product-ux | reviewer-release |
| 14 | Accessibility Agent | 키보드, 명암, 화면읽기 대응 | product-ux | reviewer-release |
| 15 | Internationalization Agent | 다국어 키와 번역구조 | product-ux | reviewer-release |

## 프론트엔드

| 번호 | 역할 | 책임 | 통합 agent | 필수 독립 검토 |
|---:|---|---|---|---|
| 16 | Frontend Architect | 프론트 모듈과 의존성 설계 | frontend | security-privacy, qa |
| 17 | UI Implementation Agent | 화면 구현 | frontend | security-privacy, qa |
| 18 | State Management Agent | 화면·작업 상태 관리 | frontend | security-privacy, qa |
| 19 | API Integration Agent | 프론트와 Supabase 연결 | frontend | security-privacy, qa |
| 20 | Form Validation Agent | 입력검증과 오류표시 | frontend | security-privacy, qa |
| 21 | Offline/PWA Agent | 설치형 앱과 오프라인 구조 | frontend | security-privacy, qa |
| 22 | Browser Compatibility Agent | 브라우저 차이 검사 | frontend | security-privacy, qa |
| 23 | Mobile Performance Agent | 모바일 속도·발열·메모리 최적화 | frontend | security-privacy, qa |
| 24 | Single HTML Build Agent | 보조 단일 HTML 빌드 | frontend | security-privacy, qa |

## 여행 도메인

| 번호 | 역할 | 책임 | 통합 agent | 필수 독립 검토 |
|---:|---|---|---|---|
| 25 | Trip Domain Agent | 여행과 하위 개체 규칙 | travel-domain | security-privacy, qa |
| 26 | Timeline Agent | 시간순 기록 구성 | travel-domain | security-privacy, qa |
| 27 | Place Management Agent | 장소 생성·수정·중복통합 | travel-domain | security-privacy, qa |
| 28 | Map Agent | 지도와 마커 구현 | travel-domain | security-privacy, qa |
| 29 | GeoJSON Agent | 위치와 경로 표준화 | travel-domain | security-privacy, qa |
| 30 | Companion Agent | 동행인 관리 | travel-domain | security-privacy, qa |
| 31 | Expense Agent | 비용기록과 통화 | travel-domain | security-privacy, qa |
| 32 | Reflection Agent | 여행 회고 | travel-domain | security-privacy, qa |
| 33 | Statistics Agent | 여행 통계 | travel-domain | security-privacy, qa |
| 34 | Natural Search Agent | 자연어 기록검색 | travel-domain | security-privacy, qa |

## 사진·영상

| 번호 | 역할 | 책임 | 통합 agent | 필수 독립 검토 |
|---:|---|---|---|---|
| 35 | Image Intake Agent | 파일선택과 초기검증 | media-pipeline | security-privacy, qa |
| 36 | Image Compression Agent | 사진 크기와 품질 압축 | media-pipeline | security-privacy, qa |
| 37 | Thumbnail Agent | 썸네일 생성 | media-pipeline | security-privacy, qa |
| 38 | EXIF Agent | 촬영정보 추출 | media-pipeline | security-privacy, qa |
| 39 | Image Orientation Agent | 회전과 방향 보정 | media-pipeline | security-privacy, qa |
| 40 | Duplicate Photo Agent | 중복사진 탐지 | media-pipeline | security-privacy, qa |
| 41 | Media Queue Agent | 처리·업로드 대기열 | media-pipeline | security-privacy, qa |
| 42 | Upload Retry Agent | 실패 재시도 | media-pipeline | security-privacy, qa |
| 43 | Image Privacy Agent | GPS와 EXIF 노출 통제 | media-pipeline | security-privacy, qa |
| 44 | Video Processing Agent | 영상 처리 | media-pipeline | security-privacy, qa |

## Supabase

| 번호 | 역할 | 책임 | 통합 agent | 필수 독립 검토 |
|---:|---|---|---|---|
| 45 | Database Schema Agent | DB 테이블·관계·인덱스 | supabase | security-privacy, qa |
| 46 | SQL Migration Agent | 변경 SQL과 되돌리기 | supabase | security-privacy, qa |
| 47 | Authentication Agent | 로그인과 세션 | supabase | security-privacy, qa |
| 48 | RLS Security Agent | 사용자별 DB 접근정책 | supabase | security-privacy, qa |
| 49 | Storage Architecture Agent | 버킷과 파일경로 | supabase | security-privacy, qa |
| 50 | Storage Policy Agent | Storage 접근정책 | supabase | security-privacy, qa |
| 51 | Signed URL Agent | 제한시간 파일 접근 | supabase | security-privacy, qa |
| 52 | Edge Function Agent | 서버측 보조처리 | supabase | security-privacy, qa |
| 53 | Realtime Agent | 실시간 갱신 | supabase | security-privacy, qa |
| 54 | Sync Agent | 서버·로컬 동기화 | supabase | security-privacy, qa |
| 55 | Conflict Resolution Agent | 데이터 충돌처리 | supabase | security-privacy, qa |
| 56 | Database Performance Agent | 쿼리·인덱스 최적화 | supabase | security-privacy, qa |
| 57 | Supabase Cost Agent | 저장·전송 사용량 감시 | supabase | security-privacy, qa |

## 오프라인

| 번호 | 역할 | 책임 | 통합 agent | 필수 독립 검토 |
|---:|---|---|---|---|
| 58 | IndexedDB Agent | 로컬 데이터베이스 | offline-sync | supabase, qa |
| 59 | Offline Queue Agent | 오프라인 작업대기 | offline-sync | supabase, qa |
| 60 | Network Status Agent | 연결상태 감지 | offline-sync | supabase, qa |
| 61 | Background Sync Agent | 연결복구 후 작업 | offline-sync | supabase, qa |
| 62 | Draft Recovery Agent | 작성 중 기록복원 | offline-sync | supabase, qa |
| 63 | Cache Strategy Agent | 화면·썸네일 캐시 | offline-sync | supabase, qa |
| 64 | Sync Integrity Agent | 동기화 누락·중복검사 | offline-sync | supabase, qa |

## AI·검색

| 번호 | 역할 | 책임 | 통합 agent | 필수 독립 검토 |
|---:|---|---|---|---|
| 65 | Tagging Agent | 태그 추천 | travel-domain (Phase 7) | security-privacy, qa |
| 66 | Daily Summary Agent | 하루 요약 | travel-domain (Phase 7) | security-privacy, qa |
| 67 | Trip Summary Agent | 여행 전체 요약 | travel-domain (Phase 7) | security-privacy, qa |
| 68 | Semantic Search Agent | 의미 기반 검색 | travel-domain (Phase 7) | security-privacy, qa |
| 69 | Photo Caption Agent | 사진 설명 | travel-domain (Phase 7) | security-privacy, qa |
| 70 | OCR Agent | 이미지 글자 읽기 | travel-domain (Phase 7) | security-privacy, qa |
| 71 | Expense Extraction Agent | 영수증 비용 추출 | travel-domain (Phase 7) | security-privacy, qa |
| 72 | AI Hallucination Guard | 기록에 없는 내용 생성 차단 | travel-domain (Phase 7) | security-privacy, qa |
| 73 | Local LLM Agent | 로컬 모델 연결 | travel-domain (Phase 7) | security-privacy, qa |
| 74 | Prompt Management Agent | 프롬프트와 출력버전 관리 | travel-domain (Phase 7) | security-privacy, qa |

## 보안·개인정보

| 번호 | 역할 | 책임 | 통합 agent | 필수 독립 검토 |
|---:|---|---|---|---|
| 75 | Security Architect | 전체 보안구조 | security-privacy | qa, reviewer-release |
| 76 | Threat Modeling Agent | 공격경로 분석 | security-privacy | qa, reviewer-release |
| 77 | Secret Scanner Agent | 비밀키 노출검사 | security-privacy | qa, reviewer-release |
| 78 | RLS Penetration Agent | 타 사용자 접근 공격검사 | security-privacy | qa, reviewer-release |
| 79 | Upload Security Agent | 위장·악성 파일 방어 | security-privacy | qa, reviewer-release |
| 80 | XSS Injection Agent | 입력값 코드삽입 검사 | security-privacy | qa, reviewer-release |
| 81 | Privacy Agent | 개인정보 흐름검사 | security-privacy | qa, reviewer-release |
| 82 | Metadata Privacy Agent | EXIF·GPS 보호 | security-privacy | qa, reviewer-release |
| 83 | Data Deletion Agent | 삭제 완전성과 복구 | security-privacy | qa, reviewer-release |
| 84 | Backup Encryption Agent | 백업 암호화 | security-privacy | qa, reviewer-release |

## 검사·품질

| 번호 | 역할 | 책임 | 통합 agent | 필수 독립 검토 |
|---:|---|---|---|---|
| 85 | Unit Test Agent | 함수 단위검사 | qa | reviewer-release |
| 86 | Integration Test Agent | 모듈·서버 연결검사 | qa | reviewer-release |
| 87 | End-to-End Test Agent | 전체 사용자 흐름검사 | qa | reviewer-release |
| 88 | Mobile Device Test Agent | 모바일 실제환경검사 | qa | reviewer-release |
| 89 | Network Failure Test Agent | 네트워크 장애검사 | qa | reviewer-release |
| 90 | Large Batch Test Agent | 사진 대량처리검사 | qa | reviewer-release |
| 91 | Low Memory Test Agent | 낮은 메모리 환경검사 | qa | reviewer-release |
| 92 | Data Integrity Agent | DB와 파일 연결검사 | qa | reviewer-release |
| 93 | Regression Test Agent | 기존 기능 회귀검사 | qa | reviewer-release |
| 94 | Adversarial QA Agent | 비정상 사용 적대적 검사 | qa | reviewer-release |
| 95 | Bug Reproduction Agent | 오류 재현절차 작성 | qa | reviewer-release |
| 96 | Acceptance Test Agent | 최종 완료조건 판정 | qa | reviewer-release |

## 성능·운영

| 번호 | 역할 | 책임 | 통합 agent | 필수 독립 검토 |
|---:|---|---|---|---|
| 97 | Performance Profiler | 병목 측정 | qa | reviewer-release |
| 98 | Image Memory Agent | 사진 처리 메모리검사 | media-pipeline | security-privacy, qa |
| 99 | Database Query Agent | 과도한 DB 요청검사 | supabase | security-privacy, qa |
| 100 | Egress Optimization Agent | 반복 다운로드 감소 | supabase | security-privacy, qa |
| 101 | Error Logging Agent | 오류기록 | reviewer-release | orchestrator |
| 102 | Usage Analytics Agent | 개인 사용통계 | product-ux | reviewer-release |
| 103 | Storage Monitoring Agent | 저장용량 감시 | supabase | security-privacy, qa |
| 104 | Health Check Agent | DB·Storage·인증 상태검사 | reviewer-release | orchestrator |
| 105 | Incident Analysis Agent | 장애원인과 방지책 | reviewer-release | orchestrator |

## 백업·데이터 보존

| 번호 | 역할 | 책임 | 통합 agent | 필수 독립 검토 |
|---:|---|---|---|---|
| 106 | Export Agent | JSON·CSV·GeoJSON 내보내기 | travel-domain | security-privacy, qa |
| 107 | Import Agent | 백업 가져오기 | travel-domain | security-privacy, qa |
| 108 | Backup Agent | 백업 생성 | travel-domain | security-privacy, qa |
| 109 | Restore Validation Agent | 복원 결과검사 | qa | reviewer-release |
| 110 | Data Migration Agent | 구버전 데이터 변환 | travel-domain | security-privacy, qa |
| 111 | Orphan File Cleanup Agent | DB와 연결되지 않은 파일검사 | supabase | security-privacy, qa |
| 112 | Orphan Record Cleanup Agent | 파일 없는 DB 기록검사 | supabase | security-privacy, qa |
| 113 | Version Compatibility Agent | 백업·DB 버전 호환 | reviewer-release | orchestrator |

## 코드검토·배포

| 번호 | 역할 | 책임 | 통합 agent | 필수 독립 검토 |
|---:|---|---|---|---|
| 114 | Code Review Agent | 코드 품질검토 | reviewer-release | orchestrator |
| 115 | Architecture Review Agent | 설계경계 위반검사 | reviewer-release | orchestrator |
| 116 | Refactoring Agent | 중복과 거대함수 정리 | reviewer-release | orchestrator |
| 117 | Dependency Review Agent | 외부 의존성 검토 | reviewer-release | orchestrator |
| 118 | Build Agent | 운영 빌드 | reviewer-release | orchestrator |
| 119 | Release Agent | 버전과 배포 | reviewer-release | orchestrator |
| 120 | GitHub Agent | branch, commit, PR 관리 | reviewer-release | orchestrator |
| 121 | Changelog Agent | 변경내용 기록 | reviewer-release | orchestrator |
| 122 | Rollback Agent | 이전 버전 복구 | reviewer-release | orchestrator |
| 123 | Documentation Agent | 개발·사용 문서 | reviewer-release | orchestrator |

## 호출 원칙

```text
- Orchestrator는 task의 위험과 의존성에 따라 최소 agent만 호출한다.
- 동일 파일을 다루는 역할은 병렬 호출하지 않는다.
- 조사와 적대 검토는 구현 agent와 다른 context에서 수행한다.
- agent 이름보다 task objective, 허용 파일과 완료조건을 우선한다.
- 에이전트 보고서의 completed 표시는 Acceptance gate를 대체하지 않는다.
```
