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

/** ISO 일시 → 사용자의 로컬 달력 날짜 'YYYY-MM-DD'. 파싱 실패는 빈 문자열. */
export function localDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
