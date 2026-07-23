// services/geocode.ts — 장소 검색(지오코딩). 무료·키 불필요 Nominatim(OpenStreetMap).
// 정책 준수: 검색은 버튼/제출 시에만(키입력마다 금지), limit 소량, 귀속표시. 개인·저트래픽용.
// URL 빌더·응답 파서는 순수 함수로 분리해 테스트로 잠근다(네트워크 fetch만 미검증).

export interface PlaceResult {
  name: string; // 짧은 표시명
  displayName: string; // 전체 주소
  lat: number;
  lng: number;
}

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

/** 검색 질의 → Nominatim URL(순수). 한국어 우선, 소량 결과. */
export function buildNominatimUrl(query: string): string {
  const params = new URLSearchParams({
    format: 'jsonv2',
    limit: '5',
    'accept-language': 'ko',
    q: query.trim(),
  });
  return `${NOMINATIM}?${params.toString()}`;
}

/** Nominatim JSON 응답 → PlaceResult[](순수). 좌표 유효한 것만. */
export function parseNominatimResults(json: unknown): PlaceResult[] {
  if (!Array.isArray(json)) return [];
  const out: PlaceResult[] = [];
  for (const r of json) {
    if (!r || typeof r !== 'object') continue;
    const row = r as Record<string, unknown>;
    const lat = Number(row['lat']);
    const lng = Number(row['lon']);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const displayName = typeof row['display_name'] === 'string' ? (row['display_name'] as string) : '';
    const rawName = typeof row['name'] === 'string' && row['name'] ? (row['name'] as string) : '';
    const name = rawName || displayName.split(',')[0]?.trim() || '이름 없음';
    out.push({ name, displayName: displayName || name, lat, lng });
  }
  return out;
}

/** 장소 검색 — Nominatim 호출 후 파싱. 실패 시 throw(호출부에서 안내). */
export async function searchPlaces(query: string): Promise<PlaceResult[]> {
  const q = query.trim();
  if (!q) return [];
  const res = await fetch(buildNominatimUrl(q), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`장소 검색 실패 (HTTP ${res.status})`);
  return parseNominatimResults(await res.json());
}
