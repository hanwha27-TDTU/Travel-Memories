// domain/place/coordInput.ts — **사용자가 붙여넣은 것에서 좌표를 읽어낸다**(순수 → 유닛으로 잠금).
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 이 기능이 있나 (사용자 제안 2026-07-30)
// ─────────────────────────────────────────────────────────────────────────────
// *"정 찾기 어려우면 이미 만들어진 네이버, 카카오, 구글 이런 곳에서 위치를 클릭하면 바로
//   그 지점의 좌표를 확인할 수 있게 하면 어때? 그리고 그 좌표를 내가 장소 입력하는 필드에
//   좌표검색으로 핀을 찍게 하는 거지."*
//
// 이 제안이 좋은 이유가 셋이다:
//  ① **약관 문제가 없다.** 우리가 남의 API를 부르는 게 아니라, 사용자가 자기 눈으로 본
//     좌표를 손으로 옮기는 것이다. 좌표는 지구에 관한 사실이지 남의 데이터베이스가 아니다.
//     (Google Geocoding API를 붙이는 길은 「비-Google 지도와 함께 쓰지 말라」에서 막힌다.)
//  ② **앱이 못 찾는 곳을 사용자가 뚫을 수 있다.** 지오코더 품질은 우리가 통제할 수 없지만,
//     사람이 다른 지도에서 눈으로 찾는 것은 언제나 가능하다. 막다른 길을 없앤다.
//  ③ **이미 있는 「다른 지도에서 열기」와 왕복이 완성된다.** 나가는 길만 있고 돌아오는 길이
//     없었다.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 이 파일의 가장 어려운 문제: **위도·경도 순서**
// ─────────────────────────────────────────────────────────────────────────────
// `37.587, 127.0016`은 서울이고 `127.0016, 37.587`도 서울이다 — 앞이 위도냐 경도냐만 다르다.
// 그런데 **`41.9, 12.5`(로마)는 둘 다 위도일 수 있어 원리적으로 모호하다.**
//
// 이 앱에서 좌표를 틀리면 **기억이 엉뚱한 곳에 찍힌다.** 그래서 추측해서 조용히 넘어가지
// 않는다(§8 — 모르는 것은 '확인 불가'다):
//   · 한쪽 순서만 유효하면(위도는 ±90을 넘을 수 없다) **그쪽이 답이다** — 모호하지 않다.
//   · 둘 다 유효하면 **관례(위도,경도)를 따르되 `ambiguous: true`로 밝힌다.** 화면이
//     「위도 X · 경도 Y로 읽었어요」라고 말하고 뒤바꿀 수단을 준다.
//   · 어느 쪽도 유효하지 않으면 **null** — 억지로 만들지 않는다.
//
// URL에서 읽을 때는 **파라미터 이름이 순서를 말해주므로 모호하지 않다.** 얀덱스만 `ll=경도,위도`
// 라는 것도 여기서 흡수한다(그 비대칭은 `externalMap.ts`에도 같은 이유로 적혀 있다).

/** 좌표 하나를 읽어낸 결과. 읽지 못했으면 호출부가 null을 받는다. */
export interface ParsedCoord {
  lat: number;
  lng: number;
  /**
   * 🔴 **위도·경도 순서를 확신할 수 없었는가.** true면 화면이 그 사실을 말해야 한다.
   * 두 값이 모두 ±90 안이면 어느 쪽이 위도인지 값만 보고는 알 수 없다.
   */
  ambiguous: boolean;
  /** 어디서 읽었는지 — 화면이 「구글 지도 링크에서 읽었어요」라고 말할 수 있게. */
  source: 'plain' | 'dms' | 'google' | 'naver' | 'kakao' | 'yandex' | 'osm' | 'url';
}

const isLat = (n: number): boolean => Number.isFinite(n) && n >= -90 && n <= 90;
const isLng = (n: number): boolean => Number.isFinite(n) && n >= -180 && n <= 180;

/**
 * 🔴 **「이게 지구 위의 진짜 좌표인가」의 단일 판정** — 이 앱에서 이 질문에 답하는 유일한 함수다.
 *
 * 왜 하나여야 하나(H-3 · 2026-08-01 감사·확정): 같은 판정이 **일곱 곳에 손으로** 있었고 이미
 * 세 가지 강도로 **갈라져 있었다** — 어떤 곳은 `Number.isFinite`로 NaN을 막고 어떤 곳은 안 막아
 * `NaN, NaN`이 화면에 그려지고 "장소 있음"으로 통과했다. 헌법 M-0060이 정확히 이걸 금지한다:
 * *"같은 판정을 두 번 쓰지 마라 — 이유를 붙여서도. 갈라질 수 있는 것은 갈라진다."*
 *
 * 세 가지를 한꺼번에 판정한다: ① 둘 다 유한한 수인가(NaN·null·undefined 배제) ② 범위 안인가
 * (위도 ±90·경도 ±180) ③ **둘 다 0이 아닌가**(0,0 = 기니만 앞바다 = 보통 파싱 실패의 흔적 —
 * M-0057이 나흘 쓴 자리). `unknown`을 받는 이유: 호출부의 값이 `number|null|undefined`로
 * 제각각이라 경계에서 한 번에 좁힌다. `check-real-coord` 게이트가 이 함수 밖의 `=== 0 && … === 0`
 * 리터럴을 RED로 잡는다(3층).
 */
export function isRealCoord(lat: unknown, lng: unknown): boolean {
  if (typeof lat !== 'number' || typeof lng !== 'number') return false;
  if (!isLat(lat) || !isLng(lng)) return false;
  return !(lat === 0 && lng === 0);
}

/** 좌표쌍이 지구 위에 있는가(붙여넣기 파서용 별칭 — 인자가 이미 number인 경로). */
export function isUsableCoord(lat: number, lng: number): boolean {
  return isRealCoord(lat, lng);
}

/**
 * 순서를 모르는 두 수 → 좌표.
 *
 * 위도는 ±90을 넘을 수 없다는 **물리적 제약**이 대부분의 모호함을 없앤다. 한국 좌표
 * (위도 33~39 · 경도 124~132)는 경도가 90을 넘으므로 **언제나 명확하다** — 사용자가 어느
 * 순서로 붙여넣든 옳게 읽힌다.
 */
export function orderPair(a: number, b: number): ParsedCoord | null {
  const abValid = isUsableCoord(a, b); // (위도, 경도)로 읽기
  const baValid = isUsableCoord(b, a); // (경도, 위도)로 읽기
  if (abValid && baValid) {
    // 둘 다 말이 된다 — 관례(위도,경도)를 쓰되 **모호했다고 밝힌다.**
    return { lat: a, lng: b, ambiguous: true, source: 'plain' };
  }
  if (abValid) return { lat: a, lng: b, ambiguous: false, source: 'plain' };
  if (baValid) return { lat: b, lng: a, ambiguous: false, source: 'plain' };
  return null;
}

/** 위·경도를 뒤바꾼다. 화면의 [바꾸기] 버튼이 쓴다 — 뒤바꾼 뒤에는 더 이상 모호하지 않다. */
export function swapCoord(c: ParsedCoord): ParsedCoord {
  return { lat: c.lng, lng: c.lat, ambiguous: false, source: c.source };
}

/** 도·분·초 한 조각 → 십진수. `37°35'13.2"N` 형태. 못 읽으면 null. */
function parseDmsPart(text: string): number | null {
  const m = /(-?\d+(?:\.\d+)?)\s*[°d:\s]\s*(?:(\d+(?:\.\d+)?)\s*['′m:\s]\s*)?(?:(\d+(?:\.\d+)?)\s*["″s]?\s*)?([NSEW])?/i.exec(
    text.trim(),
  );
  if (!m) return null;
  const deg = Number(m[1]);
  if (!Number.isFinite(deg)) return null;
  const min = m[2] ? Number(m[2]) : 0;
  const sec = m[3] ? Number(m[3]) : 0;
  if (min >= 60 || sec >= 60) return null; // 분·초는 60을 넘을 수 없다
  const sign = /[SW]/i.test(m[4] ?? '') ? -1 : 1;
  return sign * (Math.abs(deg) + min / 60 + sec / 3600) * (deg < 0 ? -1 : 1);
}

/**
 * 도분초 표기 → 좌표. `37°35'13.2"N 127°00'05.8"E`
 *
 * N/S/E/W가 있으면 **순서가 확정된다**(어느 쪽이 위도인지 글자가 말한다) — 모호하지 않다.
 */
export function parseDms(text: string): ParsedCoord | null {
  if (!/[NSEW]/i.test(text)) return null;
  const parts = text.split(/(?<=[NSEW])\s*[,/]?\s*/i).filter((p) => /[NSEW]/i.test(p));
  if (parts.length !== 2) return null;
  const a = parseDmsPart(parts[0]!);
  const b = parseDmsPart(parts[1]!);
  if (a === null || b === null) return null;
  const aIsLat = /[NS]/i.test(parts[0]!);
  const bIsLat = /[NS]/i.test(parts[1]!);
  if (aIsLat === bIsLat) return null; // 둘 다 위도이거나 둘 다 경도 — 좌표가 아니다
  const lat = aIsLat ? a : b;
  const lng = aIsLat ? b : a;
  if (!isUsableCoord(lat, lng)) return null;
  return { lat, lng, ambiguous: false, source: 'dms' };
}

/** URL 쿼리/경로에서 이름 있는 좌표를 읽는다. 이름이 순서를 말하므로 **모호하지 않다**. */
function parseKnownUrl(text: string): ParsedCoord | null {
  const build = (lat: number, lng: number, source: ParsedCoord['source']): ParsedCoord | null =>
    isUsableCoord(lat, lng) ? { lat, lng, ambiguous: false, source } : null;

  // 얀덱스: `ll=경도,위도` — 🔴 **넷 중 여기만 반대다**(externalMap.ts에 같은 경고가 있다).
  const yandex = /yandex\.[a-z.]+\/maps[^\s]*?[?&]ll=(-?\d+(?:\.\d+)?)[,%2C]+(-?\d+(?:\.\d+)?)/i.exec(text);
  if (yandex) return build(Number(yandex[2]), Number(yandex[1]), 'yandex');

  // 네이버: `?lat=..&lng=..`(순서 무관 — 이름으로 읽는다)
  if (/naver\./i.test(text)) {
    const la = /[?&]lat=(-?\d+(?:\.\d+)?)/i.exec(text);
    const ln = /[?&]lng=(-?\d+(?:\.\d+)?)/i.exec(text);
    if (la && ln) return build(Number(la[1]), Number(ln[1]), 'naver');
  }

  // 카카오: `/link/map/이름,위도,경도`
  const kakao = /kakao\.[a-z.]+\/link\/map\/[^,]*,(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i.exec(text);
  if (kakao) return build(Number(kakao[1]), Number(kakao[2]), 'kakao');

  // OSM: `#map=zoom/위도/경도`
  const osm = /openstreetmap\.[a-z.]+[^\s]*?#map=\d+(?:\.\d+)?\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/i.exec(text);
  if (osm) return build(Number(osm[1]), Number(osm[2]), 'osm');

  if (/google\.[a-z.]+\/maps|maps\.google\./i.test(text)) {
    // `/maps/@위도,경도,17z` — 화면 중심
    const at = /\/maps\/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(text);
    // `!3d위도!4d경도` — **핀이 실제로 꽂힌 지점**. 화면 중심(@)보다 정확하므로 먼저 본다.
    const bang = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(text);
    // `?q=위도,경도` — 우리가 내보내는 형식이기도 하다(왕복).
    const q = /[?&]q(?:uery)?=(-?\d+(?:\.\d+)?)[,%2C]+\s*(-?\d+(?:\.\d+)?)/i.exec(text);
    const hit = bang ?? q ?? at;
    if (hit) return build(Number(hit[1]), Number(hit[2]), 'google');
  }
  return null;
}

/** 문자열에서 숫자쌍 하나를 뽑는다(구분자는 쉼표·공백·슬래시). 못 찾으면 null. */
function firstNumberPair(text: string): [number, number] | null {
  const m = /(-?\d{1,3}(?:\.\d+)?)\s*[,/\s]\s*(-?\d{1,3}(?:\.\d+)?)/.exec(text);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : null;
}

/**
 * 사용자가 붙여넣은 무엇이든 → 좌표(또는 null).
 *
 * 순서가 중요하다: **이름 있는 형식(URL·도분초)을 먼저** 본다. 그것들은 순서를 확정해 주므로
 * 모호함이 없다. 평문 숫자쌍은 마지막이고, 그때만 `ambiguous`가 될 수 있다.
 *
 * 좌표가 아닌 평범한 장소 이름(「대학로」·「Roma Termini」)에는 **반드시 null**을 돌려줘야
 * 한다 — 안 그러면 이름 검색이 좌표 입력으로 오인돼 사라진다.
 */
export function parseCoordinateInput(raw: string): ParsedCoord | null {
  const text = (raw ?? '').trim();
  if (!text) return null;

  const url = parseKnownUrl(text);
  if (url) return url;

  const dms = parseDms(text);
  if (dms) return dms;

  // 알 수 없는 URL이라도 숫자쌍이 있으면 읽어 본다(지도 서비스는 많고 형식도 바뀐다).
  // 다만 **순서를 모르므로** 평문과 같은 규칙을 지난다.
  const isUrl = /^[a-z]+:\/\//i.test(text) || /\.[a-z]{2,}\//i.test(text);

  // 평문은 **좌표만 있는 입력**일 때만 받는다. 「스타벅스 37.5, 127.0」처럼 글자가 섞이면
  // 장소 이름으로 본다 — 사용자가 이름을 치는 중일 수 있고, 그때 필드를 빼앗으면 안 된다.
  if (!isUrl && !/^[-\d.,/\s°'"′″NSEWnsew]+$/.test(text)) return null;

  const pair = firstNumberPair(text);
  if (!pair) return null;
  const ordered = orderPair(pair[0], pair[1]);
  if (!ordered) return null;
  return isUrl ? { ...ordered, source: 'url' } : ordered;
}

const SOURCE_LABEL: Record<ParsedCoord['source'], string> = {
  plain: '좌표',
  dms: '도·분·초 좌표',
  google: '구글 지도 링크',
  naver: '네이버 지도 링크',
  kakao: '카카오맵 링크',
  yandex: '얀덱스 지도 링크',
  osm: 'OpenStreetMap 링크',
  url: '지도 링크',
};

/**
 * 사용자에게 나가는 한 문장 — **순수 함수로 뽑아 유닛이 잰다**(§10 ③).
 *
 * 🔴 모호했으면 **반드시 말한다.** 「위도 37.587 · 경도 127.0016으로 읽었어요」라고 적어야
 * 사용자가 틀린 걸 알아채고 뒤바꿀 수 있다. 조용히 추측하면 기억이 엉뚱한 곳에 남는다.
 */
export function coordInputLabel(c: ParsedCoord): string {
  const head = `${SOURCE_LABEL[c.source]}로 읽었어요`;
  const body = `위도 ${c.lat.toFixed(5)} · 경도 ${c.lng.toFixed(5)}`;
  return c.ambiguous ? `${head} — ${body} (순서가 맞나요?)` : `${head} — ${body}`;
}
