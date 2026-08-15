// ui/lazyScreens.ts — 보조 화면을 첫 로드에서 떼어내는 **단 하나의 자리**(§7 2층).
//
// 왜: 이 앱의 첫 화면은 여행 중 휴대전화 데이터로 열린다. 그런데 개발자 정보·연구노트·
// 가이드·진단 도구처럼 **여행 기록과 무관하고 어쩌다 한 번 여는 화면**이 정적 import
// 사슬로 딸려 오면 첫 로드가 그만큼 무거워진다. 실측(v0.99 직전): main 번들 388KB 중
// 한글 텍스트 리터럴만 187KB(38%)였고 그 대부분이 CHANGELOG·RESEARCH_LOG였다.
//
// 규칙: **핵심 화면(home·tripDetail)은 보조 화면을 정적으로 import하지 않는다.**
// 반드시 이 파일의 열기 함수를 거친다. 화면마다 `await import()`를 손으로 쓰면 다음
// 사람이 그 규칙을 모른 채 정적 import를 추가하고, 그 순간 형제가 갈라진다(§7).
// `scripts/check-lazy-screens.mjs` 게이트가 이탈을 RED로 잡는다.
//
// 왜 하위 화면끼리는 정적 import를 남겨두나: 끊어야 할 간선은 **핵심 → 보조** 경계뿐이다.
// aboutApp→researchNote 처럼 보조끼리의 간선은 이미 같은 지연 청크 안이라 첫 로드에
// 영향이 없다. 불필요한 지연은 오히려 화면 전환을 늦춘다.
//
// 타입은 `import type`으로만 가져온다(빌드에서 지워져 런타임 비용 0).

import type { MapPoint } from './screens/mapView';
import type { PlaceLike } from '../domain/place/externalMap';

/** 진단 도구 허브. `toolId`를 주면 해당 도구를 펼친 채로 연다. */
export async function openDiagnosticsHub(toolId?: string): Promise<void> {
  const m = await import('./screens/diagnosticsHub');
  m.openDiagnosticsHub(toolId);
}

/** '데이터 관리' 허브(백업·복원·휴지통·저장소 설정). */
export async function openDataManager(opts: { onChanged: () => void; goToTrip: (tripId: string) => void }): Promise<void> {
  const m = await import('./screens/dataManager');
  m.openDataManager(opts);
}

/** 개발자 정보(버전·변경 이력·연구노트·설계 개요도 진입점). */
export async function openAboutApp(): Promise<void> {
  const m = await import('./screens/aboutApp');
  m.openAboutApp();
}

/** 여행 지도 보기. MapLibre 자체는 mapView 안에서 한 번 더 지연 로드된다. */
export async function openMapView(
  tripTitle: string,
  points: MapPoint[],
  focusPlace?: PlaceLike,
): Promise<void> {
  const m = await import('./screens/mapView');
  m.openMapView(tripTitle, points, focusPlace);
}

/**
 * 지도로 좌표 고르기. 사용자가 고른 좌표(또는 취소 시 null)를 돌려준다.
 * 지연 로드 실패(오프라인 등)는 취소와 같게 다룬다 — 좌표를 못 고른 것이지 오류가 아니다.
 */
export async function openMapPicker(
  initial: { lat: number; lng: number } | null,
): Promise<{ lat: number; lng: number } | null> {
  const m = await import('./screens/mapView');
  return m.openMapPicker(initial);
}

/**
 * 「이 사람과 함께한 기록」 — 동행인 칩을 누르면 열린다(사용자 지시 2026-08-15).
 * 여행 상세에서 여는 보조 화면이므로 **정적 import를 만들지 않는다**(§7 2층 · check-lazy-screens).
 */
export async function openCompanionRecords(
  person: string,
  opts: { goToTrip: (tripId: string, target?: { momentId?: string; mediaId?: string }) => void },
): Promise<void> {
  const m = await import('./screens/companionRecords');
  await m.openCompanionRecords(person, opts);
}
