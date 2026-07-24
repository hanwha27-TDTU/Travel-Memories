// app/gates.ts — 게이트 한 줄 설명·카테고리(편집 메타). 목록·개수는 registry.gen.ts에서 파생.
// guide.ts와 mechChecks.ts가 공유한다(설명을 두 곳에 손으로 쓰지 않게 — §7).

export type GateCategory = 'static' | 'generated' | 'unit';

export const CATEGORY_LABEL: Record<GateCategory, string> = {
  static: '정적 검사 (저장소만 · 네트워크 없음)',
  generated: '자동 생성물 ↔ 현실 대조',
  unit: '유닛 (순수 로직)',
};

/** 게이트 한 줄 설명. 목록엔 없어도 이름만 표시되니 필수 아님. */
export const GATE_DESC: Record<string, string> = {
  typecheck: 'TypeScript strict 타입 오류 0',
  'check-secret-leak': '시크릿(키·토큰) 형태가 코드에 새지 않았는지',
  'check-domain-wiring': '도메인↔화면 배선이 죽지 않았는지',
  'check-csp': 'CSP 위반(인라인·외부 리소스) 없는지',
  'check-base-consistency': 'base 경로·자산 참조 일관성',
  'check-schema-parity': '클라 rowmap 필드 ⊆ 서버 마이그레이션 컬럼(드리프트 차단)',
  'check-backup-coverage': '모든 사용자 테이블이 백업 export/import에 다 있는지',
  'check-blueprint': '설계 개요도(배선맵) 선언 ↔ 실제 구조 일치',
  'check-registry-gen': '자동 집계 카운트·목록이 SSOT와 일치(손 스냅샷 드리프트 차단)',
  'check-doc-counts': '문서에 표시한 live 카운트가 실제와 일치(마커 대조)',
  'unit-tests': '순수 로직 유닛(비공허 확인)',
};

/** 게이트 카테고리. 없으면 'static'으로 본다. 목록은 registry.gen에서 오므로 개수는 파생. */
export const GATE_CATEGORY: Record<string, GateCategory> = {
  typecheck: 'static',
  'check-secret-leak': 'static',
  'check-domain-wiring': 'generated',
  'check-csp': 'static',
  'check-base-consistency': 'generated',
  'check-schema-parity': 'static',
  'check-backup-coverage': 'static',
  'check-blueprint': 'generated',
  'check-registry-gen': 'generated',
  'check-doc-counts': 'generated',
  'unit-tests': 'unit',
};

export function categoryOf(gate: string): GateCategory {
  return GATE_CATEGORY[gate] ?? 'static';
}
