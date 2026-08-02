// services/places.ts — **장소 라이브러리의 저장·수정·삭제·복원.** 로컬 우선·내구성 커밋·read-back.
//
// ── 형제의 규율을 물려받는다 (§7 · M-0033) ────────────────────────────
// 새 도메인은 **기존 형제가 지키는 계약을 자동으로 물려받지 않는다.** 그래서 `npm run brief`의
// 형제 목록을 놓고 한 줄씩 대조했다(오디오가 다섯 곳을 동시에 비운 그 사고를 반복하지 않게):
//
//  · 내구성 커밋 + read-back      → add/put 후 되읽어 확인
//  · 🔴 엔티티와 op은 **한 트랜잭션** → 아래 전부(M-0033 — 나누면 조용한 유실 창이 생긴다)
//  · tombstone 전용 삭제 + 복원   → `softDeletePlace`/`restorePlace` **쌍**
//                                    (`check-domain-symmetry`가 이 대칭을 강제한다)
//  · 변경마다 큐 op               → `placeOp` — 형제 다섯과 같은 형태
//  · 시각 표기                    → 로컬 생성이라 `toISOString()`이 곧 정규형(M-0034)
//  · 백업 export/import          → 별도 테이블이라 `check-backup-coverage`가 강제한다
//  · 휴지통·영구삭제               → `trash.ts`·`purge.ts`에 장소 항목을 **함께** 넣었다
//
// ── 🔴 의도적 비대칭: 장소는 여행의 자식이 아니다 ──────────────────────
// 형제 넷은 순간/여행이 지워지면 cascade로 함께 tombstone된다. 장소는 **그러지 않는다.**
// 한 장소는 여러 여행에 걸치고, 작년 여행을 지웠다고 그 카페를 잊어야 할 이유가 없다.
// 이 판단은 설계 단계에서 내렸고 이유를 여기·`db.ts`·마이그레이션 0022 **세 곳에** 적어 둔다
// — §7이 요구하는 것은 대칭이 기본값이고 **비대칭에는 심사와 기록이 있어야 한다**는 것이다.
// (안 적으면 다음 사람이 "형제들처럼" cascade를 붙이고, 그 순간 사용자의 장소가 조용히 사라진다.)

import { db, type LocalPlace, type SyncQueueItem } from '../offline/db';
import { providerKeyOf } from '../domain/place/rowmap';
import { roughDistanceMeters } from '../domain/place/provider';
import { compareInstants } from '../domain/time';

const uuid = (): string => crypto.randomUUID();

/**
 * 'place' 동기화 op 하나 — 형제(`audioOp`·`mediaOp`)와 **같은 모양**이다.
 *
 * 여기서 만드는 `entityType`이 `sync.ts`의 `pushPendingPlaces`가 고르는 값이고, 다른 도메인
 * push 루프가 자연히 건너뛰는 값이기도 하다.
 */
export function placeOp(
  operationId: string,
  entityId: string,
  operationType: SyncQueueItem['operationType'],
  createdAt: string,
): SyncQueueItem {
  return { operationId, entityType: 'place', entityId, operationType, state: 'local_only', attempts: 0, createdAt };
}

/** 새 장소를 만들 때 필요한 값. 좌표는 필수 — 좌표 없는 장소는 라이브러리에 담지 않는다. */
export interface NewPlace {
  name: string;
  latitude: number;
  longitude: number;
  formattedAddress?: string | null;
  provider?: string | null;
  providerPlaceId?: string | null;
  countryCode?: string | null;
  country?: string | null;
  region?: string | null;
  city?: string | null;
  district?: string | null;
  postcode?: string | null;
  category?: string | null;
  memo?: string | null;
  precision?: string | null;
  spanMeters?: number | null;
  mapPicked?: boolean;
}

/** 같은 곳으로 볼 거리(m) — 제공자 id가 없을 때의 판정 기준. `provider.ts`와 같은 자를 쓴다. */
const SAME_PLACE_METERS = 60;

/**
 * 이미 담아 둔 같은 장소를 찾는다(활성만).
 *
 * 두 단계로 본다:
 *  ① **제공자 id가 같으면 같은 곳이다.** 가장 강한 근거 — 이름이나 좌표가 조금 달라도 같다.
 *  ② id가 없으면(지도로 찍은 곳 등) **이름이 같고 가까울 때만** 같은 곳으로 본다.
 *     이름만으로 접으면 안 된다 — 「대학로」는 여러 도시에 있고, 그 구분이 원래 신고의 절반이었다.
 */
export async function findExistingPlace(input: {
  name: string;
  latitude: number;
  longitude: number;
  provider?: string | null;
  providerPlaceId?: string | null;
}): Promise<LocalPlace | null> {
  const d = db();
  const key = providerKeyOf(input.provider ?? null, input.providerPlaceId ?? null);
  if (key) {
    const hit = await d.localPlaces.where('providerKey').equals(key).toArray();
    const active = hit.find((p) => p.deletedAt === null);
    if (active) return active;
  }
  const all = await d.localPlaces.toArray();
  const target = { lat: input.latitude, lng: input.longitude };
  return (
    all.find(
      (p) =>
        p.deletedAt === null &&
        p.name === input.name &&
        roughDistanceMeters({ lat: p.latitude, lng: p.longitude }, target) <= SAME_PLACE_METERS,
    ) ?? null
  );
}

/**
 * 장소를 라이브러리에 담는다 — **이미 있으면 그것을 돌려준다**(멱등).
 *
 * 왜 멱등인가: 사용자는 같은 카페를 열 번 고른다. 그때마다 새 행을 만들면 라이브러리가
 * 쓰레기가 되고, 「이 근처에서 뭘 했더라」가 같은 점 열 개를 겹쳐 보여준다.
 */
export async function savePlace(input: NewPlace): Promise<LocalPlace> {
  const name = input.name.trim();
  if (!name) throw new Error('장소 이름이 비어 있습니다');
  if (!Number.isFinite(input.latitude) || !Number.isFinite(input.longitude)) {
    throw new Error('장소 좌표가 올바르지 않습니다');
  }

  const existing = await findExistingPlace({ ...input, name });
  if (existing) return existing;

  const now = new Date().toISOString(); // 로컬 생성 → 이미 정규 표기(M-0034)
  const opId = uuid();
  const provider = input.provider ?? null;
  const providerPlaceId = input.providerPlaceId ?? null;
  const key = providerKeyOf(provider, providerPlaceId);
  const row: LocalPlace = {
    id: uuid(),
    name,
    formattedAddress: input.formattedAddress ?? null,
    provider,
    providerPlaceId,
    ...(key ? { providerKey: key } : {}),
    countryCode: input.countryCode ?? null,
    country: input.country ?? null,
    region: input.region ?? null,
    city: input.city ?? null,
    district: input.district ?? null,
    postcode: input.postcode ?? null,
    category: input.category ?? null,
    memo: input.memo ?? null,
    longitude: input.longitude,
    latitude: input.latitude,
    precision: input.precision ?? null,
    spanMeters: input.spanMeters ?? null,
    mapPicked: input.mapPicked === true,
    version: 1,
    baseVersion: 0,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    clientOperationId: opId,
  };

  const d = db();
  // 행과 op은 **한 트랜잭션**이다 — 둘 중 하나만 남는 창을 만들지 않는다(M-0033).
  await d.transaction('rw', d.localPlaces, d.syncQueue, async () => {
    await d.localPlaces.add(row);
    await d.syncQueue.add(placeOp(opId, row.id, 'insert', now));
  });

  // **read-back으로 확인한 뒤에야 성공이다.** 예외가 없다는 것은 저장의 증거가 아니다.
  const back = await d.localPlaces.get(row.id);
  if (!back) throw new Error('내구성 커밋 확인 실패: 장소 read-back 불일치');
  return back;
}

/** 담아 둔 장소 목록(활성만, 최근 갱신 순). */
export async function listPlaces(): Promise<LocalPlace[]> {
  const rows = await db().localPlaces.toArray();
  // 시각 비교는 **문자열 대소가 아니라** compareInstants다(M-0034 — 서버는 `…48.34+00:00`,
  // 로컬은 `…48.340Z`로 같은 순간을 다르게 적는다). 최근 갱신 순이므로 역순.
  // compareInstants는 **파싱 실패 시 null**이다(모르는 것을 0으로 반올림하지 않는다).
  // 정렬 비교자는 숫자를 요구하므로, 못 재면 0(순서 유지)으로 둔다 — 순서를 지어내지 않는다.
  return rows
    .filter((p) => p.deletedAt === null)
    .sort((a, b) => compareInstants(b.updatedAt, a.updatedAt) ?? 0);
}

/**
 * 좌표 근처의 장소(가까운 순).
 *
 * 서버에는 PostGIS + GiST 인덱스가 있지만(0022), **로컬은 전수 스캔이다.** 개인 앱 규모
 * (장소 수백 건)에서 전수 스캔은 밀리초이고, 로컬에 공간 인덱스를 흉내 내는 복잡도는
 * 그 이득에 비해 비싸다. 오프라인에서도 답이 나오는 것이 더 중요하다(원칙: 로컬 우선).
 */
export async function placesNear(
  center: { lat: number; lng: number },
  radiusMeters: number,
): Promise<{ place: LocalPlace; distanceMeters: number }[]> {
  const rows = await listPlaces();
  return rows
    .map((place) => ({
      place,
      distanceMeters: Math.round(roughDistanceMeters({ lat: place.latitude, lng: place.longitude }, center)),
    }))
    .filter((r) => r.distanceMeters <= radiusMeters)
    .sort((a, b) => a.distanceMeters - b.distanceMeters);
}

/** 수정 가능한 칸. 이름·메모·분류와 **좌표**(사용자가 지도에서 고쳐 확정할 수 있다). */
export interface PlacePatch {
  name?: string;
  memo?: string | null;
  category?: string | null;
  latitude?: number;
  longitude?: number;
  precision?: string | null;
  spanMeters?: number | null;
  mapPicked?: boolean;
}

/**
 * 장소를 고친다.
 *
 * 🔴 **이 수정은 과거 순간의 기록을 바꾸지 않는다.** 순간은 자기 `placeName`/좌표를 그대로
 * 갖고 있고(마이그레이션 0022 설계 결정 1), 여기서 고치는 것은 라이브러리 항목뿐이다.
 * 사용자가 쓴 것을 앱이 조용히 고쳐 쓰지 않는다.
 */
export async function updatePlace(id: string, patch: PlacePatch): Promise<void> {
  const d = db();
  const cur = await d.localPlaces.get(id);
  if (!cur || cur.deletedAt !== null) return;
  const now = new Date().toISOString();
  const opId = uuid();
  const next: LocalPlace = {
    ...cur,
    ...(patch.name !== undefined ? { name: patch.name.trim() || cur.name } : {}),
    ...(patch.memo !== undefined ? { memo: patch.memo } : {}),
    ...(patch.category !== undefined ? { category: patch.category } : {}),
    ...(patch.latitude !== undefined && Number.isFinite(patch.latitude) ? { latitude: patch.latitude } : {}),
    ...(patch.longitude !== undefined && Number.isFinite(patch.longitude) ? { longitude: patch.longitude } : {}),
    ...(patch.precision !== undefined ? { precision: patch.precision } : {}),
    ...(patch.spanMeters !== undefined ? { spanMeters: patch.spanMeters } : {}),
    ...(patch.mapPicked !== undefined ? { mapPicked: patch.mapPicked } : {}),
    updatedAt: now,
    version: cur.version + 1,
    baseVersion: cur.baseVersion ?? cur.version,
    clientOperationId: opId,
  };
  await d.transaction('rw', d.localPlaces, d.syncQueue, async () => {
    await d.localPlaces.put(next);
    await d.syncQueue.add(placeOp(opId, id, 'update', now));
  });
  const back = await d.localPlaces.get(id);
  if (!back || back.version !== next.version) throw new Error('내구성 커밋 확인 실패: 장소 수정 read-back 불일치');
}

/**
 * 삭제 — **하드 삭제 없음**(§0). `deletedAt` tombstone만 세운다.
 *
 * 순간들의 링크는 여기서 끊지 않는다. 서버는 `on delete set null`로 영구삭제 때만 끊고,
 * tombstone 동안에는 **되살리면 링크가 그대로 살아난다**(실행취소가 진짜 되돌리기가 되게).
 */
export async function softDeletePlace(id: string): Promise<void> {
  const d = db();
  const cur = await d.localPlaces.get(id);
  if (!cur || cur.deletedAt !== null) return; // 멱등 — 두 번 눌러도 같다
  const now = new Date().toISOString();
  const opId = uuid();
  await d.transaction('rw', d.localPlaces, d.syncQueue, async () => {
    await d.localPlaces.put({
      ...cur,
      deletedAt: now,
      updatedAt: now,
      version: cur.version + 1,
      baseVersion: cur.baseVersion ?? cur.version,
      clientOperationId: opId,
    });
    await d.syncQueue.add(placeOp(opId, id, 'delete', now));
  });
  const back = await d.localPlaces.get(id);
  if (!back || back.deletedAt === null) throw new Error('내구성 커밋 확인 실패: 장소 삭제 read-back 불일치');
}

/** 되살리기 — 삭제와 **쌍**이다(`check-domain-symmetry`가 이 대칭을 강제한다). */
export async function restorePlace(id: string): Promise<void> {
  const d = db();
  const cur = await d.localPlaces.get(id);
  if (!cur || cur.deletedAt === null) return;
  const now = new Date().toISOString();
  const opId = uuid();
  await d.transaction('rw', d.localPlaces, d.syncQueue, async () => {
    await d.localPlaces.put({
      ...cur,
      deletedAt: null,
      updatedAt: now,
      version: cur.version + 1,
      baseVersion: cur.baseVersion ?? cur.version,
      clientOperationId: opId,
    });
    await d.syncQueue.add(placeOp(opId, id, 'update', now));
  });
  const back = await d.localPlaces.get(id);
  if (!back || back.deletedAt !== null) throw new Error('내구성 커밋 확인 실패: 장소 되살리기 read-back 불일치');
}
