// domain/placeZombieVerdict.ts — 삭제 뒤 새 UUID로 다시 생긴 장소 후보를 분류한다.
//
// 이름만 같다고 같은 장소로 단정하지 않는다. 이 판정은 "삭제 표식"과 "활성 행"이
// 정규화한 이름 및 6자리 좌표까지 같은 경우만 후보로 남긴다. 그래도 사용자가 같은 곳을
// 의도적으로 다시 등록했을 가능성은 있으므로, 이 함수는 삭제 결정을 내리지 않는다.

export interface PlaceZombieRow {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  deletedAt: string | null;
  updatedAt: string;
}

export interface PlaceZombieCandidate {
  /** 현재 활성인 새 행. 삭제 대상이라는 뜻은 아니며, 사용자가 확인할 후보다. */
  activeId: string;
  /** 같은 이름·좌표로 남아 있는 삭제 표식들. */
  deletedIds: string[];
}

function keyOf(row: PlaceZombieRow): string | null {
  const name = row.name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  if (!name || !Number.isFinite(row.latitude) || !Number.isFinite(row.longitude)) return null;
  // 장소 대장의 표시 정밀도보다 충분히 촘촘하면서 부동소수점 저장 오차는 흡수한다.
  return `${name}|${row.latitude.toFixed(6)}|${row.longitude.toFixed(6)}`;
}

/**
 * 삭제 표식이 남아 있는 같은 장소가 새 활성 UUID로 재등록된 후보를 찾는다.
 *
 * 반환 단위는 "활성 행" 하나다. 같은 활성 행에 삭제 표식이 여럿 있어도 한 후보로
 * 묶어 중복 경보를 만들지 않는다.
 */
export function findPlaceZombieCandidates(rows: readonly PlaceZombieRow[]): PlaceZombieCandidate[] {
  const deletedByKey = new Map<string, string[]>();
  const active: { id: string; key: string }[] = [];

  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    if (row.deletedAt === null) active.push({ id: row.id, key });
    else {
      const ids = deletedByKey.get(key) ?? [];
      ids.push(row.id);
      deletedByKey.set(key, ids);
    }
  }

  return active
    .flatMap(({ id, key }) => {
      const deletedIds = deletedByKey.get(key);
      return deletedIds?.length ? [{ activeId: id, deletedIds: [...deletedIds].sort() }] : [];
    })
    .sort((a, b) => a.activeId.localeCompare(b.activeId));
}
