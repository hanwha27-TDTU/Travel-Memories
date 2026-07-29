// services/geocode.ts — 장소 검색(지오코딩). 무료·키 불필요 Nominatim(OpenStreetMap).
// 정책 준수: 검색은 버튼/제출 시에만(키입력마다 금지), limit 소량, 귀속표시. 개인·저트래픽용.
// URL 빌더·응답 파서는 순수 함수로 분리해 테스트로 잠근다(네트워크 fetch만 미검증).
//
// 2026-07-30 — 「기본맵이 부정확하다」 신고 이후 바뀐 것(A단계):
//   ① 응답에서 **정밀도 근거를 버리지 않는다**. 예전 파서는 lat/lng/name만 남기고
//      `place_rank`·`boundingbox`·`category`·`osm_id`를 전부 버렸다. 그래서 앱은 도(道)
//      중심점과 건물 출입구를 **같은 문장으로** 말했다(§8 위반 — `domain/place/precision.ts`).
//   ② 구조화 주소(`addressdetails=1`)를 받는다. 「대학로」처럼 전국에 여러 개인 이름을
//      사용자가 시·구로 구분해 고를 수 있어야 하고, 저장할 때도 문자열 한 줄이 아니라
//      행정구역 조각으로 남아야 한다(주소 표기는 바뀌지만 좌표와 provider id는 안 바뀐다).
//   ③ **지역 편향**(viewbox·`bounded=0`)을 선택 인자로 받는다. 여행 중이면 지금 있는 곳
//      근처가 먼저 나오는 것이 맞다. 경계 밖 결과를 **버리지는 않는다** — 해외 검색을
//      막으면 안 되기 때문이다(사용자는 한국·해외를 둘 다 쓴다).

import { classifyPlace, type BBox, type PrecisionVerdict } from '../domain/place/precision';

/** 구조화 주소 조각. 없는 것은 null — 빈 문자열로 채우지 않는다(§8 「모르는 것」). */
export interface AddressParts {
  countryCode: string | null; // 'kr' — 소문자 ISO 3166-1 alpha-2
  country: string | null;
  region: string | null; // 시·도 / state·province
  city: string | null;
  district: string | null; // 구·군 / borough·suburb
  postcode: string | null;
}

export interface PlaceResult {
  name: string; // 짧은 표시명
  displayName: string; // 전체 주소
  lat: number;
  lng: number;
  /** 이 결과가 무엇을 가리키는지(건물인가 길인가 도(道)인가)의 판정. */
  precision: PrecisionVerdict;
  /** 대상이 걸친 범위 상자. 지도 맞춤(fitBounds)에 쓴다. 없으면 null. */
  bbox: BBox | null;
  /** 'highway:residential' 형태의 제공자 분류. 표시·중복통합 힌트. */
  kind: string | null;
  /**
   * 제공자 안정 식별자 — Nominatim은 `way/12345`(osm_type/osm_id).
   *
   * `place_id`를 쓰지 않는 이유: 그것은 **그 Nominatim 인스턴스의 내부 행 번호**라
   * 재색인하면 바뀐다. osm_type/osm_id는 OSM 원본의 id라 안정적이다.
   */
  providerId: string | null;
  address: AddressParts;
}

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

export interface GeocodeOptions {
  /** 결과 개수(기본 8). 후보가 적으면 사용자가 옳은 것을 고를 기회 자체가 없다. */
  limit?: number;
  /** 지역 편향의 중심. 경계 밖 결과를 버리지 않는다(bounded=0) — 해외 검색을 막지 않기 위해. */
  near?: { lat: number; lng: number } | null;
}

/** 편향 상자의 반변(도). 약 55km — "지금 있는 도시" 정도를 우선한다. */
const BIAS_HALF_DEGREE = 0.5;

/** 검색 질의 → Nominatim URL(순수). 한국어 우선, 소량 결과, 정밀도 근거 포함. */
export function buildNominatimUrl(query: string, opts: GeocodeOptions = {}): string {
  const params = new URLSearchParams({
    format: 'jsonv2',
    limit: String(opts.limit ?? 8),
    'accept-language': 'ko',
    addressdetails: '1',
    q: query.trim(),
  });
  const near = opts.near;
  if (near && Number.isFinite(near.lat) && Number.isFinite(near.lng)) {
    const { lat, lng } = near;
    // viewbox 순서는 서,북,동,남(왼쪽,위,오른쪽,아래).
    params.set(
      'viewbox',
      [lng - BIAS_HALF_DEGREE, lat + BIAS_HALF_DEGREE, lng + BIAS_HALF_DEGREE, lat - BIAS_HALF_DEGREE].join(','),
    );
    params.set('bounded', '0'); // 편향일 뿐 필터가 아니다 — 해외 결과를 지우지 않는다
  }
  return `${NOMINATIM}?${params.toString()}`;
}

/** 문자열/숫자 아무거나 → 유한 숫자 또는 null. 외부 데이터는 형태를 믿지 않는다. */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || !v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

/** Nominatim `boundingbox`(["남","북","서","동"] 문자열 4개) → BBox. 하나라도 깨지면 null. */
export function parseBBox(v: unknown): BBox | null {
  if (!Array.isArray(v) || v.length !== 4) return null;
  const nums = v.map(num);
  if (nums.some((n) => n === null)) return null;
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!] as BBox;
}

/**
 * Nominatim `address` 객체 → 구조화 주소(순수).
 *
 * 한국 주소가 어느 키로 오는지가 일정하지 않다 — 서울은 `city`, 광역시 밖은 `county`,
 * 구는 `borough`/`city_district`/`suburb` 중 하나로 온다. 그래서 **후보 목록의 첫 값**을
 * 쓴다. 못 찾으면 null이다(억지로 다른 층을 끌어다 채우면 틀린 주소를 지어내게 된다).
 */
export function parseAddress(v: unknown): AddressParts {
  const a = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const first = (...keys: string[]): string | null => {
    for (const k of keys) {
      const s = str(a[k]);
      if (s) return s;
    }
    return null;
  };
  const cc = str(a['country_code']);
  return {
    countryCode: cc ? cc.toLowerCase() : null,
    country: first('country'),
    region: first('state', 'province', 'region'),
    city: first('city', 'town', 'county', 'municipality', 'village'),
    district: first('borough', 'city_district', 'district', 'suburb'),
    postcode: first('postcode'),
  };
}

/** 'kr' + 시·도 + 구 → "서울특별시 종로구" 같은 짧은 행정 라벨. 없으면 null. */
export function adminLabel(a: AddressParts): string | null {
  const parts = [a.region, a.city, a.district].filter((p): p is string => !!p);
  // 서울은 region='서울특별시', city='서울'처럼 겹쳐 오는 경우가 있다 — 중복은 접는다.
  const seen: string[] = [];
  for (const p of parts) {
    if (!seen.some((s) => s.includes(p) || p.includes(s))) seen.push(p);
  }
  return seen.length ? seen.join(' ') : a.country;
}

/** Nominatim 한 행 → PlaceResult. 좌표가 깨졌으면 null(버린다). */
function parseRow(row: Record<string, unknown>): PlaceResult | null {
  const lat = num(row['lat']);
  const lng = num(row['lon']);
  if (lat === null || lng === null) return null;

  const displayName = str(row['display_name']) ?? '';
  const rawName = str(row['name']);
  const name = rawName || displayName.split(',')[0]?.trim() || '이름 없음';

  const bbox = parseBBox(row['boundingbox']);
  const category = str(row['category']) ?? str(row['class']);
  const type = str(row['type']);
  const osmType = str(row['osm_type']);
  const osmId = num(row['osm_id']);

  return {
    name,
    displayName: displayName || name,
    lat,
    lng,
    precision: classifyPlace({ placeRank: num(row['place_rank']), bbox }),
    bbox,
    kind: category && type ? `${category}:${type}` : (category ?? type),
    providerId: osmType && osmId !== null ? `${osmType}/${osmId}` : null,
    address: parseAddress(row['address']),
  };
}

/** Nominatim JSON 응답 → PlaceResult[](순수). 좌표 유효한 것만. */
export function parseNominatimResults(json: unknown): PlaceResult[] {
  if (!Array.isArray(json)) return [];
  const out: PlaceResult[] = [];
  for (const r of json) {
    if (!r || typeof r !== 'object') continue;
    const parsed = parseRow(r as Record<string, unknown>);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** 장소 검색 — Nominatim 호출 후 파싱. 실패 시 throw(호출부에서 안내). */
export async function searchPlaces(query: string, opts: GeocodeOptions = {}): Promise<PlaceResult[]> {
  const q = query.trim();
  if (!q) return [];
  const res = await fetch(buildNominatimUrl(q, opts), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`장소 검색 실패 (HTTP ${res.status})`);
  return parseNominatimResults(await res.json());
}
