// domain/media/order.ts — **한 순간 안의 사진 순서** (사용자 지시 2026-08-06).
//
// ── 왜 이 파일이 생겼나 ──────────────────────────────────────────────────────
// 🔴 **지금까지 사진에는 순서가 없었다.** 목록은 이랬다:
//
//     db().localMedia.where('tripId').equals(tripId).toArray()   // 정렬 없음
//
// id가 `uuid()`(무작위)라 화면에 보이는 순서는 **사실상 임의**였고, 기기마다 다를 수도
// 있었다 — 같은 순간을 폰과 태블릿에서 열면 사진이 다른 자리에 놓인다. 사용자가
// *"손가락으로 꾹 눌러서 순서를 변경할 수 있도록"*을 요청했을 때 먼저 필요한 것은
// 드래그가 아니라 **순서 그 자체**였다.
//
// ── 두 층으로 나눈 이유 ─────────────────────────────────────────────────────
//  · `sortOrder === null` — 아직 아무도 손대지 않은 순간. **촬영시각 순**이 자연스러운 기본값이다.
//  · `sortOrder`가 숫자 — 사용자가 **직접 정한** 순서. 이건 기계가 만든 값(촬영시각)을 이긴다.
//
// 🔴 그리고 **한 순간 안에서는 섞이지 않게** 한다: 사용자가 하나라도 옮기면 그 순간의
// 사진 **전부**에 번호를 다시 매긴다(`renumber`). 섞인 상태는 「일부는 시간순, 일부는 내 순서」라
// 사용자가 규칙을 예측할 수 없고, 그건 §7의 「형제 차별」과 같은 형태다.
//
// ── 시각 비교는 반드시 `compareInstants` ────────────────────────────────────
// 🔴 문자열 대소로 시각을 비교하면 **표기가 다른 같은 순간**이 다르게 읽힌다 — 이 저장소는
// 그걸로 멀쩡한 사진 9건을 「시간 역전」이라 부른 적이 있다(M-0034). 서버는 `…48.34+00:00`,
// 로컬은 `…48.340Z`로 같은 순간을 다르게 적는다.

import { compareInstants } from '../time';

/** 정렬에 필요한 최소 모양 — 블롭까지 끌고 오지 않는다(유닛이 가벼워야 갈래를 다 돈다). */
export interface OrderableMedia {
  id: string;
  /** 사용자가 정한 자리. `null`이면 아직 안 정했다는 뜻이지 0이 아니다(§8 · M-0057). */
  sortOrder: number | null;
  /** EXIF 촬영시각 또는 파일 mtime(ISO). */
  takenAt: string;
}

/**
 * 한 순간의 사진을 화면에 놓을 순서로 정렬한다. **원본 배열을 바꾸지 않는다.**
 *
 * 규칙(위에서부터 이긴다):
 *  ① 사용자가 정한 자리(`sortOrder`)가 있으면 그 순서. 없는 것은 뒤로 — **새로 넣은 사진이
 *     맨 뒤에 붙는다.** 중간에 끼어들면 사용자가 정해 둔 배열이 소리 없이 흐트러진다.
 *  ② 둘 다 없으면 **촬영시각** 순(오래된 것부터 — 그날의 흐름이 그 순서다).
 *  ③ 시각까지 같거나 비교할 수 없으면 `id` — **결정적**이어야 기기마다 같은 화면이 나온다.
 */
export function orderPhotos<T extends OrderableMedia>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const ao = a.sortOrder;
    const bo = b.sortOrder;
    if (ao !== null && bo !== null && ao !== bo) return ao - bo;
    if (ao !== null && bo === null) return -1;
    if (ao === null && bo !== null) return 1;
    // 🔴 문자열 대소가 아니라 **의미 단위**로 비교한다(M-0034). 비교 불가면 다음 기준으로.
    const t = compareInstants(a.takenAt, b.takenAt);
    if (t !== null && t !== 0) return t;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * 배열에서 한 항목을 다른 자리로 옮긴다 — 드래그가 끝났을 때 쓰는 순수 연산.
 *
 * 범위 밖 인덱스는 **조용히 자르지 않고 그대로 돌려준다**: 잘못된 입력을 「그럴듯한 결과」로
 * 바꾸면 그 결함이 화면까지 살아서 간다(§8 — 모르는 것을 반올림하지 않는다).
 */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}

/**
 * 옮긴 뒤의 순서를 **번호로 굳힌다** — 그 순간의 사진 전부에 0부터 다시 매긴다.
 *
 * 🔴 왜 전부인가: 옮긴 하나만 번호를 주면 나머지는 `null`로 남아 「일부는 내 순서, 일부는
 * 촬영시각」이 된다. 그 상태의 규칙은 사용자가 예측할 수 없고, 사진을 하나 더 넣으면
 * 배열이 또 달라진다. **한 번 손대면 그 순간은 전부 사용자 것**이다.
 */
export function renumber(orderedIds: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  orderedIds.forEach((id, i) => m.set(id, i));
  return m;
}

/**
 * 드래그 중 **지금 놓으면 몇 번째가 되는가** — 포인터 좌표를 항목 사각형들과 대조한다.
 *
 * 🔴 **뜻을 하나로 못박는다**: 돌려주는 값은 `moveItem(list, from, to)`의 `to`와 **같은 뜻**,
 * 즉 *"옮긴 뒤 이 항목이 앉을 자리"*다. 처음엔 「이 항목 **앞에** 끼운다」로 짰다가 두 뜻이
 * 섞여 유닛이 RED로 잡았다 — 같은 이름이 두 가지를 뜻하면 그건 결함의 씨앗이다(M-0060).
 * 그래서 규칙은 한 줄이다: **포인터가 올라가 있는 칸의 번호.**
 *
 * 순수 함수인 이유: 이 계산이 DOM 이벤트 핸들러 안에 있으면 갈래를 검사할 수 없다.
 * 화면에서만 드러나는 계산이 이 저장소의 최빈 결함군이다(§10 ③).
 */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 한 칸을 원래 자리에서 얼마나 밀어야 하는가(px). `{0,0}`이면 그대로 있는다. */
export interface Offset {
  dx: number;
  dy: number;
}

/**
 * 🔴 **끄는 동안 다른 칸들이 실제로 비켜서는 자리**(사용자 요청 2026-08-06:
 * *"이동하는 느낌이 나게 해줄 순 있나요?"*).
 *
 * 예전 판은 놓일 칸에 **테두리만** 그렸다. 자리는 알려 주지만 *들고 가는 느낌*이 없어서,
 * 사용자는 손을 떼기 전까지 「내가 지금 무엇을 하고 있는지」를 그림으로 확인할 수 없었다.
 *
 * ── 왜 순수 함수인가 ────────────────────────────────────────────────────────
 * 🔴 이 계산이 이벤트 핸들러 안에 있으면 **좌표계가 섞이는 것을 아무도 못 본다.** 이 저장소는
 * 정확히 그걸로 한 번 넘어졌다(M-0115의 곁가지 — `style.order`로 밀었더니 *화면 순서*와
 * *DOM 순서*가 갈라졌다). 그래서 규칙을 한 줄로 못박는다:
 *
 *   **`rects`는 「아무것도 밀지 않은 상태」의 자리다. 그 좌표계는 드래그 내내 바뀌지 않는다.**
 *
 * 밀린 칸을 다시 재서 넣으면 자기 출력이 자기 입력이 되어(피드백) 칸이 떨린다. 호출자는
 * 드래그가 **시작될 때 한 번** 잰 사각형을 끝까지 쓰고, `dropIndex`도 **같은 배열**로 판정한다.
 *
 * ── 규칙 ────────────────────────────────────────────────────────────────────
 * `from`이 빠져나가고 `to`에 앉으면, 그 사이 칸들이 **한 칸씩 당겨지거나 밀린다.**
 * 끌리는 칸(`from`) 자신은 `{0,0}`이다 — 그건 손가락이 정하지 여기서 정하지 않는다.
 */
export function shiftOffsets(rects: readonly Rect[], from: number, to: number): Offset[] {
  const still = rects.map(() => ({ dx: 0, dy: 0 }));
  const n = rects.length;
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return still;
  return rects.map((r, i) => {
    // 끌리는 칸은 포인터를 따라간다 — 여기서 자리를 정하면 손가락과 싸운다.
    if (i === from) return { dx: 0, dy: 0 };
    const slot = i > from && i <= to ? i - 1 : i >= to && i < from ? i + 1 : i;
    if (slot === i) return { dx: 0, dy: 0 };
    const s = rects[slot]!;
    return { dx: s.left - r.left, dy: s.top - r.top };
  });
}

export function dropIndex(rects: readonly Rect[], x: number, y: number, fallback: number): number {
  if (!rects.length) return fallback;
  // 격자가 여러 줄로 접히므로 **같은 줄**부터 고른다 — 안 그러면 다른 줄의 칸과 x를 견준다.
  const sameRow = rects.map((r, i) => ({ r, i })).filter(({ r }) => y >= r.top && y <= r.bottom);
  if (sameRow.length) {
    const over = sameRow.find(({ r }) => x >= r.left && x <= r.right);
    if (over) return over.i;
    // 줄 안이지만 칸 사이(간격)나 끝 바깥 — 그 줄의 첫/마지막 칸으로 붙인다.
    const first = sameRow[0]!;
    const last = sameRow[sameRow.length - 1]!;
    return x < first.r.left ? first.i : last.i;
  }
  // 줄 사이거나 격자 바깥 — 아래로 끌었으면 마지막, 위로 끌었으면 첫 칸.
  const above = rects.filter((r) => r.bottom < y).length;
  return above ? rects.length - 1 : 0;
}
