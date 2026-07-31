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

// ───────────────────────────────────────────────────────────────────────────
// 「그 자리의 시계」 — 여행지 시간대 (2026-07-29 사용자 지적)
//
// 사용자: *"사진 찍은 나라 또는 지역의 시간으로 적용되게 고정하고, 사진에 장소정보가 없다면
// 사용자가 지정한 장소를 기준으로 하고, 적당한 위치에 한국시간으로 자동 환산해주면 좋겠다."*
//
// 맞다. 여행의 기억은 **"저녁 7시에 연극을 봤다"**이지 UTC가 아니다. 그런데 이 파일의 위
// 절반(`localDate`/`localTime`)은 **보는 기기의 시간대**로 계산한다 — 베트남에서 저녁 7시에
// 기록한 순간을 한국에서 열면 21:08이 되고, 자정 근처면 **Day 묶음까지 하루 밀린다.**
//
// 🔴 그리고 더 무거운 결함이 저장 쪽에 있었다(M-0049): EXIF `DateTimeOriginal`은 **시간대가
// 없는 벽시계 문자열**인데 `new Date('2026-07-29T19:08:00')`로 파싱하면 **넣는 기기의
// 시간대**로 해석된다. 베트남에서 찍고 한국 와서 넣으면 절대시각이 **2시간 틀어진다.**
// 여행 중엔 안 보이고 집에 와서 넣으면 틀어지는 형태다(§10 ② 상태 의존).
//
// ─────────────────────────────────────────────────────────────────────────
// 왜 데이터셋이 필요 없나
// ─────────────────────────────────────────────────────────────────────────
// 좌표→시간대는 경계 데이터셋(수 MB)이 필요하지만, **IANA 시간대 id → 그 순간의 오프셋**은
// 브라우저에 이미 있다(`Intl` + tzdata). DST도 자동이다(파리 7월 +2, 1월 +1). 그래서
// **여행에 시간대 id 하나**를 두면 데이터셋 0바이트로 정확해진다. 목록도 브라우저가 준다
// (`Intl.supportedValuesOf('timeZone')` — 418개).
//
// ─────────────────────────────────────────────────────────────────────────
// 두 종류의 「로컬」을 섞지 않는다 — 이 파일에서 가장 중요한 구분
// ─────────────────────────────────────────────────────────────────────────
// | 무엇을 재나 | 쓸 함수 | 예 |
// |---|---|---|
// | **기억**(그 자리에서 겪은 일) | `atOffset` — 여행지 오프셋 | 순간 시각·Day 그룹·사진 촬영시각·비용 발생일 |
// | **앱 조작·오늘**(지금 이 기기에서) | `localDate`/`localTime` — 기기 시간대 | 오늘 환율 조회일·휴지통에 넣은 날 |
//
// 섞으면 사용자가 화면 안에서 어긋난 날짜를 본다 — M-utc-slice가 정확히 그 형태였다.
// `check-timezone` 게이트가 **기억 필드**(`occurredAt`·`takenAt`·`recordedAt`)에 기기 로컬
// 함수를 쓰는 것을 막는다.
// ───────────────────────────────────────────────────────────────────────────

/** 이 기기의 IANA 시간대 id. 못 알아내면 `'UTC'`(모르는 것을 조용히 서울로 만들지 않는다). */
export function deviceZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * **그 순간, 그 시간대의 오프셋(분).** 모르면 `null`.
 *
 * DST를 포함한다 — 오프셋은 시간대의 성질이 아니라 **시간대 × 순간**의 성질이기 때문이다.
 * (파리는 여름 +120, 겨울 +60. 여행이 전환일을 걸치면 순간마다 답이 다르다.)
 */
export function zoneOffsetMin(instant: string, timeZone: string): number | null {
  const t = Date.parse(instant);
  if (Number.isNaN(t) || !timeZone) return null;
  try {
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const g: Record<string, string> = {};
    for (const p of f.formatToParts(new Date(t))) if (p.type !== 'literal') g[p.type] = p.value;
    // `hour`가 24로 나오는 구현이 있다(자정). 0으로 접는다.
    const hh = Number(g.hour) % 24;
    const asUtc = Date.UTC(Number(g.year), Number(g.month) - 1, Number(g.day), hh, Number(g.minute), Number(g.second));
    return Math.round((asUtc - t) / 60000);
  } catch {
    return null; // 알 수 없는 시간대 id — 「확인 불가」이지 0이 아니다
  }
}

/**
 * **시간대 결정 사다리.** 위에서부터 먼저 맞는 것을 쓴다.
 *
 *  1. `momentOffsetMin` — 이 순간에 **직접 적힌** 오프셋. EXIF `OffsetTimeOriginal`이 있었거나
 *     사용자가 예외를 지정한 경우. *그 카메라가 그 자리에서 적은 값*이므로 가장 강하다.
 *  2. `tripZone` — 여행에 지정된 시간대(대부분의 여행은 하나다).
 *  3. `null` — **모른다.** 기기 시간대로 반올림하지 않는다(§8: 모르는 것은 '확인 불가').
 *     화면이 폴백을 고르되 **추정임을 말해야** 한다.
 *
 * 🔴 기본값을 두지 않는 이유: 인자를 생략해도 컴파일되면 그게 규율이 조용히 빠지는 길이다
 * (M-0048에서 `otherDevices`로 같은 선택을 했고, 컴파일러가 호출부를 전부 데려왔다).
 */
export function resolveOffsetMin(
  instant: string,
  momentOffsetMin: number | null | undefined,
  tripZone: string,
): number | null {
  if (typeof momentOffsetMin === 'number' && Number.isFinite(momentOffsetMin)) return momentOffsetMin;
  return zoneOffsetMin(instant, tripZone);
}

/**
 * **그 오프셋에서의 벽시계.** 순간(절대시각)을 사람이 겪은 시각으로 되돌린다.
 *
 * 정렬·LWW·동기화는 **계속 절대시각**으로 한다 — 표시만 여기를 지난다. 섞으면 M-0034 재발이다.
 */
export function atOffset(instant: string, offsetMin: number): { date: string; time: string; dateTime: string } {
  const t = Date.parse(instant);
  if (Number.isNaN(t) || !Number.isFinite(offsetMin)) return { date: '', time: '', dateTime: '' };
  const d = new Date(t + offsetMin * 60000);
  const date = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
  const time = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
  return { date, time, dateTime: `${date.replace(/-/g, '.')} ${time}` };
}

/**
 * **벽시계 + 오프셋 → 절대시각.** EXIF `DateTimeOriginal`처럼 시간대가 없는 문자열을 읽을 때.
 *
 * 🔴 `new Date('2026-07-29T19:08:00')`을 쓰지 마라 — **넣는 기기의 시간대**로 해석된다.
 * 그게 M-0049였다: 베트남에서 찍고 한국에서 넣으면 절대시각이 2시간 틀어진다.
 *
 * @param wall `YYYY-MM-DDTHH:mm:ss` 또는 `YYYY-MM-DD HH:mm(:ss)`
 */
export function wallClockToInstant(wall: string, offsetMin: number): Instant | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(wall.trim());
  if (!m || !Number.isFinite(offsetMin)) return null;
  const [, y, mo, d, h, mi, se] = m;
  const t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se ?? '0')) - offsetMin * 60000;
  if (Number.isNaN(t)) return null;
  return isoInstant(new Date(t).toISOString());
}

/**
 * 환산 꼬리표 — **다를 때만** 문자열을 준다(§8 「침묵이 정상」).
 *
 * 국내 여행에서 매번 「한국시간 19:08」이 붙으면 그건 정보가 아니라 소음이다. 시각이 같으면
 * 빈 문자열을 돌려주고 화면은 아무것도 그리지 않는다.
 *
 * @param homeLabel 사용자가 읽을 이름(예: '한국'). 표기는 호출부가 정한다.
 */
export function homeConversion(instant: string, offsetMin: number, homeZone: string, homeLabel: string): string {
  const home = zoneOffsetMin(instant, homeZone);
  if (home === null || home === offsetMin) return '';
  const { time } = atOffset(instant, home);
  if (!time) return '';
  const there = atOffset(instant, offsetMin);
  // 날짜까지 달라지면 시각만 보여주면 헷갈린다 — 그때는 날짜를 함께 말한다.
  return there.date === atOffset(instant, home).date ? `${homeLabel} ${time}` : `${homeLabel} ${atOffset(instant, home).dateTime}`;
}

/**
 * **벽시계 읽기 → 그때 그 시간대의 오프셋(분).** 모르면 `null`.
 *
 * 닭과 달걀을 푼다: 오프셋을 알아야 절대시각이 나오는데, DST는 절대시각에 달렸다.
 * 두 번 재서 수렴시킨다 — 벽시계를 UTC로 읽어 대략의 순간을 만들고(최대 ±14시간 오차),
 * 그 순간의 오프셋으로 다시 잰다.
 *
 * **정직한 한계**: DST 전환 **당일 몇 시간** 안에서는 한 시간 어긋날 수 있다(그 벽시계가
 * 두 번 존재하거나 아예 없는 구간). 그 자리는 사용자가 순간별 예외로 고칠 수 있고,
 * 어차피 「존재하지 않는 벽시계」에는 정답이 없다.
 */
export function zoneOffsetAtWall(wall: string, timeZone: string): number | null {
  const rough = zoneOffsetMin(`${wall.replace(' ', 'T')}Z`, timeZone);
  if (rough === null) return null;
  const t = Date.parse(`${wall.replace(' ', 'T')}Z`);
  if (Number.isNaN(t)) return null;
  return zoneOffsetMin(new Date(t - rough * 60000).toISOString(), timeZone);
}

// ───────────────────────────────────────────────────────────────────────────
// 표시 계층 — 「기억 시각」을 화면에 내보내는 **단 하나의 문**
//
// 위쪽 절반이 부품(오프셋 계산·벽시계 변환)이라면 여기는 **화면이 실제로 부르는 곳**이다.
// 왜 부품만으로는 안 되나: 사다리(`resolveOffsetMin`)가 `null`을 돌려줄 수 있고, 그때
// 화면마다 폴백을 각자 고르면 **같은 순간이 화면마다 다른 시각으로 보인다** — M-0048이
// 정확히 그 형태였다(같은 자료에 두 기기가 반대 판정). 그래서 폴백도 여기서 한 번만 고르고,
// **폴백을 썼다는 사실을 값에 담아** 내보낸다(`basis`·`caveat`).
//
// §8 「모르는 것은 '확인 불가'」와 어떻게 양립하나: 시각은 *안 보여줄 수 없다*(빈 칸이 곧
// 거짓말이다). 그래서 보여주되 **그게 추정임을 같은 자리에서 말한다.** 침묵하는 것은
// 확실할 때뿐이다.
// ───────────────────────────────────────────────────────────────────────────

/**
 * 「이 여행의 시계」 — 기억 시각을 그리는 데 필요한 것 전부.
 *
 * 화면이 이 묶음을 **한 번 만들어 아래로 내린다.** 개별 인자로 흩뿌리면 새 화면이 하나를
 * 빼먹고, 그 빠짐이 조용하다(§7 — 누락이 컴파일 오류가 되게 묶는다).
 */
export interface TripClock {
  /** 여행 시간대(IANA id). `''` = 미지정 — **자동으로 채우지 않는다**(사용자의 사실이다). */
  zone: string;
  /** 집 시간대(IANA id). 환산 꼬리표 전용 — 기억 시각 계산에는 쓰지 않는다. */
  homeZone: string;
}

/** 이 시각을 **무엇을 근거로** 그렸는가. `'device'`만 추정이다. */
export type WhenBasis = 'moment' | 'trip' | 'device';

export interface WhenView {
  /** 그 자리 기준 달력 날짜 `YYYY-MM-DD`. Day 묶기의 키가 이 값이다. */
  date: string;
  /** 그 자리 기준 `HH:mm`. */
  time: string;
  /** 그 자리 기준 `YYYY.MM.DD HH:mm`. */
  dateTime: string;
  offsetMin: number;
  basis: WhenBasis;
  /** 집 시간 환산 꼬리표. **같으면 `''`** — 국내 여행에서 매번 붙으면 소음이다(§8). */
  home: string;
  /** 추정이면 그 사실을 말하는 한 줄. 확실하면 `''`. */
  caveat: string;
}

/**
 * IANA id → 사람이 읽는 짧은 이름. 브라우저 tzdata가 준다(데이터셋 0바이트).
 *
 * `'Asia/Seoul'` → `'대한민국'`, `'Asia/Ho_Chi_Minh'` → `'인도차이나'`.
 * 못 알아내면 id의 마지막 조각(`'Ho_Chi_Minh'` → `'Ho Chi Minh'`) — **id를 그대로 보여주는
 * 것보다 낫고, 지어내는 것은 아니다.**
 */
export function zoneLabel(instant: string, timeZone: string): string {
  const fallback = (timeZone.split('/').pop() ?? timeZone).replace(/_/g, ' ');
  const t = Date.parse(instant);
  if (Number.isNaN(t) || !timeZone) return fallback;
  try {
    const parts = new Intl.DateTimeFormat('ko', { timeZone, timeZoneName: 'long' }).formatToParts(new Date(t));
    const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    // 'ko'는 「대한민국 표준시」·「인도차이나 시간」처럼 꼬리를 붙인다. 꼬리를 떼면 짧아지고,
    // 꼬리가 없으면(예: 'GMT+7') 그대로 쓴다 — 손으로 표를 만들지 않는다.
    return name.replace(/\s*(표준시|하계 시간|여름 시간|시간)$/, '') || fallback;
  } catch {
    return fallback;
  }
}

/**
 * 🔴 **기억 시각을 화면에 내보내는 유일한 함수.** 순간·사진·소리·비용이 전부 이 문을 지난다.
 *
 * @param momentOffsetMin 이 항목에 **직접 적힌** 오프셋(EXIF `OffsetTimeOriginal` 또는 사용자
 *   예외). 없으면 `null`/`undefined` — 사다리가 여행 시간대로 내려간다.
 *
 * 폴백은 **기기 시간대**이고, 그때 `caveat`가 채워진다. 기기 시간대를 조용히 쓰는 것이
 * M-0049였다 — 이제 쓰긴 쓰지만 **말한다.**
 */
export function momentWhen(
  instant: string,
  momentOffsetMin: number | null | undefined,
  clock: TripClock,
): WhenView {
  const resolved = resolveOffsetMin(instant, momentOffsetMin, clock.zone);
  const basis: WhenBasis =
    typeof momentOffsetMin === 'number' && Number.isFinite(momentOffsetMin) ? 'moment' : resolved === null ? 'device' : 'trip';
  const offsetMin = resolved ?? zoneOffsetMin(instant, deviceZone()) ?? 0;
  const at = atOffset(instant, offsetMin);
  return {
    ...at,
    offsetMin,
    basis,
    home: at.time ? homeConversion(instant, offsetMin, clock.homeZone, zoneLabel(instant, clock.homeZone)) : '',
    caveat: basis === 'device' && at.time ? '여행 시간대를 정하지 않아 이 기기 시간대로 보여주고 있어요' : '',
  };
}

/**
 * 사용자가 **벽시계로 적은 값**(`datetime-local`)을 절대시각으로 바꿀 때 쓸 오프셋.
 *
 * `zoneOffsetAtWall`을 쓰는 이유: 입력값은 아직 절대시각이 아니라 벽시계라, 오프셋을
 * 「그 순간」으로 물으면 닭과 달걀이 된다. DST 경계를 그 함수가 두 번 재서 푼다.
 *
 * 시간대 미지정이면 기기 시간대로 읽는다 — 입력을 **거부하지 않는다**. 그 대신 화면이
 * 어느 시계로 적는 중인지 글자로 말한다(§13 — 추측은 해도 되지만 말해야 한다).
 */
export function clockOffsetAtWall(wall: string, clock: TripClock): number {
  return zoneOffsetAtWall(wall, clock.zone) ?? zoneOffsetAtWall(wall, deviceZone()) ?? 0;
}

/**
 * 입력 칸 아래 붙는 「어느 시계로 적는 중인가」 한 줄. **늘 말한다** — 이 자리는 침묵이
 * 정상이 아니다(사용자가 적는 숫자의 뜻이 시계에 달렸으므로).
 */
export function inputClockHint(instant: string, clock: TripClock): string {
  return clock.zone && isKnownZone(instant, clock.zone)
    ? `🕒 ${zoneLabel(instant, clock.zone)} 시각으로 적어요`
    : '🕒 이 기기 시간대로 적고 있어요 — 여행 시간대를 정하면 그곳 시각으로 바뀝니다';
}

/**
 * 고를 수 있는 시간대 목록 — **브라우저가 준다**(418개). 우리가 표를 들고 있지 않다.
 *
 * 지원하지 않는 브라우저에서는 빈 배열이고, 그때 화면은 **직접 입력**으로 받는다
 * (목록이 없다고 기능이 사라지지는 않는다).
 */
export function zoneOptions(): string[] {
  try {
    const f = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    return typeof f === 'function' ? f.call(Intl, 'timeZone') : [];
  } catch {
    return [];
  }
}

/**
 * **나라(ISO 3166-1 alpha-2) → 그 나라의 시간대들.** 브라우저가 준다 — **데이터셋 0바이트.**
 *
 * 사용자 제안(2026-07-30): *"여행시간대 초기값은 사진찍은 장소로 셋팅..어때?"*
 *
 * 좌표→시간대는 경계 데이터셋이 필요해 **하지 않는다**(수 MB). 그런데 사진 GPS를 이미
 * 역지오코딩해 **나라 코드**를 얻고 있고, 나라→시간대는 `Intl`이 알고 있다.
 * `'VN'` → `['Asia/Saigon']` · `'UZ'` → `['Asia/Samarkand','Asia/Tashkent']` · `'US'` → 29개.
 *
 * 🔴 **하나일 때만 답이다.** 여럿이면 고르는 것은 사용자다(§8 — 모르는 것을 반올림하지
 * 않는다). 화면은 후보를 위로 올려 주고 묻는다.
 *
 * 구현이 둘인 이유: 표준은 `getTimeZones()` 메서드인데 옛 구현은 `timeZones` **게터**다
 * (이 저장소의 Node 22가 게터, Chromium은 둘 다). 둘 다 없으면 빈 배열 — 기능이 조용히
 * 사라질 뿐 앱은 돈다.
 */
export function zonesForCountry(countryCode: string): string[] {
  const cc = countryCode.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return [];
  try {
    const loc = new Intl.Locale(`und-${cc}`) as Intl.Locale & {
      getTimeZones?: () => string[];
      timeZones?: string[];
    };
    const zs = typeof loc.getTimeZones === 'function' ? loc.getTimeZones() : loc.timeZones;
    return Array.isArray(zs) ? zs : [];
  } catch {
    return [];
  }
}

/** 이 문자열이 브라우저가 아는 시간대 id인가. 오프셋을 계산할 수 있으면 안다고 본다. */
export function isKnownZone(instant: string, timeZone: string): boolean {
  return zoneOffsetMin(instant, timeZone) !== null;
}

/**
 * 시간대 칸 옆에 붙는 미리보기 — 「지금 그곳은 21:08 (UTC+7)」.
 * 고른 것이 맞는지 **사용자가 눈으로 확인**할 수 있게 한다(id만 보고는 아무도 모른다).
 */
export function zonePreview(instant: string, timeZone: string): string {
  const off = zoneOffsetMin(instant, timeZone);
  if (off === null) return '';
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  const hhmm = a % 60 === 0 ? `${Math.floor(a / 60)}` : `${Math.floor(a / 60)}:${p2(a % 60)}`;
  return `지금 그곳은 ${atOffset(instant, off).time} (UTC${sign}${hhmm})`;
}
