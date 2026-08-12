// supabase/functions/geocode — 국내 지오코더의 **유일한 출입구**.
//
// 왜 이 함수가 존재하나 (사용자 결정 2026-07-30: *한국 + 해외 여행지 둘 다*):
//   Nominatim(OSM)은 키가 필요 없어 브라우저가 직접 부른다. 그런데 **한국의 상호명·건물
//   검색은 국내 제공자가 압도적으로 낫고**, 국내 제공자는 전부 **키를 요구한다.**
//   그 키를 단일 페이지 앱 번들에 넣으면 저장소·배포물·개발자도구에서 그대로 읽힌다.
//
//   헌법 §0: *비밀키를 프론트엔드·번들·저장소·로그·리포트에 넣지 않는다.*
//   그래서 키는 **여기(함수 시크릿)에만** 있고, 브라우저는 검색어만 보낸다.
//
// 🔐 불변식
//   1) 제공자 키는 **응답 본문·오류 메시지에 절대 나가지 않는다.** 오류는 코드만 돌려준다
//      (`vworld_failed` 같은 짧은 코드 — 그 해석은 앱이 한다).
//   2) 인증은 플랫폼 `verify_jwt` 설정에 **의존하지 않는다.** 매 요청 `/auth/v1/user`로 직접
//      확인한다 — `media-sign`과 **같은 규율**이다. 안 그러면 이 함수는 누구나 쓰는 공짜
//      지오코딩 프록시가 되고, 남이 우리 쿼터를 태운다.
//   3) **이 함수는 DB를 보지 않는다.** 사용자의 여행·장소를 읽을 이유가 없다. 검색어와
//      좌표 편향만 받고 결과만 돌려준다(최소 권한).
//   4) 🔴 **검색어는 사용자의 사생활이다**(원칙 #3). 로그에 질의를 찍지 않는다 — 어디를
//      찾아봤는지가 곧 어디에 갔는지다.
//
// 정밀도 판정은 **여기서 하지 않는다.** 등급 규칙(`domain/place/precision.ts`)은 앱에 한 벌만
// 있어야 하고(§7 2층), 그래야 Nominatim과 국내 제공자가 같은 자로 재진다. 이 함수가 하는 일은
// 제공자마다 다른 응답을 **하나의 모양으로 옮기는 것**까지다.
//
// 배포: Supabase 대시보드 › Edge Functions › Deploy a new function › Via Editor,
//       함수 이름 `geocode`. 시크릿은 **둘 중 하나만 있어도 된다**:
//         · `KAKAO_REST_KEY`  — 카카오 개발자센터 REST API 키
//         · `VWORLD_KEY`      — 국토교통부 VWorld 인증키
//       하나도 없으면 `capabilities`가 `providers: []`를 돌려주고, 앱은 조용히
//       Nominatim만 쓴다(설정 안 해도 앱은 정상 동작 — 이것이 기본값이다).
//
// 검사 가능성: 순수 변환부(normalize*)를 export하고 `Deno.serve`는 Deno에서만 호출한다
//       → Node/Vitest에서 그대로 import해 응답 변환을 검사한다(tests/unit/geocodeProxy.test.ts).
//       **실제 제공자 응답의 정합은 실 네트워크가 있어야 증명된다** — 이 환경에서 통과했다고
//       "카카오 검색이 정확하다"고 말하지 않는다(정직한 경계).

/** Deno 런타임 전역. Node에서는 undefined → serve를 호출하지 않고 순수 함수만 노출한다. */
const DENO = (globalThis as unknown as {
  Deno?: {
    env: { get(k: string): string | undefined };
    serve(handler: (req: Request) => Promise<Response>): void;
  };
}).Deno;

const envGet = (k: string): string | undefined => DENO?.env.get(k);

/** 함수 판(version) — 앱이 「서버 함수가 낡았다」를 스스로 말할 수 있게(M-0031 규율). */
export const FN_VERSION = 1;

/** 이 함수가 처리하는 op. `check-edge-fn-ops`가 구현과 이 목록의 어긋남을 양방향으로 잡는다. */
export const FN_OPS = ['search', 'capabilities'] as const;

/** 결과 개수 상한 — 남의 서버에 예의를 지키고 화면도 감당 가능하게. */
const LIMIT = 8;

export interface NormalizedRow {
  provider: string;
  name: string;
  displayName: string;
  lat: number;
  lng: number;
  /** Nominatim의 place_rank와 **같은 자**로 옮긴 값. 모르면 null(앱이 unknown으로 판정). */
  placeRank: number | null;
  bbox: [number, number, number, number] | null;
  kind: string | null;
  providerId: string | null;
  address: {
    countryCode: string | null;
    country: string | null;
    region: string | null;
    city: string | null;
    district: string | null;
    postcode: string | null;
  };
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/**
 * 한국 주소 문자열 → 시·도 / 시·군·구.
 *
 * 국내 제공자는 구조화 주소를 조각으로 주지 않고 **한 줄 문자열**로 준다
 * (`"서울 종로구 동숭동 1-1"`). 조각이 필요한 이유는 저장 때문이다 — 주소 표기는 행정구역
 * 개편으로 바뀌지만 **어느 시·구였는지**는 기억의 일부다.
 *
 * 앞 두 토큰만 본다. 더 깊이 파면 동·리·번지까지 잘못 나누기 시작하는데, 그건 이미
 * `displayName`에 원문 그대로 남아 있다(**원문을 버리지 않으므로 추정이 손해가 아니다**).
 */
export function splitKoreanAddress(addr: string | null): { region: string | null; city: string | null } {
  if (!addr) return { region: null, city: null };
  const parts = addr.trim().split(/\s+/);
  return { region: parts[0] ?? null, city: parts[1] ?? null };
}

/**
 * 카카오 주소검색의 `address_type` → Nominatim 랭크 자.
 *
 * 근거(카카오 문서의 뜻을 우리 등급으로 옮긴 것):
 *  · `ROAD_ADDR`/`REGION_ADDR` = 건물번호까지 확정된 주소 → 건물(28+)
 *  · `ROAD` = 도로명만 → 길(26)
 *  · `REGION` = 지역명만 → 동네(22)
 * 모르는 값은 **null로 남긴다** — 정밀한 쪽으로 반올림하지 않는다(§8).
 */
export function kakaoAddressRank(addressType: string | null): number | null {
  switch (addressType) {
    case 'ROAD_ADDR':
    case 'REGION_ADDR':
      return 30;
    case 'ROAD':
      return 26;
    case 'REGION':
      return 22;
    default:
      return null;
  }
}

/**
 * 카카오 **키워드(장소)** 검색 응답 → 표준 행.
 *
 * 키워드 검색의 결과는 정의상 **POI(가게·건물·시설)**이므로 건물 등급으로 옮긴다.
 * 이건 추측이 아니라 그 엔드포인트의 계약이다 — 주소검색은 아래 함수가 따로 다룬다.
 */
export function normalizeKakaoKeyword(json: unknown): NormalizedRow[] {
  const docs = (json as { documents?: unknown })?.documents;
  if (!Array.isArray(docs)) return [];
  const out: NormalizedRow[] = [];
  for (const d of docs) {
    if (!d || typeof d !== 'object') continue;
    const r = d as Record<string, unknown>;
    const lat = num(r['y']); // 🔴 카카오는 x=경도, y=위도다. 뒤집으면 다른 나라가 나온다.
    const lng = num(r['x']);
    const name = str(r['place_name']);
    if (lat === null || lng === null || !name) continue;
    const addr = str(r['road_address_name']) ?? str(r['address_name']);
    const { region, city } = splitKoreanAddress(addr);
    out.push({
      provider: 'kakao',
      name,
      displayName: addr ? `${name}, ${addr}` : name,
      lat,
      lng,
      placeRank: 30,
      bbox: null, // 카카오는 경계상자를 주지 않는다 — 없는 것을 지어내지 않는다
      kind: str(r['category_group_name']) ?? str(r['category_name']),
      providerId: str(r['id']) ? `kakao/${str(r['id'])}` : null,
      address: { countryCode: 'kr', country: '대한민국', region, city, district: city, postcode: null },
    });
  }
  return out.slice(0, LIMIT);
}

/** 카카오 **주소** 검색 응답 → 표준 행. 랭크는 `address_type`이 정한다(위 함수 참조). */
export function normalizeKakaoAddress(json: unknown): NormalizedRow[] {
  const docs = (json as { documents?: unknown })?.documents;
  if (!Array.isArray(docs)) return [];
  const out: NormalizedRow[] = [];
  for (const d of docs) {
    if (!d || typeof d !== 'object') continue;
    const r = d as Record<string, unknown>;
    const lat = num(r['y']);
    const lng = num(r['x']);
    const name = str(r['address_name']);
    if (lat === null || lng === null || !name) continue;
    const { region, city } = splitKoreanAddress(name);
    const road = (r['road_address'] ?? null) as Record<string, unknown> | null;
    out.push({
      provider: 'kakao',
      name,
      displayName: name,
      lat,
      lng,
      placeRank: kakaoAddressRank(str(r['address_type'])),
      bbox: null,
      kind: 'address',
      providerId: null, // 주소 검색 결과에는 안정 id가 없다 — 없는 것을 지어내지 않는다
      address: {
        countryCode: 'kr',
        country: '대한민국',
        region,
        city,
        district: city,
        postcode: road ? str(road['zone_no']) : null,
      },
    });
  }
  return out.slice(0, LIMIT);
}

/**
 * VWorld 검색 응답 → 표준 행.
 *
 * VWorld는 `type=place`(POI)와 `type=address`(주소)를 나눠 부르며, 응답 모양은 같다
 * (`response.result.items[]`). 그래서 랭크는 **무엇을 물었는지**로 정한다.
 */
export function normalizeVworld(json: unknown, asked: 'place' | 'address'): NormalizedRow[] {
  const items = (json as { response?: { result?: { items?: unknown } } })?.response?.result?.items;
  if (!Array.isArray(items)) return [];
  const out: NormalizedRow[] = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const r = it as Record<string, unknown>;
    const point = (r['point'] ?? null) as Record<string, unknown> | null;
    const lat = point ? num(point['y']) : null;
    const lng = point ? num(point['x']) : null;
    const title = str(r['title']);
    if (lat === null || lng === null || !title) continue;
    const address = (r['address'] ?? null) as Record<string, unknown> | null;
    const addrLine = address ? (str(address['road']) ?? str(address['parcel'])) : null;
    const { region, city } = splitKoreanAddress(addrLine);
    out.push({
      provider: 'vworld',
      name: title,
      displayName: addrLine ? `${title}, ${addrLine}` : title,
      lat,
      lng,
      // 주소 검색은 건물번호까지 확정된 지점, 장소 검색은 POI — 둘 다 건물 등급이다.
      placeRank: 30,
      bbox: null,
      kind: asked === 'place' ? (str(r['category']) ?? 'place') : 'address',
      providerId: str(r['id']) ? `vworld/${str(r['id'])}` : null,
      address: {
        countryCode: 'kr',
        country: '대한민국',
        region,
        city,
        district: city,
        postcode: address ? str(address['zipcode']) : null,
      },
    });
  }
  return out.slice(0, LIMIT);
}

/** 설정된 시크릿으로부터 **지금 실제로 쓸 수 있는** 제공자 목록. 없으면 빈 배열. */
export function availableProviders(env: (k: string) => string | undefined): string[] {
  const out: string[] = [];
  if (env('KAKAO_REST_KEY')) out.push('kakao');
  if (env('VWORLD_KEY')) out.push('vworld');
  return out;
}

/**
 * 🔴 이 함수는 **다른 출처**(앱은 `*.github.io`, 함수는 `*.supabase.co`)에서 불린다.
 *    그러면 브라우저가 본 요청 앞에 **사전요청(OPTIONS)**을 먼저 보내는데, 그 요청에는
 *    본문이 없어 아래 `req.json()`이 던지고 **400**이 나갔다. 본 요청은 나가지도 못했다.
 *
 * **실측(2026-08-12 · M-0148)**: 운영 로그의 `geocode` 호출이 전부 `OPTIONS | 400`이었다.
 * 형제인 `media-sign`은 처음부터 이 둘을 갖고 있었다 — **형제 하나만 조용히 빠져 있었다**(§7).
 * 앱은 그 실패를 `catch { return [] }`로 삼켜 「제공자가 없다」로 접었기 때문에,
 * 화면에는 아무 말도 나오지 않았고 검색은 늘 Nominatim으로 내려갔다.
 */
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '600',
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

/**
 * 요청자의 JWT를 **직접** 확인한다(플랫폼 설정에 기대지 않는다 — media-sign과 같은 규율).
 *
 * 🔴 예전에는 `boolean`을 돌려줬다. 이제 **사용자 id**를 돌려준다 — 속도 한도를 걸려면
 *    「누가」가 필요한데, 이 호출이 이미 사용자 본문을 받아오므로 **왕복을 더 늘리지 않는다.**
 *    실패·불명은 `null`이고, 그건 여전히 거부다(모름을 통과로 반올림하지 않는다 · §8).
 */
async function verifyUser(req: Request): Promise<string | null> {
  const auth = req.headers.get('Authorization') ?? '';
  const url = envGet('SUPABASE_URL');
  const anon = envGet('SUPABASE_ANON_KEY');
  if (!auth.startsWith('Bearer ') || !url || !anon) return null;
  try {
    const r = await fetch(`${url}/auth/v1/user`, { headers: { Authorization: auth, apikey: anon } });
    if (!r.ok) return null;
    const u = (await r.json()) as { id?: unknown };
    return typeof u.id === 'string' && u.id.length > 0 ? u.id : null;
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 자원 남용 상한 (T-022)
//
// 🔴 **인증과 초대제는 「누가」를 막지, 「얼마나」를 막지 않는다.** 허용목록 안의 계정
// 하나(또는 탈취된 세션)가 이 함수를 반복 호출하면 우리 지도 API 키의 쿼터와 비용이 그대로
// 나간다. 그리고 카카오 경로는 한 요청이 상류로 **두 번** 나간다(keyword + address).
//
// 🔴 **이 한도가 무엇을 보증하고 무엇을 못 보증하는지 먼저 적는다**(§8 — 모르는 것을 정상으로
// 반올림하지 않는다). 카운터는 **이 인스턴스의 메모리**에 있다. Edge는 인스턴스가 여러 개일
// 수 있고 재시작하면 사라지므로, 이것은 **전역 쿼터가 아니라 인스턴스 단위 최선노력**이다.
// 한 클라이언트가 한 인스턴스를 두드리는 흔한 남용은 막고, 분산된 남용은 못 막는다.
// 전역 보증은 DB 카운터가 필요하고 그건 migration+배포 창이 함께 와야 한다(§18-F).

/** 질의 길이 상한. 실제 주소·상호는 이보다 훨씬 짧다 — 넘는 것은 검색이 아니라 부하다. */
export const MAX_QUERY_LEN = 100;
/**
 * 한 사용자에게 허용하는 창의 길이와 횟수.
 *
 * 🔴 **이 숫자는 「악의를 막는 선」이 아니라 「폭주를 잡는 선」이다**(사용자 결정 2026-08-12 · ADR-0065).
 * 이 함수는 초대제 뒤에 있어서 부르려면 **이미 허용목록 안의 계정**이어야 한다 — 혼자 쓰는
 * 앱에서 그건 사용자 자신이다. 그래서 남는 실제 위험은 악의가 아니라 **앱 버그로 인한
 * 반복 호출**이고, 그건 지도 API 쿼터와 비용을 실제로 태운다.
 *
 * 🔴 **그래서 사람이 원리적으로 닿을 수 없는 자리에 둔다.** 사용자 불편이 0이어야 한다는
 * 것이 이 앱의 우선순위다(사용자 지시: *"사용하는데 불편이 있으면 절대 안 되니까"*).
 *
 * **실측 근거**: Edge를 타는 경로는 **버튼을 눌러야 나가는 장소 검색** 하나뿐이고, 그 버튼은
 * 요청 중 비활성이다. 검색 1회가 제공자 폴백으로 Edge를 최대 2번 부르므로 300회/분은
 * **검색 150회/분** = 0.4초에 한 번을 1분 내내다 — 사람은 도달할 수 없다. 반면 폭주 루프는
 * 초당 수십~수백 회라 즉시 걸린다.
 *
 * **가장 많이 부르는 경로는 애초에 여기 안 온다**: 위치관리대장의 「주소 일괄 채우기」는
 * 1.1초 간격(분당 약 54회)이지만 Nominatim을 **직접** 부르므로 이 함수를 지나지 않는다.
 */
export const RATE_WINDOW_MS = 60_000;
export const RATE_MAX_PER_WINDOW = 300;

export interface RateState {
  windowStart: number;
  count: number;
}

/**
 * 순수 판정 — 이 요청을 받아도 되는가. 상태를 **돌려주고** 저장은 호출부가 한다.
 * 순수하니 유닛이 시계를 직접 먹여 경계를 잰다(§10 ③ — 재려면 순수해야 한다).
 */
export function allowRequest(
  prev: RateState | undefined,
  now: number,
  max = RATE_MAX_PER_WINDOW,
  windowMs = RATE_WINDOW_MS,
): { ok: boolean; next: RateState; retryAfterSec: number } {
  if (!prev || now - prev.windowStart >= windowMs) {
    return { ok: true, next: { windowStart: now, count: 1 }, retryAfterSec: 0 };
  }
  if (prev.count >= max) {
    const retryAfterSec = Math.max(1, Math.ceil((prev.windowStart + windowMs - now) / 1000));
    return { ok: false, next: prev, retryAfterSec };
  }
  return { ok: true, next: { windowStart: prev.windowStart, count: prev.count + 1 }, retryAfterSec: 0 };
}

/** 이 인스턴스의 카운터. 위 주석대로 **전역 보증이 아니다.** */
const rateState = new Map<string, RateState>();

/**
 * 🔐 초대제 확인 — media-sign과 **같은 규율**. 인증만으로는 부족하다.
 * journey 테이블은 RLS로 초대제(`journey.is_allowed()`)를 걸지만, 지오코딩은 DB를 거치지
 * 않으므로 그 방어가 빠진다 — 허용목록 밖 계정도 우리 지도 API 키로 검색을 돌릴 수 있었다.
 * 허용목록 SSOT(`journey.allowed_users`)에 **RPC로 되묻고**, 못 읽거나 애매하면 거부한다(§7).
 */
async function isInvited(req: Request): Promise<boolean> {
  const auth = req.headers.get('Authorization') ?? '';
  const url = envGet('SUPABASE_URL');
  const anon = envGet('SUPABASE_ANON_KEY');
  if (!auth.startsWith('Bearer ') || !url || !anon) return false;
  try {
    const r = await fetch(`${url}/rest/v1/rpc/is_allowed`, {
      method: 'POST',
      headers: {
        Authorization: auth,
        apikey: anon,
        'Content-Type': 'application/json',
        'Content-Profile': 'journey', // RPC는 POST — 스키마 선택은 Content-Profile
      },
      body: '{}',
    });
    if (!r.ok) return false;
    return (await r.json()) === true;
  } catch {
    return false;
  }
}

async function searchKakao(key: string, q: string): Promise<NormalizedRow[]> {
  const headers = { Authorization: `KakaoAK ${key}` };
  const base = 'https://dapi.kakao.com/v2/local/search';
  // 장소와 주소를 **둘 다** 묻는다 — 사용자는 「스타벅스」와 「세종대로 110」을 같은 칸에 친다.
  const [kw, addr] = await Promise.all([
    fetch(`${base}/keyword.json?size=${LIMIT}&query=${encodeURIComponent(q)}`, { headers })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
    fetch(`${base}/address.json?size=${LIMIT}&query=${encodeURIComponent(q)}`, { headers })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  ]);
  return [...normalizeKakaoKeyword(kw), ...normalizeKakaoAddress(addr)];
}

async function searchVworld(key: string, q: string): Promise<NormalizedRow[]> {
  const call = async (type: 'place' | 'address'): Promise<NormalizedRow[]> => {
    const p = new URLSearchParams({
      service: 'search',
      request: 'search',
      version: '2.0',
      size: String(LIMIT),
      query: q,
      type,
      key,
    });
    if (type === 'address') p.set('category', 'road');
    const r = await fetch(`https://api.vworld.kr/req/search?${p.toString()}`).catch(() => null);
    if (!r || !r.ok) return [];
    return normalizeVworld(await r.json().catch(() => null), type);
  };
  const [place, address] = await Promise.all([call('place'), call('address')]);
  return [...place, ...address];
}

DENO?.serve(async (req: Request): Promise<Response> => {
  // 🔴 사전요청을 **본문을 읽기 전에** 답한다. 아래 `req.json()`은 본문 없는 요청에서 던진다.
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  const op = str(body['op']);

  // capabilities는 **인증 뒤**에 답한다. 어떤 제공자를 붙였는지는 우리 구성 정보다.
  const userId = await verifyUser(req);
  if (!userId) return json({ error: 'unauthorized' }, 401);
  // 🔐 초대제 — 인증 다음 줄. RLS가 테이블에 거는 journey.is_allowed()를 이 경로에도 건다(§7).
  if (!(await isInvited(req))) return json({ error: 'forbidden' }, 403);

  if (op === 'capabilities') {
    return json({ version: FN_VERSION, ops: FN_OPS, providers: availableProviders(envGet) });
  }

  if (op === 'search') {
    const q = str(body['q']);
    if (!q) return json({ error: 'bad_query' }, 400);
    // 🔴 길이부터 본다 — 상류로 나가기 전에 거절해야 상류 쿼터가 안 나간다.
    if (q.length > MAX_QUERY_LEN) return json({ error: 'query_too_long', max: MAX_QUERY_LEN }, 400);
    // 🔴 속도 한도는 **상류 호출 직전**에 건다. 인증·초대제는 「누가」를 막지 「얼마나」를 막지 않는다.
    const decision = allowRequest(rateState.get(userId), Date.now());
    rateState.set(userId, decision.next);
    if (!decision.ok) {
      return new Response(
        JSON.stringify({ error: 'rate_limited', retryAfterSec: decision.retryAfterSec }),
        {
          status: 429,
          headers: {
            ...CORS,
            'Content-Type': 'application/json',
            'Retry-After': String(decision.retryAfterSec),
          },
        },
      );
    }
    const want = str(body['provider']);
    const kakaoKey = envGet('KAKAO_REST_KEY');
    const vworldKey = envGet('VWORLD_KEY');
    try {
      if (want === 'kakao' || (!want && kakaoKey)) {
        if (!kakaoKey) return json({ error: 'provider_unavailable' }, 503);
        return json({ provider: 'kakao', rows: await searchKakao(kakaoKey, q) });
      }
      if (want === 'vworld' || (!want && vworldKey)) {
        if (!vworldKey) return json({ error: 'provider_unavailable' }, 503);
        return json({ provider: 'vworld', rows: await searchVworld(vworldKey, q) });
      }
      return json({ error: 'provider_unavailable' }, 503);
    } catch {
      // 🔴 예외 본문을 그대로 돌려주지 않는다 — 제공자 오류에 키가 섞여 나올 수 있다.
      return json({ error: 'provider_failed' }, 502);
    }
  }

  return json({ error: 'bad_op' }, 400);
});
