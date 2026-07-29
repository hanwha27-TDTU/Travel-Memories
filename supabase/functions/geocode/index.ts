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

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** 요청자의 JWT를 **직접** 확인한다(플랫폼 설정에 기대지 않는다 — media-sign과 같은 규율). */
async function verifyUser(req: Request): Promise<boolean> {
  const auth = req.headers.get('Authorization') ?? '';
  const url = envGet('SUPABASE_URL');
  const anon = envGet('SUPABASE_ANON_KEY');
  if (!auth.startsWith('Bearer ') || !url || !anon) return false;
  try {
    const r = await fetch(`${url}/auth/v1/user`, { headers: { Authorization: auth, apikey: anon } });
    return r.ok;
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
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  const op = str(body['op']);

  // capabilities는 **인증 뒤**에 답한다. 어떤 제공자를 붙였는지는 우리 구성 정보다.
  if (!(await verifyUser(req))) return json({ error: 'unauthorized' }, 401);

  if (op === 'capabilities') {
    return json({ version: FN_VERSION, ops: FN_OPS, providers: availableProviders(envGet) });
  }

  if (op === 'search') {
    const q = str(body['q']);
    if (!q) return json({ error: 'bad_query' }, 400);
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
