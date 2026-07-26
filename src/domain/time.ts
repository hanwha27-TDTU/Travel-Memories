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
