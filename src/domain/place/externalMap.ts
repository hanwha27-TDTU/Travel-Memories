// domain/place/externalMap.ts — **바깥 지도로 나가는 링크와 그 정직한 라벨.** 순수 함수.
//
// ── 왜 무료인가 (넷 다) ──────────────────────────────────────────────
// 돈이 드는 것은 지도 **API**다(JavaScript SDK·Static Maps·Places·Geocoding — 키·과금 필요).
// 여기서 쓰는 것은 전부 **그냥 링크**라 키도 계정도 과금도 없다.
// 그래서 이 앱의 구도가 성립한다: **입력은 무료 OSM(Nominatim), 출력은 사용자가 고른 지도.**
// 앱 안 지도(MapLibre+OSM 타일)가 주(主)이고, 바깥 지도는 길찾기·스트리트뷰·리뷰가
// 필요할 때 **한 걸음 더 가서** 여는 곳이다.
//
// ── 왜 넷인가 (사용자 요청 2026-07-28) ───────────────────────────────
// 지도는 **어디를 여행하느냐에 따라 쓸모가 갈린다.** 구글은 한국에서 길찾기가 약하고,
// 카카오·네이버는 해외가 비어 있고, 얀덱스는 중앙아시아·러시아에서 가장 정확하다.
// 하나만 두면 여행지의 절반에서 쓸모가 없다.
//
// ── 좌표 순서 (여기서 틀리면 엉뚱한 나라가 열린다) ───────────────────
// 🔴 **얀덱스만 경도,위도 순서다.** 나머지 셋은 위도,경도.
//    `ll=126.8,37.5`(얀덱스) ↔ `query=37.5,126.8`(구글) — 뒤집으면 서울이 아니라
//    인도양 한복판이 열린다. `tests/unit/externalMap.test.ts`가 이 순서를 잠근다.
//
// ── 왜 순수 함수인가 (§10 ③) ─────────────────────────────────────────
// 여기서 만드는 것은 URL만이 아니라 **사용자에게 갈 문장**이다 — 특히 좌표가 없어
// *이름으로 찾은* 경우, 그 사실을 말하지 않으면 앱이 **엉뚱한 곳을 그 장소라고 우기는** 셈이 된다.
// M-0022가 정확히 그 자리에서 났다: 숫자는 다 맞았고 화면에 나가는 문장만 틀렸으며,
// 유닛 15건이 전부 통과했다. 그래서 문장을 자료구조에서 떼어내 검사 가능하게 둔다.
//
// ── 개인정보 (PRIVACY.md「개인자료 기본 비공개」) ─────────────────────
// 이 링크를 여는 순간 **좌표(또는 장소 이름)가 그 회사로 나간다.** 이 앱이 평소 하지 않는
// 일이므로 조용히 하지 않는다: ①사용자가 직접 누를 때만 ②**제공자마다 처음 한 번** 무엇이
// 어디로 나가는지 확인 ③`rel/noreferrer`로 앱 주소가 함께 새지 않게.
// 🔴 ②가 **제공자별**인 것이 중요하다 — 구글에 보내도 된다는 동의는 얀덱스에 보내도 된다는
// 동의가 아니다. 받는 회사가 다르면 다른 결정이다.

import { isRealCoord } from './coordInput';

/** 제공자 식별자. 동의 저장 키와 검사에서 쓰므로 **문자열을 손으로 다시 적지 않는다.** */
export type MapProviderId = 'google' | 'yandex' | 'naver' | 'kakao';

export interface PlaceLike {
  name: string;
  lat: number | null;
  lng: number | null;
}

export interface ExternalMapTarget {
  id: MapProviderId;
  url: string;
  /**
   * **좌표로 정확히 집었는가, 이름으로 찾은 것인가.**
   * 이 둘을 같은 문장으로 말하면 안 된다 — 이름 검색은 동명이 있으면 다른 곳을 연다.
   */
  precision: 'coords' | 'name';
  /** 버튼에 보일 짧은 이름(구글·얀덱스·네이버·카카오). */
  label: string;
  /** 동의 문구에서 쓸 정식 이름. */
  company: string;
  /** 이름으로 찾은 경우에만 있는 한 줄 — 없으면 null(모르는 것을 지어내지 않는다). */
  caveat: string | null;
  /** 「무엇이 어디로 나가는가」 — 동의 문구가 이 값을 그대로 쓴다(따로 적지 않는다). */
  sends: string;
}

/**
 * 좌표가 지구 위의 값인가 — **단일 판정(isRealCoord)에 위임한다**(H-3).
 *
 * 🔴 예전엔 이 함수가 유한·범위·0,0 검사를 **손으로 다시 구현**했다(감사가 센 7곳의 8번째 —
 * `coordInput.ts`의 판정과 갈라질 수 있었다). 이름은 이 층의 어휘(외부 지도 링크)라 남기되
 * 몸은 공용 함수를 부른다. `check-real-coord` 게이트가 이 함수 밖의 0,0 리터럴을 잡는다.
 */
export function isUsableCoord(lat: number | null, lng: number | null): boolean {
  return isRealCoord(lat, lng);
}

/** 좌표 표기 — 소수 6자리면 약 10cm다. 그 이상은 정밀도를 **가장**하는 것이다. */
function n6(v: number): string {
  return String(Number(v.toFixed(6)));
}

/**
 * 카카오 링크는 경로가 **쉼표로 나뉜다**(`/link/map/이름,위도,경도`).
 * 그래서 이름에 쉼표가 있으면 **좌표 자리가 밀려** 엉뚱한 곳이 열린다 — 지어낸 위험이 아니라
 * 「서울시청, 본관」 같은 흔한 이름에서 바로 난다. 쉼표를 공백으로 바꿔 자리를 지킨다.
 */
function commaSafe(name: string): string {
  return name.replace(/,/g, ' ').trim();
}

interface Provider {
  id: MapProviderId;
  label: string;
  company: string;
  /** 좌표로 여는 URL. */
  byCoords: (lat: number, lng: number, name: string) => string;
  /** 이름으로 찾는 URL. 이름 검색을 지원하지 않으면 null. */
  byName: (name: string) => string | null;
}

/**
 * 제공자 등록부. **여기 한 줄이 곧 버튼 하나**다 — 화면이 목록을 손으로 다시 적지 않는다(§7).
 *
 * ⚠️ 각 URL 형식의 출처와 검증 상태는 `docs/DECISIONS.md`(ADR-0031)에 적었다.
 * 구글만 실기기에서 좌표까지 확인됐고(2026-07-28 사용자), 나머지 셋은 **문서 기준**이다.
 */
const PROVIDERS: readonly Provider[] = [
  {
    id: 'google',
    label: '구글',
    company: '구글',
    // Maps URLs. `api=1`이 없으면 나머지 매개변수가 전부 무시된다.
    byCoords: (lat, lng) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${n6(lat)},${n6(lng)}`)}`,
    byName: (name) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}`,
  },
  {
    id: 'yandex',
    label: '얀덱스',
    company: '얀덱스(Yandex)',
    // 🔴 **경도,위도 순서**다(넷 중 여기만). `pt`는 핀, `ll`은 지도 중심.
    byCoords: (lat, lng) =>
      `https://yandex.com/maps/?ll=${n6(lng)},${n6(lat)}&z=17&pt=${n6(lng)},${n6(lat)}`,
    byName: (name) => `https://yandex.com/maps/?text=${encodeURIComponent(name)}`,
  },
  {
    id: 'naver',
    label: '네이버',
    company: '네이버',
    byCoords: (lat, lng, name) => {
      const t = name || '저장한 위치'; // title이 비면 핀에 이름이 안 붙는다
      return `https://map.naver.com/p?title=${encodeURIComponent(t)}&lat=${n6(lat)}&lng=${n6(lng)}`;
    },
    byName: (name) => `https://map.naver.com/p/search/${encodeURIComponent(name)}`,
  },
  {
    id: 'kakao',
    label: '카카오',
    company: '카카오',
    // 경로가 쉼표로 나뉜다 — `commaSafe`가 이름의 쉼표를 없앤 뒤에만 안전하다.
    byCoords: (lat, lng, name) =>
      `https://map.kakao.com/link/map/${encodeURIComponent(commaSafe(name) || '저장한 위치')},${n6(lat)},${n6(lng)}`,
    byName: (name) => `https://map.kakao.com/link/search/${encodeURIComponent(name)}`,
  },
];

/** 제공자 목록(화면이 순서를 정하지 않게 여기서 준다). */
export const MAP_PROVIDER_IDS: readonly MapProviderId[] = PROVIDERS.map((p) => p.id);

/**
 * 이 장소를 **각 지도에서 열 링크**. 좌표도 이름도 없으면 **빈 배열**(열 곳이 없다고 정직하게).
 *
 * 좌표가 있으면 좌표로 집는다(정확). 없으면 이름으로 검색하되 **그 사실을 caveat에 담는다** —
 * 사용자 결정(2026-07-27): *"이름으로 검색해 연다. 단 이름으로 찾은 결과라고 화면에 밝힌다."*
 */
export function externalMapTargets(place: PlaceLike): ExternalMapTarget[] {
  const name = place.name.trim();
  const hasCoords = isUsableCoord(place.lat, place.lng);
  if (!hasCoords && !name) return [];

  const out: ExternalMapTarget[] = [];
  for (const p of PROVIDERS) {
    if (hasCoords) {
      const lat = place.lat as number;
      const lng = place.lng as number;
      out.push({
        id: p.id,
        url: p.byCoords(lat, lng, name),
        precision: 'coords',
        label: p.label,
        company: p.company,
        caveat: null,
        sends: `이 장소의 좌표(${n6(lat)},${n6(lng)})`,
      });
      continue;
    }
    const url = p.byName(name);
    if (!url) continue;
    out.push({
      id: p.id,
      url,
      precision: 'name',
      label: p.label,
      company: p.company,
      caveat: '저장된 좌표가 없어 장소 이름으로 검색해요. 같은 이름이 여러 곳이면 다른 곳이 열릴 수 있어요.',
      sends: `장소 이름("${name}")`,
    });
  }
  return out;
}

/**
 * 처음 한 번 보여줄 확인 문구. **무엇이 어디로 나가는지**를 `sends`·`company`에서 파생한다 —
 * 문구를 손으로 다시 적으면 링크가 바뀔 때 문장만 옛말로 남는다(SSOT).
 */
export function externalMapConsentText(t: ExternalMapTarget): string {
  return [
    `${t.company} 지도로 이동할까요?`,
    '',
    `${t.sends}가 ${t.company}에 전달됩니다. 이 앱은 평소 위치를 밖으로 보내지 않아요.`,
    '',
    `이 안내는 ${t.company}에 대해 처음 한 번만 보여드립니다.`,
  ].join('\n');
}
