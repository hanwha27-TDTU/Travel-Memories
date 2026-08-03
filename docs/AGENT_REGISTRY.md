# AGENT REGISTRY · Bugeon Journey

전체 서브에이전트 등록부. 설계지시서 §19의 123개 역할에 디자인 확장 16개(124~139)를 더한 **<!--reg:logicalRoleCount-->139<!--/reg-->개 논리 역할**을 정의한다.

> **운영 원칙 (§18)**: 전부를 동시에 실행하지 않는다. Orchestrator가 작업 성격에 따라 필요한 역할만 호출한다. 실제 `.claude/agents/`에는 이 역할들을 묶은 **물리 에이전트 <!--reg:agentCount-->27<!--/reg-->개**(통합·디자인·독립 감사)가 있다. 각 통합 에이전트는 아래 세부 역할을 내부 책임으로 포함한다. (즉 **<!--reg:logicalRoleCount-->139<!--/reg--> 논리 역할 → <!--reg:agentCount-->27<!--/reg--> 물리 에이전트.** v0.2 기준서의 123→10을 상위 집합으로 확장한 것이다.)
>
> 🔴 **물리 에이전트 수를 여기 손으로 적지 않는다.** 위 숫자는 `gen-registry`가 `.claude/agents/`를
> 실측해 심는다(`check-doc-counts`가 대조). 예전엔 「10 + 16 = 26」이라고 **손으로 계산해** 적어 둬서,
> 독립 감사 에이전트가 늘어난 뒤에도 26으로 남아 있었다.

## 공통 실행 규칙 (v0.2)

```text
- 한 agent는 한 task_id만 처리한다.
- docs/ACTIVE_TASKS.md에 branch, worktree와 예상 수정 경로를 등록한다.
- 다른 활성 task가 소유한 파일을 수정하지 않는다.
- 요구범위 밖 리팩터링을 하지 않는다.
- 결과는 artifacts/agent-reports/{TASK_ID}-{agent}.json으로 남긴다(schemas/agent-report.schema.json 검증).
- DB, RLS, media, 삭제와 배포에는 지정된 독립 검토자가 필요하다(아래 "필수 독립 검토" 열).
- AI 역할 65~74는 Phase 7 전 실행하지 않는다.
```

## 호출 원칙 (v0.2)

```text
- Orchestrator는 task의 위험과 의존성에 따라 최소 agent만 호출한다.
- 동일 파일을 다루는 역할은 병렬 호출하지 않는다.
- 조사와 적대 검토는 구현 agent와 다른 context에서 수행한다.
- agent 이름보다 task objective, 허용 파일과 완료조건을 우선한다.
- 에이전트 보고서의 completed 표시는 Acceptance gate를 대체하지 않는다.
```

## 통합 에이전트 ↔ 세부 역할 매핑

| 통합 에이전트 (`.claude/agents/`) | 포함하는 세부 역할 번호 | 모델 |
|------------------------------------|--------------------------|------|
| `orchestrator` | 1–7 (중앙 관리) | opus |
| `product-ux` | 8–15 (제품·화면설계) | fable |
| `frontend` | 16–24 (프론트엔드) | fable |
| `travel-domain` | 25–34 (여행 도메인) | opus |
| `media-pipeline` | 35–44 (사진·영상) | opus |
| `supabase` | 45–57 (Supabase) | opus |
| `offline-sync` | 58–64 (오프라인) | opus |
| `security-privacy` | 75–84 (보안·개인정보) | opus |
| `qa` | 85–96, 97–105 (검사·성능) | opus |
| `reviewer-release` | 106–123 (백업·검토·배포) | opus |
| AI·검색(65–74)은 MVP 안정화 후 별도 branch에서 활성화 | 65–74 | opus |

디자인 확장 에이전트(124–139)는 개별 파일로 생성하며 대부분 `fable` 모델을 사용한다(감사류 일부는 opus). `product-ux`/`frontend`의 시각작업을 심화·감사한다. **물리 에이전트 합계 = 통합 10 + 디자인 16 = 26.**

> **필수 독립 검토** 열: 해당 역할의 산출물을 반드시 다른 context의 독립 에이전트가 적대적으로 검토한다(구현자 자기인증 금지). 값 출처: `docs/reference/v0.2/AGENT_REGISTRY_v0.2.md`.

---

## 19.1 중앙 관리
| # | 에이전트 | 책임 | 필수 독립 검토 |
|---|----------|------|----------------|
| 1 | Orchestrator Agent | 작업분배, 순서관리, 결과통합 | reviewer-release |
| 2 | Requirement Analyst | 요구사항을 기능·비기능 기준으로 변환 | reviewer-release |
| 3 | Task Planner | 작업분해, 의존관계, 완료조건 설정 | reviewer-release |
| 4 | Solution Architect | 전체 기술구조와 경계 설계 | reviewer-release |
| 5 | Context Manager | 기존 코드·규칙·문서 맥락 유지 | reviewer-release |
| 6 | Decision Log Agent | 설계결정과 이유 기록 | reviewer-release |
| 7 | Scope Guard Agent | 범위확대와 불필요한 기능 차단 | reviewer-release |

## 19.2 제품·화면설계
| # | 에이전트 | 책임 | 필수 독립 검토 |
|---|----------|------|----------------|
| 8 | Product Manager Agent | 제품목표, MVP, 우선순위 | reviewer-release |
| 9 | User Flow Agent | 사용자 흐름 설계 | reviewer-release |
| 10 | Information Architecture Agent | 화면과 정보관계 설계 | reviewer-release |
| 11 | UX Friction Auditor | 입력 단계와 클릭 수 축소 | reviewer-release |
| 12 | UI Design System Agent | 색상, 간격, 글꼴, 컴포넌트 규칙 | reviewer-release |
| 13 | Responsive UI Agent | 휴대전화·태블릿·PC 대응 | reviewer-release |
| 14 | Accessibility Agent | 키보드, 명암, 화면읽기 대응 | reviewer-release |
| 15 | Internationalization Agent | 다국어 키와 번역구조 | reviewer-release |

## 19.3 프론트엔드
| # | 에이전트 | 책임 | 필수 독립 검토 |
|---|----------|------|----------------|
| 16 | Frontend Architect | 프론트 모듈과 의존성 설계 | security-privacy, qa |
| 17 | UI Implementation Agent | 화면 구현 | security-privacy, qa |
| 18 | State Management Agent | 화면·작업 상태 관리 | security-privacy, qa |
| 19 | API Integration Agent | 프론트와 Supabase 연결 | security-privacy, qa |
| 20 | Form Validation Agent | 입력검증과 오류표시 | security-privacy, qa |
| 21 | Offline/PWA Agent | 설치형 앱과 오프라인 구조 | security-privacy, qa |
| 22 | Browser Compatibility Agent | 브라우저 차이 검사 | security-privacy, qa |
| 23 | Mobile Performance Agent | 모바일 속도·발열·메모리 최적화 | security-privacy, qa |
| 24 | Single HTML Build Agent | 보조 단일 HTML 빌드 | security-privacy, qa |

## 19.4 여행 도메인
| # | 에이전트 | 책임 | 필수 독립 검토 |
|---|----------|------|----------------|
| 25 | Trip Domain Agent | 여행과 하위 개체 규칙 | security-privacy, qa |
| 26 | Timeline Agent | 시간순 기록 구성 | security-privacy, qa |
| 27 | Place Management Agent | 장소 생성·수정·중복통합 | security-privacy, qa |
| 28 | Map Agent | 지도와 마커 구현 | security-privacy, qa |
| 29 | GeoJSON Agent | 위치와 경로 표준화 | security-privacy, qa |
| 30 | Companion Agent | 동행인 관리 | security-privacy, qa |
| 31 | Expense Agent | 비용기록과 통화 | security-privacy, qa |
| 32 | Reflection Agent | 여행 회고 | security-privacy, qa |
| 33 | Statistics Agent | 여행 통계 | security-privacy, qa |
| 34 | Natural Search Agent | 자연어 기록검색 | security-privacy, qa |

## 19.5 사진·영상
| # | 에이전트 | 책임 | 필수 독립 검토 |
|---|----------|------|----------------|
| 35 | Image Intake Agent | 파일선택과 초기검증 | security-privacy, qa |
| 36 | Image Compression Agent | 사진 크기와 품질 압축 | security-privacy, qa |
| 37 | Thumbnail Agent | 썸네일 생성 | security-privacy, qa |
| 38 | EXIF Agent | 촬영정보 추출 | security-privacy, qa |
| 39 | Image Orientation Agent | 회전과 방향 보정 | security-privacy, qa |
| 40 | Duplicate Photo Agent | 중복사진 탐지 | security-privacy, qa |
| 41 | Media Queue Agent | 처리·업로드 대기열 | security-privacy, qa |
| 42 | Upload Retry Agent | 실패 재시도 | security-privacy, qa |
| 43 | Image Privacy Agent | GPS와 EXIF 노출 통제 | security-privacy, qa |
| 44 | Video Processing Agent | 영상 처리 | security-privacy, qa |

## 19.6 Supabase
| # | 에이전트 | 책임 | 필수 독립 검토 |
|---|----------|------|----------------|
| 45 | Database Schema Agent | DB 테이블·관계·인덱스 | security-privacy, qa |
| 46 | SQL Migration Agent | 변경 SQL과 되돌리기 | security-privacy, qa |
| 47 | Authentication Agent | 로그인과 세션 | security-privacy, qa |
| 48 | RLS Security Agent | 사용자별 DB 접근정책 | security-privacy, qa |
| 49 | Storage Architecture Agent | 버킷과 파일경로 | security-privacy, qa |
| 50 | Storage Policy Agent | Storage 접근정책 | security-privacy, qa |
| 51 | Signed URL Agent | 제한시간 파일 접근 | security-privacy, qa |
| 52 | Edge Function Agent | 서버측 보조처리 | security-privacy, qa |
| 53 | Realtime Agent | 실시간 갱신 | security-privacy, qa |
| 54 | Sync Agent | 서버·로컬 동기화 | security-privacy, qa |
| 55 | Conflict Resolution Agent | 데이터 충돌처리 | security-privacy, qa |
| 56 | Database Performance Agent | 쿼리·인덱스 최적화 | security-privacy, qa |
| 57 | Supabase Cost Agent | 저장·전송 사용량 감시 | security-privacy, qa |

## 19.7 오프라인
| # | 에이전트 | 책임 | 필수 독립 검토 |
|---|----------|------|----------------|
| 58 | IndexedDB Agent | 로컬 데이터베이스 | supabase, qa |
| 59 | Offline Queue Agent | 오프라인 작업대기 | supabase, qa |
| 60 | Network Status Agent | 연결상태 감지 | supabase, qa |
| 61 | Background Sync Agent | 연결복구 후 작업 | supabase, qa |
| 62 | Draft Recovery Agent | 작성 중 기록복원 | supabase, qa |
| 63 | Cache Strategy Agent | 화면·썸네일 캐시 | supabase, qa |
| 64 | Sync Integrity Agent | 동기화 누락·중복검사 | supabase, qa |

## 19.8 AI·검색 (MVP 이후 · Phase 7 전 비실행)
| # | 에이전트 | 책임 | 필수 독립 검토 |
|---|----------|------|----------------|
| 65 | Tagging Agent | 태그 추천 | security-privacy, qa |
| 66 | Daily Summary Agent | 하루 요약 | security-privacy, qa |
| 67 | Trip Summary Agent | 여행 전체 요약 | security-privacy, qa |
| 68 | Semantic Search Agent | 의미 기반 검색 | security-privacy, qa |
| 69 | Photo Caption Agent | 사진 설명 | security-privacy, qa |
| 70 | OCR Agent | 이미지 글자 읽기 | security-privacy, qa |
| 71 | Expense Extraction Agent | 영수증 비용 추출 | security-privacy, qa |
| 72 | AI Hallucination Guard | 기록에 없는 내용 생성 차단 | security-privacy, qa |
| 73 | Local LLM Agent | 로컬 모델 연결 | security-privacy, qa |
| 74 | Prompt Management Agent | 프롬프트와 출력버전 관리 | security-privacy, qa |

## 19.9 보안·개인정보
| # | 에이전트 | 책임 | 필수 독립 검토 |
|---|----------|------|----------------|
| 75 | Security Architect | 전체 보안구조 | qa, reviewer-release |
| 76 | Threat Modeling Agent | 공격경로 분석 | qa, reviewer-release |
| 77 | Secret Scanner Agent | 비밀키 노출검사 | qa, reviewer-release |
| 78 | RLS Penetration Agent | 타 사용자 접근 공격검사 | qa, reviewer-release |
| 79 | Upload Security Agent | 위장·악성 파일 방어 | qa, reviewer-release |
| 80 | XSS Injection Agent | 입력값 코드삽입 검사 | qa, reviewer-release |
| 81 | Privacy Agent | 개인정보 흐름검사 | qa, reviewer-release |
| 82 | Metadata Privacy Agent | EXIF·GPS 보호 | qa, reviewer-release |
| 83 | Data Deletion Agent | 삭제 완전성과 복구 | qa, reviewer-release |
| 84 | Backup Encryption Agent | 백업 암호화 | qa, reviewer-release |

## 19.10 검사·품질
| # | 에이전트 | 책임 | 필수 독립 검토 |
|---|----------|------|----------------|
| 85 | Unit Test Agent | 함수 단위검사 | reviewer-release |
| 86 | Integration Test Agent | 모듈·서버 연결검사 | reviewer-release |
| 87 | End-to-End Test Agent | 전체 사용자 흐름검사 | reviewer-release |
| 88 | Mobile Device Test Agent | 모바일 실제환경검사 | reviewer-release |
| 89 | Network Failure Test Agent | 네트워크 장애검사 | reviewer-release |
| 90 | Large Batch Test Agent | 사진 대량처리검사 | reviewer-release |
| 91 | Low Memory Test Agent | 낮은 메모리 환경검사 | reviewer-release |
| 92 | Data Integrity Agent | DB와 파일 연결검사 | reviewer-release |
| 93 | Regression Test Agent | 기존 기능 회귀검사 | reviewer-release |
| 94 | Adversarial QA Agent | 비정상 사용 적대적 검사 | reviewer-release |
| 95 | Bug Reproduction Agent | 오류 재현절차 작성 | reviewer-release |
| 96 | Acceptance Test Agent | 최종 완료조건 판정 | reviewer-release |

## 19.11 성능·운영
| # | 에이전트 | 책임 | 필수 독립 검토 |
|---|----------|------|----------------|
| 97 | Performance Profiler | 병목 측정 | reviewer-release |
| 98 | Image Memory Agent | 사진 처리 메모리검사 | security-privacy, qa |
| 99 | Database Query Agent | 과도한 DB 요청검사 | security-privacy, qa |
| 100 | Egress Optimization Agent | 반복 다운로드 감소 | security-privacy, qa |
| 101 | Error Logging Agent | 오류기록 | orchestrator |
| 102 | Usage Analytics Agent | 개인 사용통계 | reviewer-release |
| 103 | Storage Monitoring Agent | 저장용량 감시 | security-privacy, qa |
| 104 | Health Check Agent | DB·Storage·인증 상태검사 | orchestrator |
| 105 | Incident Analysis Agent | 장애원인과 방지책 | orchestrator |

## 19.12 백업·데이터 보존
| # | 에이전트 | 책임 | 필수 독립 검토 |
|---|----------|------|----------------|
| 106 | Export Agent | JSON·CSV·GeoJSON 내보내기 | security-privacy, qa |
| 107 | Import Agent | 백업 가져오기 | security-privacy, qa |
| 108 | Backup Agent | 백업 생성 | security-privacy, qa |
| 109 | Restore Validation Agent | 복원 결과검사 | reviewer-release |
| 110 | Data Migration Agent | 구버전 데이터 변환 | security-privacy, qa |
| 111 | Orphan File Cleanup Agent | DB와 연결되지 않은 파일검사 | security-privacy, qa |
| 112 | Orphan Record Cleanup Agent | 파일 없는 DB 기록검사 | security-privacy, qa |
| 113 | Version Compatibility Agent | 백업·DB 버전 호환 | orchestrator |

## 19.13 코드검토·배포
| # | 에이전트 | 책임 | 필수 독립 검토 |
|---|----------|------|----------------|
| 114 | Code Review Agent | 코드 품질검토 | orchestrator |
| 115 | Architecture Review Agent | 설계경계 위반검사 | orchestrator |
| 116 | Refactoring Agent | 중복과 거대함수 정리 | orchestrator |
| 117 | Dependency Review Agent | 외부 의존성 검토 | orchestrator |
| 118 | Build Agent | 운영 빌드 | orchestrator |
| 119 | Release Agent | 버전과 배포 | orchestrator |
| 120 | GitHub Agent | branch, commit, PR 관리 | orchestrator |
| 121 | Changelog Agent | 변경내용 기록 | orchestrator |
| 122 | Rollback Agent | 이전 버전 복구 | orchestrator |
| 123 | Documentation Agent | 개발·사용 문서 | orchestrator |

## 디자인 확장 (124–139) · USER 결정 · 유지
여행기록의 감성·사진·지도·타임라인·모바일 입력을 각각 전담하는 전문 디자인 역할. `.claude/agents/`에 개별 생성. **v0.2 기준서에는 없는 우리 저장소의 확장(139/26)으로, 사용자 결정에 따라 유지한다.** 독립 검토는 코어 감사(134–137)와 `travel-experience-director`(124) 승인으로 수행한다.

| # | 에이전트 | 핵심 책임 | 중요도 | 모델 | 필수 독립 검토 |
|---|----------|-----------|--------|------|----------------|
| 124 | Travel Experience Director | 전체 경험·디자인 방향 총괄·통합·승인 | 필수 | opus | adversarial-visual-reviewer |
| 125 | Memory-Centered UX Agent | 기록이 의미 있는 기억으로 남도록 설계 | 필수 | fable | 124, 137 |
| 126 | Mobile Capture UX Agent | 여행 중 10초 이내 기록 흐름 | 필수 | fable | 124, 135 |
| 127 | Photo Storytelling Designer | 사진 중심 갤러리·여행 이야기 | 필수 | fable | 124, 136 |
| 128 | Timeline Interaction Designer | 날짜별 흐름·순간 기록 | 필수 | fable | 124, 136 |
| 129 | Map Experience Designer | 지도·장소·이동경로 경험 | 필수 | fable | 124, 136 |
| 130 | Travel Design System Agent | 색·글꼴·카드·버튼·간격 토큰 통합 | 필수 | fable | 136, 139 |
| 131 | Emotional Visual Director | 감정·분위기 시각화, 감성 과잉 차단 | 권장 | fable | 124, 137 |
| 132 | Empty State Designer | 여행·기록 부족 화면 설계 | 권장 | fable | 124, 136 |
| 133 | Motion Interaction Designer | 사진 전환·저장·업로드 모션 | 권장 | fable | 134, 137 |
| 134 | Accessibility Design Auditor | 명암·글자·터치영역·화면읽기 감사 | 필수 | opus | qa |
| 135 | Mobile Device Design Auditor | 실제 휴대전화 사용성 감사 | 필수 | opus | qa |
| 136 | Design Consistency Auditor | 화면 간 디자인 불일치 감사 | 필수 | opus | 124 |
| 137 | Adversarial Visual Reviewer | 촌스러움·복잡함·정보과잉 적대 평가 | 필수 | opus | 124 |
| 138 | Figma Handoff Agent | Figma↔코드 일치 관리 | 권장 | opus | reviewer-release |
| 139 | Design Token Sync Agent | Figma 토큰↔CSS 변수 동기화 | 권장 | opus | reviewer-release |
