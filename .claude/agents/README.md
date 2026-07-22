# .claude/agents · Journey Archive 에이전트 팀

139개 논리 역할(`docs/AGENT_REGISTRY.md`)을 **통합 에이전트 10개 + 디자인 에이전트 16개**로 구현. 동시에 다 돌리지 않고 Orchestrator가 변경유형별로 필요한 역할만 호출한다(AGENTS.md 보증 매트릭스).

## 통합 에이전트 (10)
| 파일 | 담당 역할(레지스트리) | 모델 | 도구 |
|------|----------------------|------|------|
| `orchestrator` | 1–7 중앙관리 | opus | R/G/Gl/W/E/Bash |
| `product-ux` | 8–15 제품·화면설계 | fable | R/G/Gl/W/E/Bash |
| `frontend` | 16–24 프론트엔드 | fable | R/G/Gl/W/E/Bash |
| `travel-domain` | 25–34 여행 도메인 | opus | R/G/Gl/W/E/Bash |
| `media-pipeline` | 35–44 사진·영상 | opus | R/G/Gl/W/E/Bash |
| `supabase` | 45–57 Supabase | opus | R/G/Gl/W/E/Bash |
| `offline-sync` | 58–64 오프라인 | opus | R/G/Gl/W/E/Bash |
| `security-privacy` | 75–84 보안·개인정보 | opus | R/G/Gl/Bash (읽기전용) |
| `qa` | 85–105 검사·성능 | opus | R/G/Gl/Bash (읽기전용) |
| `reviewer-release` | 106–123 백업·검토·배포 | opus | R/G/Gl/Bash (읽기전용) |

> AI·검색(65–74)은 MVP 안정화 후 별도 branch에서 활성화.

## 디자인 에이전트 (16 · 레지스트리 124–139)
| 파일 | 책임 | 모델 | 유형 |
|------|------|------|------|
| `travel-experience-director` | 전체 경험·방향 총괄·승인 | opus | 총괄 |
| `memory-centered-ux` | 의미 있는 기억으로 남게 | fable | 생산 |
| `mobile-capture-ux` | 10초 기록 흐름 | fable | 생산 |
| `photo-storytelling-designer` | 사진 중심 이야기 | fable | 생산 |
| `timeline-interaction-designer` | 날짜별 흐름 | fable | 생산 |
| `map-experience-designer` | 지도·장소·경로 | fable | 생산 |
| `travel-design-system` | 디자인 토큰 통합 | fable | 생산 |
| `emotional-visual-director` | 감정·분위기, 과잉 차단 | fable | 생산 |
| `empty-state-designer` | 빈 화면 설계 | fable | 생산 |
| `motion-interaction-designer` | 최소 모션 | fable | 생산 |
| `accessibility-design-auditor` | 명암·터치·리더 감사 | opus | 감사(읽기전용) |
| `mobile-device-design-auditor` | 실기기 사용성 감사 | opus | 감사(읽기전용) |
| `design-consistency-auditor` | 화면 간 일치 감사 | opus | 감사(읽기전용) |
| `adversarial-visual-reviewer` | 적대적 시각 평가(JSON) | opus | 감사(읽기전용) |
| `figma-handoff-agent` | Figma↔코드 일치 | opus | 브릿지 |
| `design-token-sync-agent` | Figma 토큰↔CSS 동기화 | opus | 브릿지 |

## 운영 원칙
- **역할→필수 독립 검토자 매핑은 `docs/AGENT_REGISTRY.md`의 "필수 독립 검토" 열에 있다** (예: 대부분 → security-privacy+qa, supabase 접촉 → security-privacy+qa, 오프라인 → supabase+qa 등). 여기서 중복하지 않고 레지스트리를 SSOT로 참조한다.
- **에이전트 보고서는 스키마 검증 artifact다** — `schemas/agent-report.schema.json`으로 검증해 `artifacts/agent-reports/{TASK_ID}-{agent}.json`에 남긴다(AGENTS.md §18.1, S-07). chat output만으로 인계하지 않는다.
- 기본값은 단일 구현 에이전트가 맥락 유지(조사→구현→검증→문서→보고). 광범위 탐색·감사만 병렬화.
- 감사·리뷰어는 **읽기전용** — 코드를 수정하지 않고 결함만 보고. 구현자 자기인증 금지. 감사·리뷰어에는 Write/Edit를 부여하지 않아 코드 수정을 막고, Bash는 스크린샷·테스트 실행용이다(정책상 읽기전용; Phase 0에서 hook으로 쓰기 차단을 보강).
- 모든 에이전트는 AGENTS.md §18.1 공통 출력계약 JSON으로 결과 반환.
- 코어 디자인 7개 운영 순서: director → memory-centered-ux → mobile-capture-ux → photo-storytelling → (timeline+map) → design-system → adversarial-visual-reviewer.
- 외부 도구 흐름(권장): Claude Code(요구·데이터 상태 정의) → Figma First Draft(와이어프레임) → Figma Make(시제품) → Travel Experience Director(목적 일치 검토) → Adversarial Visual Reviewer(복잡·촌스러움) → Claude Code(구현) → Codex(토큰·구현 일치 재검토).
