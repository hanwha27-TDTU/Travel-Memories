// domain/place/registry.ts — 「위치관리대장」의 순수 로직(검색·좌표 미리보기·짧은 주소).
//
// 사용자 요청(2026-08-05): *"데이터 관리 내 위치관리대장 버튼을 만들고 나서 한 번 등록된
// 장소는 자동으로 위치관리대장에 등재하도록"*.
//
// 🔴 **대장은 이미 있었다.** `LocalPlace` 테이블이 이름·주소·국가·도시·좌표를 다 갖고 있고
//    `savePlace()`가 장소를 만들 때마다 자동으로 넣는다 — 없었던 것은 **그걸 보여주는 화면**뿐이다.
//    그래서 이 기능은 새 데이터 모델이 아니라 **이미 쌓인 것을 꺼내 보는 창**이다(스키마 변경 0).
//
// ─────────────────────────────────────────────────────────────────────────────
// 좌표 순서 — 왜 「두 벌 저장」이 아니라 「한 벌 저장 + 두 벌 보기」인가
// ─────────────────────────────────────────────────────────────────────────────
// 사용자 제안은 *"좌표 2개 버전으로 관리(위도와경도의 순서를 바꾸는 경우도 있으므로)"*였고,
// 논의 끝에 **한 벌 저장**으로 정했다(사용자 결정 2026-08-05).
//
// 두 벌을 저장하면 **어느 쪽이 정본인지 앱이 모른다.** 지도·통계·내보내기가 매번 골라야 하고,
// 고르는 규칙이 없으면 조용히 한쪽을 쓴다 — 그게 M-0057에서 **기억이 기니만 앞바다에 찍힌**
// 방식이다. 대신 화면이 **두 벌을 나란히 보여주고 주소로 답을 드러낸다**:
//
//     41.3111, 69.2797  →  우즈베키스탄 · 타슈켄트   ← 지금 이것
//     69.2797, 41.3111  →  (바다 · 주소 없음)        [이걸로 바꾸기]
//
// 사용자가 눈으로 확인하고 **지금 확정한다.** 나중에 고를 것을 남기지 않는다.

import { isUsableCoord } from './coordInput';

/** 대장이 다루는 장소의 최소 모양 — 화면·유닛이 이 형태만 알면 된다. */
export interface RegistryPlace {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  country: string | null;
  city: string | null;
  formattedAddress: string | null;
  /** 어느 지오코더가 준 주소인가. null이면 지도에서 직접 찍었거나 아직 주소를 안 받은 것. */
  provider: string | null;
  deletedAt: string | null;
}

/**
 * 이름 부분일치 검색.
 *
 * 사용자 요청: *"장소 필드에 입력할 때 한글자라도 동일하면 그 글자가 포함된 장소들은 다 나오게"*
 *
 * 🔴 **상한을 두지 않는다.** 기존 순간 편집 화면은 `.slice(0, 5)`로 잘랐는데, 그러면
 * 「타」를 쳤을 때 여섯 번째 장소는 **존재하지 않는 것과 같다.** 개인 여행 앱이라 장소 수가
 * 수백 규모이므로 전부 보여도 감당된다. 자를 거면 자른 사실을 말해야 하는데(§5 3항),
 * 자동완성에서 "외 N건 생략"은 읽히지 않는다 — 그래서 아예 안 자른다.
 *
 * 빈 검색어는 **전부**를 준다(대장 화면의 기본 상태). 지운 장소는 언제나 뺀다.
 */
export function searchRegistry<T extends RegistryPlace>(places: readonly T[], query: string): T[] {
  const alive = places.filter((p) => p.deletedAt === null);
  const needle = query.trim().toLowerCase();
  if (!needle) return alive;
  return alive.filter((p) => {
    // 이름뿐 아니라 주소·도시·국가에서도 찾는다 — 「타슈켄트」를 쳤을 때 이름이 「집」인
    // 장소도 나와야 한다. 사용자가 기억하는 실마리가 이름이라는 보장이 없다.
    const hay = [p.name, p.city, p.country, p.formattedAddress].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(needle);
  });
}

/**
 * 순간 편집의 장소 칸에서 **치는 동안** 대장이 못 찾았을 때 할 말. 못 찾았으면 `null`이 아니라
 * 문장을 준다 — 침묵은 「그런 곳은 없다」로 읽히는데, 대장이 아는 것은 **내가 담아 둔 곳뿐**이다
 * (§7-C 「한정을 생략」). 그래서 시야의 경계를 밝히고 **다음에 할 일**을 함께 준다(막다른 길 금지).
 *
 * 순수 함수인 이유: 이 한 줄이 사용자가 「내 장소에 없구나」를 판단하는 근거이고, 문장 로직이
 * DOM 클로저에 있으면 갈래를 검사할 수 없다(§10 ③ — 이 저장소의 최빈 결함군).
 *
 * @param total 대장에 담긴 살아 있는 장소 수. 0이면 「없다」가 아니라 **아직 안 쌓였다**이다.
 */
export function liveLookupNote(query: string, total: number): string | null {
  if (!query.trim()) return null; // 안 친 상태에서 먼저 말하지 않는다(§8 침묵이 정상)
  if (total === 0) return '아직 담아 둔 장소가 없어요 — [🔍 검색]이나 [🗺 지도]로 정하면 여기 쌓입니다.';
  return `내 장소 ${total}곳 중에 없어요 — [🔍 검색]으로 지도에서 찾을 수 있어요.`;
}

/** 국가·도시까지만 — 사용자 요청 ④ (예: `우즈베키스탄 · 타슈켄트`). 없으면 null. */
export function shortAddress(p: { country: string | null; city: string | null }): string | null {
  const parts = [p.country, p.city].filter((x): x is string => Boolean(x));
  if (!parts.length) return null;
  // 국가와 도시가 같은 문자열로 오는 경우(도시국가 등)는 한 번만 적는다.
  if (parts.length === 2 && parts[0] === parts[1]) return parts[0];
  return parts.join(' · ');
}

/** 좌표 한 벌의 표시 정보. */
export interface CoordView {
  lat: number;
  lng: number;
  /** 위도 ±90 · 경도 ±180 안에 드는가. 벗어나면 이 순서는 **불가능하다**. */
  usable: boolean;
  /** 소수점 4자리 표시 — 약 11m 해상도로, 사람이 눈으로 대조하기에 충분하다. */
  label: string;
}

/** 지금 좌표와 뒤집은 좌표를 **나란히** 준다. 화면이 둘을 함께 보여주고 사용자가 고른다. */
export interface CoordPreview {
  current: CoordView;
  swapped: CoordView;
  /**
   * 🔴 뒤집어도 말이 되는가 — `true`면 **물리 제약으로는 못 가른다**(예: 41.3, 69.2).
   * 이때만 화면이 「뒤집으면 여기」를 눈에 띄게 보여준다. 못 가르는 것을 가른 척하지 않는다(§8).
   */
  ambiguous: boolean;
}

function view(lat: number, lng: number): CoordView {
  return {
    lat,
    lng,
    usable: isUsableCoord(lat, lng),
    label: `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
  };
}

/**
 * 좌표 미리보기.
 *
 * 위도는 ±90을 넘을 수 없다는 **물리 제약**이 대부분의 모호함을 없앤다 — 한국 좌표
 * (경도 124~132)는 뒤집으면 위도가 90을 넘어 불가능하므로 `ambiguous: false`다.
 * 타슈켄트(41.3, 69.2)처럼 둘 다 90 미만이면 원리적으로 모호하고, 그때는 **주소가 답한다**.
 */
export function coordPreview(lat: number, lng: number): CoordPreview {
  const current = view(lat, lng);
  const swapped = view(lng, lat);
  return { current, swapped, ambiguous: current.usable && swapped.usable };
}

/**
 * 대장 목록의 정렬 — 이름 가나다순.
 *
 * 왜 최신순이 아닌가: 대장은 **찾으러 오는 화면**이다(사진의 위치를 고치려고 온다).
 * 「언제 만들었나」가 아니라 「이름이 무엇인가」로 찾으므로 가나다순이 맞다.
 */
export function sortRegistry<T extends RegistryPlace>(places: readonly T[]): T[] {
  return [...places].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}

/** 주소를 아직 못 받은 장소 — 대장이 「주소 불러오기」를 권할 대상. */
export function needsAddress(p: RegistryPlace): boolean {
  return p.country === null && p.city === null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 「이 장소를 쓰는 순간들」 — 고치기 전에 **어디에 영향이 가나**를 본다 (사용자 결정 2026-08-05)
// ─────────────────────────────────────────────────────────────────────────────

/** 순간 쪽에서 이 판단에 필요한 부분만. */
export interface MomentLike {
  id: string;
  tripId: string;
  title: string;
  occurredAt: string;
  placeName: string;
  /** 라이브러리에서 골랐으면 그 장소 id. 자유 입력·지도 직접 지정은 **없는 것이 정상**이다. */
  placeId?: string | null;
  deletedAt: string | null;
}

/**
 * 이 장소를 쓰는 순간들 — **두 갈래로 나눠 센다.**
 *
 * 🔴 왜 나누는가(§8 — 모르는 것을 아는 척하지 않는다):
 *  · `linked` = `placeId`가 이 장소를 가리킨다. **확실하다.**
 *  · `sameName` = 링크는 없고 이름만 같다. 같은 곳일 **수도** 있고 아닐 수도 있다 —
 *    「집」이라 적은 곳이 서울 집일 수도 타슈켄트 집일 수도 있다.
 *
 * 둘을 한 숫자로 합치면 그 숫자가 거짓이 된다. 합치면 사용자는 「7개가 이 장소를 쓴다」로
 * 읽는데 실제로는 3개만 확실하다 — 그 차이가 장소를 고칠지 말지의 판단을 바꾼다.
 *
 * 🔴 그리고 **이름이 같아도 좌표는 안 바꾼다**: `updatePlace`의 계약대로 대장 수정은 과거
 * 순간의 기록을 건드리지 않는다(사용자가 쓴 것을 앱이 고쳐 쓰지 않는다). 여기서 세는 것은
 * 「무엇이 이 이름을 쓰고 있나」이지 「무엇이 바뀔 것인가」가 아니다.
 */
export function momentsUsingPlace<T extends MomentLike>(
  moments: readonly T[],
  place: { id: string; name: string },
): { linked: T[]; sameName: T[] } {
  const alive = moments.filter((m) => m.deletedAt === null);
  const linked = alive.filter((m) => m.placeId === place.id);
  const linkedIds = new Set(linked.map((m) => m.id));
  const sameName = alive.filter(
    // 링크된 것은 이미 셌으므로 빼고, 이름이 정확히 같은 것만(부분일치는 여기서 쓰지 않는다 —
    // 검색과 달리 이건 **동일성 판단**이라 느슨하게 하면 남의 순간을 끌어온다).
    // 다른 장소 ID가 있으면 이름이 같아도 "링크 없음" 추정이 아니라 서로 다른 장소라는 명시적 사실이다.
    (m) => !linkedIds.has(m.id) && !m.placeId && m.placeName.trim() !== '' && m.placeName.trim() === place.name.trim(),
  );
  return { linked, sameName };
}

/**
 * 「이 장소를 쓰는 순간」 개수 한 줄.
 *
 * 🔴 확실한 것과 짐작을 **한 문장 안에서도 구분해 말한다**. `null`이면 쓰는 순간이 없다는 뜻.
 */
export function usageLabel(u: { linked: unknown[]; sameName: unknown[] }): string | null {
  const l = u.linked.length;
  const s = u.sameName.length;
  if (!l && !s) return null;
  if (l && s) return `이 장소를 쓰는 순간 ${l}개 · 이름만 같은 순간 ${s}개`;
  if (l) return `이 장소를 쓰는 순간 ${l}개`;
  return `이름만 같은 순간 ${s}개`;
}

/** 장소 기록 모달의 최소 투영. 사진 제목은 별도 필드가 아니라 순간 제목이다. */
export interface PlaceRecordMoment extends MomentLike {
  tripTitle: string;
}

export interface PlaceRecordTripGroup<T extends PlaceRecordMoment> {
  tripId: string;
  tripTitle: string;
  moments: T[];
}

/** 기존 장소 판정을 재사용해 확실한 링크와 이름만 같은 추정을 여행별로 묶는다. */
export function placeRecordGroups<T extends PlaceRecordMoment>(
  moments: readonly T[],
  place: { id: string; name: string },
): { linked: PlaceRecordTripGroup<T>[]; sameName: PlaceRecordTripGroup<T>[] } {
  const group = (items: T[]): PlaceRecordTripGroup<T>[] => {
    const byTrip = new Map<string, PlaceRecordTripGroup<T>>();
    for (const item of items) {
      const existing = byTrip.get(item.tripId);
      if (existing) existing.moments.push(item);
      else byTrip.set(item.tripId, { tripId: item.tripId, tripTitle: item.tripTitle, moments: [item] });
    }
    return [...byTrip.values()];
  };
  const usage = momentsUsingPlace(moments, place);
  return { linked: group(usage.linked), sameName: group(usage.sameName) };
}
