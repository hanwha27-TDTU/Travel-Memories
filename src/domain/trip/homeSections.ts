// domain/trip/homeSections.ts — 홈 첫 화면의 「상태별 보기」 순수 로직.
//
// 왜 순수 함수인가(§10 ③): 칩에 적히는 개수와 「완료 7개 모두 보기」 같은 문장은 전부
// **사용자에게 나가는 판정**이다. DOM 클로저에 넣으면 갈래를 검사할 수 없다 — M-0022는
// 자료구조가 전부 옳은데 화면에 나가는 것만 틀렸고, 유닛 15건이 모두 초록이었다.
//
// 왜 이 모듈이 생겼나(사용자 지적 2026-08-06): *"첫화면에 목록이 다 보이다보니 너무
// 산만해요."* 실측하니 여행 9건 중 7건에 **똑같은 「완료」 배지**가 붙어 있었고, 지금
// 진행 중인 여행과 13년 전 여행이 **같은 크기·같은 자리**에 있었다. 산만함의 원인은
// 개수가 아니라 **무게가 전부 같은 것**이었다(§8 — 거의 모두에 붙는 표시는 정보가 아니라 소음).
//
// 🔴 라벨·순서의 SSOT는 여기다. 예전엔 `home.ts`와 `tripDetail.ts`가 **각자 손으로** 같은
// 표를 갖고 있었다(§2 — 손편집 중복 자체가 결함). 한쪽만 고치면 같은 상태가 화면마다
// 다른 낱말로 불린다(§7 사용자 대면 대칭).

import { sortTripsNewestFirst } from './timeTree';

export type TripStatus = 'planned' | 'active' | 'completed' | 'archived';

/**
 * 상태 하나뿐인 최소 구조 — Dexie 타입을 끌어오지 않는다(유닛이 DB 없이 돈다).
 * `startDate`는 정렬에 쓴다(`sortTripsNewestFirst`와 같은 계약).
 */
export interface StatusTrip {
  status: TripStatus;
  startDate?: string | null;
}

export const STATUS_LABEL: Record<TripStatus, string> = {
  planned: '계획 중',
  active: '진행 중',
  completed: '완료',
  archived: '보관 중',
};

/**
 * 생명주기 순서 — 계획 → 진행 → 완료 → 보관. 사용자가 부른 순서 그대로다
 * (2026-08-06: *"'계획중, 진행중, 완료, 보관중'만 보이게"*).
 *
 * 🔴 **칩과 구획이 같은 순서를 쓴다.** 「지금 중요한 것 먼저(진행 중 → 계획 중)」로 칩만
 * 다르게 놓을까 했는데, 그러면 **한 화면에서 같은 넷이 두 순서로 나온다** — §7이 막는
 * 바로 그것이다(같은 성격은 같은 자리에 같은 어휘로). 실제로 계획 중이 0건이면 칩도
 * 구획도 진행 중이 맨 앞이라, 순서를 나눌 실익도 없었다.
 */
export const STATUS_ORDER: readonly TripStatus[] = ['planned', 'active', 'completed', 'archived'];

/** 요약 화면이 「완료」에서 펼쳐 두는 개수. 나머지는 [모두 보기] 뒤로 접힌다. */
export const RECENT_LIMIT = 3;

export interface StatusChip {
  status: TripStatus;
  label: string;
  count: number;
}

export interface HomeSection<T> {
  status: TripStatus;
  title: string;
  /** 이 상태의 전체 개수(접힌 것 포함) — 제목 옆 숫자. */
  total: number;
  /** 실제로 그릴 여행(최신순). */
  trips: T[];
  /** 접힌 나머지. 0이면 [모두 보기]를 **그리지 않는다**(침묵이 정상 — §8). */
  hiddenCount: number;
  /** [모두 보기] 문장. hiddenCount가 0이면 null — 없는 버튼의 문장을 만들지 않는다. */
  moreLabel: string | null;
}

/**
 * 상태 칩 — **0건은 아예 빼고** 돌려준다.
 *
 * 왜 0을 안 그리나: 지금 이 사용자의 데이터는 계획 중 0건·보관 0건이다. 넷을 늘 나열하면
 * 산만함을 없애려고 만든 줄이 **빈 칸 두 개로 새 소음**을 만든다(§8 — 침묵이 정상).
 * 여행이 생기면 칩도 저절로 나타난다(데이터에서 파생 — SSOT).
 */
export function statusChips(trips: ReadonlyArray<StatusTrip>): StatusChip[] {
  const counts = new Map<TripStatus, number>();
  for (const t of trips) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  return STATUS_ORDER.filter((s) => (counts.get(s) ?? 0) > 0).map((status) => ({
    status,
    label: STATUS_LABEL[status],
    count: counts.get(status) ?? 0,
  }));
}

/**
 * 요약 화면의 구획 — 상태별로 묶고 **완료만 최근 N개로 접는다**.
 *
 * 왜 완료만 접나: 완료는 계속 쌓이기만 하는 유일한 상태다(실측 9건 중 7건). 진행 중·계획 중은
 * 「지금·앞으로」라 개수가 적고, 그게 사용자가 홈을 여는 이유다 — 접으면 목적을 잃는다.
 *
 * 🔴 **보관은 구획을 갖지 않는다.** 이유 없는 제외는 결함이므로 적는다(§7): 보관은 사용자가
 * **명시적으로 치운 것**이라 첫 화면에서 침묵해야 한다. 볼 길이 없어지는 것은 아니다 —
 * 칩이 그 문을 연다(예전 [📦 보관함] 토글이 하던 일을 칩이 그대로 받았다).
 *
 * 정렬은 `sortTripsNewestFirst` **한 곳**을 통과한다 — 필터마다 정렬을 손으로 다시 쓰면
 * 같은 성격의 목록이 서로 다른 순서를 갖는다(ui-responsive-dev §1 목록 순서 계약).
 */
export function homeSections<T extends StatusTrip>(trips: ReadonlyArray<T>): HomeSection<T>[] {
  const sections: HomeSection<T>[] = [];
  for (const status of STATUS_ORDER) {
    if (status === 'archived') continue; // 위 주석의 「명시적으로 치운 것」
    const own = sortTripsNewestFirst(trips.filter((t) => t.status === status));
    if (own.length === 0) continue; // 빈 구획은 그리지 않는다(§8)
    const limit = status === 'completed' ? RECENT_LIMIT : own.length;
    const hiddenCount = Math.max(0, own.length - limit);
    sections.push({
      status,
      title: STATUS_LABEL[status],
      total: own.length,
      trips: own.slice(0, limit),
      hiddenCount,
      moreLabel: hiddenCount > 0 ? `${STATUS_LABEL[status]} ${own.length}개 모두 보기` : null,
    });
  }
  return sections;
}

/**
 * 요약 화면에 그릴 여행 집합(= 보관 제외). 칩이 안 눌린 기본 상태의 「대상 목록」이다.
 * 기간 트리가 이 집합에서 파생되므로 화면과 트리가 같은 것을 센다(§7).
 */
export function summaryPool<T extends StatusTrip>(trips: ReadonlyArray<T>): T[] {
  return trips.filter((t) => t.status !== 'archived');
}
