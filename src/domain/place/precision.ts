// domain/place/precision.ts — 지오코딩 결과의 **정밀도 판정**(순수 → 유닛으로 잠금).
//
// 왜 이 파일이 생겼나(2026-07-30 · 사용자 실기기 지적 「기본맵이 너무 부정확하다」):
//   「대학로」를 검색해 저장했더니 지도가 엉뚱해 보였다. 스크린샷의 축척 기준점으로 핀을
//   역산하니 **127.00E / 37.587N — 혜화동로터리, 대학로의 북쪽 끝**이었다. 즉 좌표는
//   틀리지 않았다. 틀린 것은 **길이 1.1km인 선을 점 하나로 답한 것**, 그리고 그것을
//   앱이 아무 말 없이 「📍 위치 지정됨」이라고 적은 것이다.
//
//   헌법 §8: *"모르는 것은 '확인 불가'다. 정상으로도 문제로도 반올림하지 않는다."*
//   도(道) 중심점과 건물 출입구를 **같은 문장으로 말하는 것**이 이 결함의 본체다.
//   좌표를 더 정확하게 만드는 것과, 얼마나 정확한지 말하는 것은 다른 일이고 — 후자가 없으면
//   사용자는 자기 기억이 어디에 찍혔는지 영영 알 수 없다.
//
// 이 모듈은 좌표를 만들지 않는다. **온 좌표가 무엇을 가리키는지 판정만** 한다.

/** 결과가 가리키는 대상의 크기 등급. 'unknown'은 정상으로 반올림하지 않은 상태다(§8). */
export type PlacePrecision = 'point' | 'street' | 'area' | 'settlement' | 'region' | 'unknown';

/** [남, 북, 서, 동] — Nominatim boundingbox의 순서 그대로(문자열로 온다). */
export type BBox = readonly [number, number, number, number];

export interface PrecisionVerdict {
  precision: PlacePrecision;
  /** 대상이 걸친 대략 범위(m). **모르면 null** — 0으로 반올림하지 않는다(§8). */
  spanMeters: number | null;
  /** 이 좌표를 "바로 그 지점"이라고 말해도 되는가. false면 화면이 그렇게 말하면 안 된다. */
  pinpoint: boolean;
}

/** 위도 1도의 대략 거리(m). 경도는 위도에 따라 줄어든다(cos 보정). */
const METERS_PER_DEGREE = 111_320;

/**
 * boundingbox → 대상이 걸친 대략 범위(m). 가로·세로 중 **큰 쪽**을 쓴다.
 *
 * 왜 큰 쪽인가: 대학로처럼 가늘고 긴 대상은 짧은 변만 보면 "정밀하다"고 오판한다.
 * 정밀도는 **가장 나쁜 축**이 결정한다(작은 쪽으로 반올림하면 앱이 아는 척하게 된다).
 */
export function bboxSpanMeters(bbox: BBox | null): number | null {
  if (!bbox) return null;
  const [south, north, west, east] = bbox;
  if (![south, north, west, east].every((n) => Number.isFinite(n))) return null;
  const midLat = (south + north) / 2;
  const latSpan = Math.abs(north - south) * METERS_PER_DEGREE;
  const lngSpan = Math.abs(east - west) * METERS_PER_DEGREE * Math.cos((midLat * Math.PI) / 180);
  const span = Math.max(latSpan, lngSpan);
  return Number.isFinite(span) ? Math.round(span) : null;
}

/**
 * Nominatim `place_rank` → 등급.
 *
 * 출처는 Nominatim의 주소 랭크 체계다(낮을수록 넓다): ~16 국가·광역, 17–21 도시·읍면,
 * 22–25 동네·구역, 26–27 도로, 28+ 건물·지점. 범위로 잡는 이유는 제공자가 세부 값을
 * 조정해도 등급이 흔들리지 않게 하기 위해서다.
 */
export function precisionFromRank(placeRank: number | null): PlacePrecision {
  if (placeRank === null || !Number.isFinite(placeRank)) return 'unknown';
  if (placeRank >= 28) return 'point';
  if (placeRank >= 26) return 'street';
  if (placeRank >= 22) return 'area';
  if (placeRank >= 17) return 'settlement';
  return 'region';
}

/**
 * 범위(m) → 등급. `place_rank`가 없는 제공자(B단계에서 붙는 국내 제공자 등)를 위한 경로다.
 * 경계값은 등급의 **대표 크기**에서 왔다: 건물 100m, 도로 2km, 동네 8km, 도시 40km.
 */
export function precisionFromSpan(spanMeters: number | null): PlacePrecision {
  if (spanMeters === null || !Number.isFinite(spanMeters)) return 'unknown';
  if (spanMeters <= 120) return 'point';
  if (spanMeters <= 2_000) return 'street';
  if (spanMeters <= 8_000) return 'area';
  if (spanMeters <= 40_000) return 'settlement';
  return 'region';
}

/**
 * 결과 하나의 정밀도 판정.
 *
 * **랭크가 있으면 랭크가 이긴다** — 랭크는 제공자가 말한 *의미*(이건 도로다)이고, 범위는
 * 우리가 잰 *크기*다. 작은 도로는 범위만 보면 건물처럼 보이는데, 그래도 도로는 도로다
 * (어느 지점인지 여전히 알 수 없다). 둘 다 없으면 'unknown'으로 남긴다 — 모르는 것을
 * 정밀한 쪽으로 반올림하지 않는다(§8).
 */
export function classifyPlace(input: { placeRank: number | null; bbox: BBox | null }): PrecisionVerdict {
  const spanMeters = bboxSpanMeters(input.bbox);
  const byRank = precisionFromRank(input.placeRank);
  const precision = byRank !== 'unknown' ? byRank : precisionFromSpan(spanMeters);
  return { precision, spanMeters, pinpoint: precision === 'point' };
}

/** 범위(m) → 사람이 읽는 거리. 모르면 null(«대략»이라고도 말하지 않는다). */
export function spanText(spanMeters: number | null): string | null {
  if (spanMeters === null || !Number.isFinite(spanMeters) || spanMeters < 0) return null;
  if (spanMeters < 1_000) return `약 ${Math.max(1, Math.round(spanMeters / 10) * 10)}m`;
  return `약 ${(spanMeters / 1_000).toFixed(spanMeters < 10_000 ? 1 : 0)}km`;
}

const PRECISION_NOUN: Record<PlacePrecision, string> = {
  point: '건물·지점',
  street: '길 전체',
  area: '동네 범위',
  settlement: '도시 범위',
  region: '행정구역 범위',
  unknown: '정밀도 확인 불가',
};

/** 등급의 짧은 이름(칩·배지용). */
export function precisionNoun(p: PlacePrecision): string {
  return PRECISION_NOUN[p];
}

/**
 * 등급 글리프. **색은 늘 글리프와 함께**(헌법 §7 사용자 대면 대칭) — 색만으로 구분하면
 * 색각 이상·흑백 인쇄·저대비 환경에서 정보가 통째로 사라진다.
 *
 * '?'와 '⚠'를 나누는 이유: §8은 *모르는 것*과 *문제인 것*을 반올림해 섞지 말라고 한다.
 * 넓은 대상은 우리가 **알고** 넓다고 말하는 것이고, unknown은 **재지 못한** 것이다.
 */
export function precisionGlyph(v: PrecisionVerdict): string {
  if (v.precision === 'unknown') return '?';
  return v.pinpoint ? '📍' : '⚠';
}

/**
 * 사용자에게 나가는 한 문장 — **순수 함수로 뽑아 유닛이 잰다**(§10 ③).
 *
 * M-0022의 교훈이 이 자리다: 자료구조가 옳아도 화면에 나가는 문장이 틀리면 그건 결함이고,
 * 유닛 15건이 전부 통과해도 아무도 못 잡는다. 그래서 문장을 DOM에서 떼어 놓는다.
 */
export function precisionLabel(v: PrecisionVerdict): string {
  const span = spanText(v.spanMeters);
  if (v.precision === 'unknown') {
    return span ? `정밀도 확인 불가 · ${span} 범위` : '정밀도 확인 불가';
  }
  if (v.pinpoint) return span ? `${PRECISION_NOUN.point} · ${span}` : PRECISION_NOUN.point;
  // 넓은 등급의 이름은 전부 모음으로 끝난다('길 전체'·'동네 범위'…) → 조사는 '를'.
  // 새 등급을 추가하며 받침 있는 이름을 넣으면 이 조사가 어색해진다 — 그때 조사 규칙을 만든다.
  const noun = PRECISION_NOUN[v.precision];
  return span ? `${noun}를 가리켜요 · ${span}` : `${noun}를 가리켜요`;
}

/**
 * 지도 미세조정을 권할 것인가.
 *
 * 'point'가 아니면 **어느 지점인지 앱이 모른다.** 그 상태로 저장해도 되지만, 사용자가
 * 나중에 "왜 엉뚱한 데 찍혔지?"라고 묻게 된다 — 그 질문이 나오기 전에 앱이 먼저 말한다.
 * 'unknown'도 포함한다: 모르는 것은 정밀한 쪽으로 반올림하지 않는다.
 */
export function needsRefine(v: PrecisionVerdict): boolean {
  return !v.pinpoint;
}

/**
 * 이 결과를 지도에 띄울 때의 확대수준.
 *
 * 🔴 이 함수가 생긴 이유가 원래 신고의 절반이다. `mapView`가 지점이 **하나뿐일 때만**
 * zoom을 손대지 않아(`setCenter`만 호출) 초기값 10 — 김포~남양주가 다 보이는 화면 —
 * 위에 핀 하나가 떠 있었다. 형제(목록 행 클릭)는 `flyTo({zoom:14})`로 제대로 하고 있었다.
 * **같은 규율이 두 곳에 손으로 구현돼 한쪽만 빠진** §7 비대칭이다.
 *
 * 범위를 알면 범위에 맞춘다(길이 1.1km인 대학로를 zoom 18로 확대해도 거짓 정밀이다).
 */
export function zoomForSpan(spanMeters: number | null): number {
  if (spanMeters === null || !Number.isFinite(spanMeters) || spanMeters <= 0) return 16;
  if (spanMeters <= 120) return 17;
  if (spanMeters <= 500) return 16;
  if (spanMeters <= 2_000) return 15;
  if (spanMeters <= 8_000) return 13;
  if (spanMeters <= 40_000) return 11;
  return 9;
}
