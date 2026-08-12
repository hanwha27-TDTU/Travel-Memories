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
import { dedupePlaces, providerOrder, type ProviderId } from '../domain/place/provider';

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
  /** 이 답이 **어디서 왔는가**. 출처를 숨기지 않는다(§8) — 화면이 밝힐 수 있어야 한다. */
  provider: ProviderId;
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
    provider: 'nominatim',
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

const NOMINATIM_REVERSE = 'https://nominatim.openstreetmap.org/reverse';

/**
 * 좌표 → 그 자리의 주소(역지오코딩) URL(순수).
 *
 * `zoom=18`은 **건물 단위**다. 더 낮추면 동네 이름이 나오고, 더 올리면 없는 정밀도를
 * 요구하게 된다. 지도에서 콕 찍은 지점에 이름을 붙이는 것이 목적이므로 건물이 맞다.
 */
export function buildNominatimReverseUrl(lat: number, lng: number): string {
  const params = new URLSearchParams({
    format: 'jsonv2',
    'accept-language': 'ko',
    addressdetails: '1',
    zoom: '18',
    lat: String(lat),
    lon: String(lng),
  });
  return `${NOMINATIM_REVERSE}?${params.toString()}`;
}

/**
 * 역지오코딩 응답 → PlaceResult(순수). 배열이 아니라 **객체 하나**로 온다.
 *
 * 바다 한가운데처럼 아무것도 없는 곳은 `{ error: … }`를 준다 — 그때는 **null**이다.
 * 이름을 지어내지 않는다(§8). 호출부는 그냥 좌표만 쓰고 이름은 사용자가 적는다.
 */
export function parseReverseResult(json: unknown): PlaceResult | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  if ('error' in (json as Record<string, unknown>)) return null;
  return parseNominatimResults([json])[0] ?? null;
}

/**
 * 좌표 → 그 자리의 이름·주소. 실패·결과없음은 **null**(throw하지 않는다).
 *
 * 🔴 왜 throw하지 않나: 이건 **거들어 주는 기능**이다. 사용자는 이미 지도에서 지점을
 * 확정했고 좌표는 손에 있다. 이름을 못 붙였다고 그 저장을 막으면, 편의 기능이 기억을
 * 막는 셈이 된다(§0의 정신 — 앱이 사용자를 이기지 않는다).
 *
 * 저트래픽 예의(map-place-dev §1 6항): **확정 시 1회만** 부른다. 마커를 끌 때마다
 * 부르지 않는다 — 공용 서버이고, 사용자는 한 지점을 찍기까지 수십 번 끈다.
 */
export async function reverseGeocode(lat: number, lng: number): Promise<PlaceResult | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  try {
    const res = await fetch(buildNominatimReverseUrl(lat, lng), { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return parseReverseResult(await res.json());
  } catch {
    return null; // 오프라인·차단 — 좌표는 이미 있으므로 이름만 못 붙인다
  }
}

/** 장소 검색(Nominatim 단독) — 실패 시 throw(호출부에서 안내). */
export async function searchNominatim(query: string, opts: GeocodeOptions = {}): Promise<PlaceResult[]> {
  const q = query.trim();
  if (!q) return [];
  const res = await fetch(buildNominatimUrl(q, opts), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`장소 검색 실패 (HTTP ${res.status})`);
  return parseNominatimResults(await res.json()).map((p) => ({ ...p, provider: 'nominatim' as ProviderId }));
}

// ─────────────────────────────────────────────────────────────────────────────
// B단계 — 제공자 라우팅 (사용자 결정 2026-07-30: 한국 + 해외 여행지 둘 다)
// ─────────────────────────────────────────────────────────────────────────────
// Nominatim은 키가 없어 브라우저가 직접 부른다. 국내 제공자는 키가 필요하므로 **Edge Function
// 뒤**에 있다(§0 — 키를 번들에 넣지 않는다). 여기서는 "누구에게 먼저 묻고, 못 받으면 누구로
// 내려가는가"만 조립한다. 순서 규칙 자체는 `domain/place/provider.ts`(순수)가 갖는다.

const PROXY_FN = 'geocode';

/** Edge Function이 돌려주는 표준 행 — supabase/functions/geocode의 NormalizedRow와 같은 모양. */
interface ProxyRow {
  provider?: unknown;
  name?: unknown;
  displayName?: unknown;
  lat?: unknown;
  lng?: unknown;
  placeRank?: unknown;
  bbox?: unknown;
  kind?: unknown;
  providerId?: unknown;
  address?: unknown;
}

/**
 * 프록시 행 → PlaceResult(순수).
 *
 * 🔴 **정밀도는 여기서 다시 판정한다** — 서버가 보낸 등급을 그대로 믿지 않는다. 등급 규칙은
 * 앱에 한 벌만 있어야 하고(§7 2층), 그래야 Nominatim과 국내 제공자가 **같은 자**로 재진다.
 * 서버가 옛 판이어도 앱의 자가 바뀌면 화면은 같이 바뀐다.
 */
export function parseProxyRows(json: unknown, fallbackProvider: ProviderId): PlaceResult[] {
  const rows = (json as { rows?: unknown })?.rows;
  if (!Array.isArray(rows)) return [];
  const out: PlaceResult[] = [];
  for (const r of rows as ProxyRow[]) {
    if (!r || typeof r !== 'object') continue;
    const lat = num(r.lat);
    const lng = num(r.lng);
    const name = str(r.name);
    if (lat === null || lng === null || !name) continue;
    const bbox = parseBBox(r.bbox);
    out.push({
      name,
      displayName: str(r.displayName) ?? name,
      lat,
      lng,
      precision: classifyPlace({ placeRank: num(r.placeRank), bbox }),
      bbox,
      kind: str(r.kind),
      providerId: str(r.providerId),
      address: parseAddress(r.address),
      provider: (str(r.provider) as ProviderId | null) ?? fallbackProvider,
    });
  }
  return out;
}

/**
 * 사용 가능 제공자를 **세션에 한 번만** 묻는다.
 *
 * 매 검색마다 `capabilities`를 되물으면 검색 한 번에 왕복이 둘이 된다. 이 값은 서버 시크릿
 * 구성이라 세션 중에 바뀌지 않는다 — 바뀌었다면 새로고침이 정상적인 반영 경로다.
 */
let cachedProbe: ProviderProbe | null = null;
export async function ensureProviders(client: ProxyClient | null): Promise<ProviderProbe> {
  if (cachedProbe) return cachedProbe;
  cachedProbe = await proxyProviders(client);
  return cachedProbe;
}

/** 검사용 — 캐시를 비운다. 제품 코드에서 부르지 않는다. */
export function resetProviderCache(): void {
  cachedProbe = null;
}

/**
 * 🔴 **「물어봤더니 없다」와 「못 물어봤다」는 다른 사실이다**(§8 · T-025 · M-0148).
 *
 * 예전에는 둘 다 `[]`였다. 그래서 `geocode`가 **CORS 때문에 브라우저에서 아예 안 불리는**
 * 상태가 오래 조용했다 — 앱은 「국내 제공자가 없나 보다」로 접고 Nominatim으로 내려갔고,
 * 화면에는 아무 말도 나오지 않았다. 로그를 읽고서야 알았다.
 *
 * 두 상태를 **타입으로** 가른다. 세 번째 상태를 만들려면 `asked`를 붙일 수밖에 없으므로
 * 다음 사람이 또 `[]`로 접을 수 없다(§7 2층 — 구조가 규율을 지킨다).
 */
export type ProbeFailure =
  /** 클라우드 자체가 설정되지 않았다(로그아웃·미설정). 물어볼 서버가 없다 — 결함이 아니다. */
  | 'no-client'
  /** 물어봤는데 오류가 왔다. 배포·네트워크·CORS 어느 쪽인지는 여기서 모른다. */
  | 'error'
  /** 답은 왔는데 모양이 계약과 다르다. 서버가 낡았거나 우리 계약이 틀렸다. */
  | 'bad-shape';

export type ProviderProbe =
  /** 물어봤고 답을 받았다. **빈 배열도 답이다** — 「키가 안 붙었다」는 정상 상태다. */
  | { asked: true; providers: ProviderId[] }
  /** 못 물어봤다. 이 상태를 「없다」로 반올림하지 않는다. */
  | { asked: false; why: ProbeFailure };

/** 검색 경로가 쓰는 목록. 못 물어본 상태는 빈 목록으로 취급한다 — **검색은 조용히 계속된다.** */
export function providersOf(probe: ProviderProbe): readonly ProviderId[] {
  return probe.asked ? probe.providers : [];
}

/**
 * 프록시에 붙어 있는 국내 제공자 목록.
 *
 * 🔴 실패해도 **검색 화면은 조용하다** — Nominatim이 답하므로 사용자에게 알릴 일이 아니다.
 *    그러나 **진단은 조용하면 안 된다.** 그래서 사유를 잃지 않고 돌려준다(§8).
 */
export async function proxyProviders(client: ProxyClient | null): Promise<ProviderProbe> {
  if (!client) return { asked: false, why: 'no-client' };
  try {
    const r = await client.functions.invoke(PROXY_FN, { body: { op: 'capabilities' } });
    if (r.error) return { asked: false, why: 'error' };
    const list = (r.data as { providers?: unknown })?.providers;
    if (!Array.isArray(list)) return { asked: false, why: 'bad-shape' };
    return { asked: true, providers: list.filter((p): p is ProviderId => p === 'kakao' || p === 'vworld') };
  } catch {
    return { asked: false, why: 'error' };
  }
}

/** 프록시 호출에 필요한 최소 모양만 요구한다(전체 Supabase 타입에 묶이지 않게). */
export interface ProxyClient {
  functions: {
    invoke(
      name: string,
      args: { body: Record<string, unknown> },
    ): Promise<{ data: unknown; error: { message: string } | null }>;
  };
}

async function searchViaProxy(
  client: ProxyClient,
  provider: ProviderId,
  query: string,
): Promise<PlaceResult[]> {
  const r = await client.functions.invoke(PROXY_FN, { body: { op: 'search', q: query, provider } });
  if (r.error) throw new Error(r.error.message);
  return parseProxyRows(r.data, provider);
}

export interface RoutedOptions extends GeocodeOptions {
  /** 로그인된 Supabase 클라이언트. 없으면 국내 제공자는 건너뛴다(로그인 없이도 검색은 된다). */
  client?: ProxyClient | null;
  /** 이미 알아낸 사용 가능 제공자(매 검색마다 capabilities를 되묻지 않게). */
  available?: readonly ProviderId[];
}

/**
 * 장소 검색 — **순서대로 묻고, 답이 있으면 멈춘다.**
 *
 * 정직한 설계 선택 두 가지:
 *  1. **Nominatim은 언제나 마지막에 있다.** 국내 제공자가 없거나·실패하거나·빈 결과를 줘도
 *     앱은 답을 낸다. 설정 0에서 동작하는 것이 기본값이고, 국내 제공자는 개선이지 전제가 아니다.
 *  2. **앞선 제공자가 답을 주면 거기서 멈춘다.** 전부 부른 뒤 합치면 더 많아 보이지만,
 *     결과 목록이 길어질수록 사용자가 옳은 것을 고르기는 **어려워진다** — 원래 신고가
 *     "어느 대학로인지 모르겠다"였다는 걸 잊으면 안 된다.
 *
 * 실패는 삼키지 않는다: 전부 실패하면 마지막 오류를 던져 호출부가 사유를 보여준다.
 */
export async function searchPlaces(query: string, opts: RoutedOptions = {}): Promise<PlaceResult[]> {
  const q = query.trim();
  if (!q) return [];
  const order = providerOrder(q, { available: opts.available ?? [], near: opts.near ?? null });
  let lastError: unknown = null;
  for (const provider of order) {
    try {
      const found =
        provider === 'nominatim' || !opts.client
          ? await searchNominatim(q, opts)
          : await searchViaProxy(opts.client, provider, q);
      if (found.length) return dedupePlaces(found);
    } catch (e) {
      lastError = e; // 다음 제공자로 내려간다 — 하나가 죽었다고 검색이 죽지 않는다
    }
  }
  if (lastError) throw lastError instanceof Error ? lastError : new Error(String(lastError));
  return [];
}
