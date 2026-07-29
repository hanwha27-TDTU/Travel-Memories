// app/blueprint.ts — 설계 개요도(배선맵)의 단일 진실원(SSOT).
//
// 원칙(LESSONS §3·§7): 손으로 그리지 않는다. 발전원(데이터)→배선(다듬기·보관·동기화)→
// 말단(화면)을 실제 구조에서 파생하고, `scripts/check-blueprint.mjs` 게이트가 이 선언을
// 현실(db.ts 테이블·rowmap 파일·sync.ts·화면 파일)과 대조한다. 선언과 코드가 어긋나면 RED.
// "데이터가 있기만 하면 0점, 실제로 화면까지 닿아야 100점" — 끊긴 배선을 눈+게이트로 잡는다.
//
// 실카운트(liveCounts)는 Dexie 실제 목록에서 그때그때 읽는다(앱이 자동으로 그림).

import { db } from '../offline/db';

export type StorageForm = 'table' | 'bundle';

/** 발전원 = 데이터 도메인. implemented=Dexie 테이블 실장 여부(계획 도메인은 false). */
export interface SourceDomain {
  readonly key: string;
  readonly label: string;
  readonly table: string;
  readonly form: StorageForm;
  readonly implemented: boolean;
  /** 실카운트용 Dexie 프로퍼티(implemented일 때). */
  readonly localTable?: 'localTrips' | 'localMoments' | 'localMedia' | 'localExpenses' | 'localAudio' | 'localPlaces';
  readonly hasRowmap?: boolean; // src/domain/<key>/rowmap.ts 존재(게이트 검증)
  readonly hasSync?: boolean; // sync.ts에 table push/pull 배선(게이트 검증)
  // 🔴 여기 `localOnlyReason?: string`이 있었다(2026-07-27 오전). 오디오가 서버 테이블 없이
  //    태어나서, 자가점검이 그걸 「끊긴 배선」으로 판정하는 것을 막으려고 **이유를 강제하는**
  //    필드를 뒀다. 같은 날 오후 사용자가 전제를 없앴고(*"로컬에만 있는 자료는 결함"*), 쓰는
  //    도메인이 사라졌다. **빈 예외 구멍은 남기지 않는다** — 언젠가 또 채워도 된다는 뜻으로
  //    읽히기 때문이다. 정말로 서버에 못 가는 도메인이 생기면 그때 §7대로 **설계 단계에서**
  //    심사하고 이 필드를 다시 만든다(`purge.ts`의 `LOCAL_ONLY_DOMAINS`도 같이 사라졌다).
}

// 실장 도메인은 게이트가 db.ts·rowmap·sync.ts와 대조한다. 계획 도메인은 로드맵으로 표시(정직).
export const SOURCES: readonly SourceDomain[] = [
  { key: 'trip', label: '여행', table: 'trips', form: 'table', implemented: true, localTable: 'localTrips', hasRowmap: true, hasSync: true },
  { key: 'moment', label: '순간', table: 'moments', form: 'table', implemented: true, localTable: 'localMoments', hasRowmap: true, hasSync: true },
  { key: 'expense', label: '비용', table: 'expenses', form: 'table', implemented: true, localTable: 'localExpenses', hasRowmap: true, hasSync: true },
  { key: 'media', label: '사진', table: 'media', form: 'bundle', implemented: true, localTable: 'localMedia', hasRowmap: true, hasSync: true },
  { key: 'audio', label: '소리', table: 'audio', form: 'bundle', implemented: true, localTable: 'localAudio', hasRowmap: true, hasSync: true },
  // 오디오 노트 — 2026-07-27부터 **로컬+서버+백업 세 계층**(사진과 같다). 예전엔 여기 `localOnlyReason`이
  // 붙어 있었다; 그 예외는 사용자 결정으로 사라졌다(마이그레이션 0019 · services/audio.ts 머리주석).
  // 장소 — 2026-07-30부터 **1급 도메인**(마이그레이션 0022·0023). 순간의 장소 필드를
  // 대체하지 않는다: 링크(`moments.place_id`)는 선택이고, 순간에 적힌 이름·좌표가 기록 당시의
  // 사실로 그대로 남는다(0022 설계 결정 1). 여행의 자식이 아니라 **사용자 소유**다.
  { key: 'place', label: '장소', table: 'places', form: 'table', implemented: true, localTable: 'localPlaces', hasRowmap: true, hasSync: true },
  // 계획(DOMAIN_REGISTRY엔 있으나 아직 미실장 — 정직하게 로드맵으로 표시)
  { key: 'reflection', label: '회고', table: 'reflections', form: 'table', implemented: false },
  { key: 'companion', label: '동행', table: 'companions', form: 'table', implemented: false },
  { key: 'tripDay', label: '여행 하루', table: 'trip_days', form: 'table', implemented: false },
  { key: 'tag', label: '태그', table: 'tags', form: 'table', implemented: false },
];

/** ② 다듬기 — 저장·동기화 전 공통 처리(merge.ts·rowmap.ts의 실제 단계). */
export const SHAPING: readonly { code: string; label: string; sub: string }[] = [
  { code: '01', label: '모양 통일', sub: '정규화' },
  { code: '02', label: '중복 제거', sub: '중복 걸러내기' },
  { code: '03', label: 'DB 저장형 왕복', sub: '레코드 ↔ 행(rowmap)' },
  { code: '04', label: '합치기(최신 우선)', sub: 'LWW 병합' },
  { code: '05', label: '무결성·삭제표시', sub: 'tombstone · version' },
];

/** ③ 보관·동기화 — 로컬 우선 → 클라우드 맞춤 → 삭제는 휴지통(sync.ts의 실제 자세). */
export const STORAGE: readonly { code: string; label: string; sub: string }[] = [
  { code: '01', label: '내 기기에 먼저', sub: 'IndexedDB(Dexie) · 원본 보존' },
  { code: '02', label: '클라우드와 맞춤', sub: 'Supabase upsert·read-back · 빈-클라우드 가드' },
  { code: '03', label: '삭제는 휴지통으로', sub: 'tombstone · 실행취소 · 복구 가능' },
];

/** ④ 말단 = 화면. feeds=소비하는 발전원 키(게이트가 file 존재를 검증). */
export interface ScreenNode {
  readonly key: string;
  readonly label: string;
  readonly file: string;
  readonly route?: string;
  readonly feeds: readonly string[];
}
export const SCREENS: readonly ScreenNode[] = [
  { key: 'home', label: '홈 · 여행 목록', file: 'home.ts', route: 'home', feeds: ['trip'] },
  { key: 'tripDetail', label: '여행 상세 · 타임라인', file: 'tripDetail.ts', route: 'trip-detail', feeds: ['trip', 'moment', 'media', 'expense', 'audio', 'place'] },
  { key: 'mapView', label: '지도', file: 'mapView.ts', route: 'map', feeds: ['moment', 'media'] },
  { key: 'dataManager', label: '데이터 관리 · 백업', file: 'dataManager.ts', feeds: ['trip', 'moment', 'media', 'expense'] },
  { key: 'aboutApp', label: '개발자 정보', file: 'aboutApp.ts', feeds: [] },
  { key: 'designOverview', label: '설계 개요도', file: 'designOverview.ts', feeds: [] },
  { key: 'r2Setup', label: 'R2 저장소 설정 가이드', file: 'r2Setup.ts', feeds: [] },
  { key: 'guide', label: '가이드', file: 'guide.ts', feeds: [] },
  { key: 'researchNote', label: '연구노트', file: 'researchNote.ts', feeds: [] },
];

// ── 자가 점검(순수) — 실장 도메인이 왕복·동기화·화면까지 배선됐는지. 게이트와 같은 불변식. ──
export interface CheckGroup {
  label: string;
  got: number;
  total: number;
}
export interface SelfCheck {
  score: number; // 0..100
  got: number;
  total: number;
  groups: CheckGroup[];
  gaps: string[]; // 끊긴 배선(감점)
  roadmap: string[]; // 계획 도메인(정직 — 감점 아님)
}

export function selfCheck(): SelfCheck {
  const built = SOURCES.filter((s) => s.implemented);
  const fed = (key: string): boolean => SCREENS.some((sc) => sc.feeds.includes(key));

  // **실장 도메인은 전부 서버로 간다**(2026-07-27~). 분모에서 빼는 도메인이 없다 —
  // 예외를 만들려면 그 자리에 이유를 설계해 넣어야 한다(§7).
  const synced = built;

  const groups: CheckGroup[] = [
    { label: '저장형 왕복(rowmap)', got: synced.filter((s) => s.hasRowmap).length, total: synced.length },
    { label: '동기화 배선(sync)', got: synced.filter((s) => s.hasSync).length, total: synced.length },
    { label: '데이터 → 화면 연결', got: built.filter((s) => fed(s.key)).length, total: built.length },
  ];

  const gaps: string[] = [];
  for (const s of built) {
    if (!s.hasRowmap) gaps.push(`${s.label}: 저장형 왕복(rowmap) 없음`);
    if (!s.hasSync) gaps.push(`${s.label}: 동기화 배선 없음`);
    if (!fed(s.key)) gaps.push(`${s.label}: 어느 화면에도 닿지 않음(끊긴 배선)`);
  }
  const roadmap = SOURCES.filter((s) => !s.implemented).map((s) => s.label);

  const got = groups.reduce((n, g) => n + g.got, 0);
  const total = groups.reduce((n, g) => n + g.total, 0);
  const score = total === 0 ? 100 : Math.round((got / total) * 100);
  return { score, got, total, groups, gaps, roadmap };
}

/** 실카운트: Dexie 실제 목록에서 활성(미삭제) 개수. implemented 도메인만. */
export async function liveCounts(): Promise<Record<string, number>> {
  const d = db();
  const out: Record<string, number> = {};
  await Promise.all(
    SOURCES.filter((s) => s.localTable).map(async (s) => {
      out[s.key] = await d[s.localTable!].filter((r) => (r as { deletedAt: string | null }).deletedAt === null).count();
    }),
  );
  return out;
}
