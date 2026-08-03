// app/agents.ts — 에이전트 한 줄 설명·분류(편집 메타). 목록·개수는 registry.gen.ts에서 파생.
//
// 🔴 **왜 게이트(gates.ts)와 같은 모양인가**: 형제이기 때문이다(§7). 게이트는 이미
// 「목록은 자동 파생, 설명은 사람의 말, 둘의 어긋남은 게이트가 양방향 대조」로 정착했다.
// 에이전트만 가이드 화면에 **손으로 나열**돼 있었다 — 그래서 새 에이전트가 생겨도 화면은
// 옛 목록을 보여줬고, 반대로 지운 에이전트가 화면에 남아도 아무도 몰랐다.
//
// 실제로 이 자리에서 두 번 데였다:
//  · 가이드가 「6게이트·26에이전트」를 손 스냅샷으로 적어 실제(10·28)와 어긋남 → gen-registry 도입
//  · `agentCount`가 `README.md`를 세어 **28**이라고 말함(실제 27) — 기계화됐다는 이유로
//    아무도 의심하지 않았다(2026-08-03 전수 감사에서 발견). 이제 frontmatter로 판정한다.
//
// **새 에이전트를 추가하면 여기 설명도 반드시 따라온다** — `check-registry-gen`이 누락과
// 잔존을 **양방향**으로 RED로 잡는다.

export type AgentCategory = 'core' | 'design' | 'audit';

export const AGENT_CATEGORY_LABEL: Record<AgentCategory, string> = {
  core: '통합 (구현·검증)',
  design: '디자인 (감성과 실용의 균형)',
  audit: '독립 감사 (읽기전용 · 구현자와 분리)',
};

/** 에이전트 한 줄 설명 — **에이전트마다 반드시 하나씩**(없으면 화면에 이름만 뜬다). */
export const AGENT_DESC: Record<string, string> = {
  // ── 통합: 조사 → 구현 → 검증 → 문서까지 맥락을 유지하는 실행 에이전트
  orchestrator: '무엇을·어떤 순서로·누가 — 변경 분해와 게이트 라우팅',
  'product-ux': '범위·사용자 흐름·정보구조·디자인 토큰·접근성 결정',
  frontend: '화면 구현·상태 관리·Supabase 배선·오프라인/PWA',
  'travel-domain': '여행·순간·장소·비용·회고의 도메인 규칙과 데이터 모델',
  'media-pipeline': '사진 인테이크 — EXIF·방향 보정·압축·썸네일·업로드 대기열',
  supabase: '스키마·RLS 정책·마이그레이션·Storage·Edge Function',
  'offline-sync': 'Dexie 로컬 저장·오프라인 큐·LWW/tombstone·빈-클라우드 가드',
  'security-privacy': '시크릿 스캔·RLS 침투검사·EXIF/PII·삭제 완전성 (읽기전용)',
  qa: '유닛·통합·E2E·저메모리·대량사진·성능 측정 (읽기전용)',
  'reviewer-release': '내보내기/복원·코드 품질·릴리스·롤백 조율 (읽기전용)',

  // ── 디자인: 사진과 기억이 주인공이라는 전제를 화면에서 지킨다
  'travel-experience-director': '디자인 결과 통합·승인 — 화면 간 경험 일관성 판정',
  'memory-centered-ux': '데이터 나열이 아니라 기억을 떠올리게 하는 구조 설계',
  'mobile-capture-ux': '걸으며 한 손으로 10초 안에 기록하는 흐름',
  'photo-storytelling-designer': '격자 나열이 아니라 여행 이야기로 보이는 사진 배치',
  'timeline-interaction-designer': '타임라인을 하루의 흐름으로 읽히게 — 날짜 이동·가상 렌더링',
  'map-experience-designer': '지도를 장식이 아니라 공간적 기억 복원 도구로',
  'travel-design-system': '색·간격·반경·사진비율 등 디자인 토큰의 단일 정의',
  'emotional-visual-director': '여행의 분위기 시각화 — 감성 과잉과 사진 방해를 차단',
  'motion-interaction-designer': '상태 변화를 이해시키는 최소한의 움직임',
  'empty-state-designer': '비어 있음이 막다른 길이 되지 않게 — 다음 행동으로 유도',
  'design-token-sync-agent': 'Figma 변수 ↔ CSS 토큰 동기화와 드리프트 검출',
  'figma-handoff-agent': 'Figma 컴포넌트 ↔ 코드 컴포넌트 대응(Code Connect)',
  'accessibility-design-auditor': '명암비·터치 영역·초점·화면읽기 라벨 감사 (읽기전용)',
  'adversarial-visual-reviewer': '촌스러움·정보 과잉을 적대적으로 판정 (읽기전용)',
  'design-consistency-auditor': '화면 간 불일치·하드코딩 색 등 토큰 위반 감사 (읽기전용)',
  'mobile-device-design-auditor': '실기기 세로 화면 한 손 조작·경계대역 붕괴 감사 (읽기전용)',

  // ── 독립 감사: 구현자가 스스로 인증할 수 없는 자리
  'disaster-recovery-guardian': '진짜 복원 가능한 백업이 실재·무장돼 있는지 (PASS/FAIL/HOLD)',
};

/** 에이전트 분류 — 가이드 화면이 이 값으로 묶어 그린다. */
export const AGENT_CATEGORY: Record<string, AgentCategory> = {
  orchestrator: 'core',
  'product-ux': 'core',
  frontend: 'core',
  'travel-domain': 'core',
  'media-pipeline': 'core',
  supabase: 'core',
  'offline-sync': 'core',
  'security-privacy': 'core',
  qa: 'core',
  'reviewer-release': 'core',

  'travel-experience-director': 'design',
  'memory-centered-ux': 'design',
  'mobile-capture-ux': 'design',
  'photo-storytelling-designer': 'design',
  'timeline-interaction-designer': 'design',
  'map-experience-designer': 'design',
  'travel-design-system': 'design',
  'emotional-visual-director': 'design',
  'motion-interaction-designer': 'design',
  'empty-state-designer': 'design',
  'design-token-sync-agent': 'design',
  'figma-handoff-agent': 'design',
  'accessibility-design-auditor': 'design',
  'adversarial-visual-reviewer': 'design',
  'design-consistency-auditor': 'design',
  'mobile-device-design-auditor': 'design',

  'disaster-recovery-guardian': 'audit',
};
