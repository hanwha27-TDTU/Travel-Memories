// domain/place/provider.ts — **어느 지오코더에게 물을 것인가**(순수 → 유닛으로 잠금).
//
// 왜 제공자가 둘 이상인가 (사용자 결정 2026-07-30: *한국 + 해외 여행지 둘 다*):
//   Nominatim(OSM)은 키가 필요 없고 전 세계를 덮지만, **한국의 상호명·건물 검색은 약하다**
//   — OSM의 한국 POI 밀도가 국내 서비스보다 낮기 때문이다. 반대로 국내 제공자(VWorld·Kakao)는
//   한국을 잘 알지만 해외를 모른다. 어느 하나로 통일하면 사용자의 절반이 손해를 본다.
//
//   그래서 **하나를 고르지 않고 순서를 정한다.** 한국을 가리키는 질의는 국내 제공자에게
//   먼저 묻고, 답이 없거나 국내 제공자가 설정되지 않았으면 Nominatim으로 내려온다.
//   Nominatim은 **키가 필요 없으므로 언제나 마지막에 있다** — 설정을 안 해도 앱은 돈다.
//
// 🔴 이 파일은 "어디에 묻는가"만 정한다. 실제 호출·키·네트워크는 services/geocode.ts와
//    Edge Function(supabase/functions/geocode)의 몫이다. 라우팅 규칙은 순수해야 검사된다.

export type ProviderId = 'nominatim' | 'vworld' | 'kakao';

/** 사용자에게 보이는 제공자 이름 — **어디서 온 답인지 숨기지 않는다**(§8 출처 표시). */
const PROVIDER_LABEL: Record<ProviderId, string> = {
  nominatim: 'OpenStreetMap',
  vworld: '국토교통부 VWorld',
  kakao: '카카오맵',
};

export function providerLabel(id: ProviderId): string {
  return PROVIDER_LABEL[id];
}

/** 키가 필요 없어 **언제나 쓸 수 있는** 제공자. 설정이 하나도 없어도 앱이 도는 근거다. */
export const FALLBACK_PROVIDER: ProviderId = 'nominatim';

/** 국내 전용 제공자(해외 질의에 쓰면 답이 없거나 엉뚱하다). */
const KOREA_ONLY: ReadonlySet<ProviderId> = new Set<ProviderId>(['vworld', 'kakao']);

export function isKoreaOnly(id: ProviderId): boolean {
  return KOREA_ONLY.has(id);
}

/** 한글(음절·자모)이 하나라도 있는가. */
export function hasHangul(text: string): boolean {
  return /[ㄱ-ㆎ가-힣]/.test(text);
}

/**
 * 대한민국 본토 + 제주 + 울릉/독도를 넉넉히 덮는 상자.
 *
 * 정밀한 국경이 목적이 아니다 — **"국내 제공자에게 먼저 물어볼 가치가 있는가"**만 가르면 된다.
 * 넓게 잡아 틀려도 손해가 없다: 국내 제공자가 답을 못 주면 Nominatim으로 내려가기 때문이다.
 */
const KR_BOX = { south: 32.5, north: 39.0, west: 124.0, east: 132.5 };

export function inKoreaBox(p: { lat: number; lng: number } | null | undefined): boolean {
  if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return false;
  return p.lat >= KR_BOX.south && p.lat <= KR_BOX.north && p.lng >= KR_BOX.west && p.lng <= KR_BOX.east;
}

/**
 * 이 질의가 **한국을 가리키는가**.
 *
 * 두 단서를 쓴다. ①질의에 한글이 있다 ②지금 보고 있는 위치가 한국 안이다.
 * 둘 중 하나면 충분하다 — 「Gyeongbokgung」처럼 로마자로 적은 국내 검색(①이 거짓)과
 * 「스타벅스」처럼 어디에나 있는 이름(②가 결정)을 둘 다 살리기 위해서다.
 *
 * **틀려도 안전한 판정이다.** 틀리게 국내로 보내면 결과가 비고 Nominatim이 답한다.
 * 틀리게 해외로 보내도 Nominatim이 답한다. 비용은 요청 한 번이지 오답이 아니다.
 */
export function looksKorean(query: string, near?: { lat: number; lng: number } | null): boolean {
  return hasHangul(query) || inKoreaBox(near);
}

/**
 * 물어볼 순서를 정한다.
 *
 * @param available 지금 실제로 쓸 수 있는 제공자(키·프록시가 설정된 것). Nominatim은 늘 포함.
 *
 * 규칙:
 *  - 한국 질의: 설정된 국내 제공자 먼저, 그 다음 Nominatim.
 *  - 해외 질의: **국내 제공자를 아예 부르지 않는다** — 답이 없을 걸 알면서 부르는 것은
 *    사용자의 시간과 남의 서버를 함께 낭비하는 일이다.
 *  - 어느 경우든 Nominatim이 **마지막에 반드시 있다**(설정 0에서도 앱이 돈다).
 */
export function providerOrder(
  query: string,
  opts: { available: readonly ProviderId[]; near?: { lat: number; lng: number } | null } = { available: [] },
): ProviderId[] {
  const korean = looksKorean(query, opts.near);
  const order: ProviderId[] = [];
  if (korean) {
    for (const id of opts.available) {
      if (isKoreaOnly(id) && !order.includes(id)) order.push(id);
    }
  }
  if (!order.includes(FALLBACK_PROVIDER)) order.push(FALLBACK_PROVIDER);
  return order;
}

/** 두 좌표 사이 대략 거리(m). 중복 판정에만 쓰므로 평면 근사로 충분하다. */
export function roughDistanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const midLat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dLat = (a.lat - b.lat) * 111_320;
  const dLng = (a.lng - b.lng) * 111_320 * Math.cos(midLat);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

/** 같은 곳으로 볼 거리(m). 건물 하나 크기 — 이보다 가까우면서 이름도 같으면 같은 곳이다. */
const SAME_PLACE_METERS = 60;

interface Dedupable {
  name: string;
  lat: number;
  lng: number;
}

/** 비교용으로 이름을 정규화 — 공백·괄호주석·점을 무시한다(『스타벅스 종로점』 vs 『스타벅스종로점』). */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/[\s.·,]/g, '');
}

/**
 * 여러 제공자의 결과를 **순서를 지키며** 합치고 중복을 접는다.
 *
 * 왜 순서를 지키나: 앞선 제공자가 더 잘 아는 쪽이다(한국 질의라면 국내 제공자). 뒤에서 온
 * 같은 장소가 앞을 덮으면 라우팅이 무의미해진다. 그래서 **먼저 온 것이 이긴다.**
 *
 * 왜 이름만으로 접지 않나: 「대학로」는 서울에도 있고 다른 도시에도 있다. 이름이 같아도
 * **다른 곳이면 둘 다 보여야** 사용자가 고를 수 있다(그게 원래 신고의 절반이었다).
 * 그래서 이름이 같고 **가까울 때만** 같은 곳으로 본다.
 */
export function dedupePlaces<T extends Dedupable>(items: readonly T[]): T[] {
  const out: T[] = [];
  for (const item of items) {
    const key = normalizeName(item.name);
    const dup = out.some((k) => normalizeName(k.name) === key && roughDistanceMeters(k, item) <= SAME_PLACE_METERS);
    if (!dup) out.push(item);
  }
  return out;
}
