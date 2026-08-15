/**
 * 동행인 — **한 덩어리 문자열을 사람 단위로 읽는 유일한 곳**(사용자 지시 2026-08-15).
 *
 * ── 왜 저장 형태를 안 바꾸는가 (ADR-0074) ────────────────────────────────────
 * 사용자가 요청했다: *"함께한 사람은 한명단위로 입력할 수 있게… 그 사람 배지를 누르면
 * 그 사람과 함께한 사진들을 별도 창으로 로딩해서 보면 좋겠다."*
 *
 * 🔴 **이건 §7이 이미 요구하던 것이다.** 장소는 배지를 누르면 「이 장소가 담긴 기록」 창이
 * 열려 순간·사진이 다 나온다(`placeRegistry.ts`). **동행인만 그 대칭을 못 받고 있었다** —
 * 「아직 안 한 것」이 아니라 **차별한 것**이고, §7은 그것을 결함이라 부른다.
 *
 * **그런데 사람을 새 엔티티로 만들지는 않는다.** 연구노트에 *"동행인은 아직 독립 인물
 * 원장이 없는 범위이므로 순간 소유의 `companionNames`로 두되"*라는 결정이 이미 적혀 있고
 * (§16 ⑥ — 코드에 적힌 설계 판단을 다시 하지 않는다), 새 형제를 만들면 헌법대로
 * **원자 커밋·rowmap/OCC·read-back·정확집합·tombstone·복원·영구삭제·백업·진단·릴리스
 * 분류를 전부 상속**해야 한다 — 화면에서 얻는 것은 같은데 가장 위험한 표면을 건드린다.
 *
 * 그래서 **저장은 그대로 두고 읽을 때 쪼갠다.** 마이그레이션 0건, 동기화 변경 0건.
 *
 * 🔴 **대신 정직해야 할 한계가 하나 있다**: 사람의 동일성은 **적은 글자**로만 판정된다.
 * 「러원이」와 「러원」은 기계에겐 남남이다. 이 파일은 그것을 **숨기지 않고**, 화면이
 * 사용자에게 그렇게 말하게 한다(§8 — 모르는 것을 아는 척하지 않는다). 이름을 합치는 일은
 * 인물 원장이 생겨야 풀리고, 그때가 오면 이 함수의 호출부만 갈아끼우면 된다.
 */

/** 사람 사이 구분자. 쉼표(반각·전각)와 가운뎃점 — 한국어 입력에서 실제로 섞여 들어온다. */
const SEPARATORS = /[,，·]/;

/**
 * 저장된 한 덩어리를 **사람 목록**으로 읽는다.
 *
 * - 앞뒤 공백을 버리고, 빈 조각은 사람이 아니므로 뺀다.
 * - 🔴 **같은 이름이 두 번 나오면 한 번만 센다** — 안 그러면 칩이 두 개 그려지고
 *   「이 사람과 함께한 기록」이 같은 순간을 두 번 세게 된다.
 * - 🔴 **순서는 사용자가 적은 순서 그대로 둔다.** 가나다순으로 정렬하고 싶은 유혹이 있지만,
 *   사용자가 적은 순서에는 뜻이 있을 수 있고(누구와 주로 다녔는지) 그것을 지어낸 순서로
 *   덮을 이유가 없다.
 */
export function parseCompanions(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of raw.split(SEPARATORS)) {
    const name = piece.trim();
    if (!name) continue;
    const key = companionKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * 두 이름이 **같은 사람인가**를 판정할 때 쓰는 열쇠.
 *
 * 🔴 **여기서 하는 일은 딱 둘뿐이다**: 대소문자를 무시하고, 안쪽 공백을 하나로 줄인다.
 * 그 이상(별명 짐작·부분 일치)은 **하지 않는다** — 「러원이」와 「러원」을 같다고 묶는 순간
 * 「김민수」와 「김민수아버지」도 묶이고, 그건 사용자의 기억을 앱이 지어내는 것이다
 * (비타협 원칙 #2 — 사용자 기록과 AI/기계 생성물을 섞지 않는다).
 */
export function companionKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ko-KR');
}

/** 사람 목록을 저장 형태(한 덩어리)로 되돌린다. 저장 계약은 예전 그대로다. */
export function formatCompanions(names: readonly string[]): string {
  return names.join(', ');
}

/**
 * 목록에 이름을 더한다 — **이미 있으면 그대로 둔다**(토큰 입력이 쓴다).
 * 반환은 새 배열이다: 부르는 쪽이 원본을 들고 있어도 조용히 바뀌지 않는다.
 */
export function addCompanion(names: readonly string[], raw: string): string[] {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name) return [...names];
  // 🔴 구분자가 든 채로 붙여넣는 경우(예: 「아빠, 엄마」)를 한 사람으로 만들지 않는다.
  //    사용자가 목록을 통째로 붙여넣는 것은 흔한 일이고, 그걸 이름 하나로 저장하면
  //    「이 사람과 함께한 기록」이 영영 0건이 된다.
  if (SEPARATORS.test(name)) {
    let out = [...names];
    for (const piece of parseCompanions(name)) out = addCompanion(out, piece);
    return out;
  }
  const seen = new Set(names.map(companionKey));
  return seen.has(companionKey(name)) ? [...names] : [...names, name];
}

/** 목록에서 한 사람을 뺀다(칩의 ✕가 쓴다). */
export function removeCompanion(names: readonly string[], raw: string): string[] {
  const key = companionKey(raw);
  return names.filter((n) => companionKey(n) !== key);
}

/** 이 순간이 그 사람과 함께한 것인가. 판정을 한 곳에 둬 화면마다 갈라지지 않게 한다(§7 2층). */
export function momentHasCompanion(companionNames: string | null | undefined, person: string): boolean {
  const key = companionKey(person);
  return parseCompanions(companionNames).some((n) => companionKey(n) === key);
}

/**
 * 여러 순간에서 **사람 목록과 각자의 등장 횟수**를 뽑는다.
 *
 * 🔴 **표시 이름은 「가장 많이 쓰인 표기」를 고른다.** 같은 사람을 「러원이」로 아홉 번,
 * 「러원이 」로 한 번 적었다면 화면에는 아홉 번 쪽이 나와야 한다 — 지어낸 이름이 아니라
 * **사용자가 실제로 가장 많이 쓴 글자**다. 동률이면 먼저 나온 것이 이긴다(안정적).
 */
export function companionTally(
  moments: readonly { companionNames?: string | null }[],
): { name: string; count: number }[] {
  const byKey = new Map<string, { count: number; spellings: Map<string, number> }>();
  for (const m of moments) {
    for (const name of parseCompanions(m.companionNames)) {
      const key = companionKey(name);
      const entry = byKey.get(key) ?? { count: 0, spellings: new Map<string, number>() };
      entry.count += 1;
      entry.spellings.set(name, (entry.spellings.get(name) ?? 0) + 1);
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()]
    .map((entry) => {
      let best = '';
      let bestCount = -1;
      for (const [spelling, n] of entry.spellings) {
        if (n > bestCount) { best = spelling; bestCount = n; }
      }
      return { name: best, count: entry.count };
    })
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ko-KR'));
}
