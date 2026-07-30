// domain/moment/whenDefault.ts — **순간의 발생 시각을 무엇으로 채울 것인가**, 그리고
// **그 근거를 어떻게 말할 것인가**. 순수 함수라 유닛이 모든 갈래를 직접 돌린다(§10 ③).
//
// ── 왜 필요했나 (2026-07-27 사용자 실기기) ────────────────────────────
// 순간 생성 폼에 시각 칸이 **아예 없었다.** `occurredAt`은 조용히 `now`로 찍혔다.
// 사용자가 물었다 — *"입력단계에서 날짜와 시간을 지정하는 필드가 없네요."*
//
// 그런데 진짜 문제는 칸이 없는 게 아니라 **값이 조용히 틀린다**는 것이었다:
// 7/16~19 여행을 7/27에 정리하면 순간이 전부 **7/27**로 찍힌다. 사진 파일 이름은
// EXIF에서 `20260716_…`을 쓰는데 그 사진이 달린 순간은 7/27 — 앱이 자기 안에서
// 서로 다른 말을 한다. 타임라인은 여행 기간 **밖**에 카드를 놓는다.
//
// ── 설계를 정한 한 문장 ───────────────────────────────────────────────
// > *"순간 저장도 의미있지만 **사후에 소급하는 경우가 더 많아요**."* (사용자)
//
// 그 말이 무게중심을 옮겼다. 소급이 주 흐름이면 `지금`은 기본값이 아니라 **거의 항상
// 틀린 값**이다. 그리고 시각 칸을 접어 두면(펼쳐야 보이면) 매번 펼쳐야 하므로 마찰이 된다.
//
// ── 규율: 추측했으면 **무엇을 근거로 추측했는지 말한다** ──────────────
// 앱이 값을 골라 주는 것과 사용자가 그 값을 믿는 것은 다르다. 근거를 화면에 적어야
// 틀렸을 때 알아챈다(비타협 원칙 #4 — 모르는 것을 정상으로 반올림하지 않는다).
// 그래서 이 함수는 시각만이 아니라 **`source`와 사람이 읽는 라벨**을 함께 돌려준다.

import { atOffset, wallClockToInstant, compareInstants } from '../time';

/** 시각을 어디서 가져왔는가. 화면이 이 값으로 아이콘·문구를 고른다. */
export type WhenSource = 'photo' | 'previous' | 'tripStart' | 'now';

export interface WhenGuess {
  /** 채워 넣을 발생 시각(ISO). */
  at: string;
  source: WhenSource;
  /** 화면에 그대로 붙는 한 줄. **근거 + 값**을 함께 말한다. */
  label: string;
}

export interface WhenInput {
  /** 이번에 고른 사진들의 EXIF 촬영시각(ISO). 없으면 빈 배열. */
  photoTakenAts: string[];
  /** 이 여행에서 **직전에 저장한** 순간의 발생 시각. 없으면 null. */
  previousOccurredAt: string | null;
  /** 여행 시작일 `YYYY-MM-DD`. 없으면 null. */
  tripStartDate: string | null;
  /** 지금(ISO). **주입받는다** — 순수하게 유지해야 유닛이 모든 갈래를 돌릴 수 있다. */
  now: string;
  /**
   * **여행지 오프셋(분).** 이 값으로 근거 문장의 시각을 적고 여행 시작일 자정을 만든다.
   *
   * 왜 인자인가: 기본값을 두면 `0`(UTC)이나 기기 시간대가 조용히 섞이고, 그게 M-0049였다.
   * 화면은 `momentWhen(...).offsetMin`을 그대로 넘긴다 — 그러면 **입력 칸과 타임라인이
   * 같은 자로 잰다.**
   */
  offsetMin: number;
}

/**
 * ISO → 사람이 읽는 `YYYY-MM-DD HH:MM`, **그 자리 기준**.
 *
 * 옛 판은 인자가 하나였고 기기 시간대로 적었다. 그래서 베트남 여행을 한국에서 정리하면
 * 근거 줄이 「📷 사진에서 · 2026-07-29 21:08」이라 말하는데 타임라인은 19:08을 보였다 —
 * **같은 값을 두 자로 잰 것**이고, 사용자에게는 앱이 자기 안에서 다른 말을 하는 것으로 보인다.
 */
export function humanWhen(iso: string, offsetMin: number): string {
  const { date, time } = atOffset(iso, offsetMin);
  return date ? `${date} ${time}` : '(시각 없음)';
}

/**
 * 이 여행에서 **가장 늦은 발생 시각** — 다음 순간의 기본값이 물려받을 값(우선순위 2).
 *
 * 순수 함수로 뽑은 이유가 둘이다. ①`renderTripDetail` 안의 한 줄이면 유닛이 못 닿는다
 * (§10 ③ — M-0022가 그 자리였다). ②비교를 **순간으로** 해야 하는데(M-0034), 그 규율이
 * 화면 코드에 흩어져 있으면 다음 사람이 무심코 `>`로 되돌린다.
 *
 * 목록은 정렬돼 있지 않을 수 있으므로 최댓값을 고른다. 못 읽는 값은 이기지 못한다.
 */
export function latestOccurredAt(moments: { occurredAt: string }[]): string | null {
  let best: string | null = null;
  for (const m of moments) {
    if (Number.isNaN(Date.parse(m.occurredAt))) continue; // 지어낸 값이 기준이 되지 않게
    if (best === null || (compareInstants(m.occurredAt, best) ?? 0) > 0) best = m.occurredAt;
  }
  return best;
}

/** 유효한 ISO만 남긴다. 파싱 안 되는 값은 **버린다** — 지어낸 시각으로 정렬하지 않는다. */
function validTimes(list: string[]): number[] {
  return list.map((s) => Date.parse(s)).filter((t) => !Number.isNaN(t));
}

/**
 * 발생 시각의 기본값과 **그 근거**를 고른다.
 *
 * 우선순위와 이유:
 *  1. **사진의 EXIF 촬영시각** — 소급이든 실시간이든 가장 강한 근거다. 사용자가 이미
 *     사진을 골랐고 **그 사진이 시각을 알고 있다.** 앱이 아는 것을 사람에게 묻지 않는다(§12).
 *     여러 장이면 **가장 이른 것**을 쓴다: 그 순간의 *시작*이 그 순간이다.
 *     평균·중앙값은 **실제로 존재하지 않은 시각을 지어내는** 것이라 쓰지 않는다.
 *  2. **직전 순간과 같은 시각** — 소급 입력은 순차적이다(첫날부터 차례로). 날짜를 아홉 번
 *     다시 고르게 하지 않는다. 시각까지 물려주고 **사용자가 시각만 고치게** 한다.
 *  3. **여행 시작일 00:00** — `00:00`은 이 저장소에서 이미 *"시각을 모른다"*의 표시다
 *     (사진 파일명 폴백이 `00000000_0000`인 것과 같은 어휘). 명백히 미정으로 읽히므로
 *     그럴듯한 시각을 지어내는 것보다 정직하다.
 *  4. **지금** — 여행 날짜조차 없을 때의 마지막 수단.
 */
export function guessOccurredAt(i: WhenInput): WhenGuess {
  const say = (at: string): string => humanWhen(at, i.offsetMin);
  const photo = validTimes(i.photoTakenAts);
  if (photo.length > 0) {
    const at = new Date(Math.min(...photo)).toISOString();
    const many = photo.length > 1 ? ` (${photo.length}장 중 가장 이른 것)` : '';
    return { at, source: 'photo', label: `📷 사진에서 · ${say(at)}${many}` };
  }

  if (i.previousOccurredAt && !Number.isNaN(Date.parse(i.previousOccurredAt))) {
    const at = i.previousOccurredAt;
    return { at, source: 'previous', label: `⬆ 직전 순간과 같은 시각 · ${say(at)}` };
  }

  if (i.tripStartDate && /^\d{4}-\d{2}-\d{2}$/.test(i.tripStartDate)) {
    // **여행지의** 자정이다. 기기 자정(`new Date(y, m-1, d)`)으로 만들면 시간대가 다를 때
    // 여행 시작일 00:00이 전날 22:00 같은 값이 되어 Day 묶음이 하루 앞으로 새어 나간다.
    const at = wallClockToInstant(`${i.tripStartDate}T00:00:00`, i.offsetMin);
    if (at) return { at, source: 'tripStart', label: `📅 여행 시작일 · ${say(at)} — 시각을 정해 주세요` };
  }

  return { at: i.now, source: 'now', label: `⏱ 지금 · ${say(i.now)}` };
}

/**
 * **여행 기간 밖인가** — 막지 않고 말만 한다.
 *
 * 왜 막지 않나: 소급 입력이 주 흐름이라(사용자 2026-07-27) 기간 밖 입력을 막으면 *지난
 * 여행을 나중에 정리하는* 흐름 자체가 막힌다. 그리고 여행 날짜 자체가 대략일 수 있다.
 *
 * 왜 그래도 말하나: 조용히 두면 타임라인이 이상해지는데 앱은 아무 말도 안 한다 —
 * 이 저장소가 계속 고쳐온 바로 그 형태다(M-0021·M-0028).
 *
 * @returns 경고 문장. 기간 안이거나 판단할 수 없으면 **null**(모르면 말하지 않는다).
 */
export function outsideTripWarning(
  occurredAt: string,
  startDate: string | null,
  endDate: string | null,
  offsetMin: number,
): string | null {
  const t = Date.parse(occurredAt);
  if (Number.isNaN(t)) return null;
  // **여행지 기준** 날짜로 잰다 — 여행 시작·종료일도 그 자리의 달력이므로 같은 자여야 한다.
  // 기기 기준으로 재면 시간대가 다를 때 첫날/마지막날 순간이 「기간 밖」으로 잘못 경고된다.
  const day = atOffset(occurredAt, offsetMin).date;
  if (!day) return null;
  // 한쪽만 있어도 그쪽은 판정한다 — 있는 근거는 쓴다.
  if (startDate && day < startDate) return `이 여행 기간(${startDate} ~ ${endDate ?? '미정'}) 이전이에요`;
  if (endDate && day > endDate) return `이 여행 기간(${startDate ?? '미정'} ~ ${endDate}) 이후예요`;
  return null;
}
