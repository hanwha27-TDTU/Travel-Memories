// domain/time.ts — "사용자가 겪은 날짜"의 단일 진실원(SSOT).
//
// 왜 이 파일이 있나(결함군 M-utc-slice, 2026-07-25):
//   타임라인 날짜 그룹이 `occurredAt.slice(0, 10)`으로 **UTC 날짜**를 뽑는 바람에,
//   한국(UTC+9)에서 새벽에 기록한 순간이 전날 그룹에 묶였다. 시각 표시(06:48)·발생 시각 입력·
//   백업 파일명은 전부 **로컬**이라 화면 안에서 날짜가 서로 어긋났고, 환율(사용일 기준)이
//   로컬 날짜를 쓰면서 "타임라인은 7/15인데 환율은 7/16" 형태로 드러났다.
//
// 계약: 이 앱에서 "그 날"은 **사용자의 로컬 달력 날짜**다(그 사람이 실제로 겪은 날).
//   ISO 문자열을 잘라(slice) 날짜를 만들지 않는다 — 그건 UTC 날짜이지 사용자의 날짜가 아니다.
//   `scripts/check-local-date.mjs` 게이트가 이 규칙을 기계적으로 강제한다.

const p2 = (n: number): string => String(n).padStart(2, '0');

// ───────────────────────────────────────────────────────────────────────────
// 시각 **표기**의 SSOT — 결함군 M-0034(2026-07-27 사용자 실기기)
//
// 진단이 사진 9건을 「만든 시각이 고친 시각보다 늦음」으로 띄웠다. 실제 데이터는 멀쩡했다.
// 같은 순간을 **두 가지 표기**로 저장하고 있었을 뿐이다:
//
//   로컬(JS `toISOString()`)  2026-07-26T17:29:48.340Z      ← ms 3자리 고정 · `Z`
//   서버(PostgREST/JSON)      2026-07-26T17:29:48.34+00:00  ← ms 끝 0 생략 · `+00:00`
//
// 그리고 이 앱은 시각을 **문자열로 비교**한다(`mergeDecision`의 LWW, 진단의 시간 역전).
// `'0'`(0x30) > `'+'`(0x2B)이므로 **같은 순간인데 createdAt이 더 크다**고 읽혔다.
//
// 근본형 한 문장: **밖에서 들어온 시각 문자열을 우리 표기로 바꾸지 않고 저장했다.**
// 그래서 표기를 정하는 곳을 여기 하나로 두고, 서버·백업 경계가 **반드시** 통과하게 한다
// (`Instant` 브랜드 타입 — 통과하지 않으면 컴파일 오류. §7 2층).
// ───────────────────────────────────────────────────────────────────────────

/**
 * **정규 표기로 검증된** ISO 시각. `isoInstant()`만 만들 수 있다.
 *
 * 왜 브랜드인가: 조항("서버 시각은 정규화한다")과 게이트만으로는 다음 rowmap이 자동으로
 * 따라오지 않는다 — M-0033이 정확히 그 형태였다(규율이 문서에 있었는데 새것 하나만
 * 바깥에서 태어났다). 타입이면 `createdAt: r.created_at`이 **컴파일 오류**가 된다.
 */
export type Instant = string & { readonly __instant: unique symbol };

/**
 * 시각 3종이 **정규화를 거쳤음이 타입에 박힌** 행. 서버·백업에서 들어오는 모든 행의 반환형이다.
 * `createdAt: r.created_at`처럼 날것을 넣으면 `string`은 `Instant`가 아니라서 **컴파일이 막는다.**
 */
export type WithInstants<T extends { createdAt: string; updatedAt: string; deletedAt: string | null }> =
  Omit<T, 'createdAt' | 'updatedAt' | 'deletedAt'> & { createdAt: Instant; updatedAt: Instant; deletedAt: Instant | null };

/**
 * 어떤 표기의 ISO 시각이든 → 이 앱의 정규 표기(`YYYY-MM-DDTHH:MM:SS.sssZ`).
 *
 * 파싱 안 되는 값은 **그대로 돌려준다.** 지어내지 않는다(비타협 원칙 #4) — 대신 진단의
 * `BAD_TIME_FORMAT`가 그 값을 보이게 한다. 조용히 `now`로 채우면 사용자의 시각이 사라진다.
 */
export function isoInstant(s: string): Instant {
  const t = Date.parse(s);
  return (Number.isNaN(t) ? s : new Date(t).toISOString()) as Instant;
}

/** `isoInstant`의 null 허용판 — tombstone(`deletedAt`)처럼 없을 수 있는 시각용. */
export function isoInstantOrNull(s: string | null): Instant | null {
  return s == null ? null : isoInstant(s);
}

/** 이 문자열이 이미 정규 표기인가. 진단이 "옛 표기로 저장된 기록"을 셀 때 쓴다. */
export function isCanonicalInstant(s: string): boolean {
  return s === isoInstant(s);
}

/**
 * 이 행이 가진 **모든 시각 필드**의 이름. `…At`으로 끝나고 값이 빈 문자열이 아닌 문자열.
 *
 * ⚠️ **목록을 손으로 적지 않는다**(자기점검 2026-07-27). 처음엔 `createdAt`·`updatedAt`·
 * `deletedAt` 셋을 박아 뒀고, 그래서 `occurredAt`(순간의 발생 시각)·`takenAt`(사진 촬영 시각)이
 * **정리에서도 진단에서도 빠졌다.** 손으로 적은 목록은 적은 사람의 사각지대를 그대로 갖는다.
 * 이제 새 시각 필드가 생기면 정리·진단이 **자동으로 따라온다**(§7의 세 번째 질문).
 *
 * `deletedAt: null`(tombstone 없음)과 `''`(모름)은 대상이 아니다 — 없는 시각을 지어내지 않는다.
 */
export function instantFieldsOf(row: object): string[] {
  return Object.entries(row)
    .filter(([k, v]) => k.endsWith('At') && typeof v === 'string' && v !== '')
    .map(([k]) => k);
}

/**
 * 행의 **모든 시각 필드**를 정규 표기로 다시 쓴다.
 * **같은 순간, 다른 표기**일 뿐이므로 version·LWW 의미가 바뀌지 않는다 — 그래서 이 변환은
 * 사용자 편집이 아니고 sync op를 만들지 않는다.
 *
 * 쓰는 곳이 둘이다(§7 — 한 곳에 구현하고 형제가 통과하게):
 *  · 백업 복원(`importMergeRows`) — 옛 백업 파일에 옛 표기가 들어 있다.
 *  · 로컬 1회 정리(`normalizeStampsOnce`) — **이미 저장된** 행은 코드를 고쳐도 안 바뀐다(§10 ②).
 */
export function withCanonicalStamps<T extends object>(row: T): T {
  const out = { ...row } as Record<string, unknown>;
  for (const k of instantFieldsOf(row)) out[k] = isoInstant(out[k] as string);
  return out as T;
}

/**
 * 시각 두 개를 **순간으로** 비교한다(문자열 대소가 아니라). `a - b`의 부호.
 * 하나라도 파싱 안 되면 `null` — 모르는 것을 "같다"로도 "크다"로도 반올림하지 않는다.
 */
export function compareInstants(a: string, b: string): number | null {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return ta - tb;
}

/** ISO 일시 → 사용자의 로컬 달력 날짜 'YYYY-MM-DD'. 파싱 실패는 빈 문자열. */
export function localDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/**
 * ISO 일시 → 로컬 시각 'HH:mm'. 파싱 실패는 빈 문자열.
 * 화면에서 "몇 시에 있었던 일인가"를 말할 때 쓴다(타임라인 순간·사진 편집기 제목).
 */
export function localTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/**
 * ISO 일시 → 로컬 날짜+시각 'YYYY.MM.DD HH:mm'. 파싱 실패는 빈 문자열.
 * 지도 팝업처럼 **날짜 맥락이 화면에 없는 자리**에서 쓴다(타임라인은 날짜 헤더가 이미 있어 시각만 쓴다).
 *
 * 왜 여기 있나: 같은 계산이 `tripDetail`·`mapView`에 각자 `timeLabel`이라는 같은 이름으로
 * 있었고 **내용은 서로 달랐다**(하나는 시각만, 하나는 날짜까지). 이름이 같고 뜻이 다른 것은
 * 다음 사람을 속인다 — 로컬 시각 파생은 이 파일 하나에서만 한다.
 */
export function localDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}.${p2(d.getMonth() + 1)}.${p2(d.getDate())} ${localTime(iso)}`;
}
