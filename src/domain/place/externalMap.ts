// domain/place/externalMap.ts — **바깥 지도(구글)로 나가는 링크와 그 정직한 라벨.** 순수 함수.
//
// ── 왜 구글인가, 그리고 왜 무료인가 ──────────────────────────────────
// 돈이 드는 것은 Maps **JavaScript API**·Static Maps·Places API다(키·과금 필요).
// 여기서 쓰는 것은 **Maps URLs** — 그냥 링크라 키도 계정도 과금도 없다.
// 그래서 이 앱의 구도가 성립한다: **입력은 무료 OSM(Nominatim), 출력은 구글 지도.**
// 앱 안 지도(MapLibre+OSM 타일)가 주(主)이고, 구글은 길찾기·스트리트뷰가 필요할 때 가는 곳이다.
//
// ── 왜 순수 함수인가 (§10 ③) ─────────────────────────────────────────
// 여기서 만드는 것은 URL만이 아니라 **사용자에게 갈 문장**이다 — 특히 좌표가 없어
// *이름으로 찾은* 경우, 그 사실을 말하지 않으면 앱이 **엉뚱한 곳을 그 장소라고 우기는** 셈이 된다.
// M-0022가 정확히 그 자리에서 났다: 숫자는 다 맞았고 화면에 나가는 문장만 틀렸으며,
// 유닛 15건이 전부 통과했다. 그래서 문장을 자료구조에서 떼어내 검사 가능하게 둔다.
//
// ── 개인정보 (PRIVACY.md「개인자료 기본 비공개」) ─────────────────────
// 이 링크를 여는 순간 **좌표(또는 장소 이름)가 구글로 나간다.** 이 앱이 지금까지 하지 않던
// 일이므로 조용히 하지 않는다: ①사용자가 직접 누를 때만 ②처음 한 번 무엇이 나가는지 확인
// ③`rel="noreferrer"`로 앱 주소가 함께 새지 않게. ①②③은 호출부(services/ui)가 맡고,
// 여기서는 **무엇이 나가는지를 문장으로** 만들어 준다.

/** 구글 Maps URLs의 검색 진입점. `api=1`이 없으면 나머지 매개변수가 전부 무시된다. */
const MAPS_URL = 'https://www.google.com/maps/search/?api=1&query=';

export interface PlaceLike {
  name: string;
  lat: number | null;
  lng: number | null;
}

export interface ExternalMapTarget {
  url: string;
  /**
   * **좌표로 정확히 집었는가, 이름으로 찾은 것인가.**
   * 이 둘을 같은 문장으로 말하면 안 된다 — 이름 검색은 동명이 있으면 다른 곳을 연다.
   */
  precision: 'coords' | 'name';
  /** 버튼 라벨. */
  label: string;
  /** 이름으로 찾은 경우에만 있는 한 줄 — 없으면 null(모르는 것을 지어내지 않는다). */
  caveat: string | null;
  /** 「무엇이 구글로 나가는가」 — 동의 문구가 이 값을 그대로 쓴다(따로 적지 않는다). */
  sends: string;
}

/** 좌표가 지구 위의 값인가. 범위를 벗어난 값은 **없는 것으로 친다**(엉뚱한 곳을 열지 않는다). */
export function isUsableCoord(lat: number | null, lng: number | null): boolean {
  return (
    typeof lat === 'number' && typeof lng === 'number' &&
    Number.isFinite(lat) && Number.isFinite(lng) &&
    Math.abs(lat) <= 90 && Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0) // 0,0(Null Island)은 사실상 "좌표 없음"의 흔한 형태다
  );
}

/** 좌표 표기 — 소수 6자리면 약 10cm다. 그 이상은 정밀도를 **가장**하는 것이다. */
function coordText(lat: number, lng: number): string {
  const t = (n: number): string => String(Number(n.toFixed(6)));
  return `${t(lat)},${t(lng)}`;
}

/**
 * 이 장소를 구글 지도에서 열 링크. 좌표도 이름도 없으면 **null**(열 곳이 없다고 정직하게).
 *
 * 좌표가 있으면 좌표로 집는다(정확). 없으면 이름으로 검색하되 **그 사실을 caveat에 담는다** —
 * 사용자 결정(2026-07-27): *"이름으로 검색해 연다. 단 이름으로 찾은 결과라고 화면에 밝힌다."*
 */
export function externalMapTarget(place: PlaceLike): ExternalMapTarget | null {
  const name = place.name.trim();
  if (isUsableCoord(place.lat, place.lng)) {
    const q = coordText(place.lat as number, place.lng as number);
    return {
      url: MAPS_URL + encodeURIComponent(q),
      precision: 'coords',
      label: '구글지도로 열기',
      caveat: null,
      sends: `이 장소의 좌표(${q})`,
    };
  }
  if (name) {
    return {
      url: MAPS_URL + encodeURIComponent(name),
      precision: 'name',
      label: '구글지도에서 이름으로 찾기',
      caveat: '저장된 좌표가 없어 **장소 이름으로 검색**해요. 같은 이름이 여러 곳이면 다른 곳이 열릴 수 있어요.',
      sends: `장소 이름("${name}")`,
    };
  }
  return null;
}

/**
 * 처음 한 번 보여줄 확인 문구. **무엇이 어디로 나가는지**를 `sends`에서 파생한다 —
 * 문구를 손으로 다시 적으면 링크가 바뀔 때 문장만 옛말로 남는다(SSOT).
 */
export function externalMapConsentText(t: ExternalMapTarget): string {
  return [
    '구글 지도로 이동할까요?',
    '',
    `${t.sends}가 구글에 전달됩니다. 이 앱은 평소 위치를 밖으로 보내지 않아요.`,
    '',
    '이 안내는 처음 한 번만 보여드립니다.',
  ].join('\n');
}
