// domain/place/rowmap.ts — 장소 라이브러리의 직렬화 경계 (마이그레이션 0022).
//
// ── 형제와 다른 점 두 가지 (둘 다 설계 단계에서 심사한 비대칭 · §7) ─────────
// ① **부모가 없다.** 형제 넷(media·expenses·audio)은 `moment_id`/`trip_id`를 갖는데 장소는
//    없다. 한 장소는 여러 여행에 걸치고, 작년 여행을 지웠다고 그 카페를 잊을 이유가 없다.
// ② **`location`을 쓰지 않는다.** 서버의 지리 컬럼은 longitude/latitude에서 유도되는
//    **생성 컬럼**이라 앱이 쓸 수 없다(0022 설계 결정 2 — 경도·위도 순서를 틀릴 방법 자체를
//    없앤다). 그래서 `PlaceRow`에 그 필드가 없고, `check-schema-parity`도 조용하다.
//
// 나머지 규율은 같다: snake_case는 이 파일 밖 금지 · 시각은 `isoInstant()`를 반드시 통과
// (M-0034) · 반환형은 `WithInstants<T>`라 누락이 컴파일 오류가 된다.

import { isoInstant, isoInstantOrNull, type WithInstants } from '../time';
import type { LocalPlace } from '../../offline/db';

/** Supabase journey.places 행 (snake_case — 이 파일 밖에서 사용 금지). */
export interface PlaceRow {
  id: string;
  user_id: string;
  name: string;
  formatted_address: string | null;
  provider: string | null;
  provider_place_id: string | null;
  country_code: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  district: string | null;
  postcode: string | null;
  category: string | null;
  memo: string | null;
  longitude: number;
  latitude: number;
  precision: string | null;
  span_meters: number | null;
  map_picked: boolean;
  source: string;
  version: number;
  base_version?: number | null;
  base_canonical_version?: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  client_operation_id: string | null;
  /** 마지막으로 이 행을 올린 기기(`라벨#짧은id`) — 진단의 "기기별 현황"이 읽는다. */
  updated_by_device?: string | null;
}

/**
 * `provider/providerPlaceId` → Dexie 인덱스 한 칸.
 *
 * 둘 중 하나라도 없으면 **undefined**다. Dexie는 undefined인 속성을 인덱스에 넣지 않으므로,
 * 지도에서 직접 찍은 장소들은 이 인덱스에서 통째로 빠진다 — **그게 맞다.** 제공자 id가 없는
 * 두 장소가 이름이 같다고 같은 곳이라 단정할 수 없기 때문이다(「대학로」는 여러 도시에 있다).
 */
export function providerKeyOf(provider: string | null, providerPlaceId: string | null): string | undefined {
  return provider && providerPlaceId ? `${provider}/${providerPlaceId}` : undefined;
}

export function toPlaceRow(p: LocalPlace, userId: string, device?: string): PlaceRow {
  return {
    id: p.id,
    user_id: userId,
    updated_by_device: device ?? null,
    name: p.name,
    formatted_address: p.formattedAddress,
    provider: p.provider,
    provider_place_id: p.providerPlaceId,
    country_code: p.countryCode,
    country: p.country,
    region: p.region,
    city: p.city,
    district: p.district,
    postcode: p.postcode,
    category: p.category,
    memo: p.memo,
    longitude: p.longitude,
    latitude: p.latitude,
    precision: p.precision,
    span_meters: p.spanMeters,
    map_picked: p.mapPicked,
    source: 'user',
    version: p.version,
    base_version: p.baseVersion ?? Math.max(0, p.version - 1),
    base_canonical_version: p.baseCanonicalVersion ?? 'legacy',
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    deleted_at: p.deletedAt,
    client_operation_id: p.clientOperationId ?? null,
  };
}

/**
 * 서버 행 → 로컬 장소. 시각은 **반드시** `isoInstant()`를 통과한다(M-0034).
 *
 * 왜 한 줄도 빼면 안 되나: 서버는 `…48.34+00:00`, 로컬은 `…48.340Z`로 **같은 순간을 다르게**
 * 적는다. 이 앱은 시각을 문자열로 비교하므로(LWW·정렬·진단) 표기가 곧 의미다.
 */
export function fromPlaceRow(r: PlaceRow): WithInstants<LocalPlace> {
  const provider = r.provider ?? null;
  const providerPlaceId = r.provider_place_id ?? null;
  const key = providerKeyOf(provider, providerPlaceId);
  return {
    id: r.id,
    name: r.name || '이름 없음',
    formattedAddress: r.formatted_address ?? null,
    provider,
    providerPlaceId,
    ...(key ? { providerKey: key } : {}),
    countryCode: r.country_code ?? null,
    country: r.country ?? null,
    region: r.region ?? null,
    city: r.city ?? null,
    district: r.district ?? null,
    postcode: r.postcode ?? null,
    category: r.category ?? null,
    memo: r.memo ?? null,
    longitude: r.longitude,
    latitude: r.latitude,
    precision: r.precision ?? null,
    spanMeters: r.span_meters ?? null,
    mapPicked: r.map_picked === true,
    version: r.version,
    baseVersion: r.version,
    baseCanonicalVersion: r.base_canonical_version ?? 'legacy',
    createdAt: isoInstant(r.created_at),
    updatedAt: isoInstant(r.updated_at),
    deletedAt: isoInstantOrNull(r.deleted_at),
    ...(r.client_operation_id ? { clientOperationId: r.client_operation_id } : {}),
  };
}
