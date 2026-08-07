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

import { db, type JourneyDB, type LocalPlace, type SyncQueueItem } from '../offline/db';
import { providerKeyOf } from '../domain/place/rowmap';
import { roughDistanceMeters } from '../domain/place/provider';
import { compareInstants } from '../domain/time';
import { reverseGeocode } from './geocode';
import { isRealCoord } from '../domain/place/coordInput';
import { orderPhotos } from '../domain/media/order';

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

export interface LinkedPlaceNameSyncResult {
  placeFound: boolean;
  placeChanged: boolean;
  momentIds: string[];
}

/**
 * 연결된 장소 이름의 **유일한 쓰기 문**. 호출자는 반드시 `localPlaces`·`localMoments`·
 * `syncQueue`를 포함한 Dexie 쓰기 트랜잭션 안에 있어야 한다.
 *
 * 이름은 링크된 장소의 표시값이므로 양쪽에서 같게 유지한다. 좌표는 당시 기록이므로 손대지
 * 않는다. 각 행과 각 op을 같은 트랜잭션에서 만들기 때문에 앱이 중간에 닫혀도 한쪽만 바뀐
 * 고아 상태가 남지 않는다(M-0124).
 */
export async function mirrorLinkedPlaceNameInTransaction(
  d: JourneyDB,
  placeId: string,
  rawName: string,
  now: string,
): Promise<LinkedPlaceNameSyncResult> {
  const name = rawName.trim();
  if (!name) return { placeFound: false, placeChanged: false, momentIds: [] };
  const place = await d.localPlaces.get(placeId);
  if (!place || place.deletedAt !== null) return { placeFound: false, placeChanged: false, momentIds: [] };

  let placeChanged = false;
  if (place.name !== name) {
    const operationId = uuid();
    await d.localPlaces.put({
      ...place,
      name,
      updatedAt: now,
      version: place.version + 1,
      baseVersion: place.baseVersion ?? place.version,
      clientOperationId: operationId,
    });
    await d.syncQueue.add(placeOp(operationId, place.id, 'update', now));
    placeChanged = true;
  }

  // 휴지통 순간도 복원될 수 있으므로 함께 맞춘다. 활성 순간만 고치면 복원 순간에 옛 이름이
  // 다시 나타나 연결된 장소와 즉시 갈라진다.
  const linked = await d.localMoments.filter((moment) => moment.placeId === placeId).toArray();
  const momentIds: string[] = [];
  for (const moment of linked) {
    if (moment.placeName === name) continue;
    const operationId = uuid();
    await d.localMoments.put({
      ...moment,
      placeName: name,
      updatedAt: now,
      version: moment.version + 1,
      baseVersion: moment.baseVersion ?? moment.version,
      clientOperationId: operationId,
    });
    await d.syncQueue.add({
      operationId,
      entityType: 'moment',
      entityId: moment.id,
      operationType: 'update',
      state: 'local_only',
      attempts: 0,
      createdAt: now,
    });
    momentIds.push(moment.id);
  }
  return { placeFound: true, placeChanged, momentIds };
}

export async function verifyLinkedPlaceNameReadBack(placeId: string, name: string): Promise<void> {
  const d = db();
  const [place, linked] = await Promise.all([
    d.localPlaces.get(placeId),
    d.localMoments.filter((moment) => moment.placeId === placeId).toArray(),
  ]);
  if (!place || place.name !== name || linked.some((moment) => moment.placeName !== name)) {
    throw new Error('내구성 커밋 확인 실패: 연결된 장소 이름 read-back 불일치');
  }
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
    // 같은 제공자 지점·같은 좌표라도 사용자가 붙인 이름이 다르면 **다른 장소**다.
    // 순간에 저장한 이름이 기준본이므로 provider id만으로 접지 않는다.
    const active = hit.find((p) => p.deletedAt === null && p.name.trim() === input.name.trim());
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

/** 순간 저장값을 장소 대장의 기준본으로 등록하고 그 항목 id를 돌려준다. */
export async function registerMomentPlace(input: {
  name: string;
  latitude: number | null;
  longitude: number | null;
}): Promise<string | null> {
  const name = input.name.trim();
  if (!name || !isRealCoord(input.latitude, input.longitude)) return null;
  const place = await savePlace({
    name,
    latitude: input.latitude!,
    longitude: input.longitude!,
    mapPicked: true,
  });
  return place.id;
}

/**
 * 옛 순간을 현재 계약으로 소급한다. 반복 실행해도 같은 이름+좌표는 같은 대장 행으로 모인다.
 * 서버에서 나중에 내려온 옛 순간도 다음 홈 진입 때 다시 대상이 되므로 일회성 마커를 두지 않는다.
 */
let reconcileInFlight: Promise<number> | null = null;

export async function reconcileMomentPlaces(): Promise<number> {
  if (reconcileInFlight) return reconcileInFlight;
  reconcileInFlight = reconcileMomentPlacesOnce();
  try {
    return await reconcileInFlight;
  } finally {
    reconcileInFlight = null;
  }
}

async function reconcileMomentPlacesOnce(): Promise<number> {
  const d = db();
  const moments = (await d.localMoments.toArray()).filter(
    (m) => m.deletedAt === null && m.placeName.trim() !== '' && isRealCoord(m.placeLat, m.placeLng),
  ).sort((a, b) => (compareInstants(a.occurredAt, b.occurredAt) ?? 0) || a.id.localeCompare(b.id));
  const canonicalKey = (m: typeof moments[number]): string =>
    `${m.placeName.trim()}\u0000${m.placeLat!.toFixed(7)}\u0000${m.placeLng!.toFixed(7)}`;
  const firstKeyByPlaceId = new Map<string, string>();
  for (const moment of moments) {
    if (moment.placeId && !firstKeyByPlaceId.has(moment.placeId)) {
      firstKeyByPlaceId.set(moment.placeId, canonicalKey(moment));
    }
  }
  let changed = 0;
  for (const moment of moments) {
    // Backfill the previously linked ledger row from the first authoritative moment. If old moments
    // shared one row under different names, later variants are split below instead of overwriting it.
    if (moment.placeId && firstKeyByPlaceId.get(moment.placeId) === canonicalKey(moment)) {
      const linked = await d.localPlaces.get(moment.placeId);
      if (linked && linked.deletedAt === null) {
        const name = moment.placeName.trim();
        // 이름이 이미 순간 기준본과 같다면 대장 좌표가 권위다. 사용자가 대장의 지도 핀을
        // 옮긴 뒤 홈에 돌아왔다고 순간의 옛 좌표로 되돌리면 안 된다.
        if (linked.name !== name) {
          // 옛 데이터가 한 placeId를 서로 다른 이름으로 공유하면 아래 반복이 이름별로 행을
          // 갈라 준다. 이 소급 단계에서 먼저 형제 순간 이름을 덮으면 갈라낼 증거를 잃으므로,
          // 사용자 편집용 양방향 미러가 아니라 명시적인 legacy 정책을 쓴다.
          await updatePlaceWithNamePolicy(linked.id, {
            name,
            latitude: moment.placeLat!,
            longitude: moment.placeLng!,
            mapPicked: true,
          }, 'legacy-reconcile');
          changed += 1;
        }
        continue;
      }
    }
    const placeId = await registerMomentPlace({
      name: moment.placeName,
      latitude: moment.placeLat ?? null,
      longitude: moment.placeLng ?? null,
    });
    if (!placeId || moment.placeId === placeId) continue;
    const now = new Date().toISOString();
    const opId = uuid();
    let relinked = false;
    await d.transaction('rw', d.localMoments, d.syncQueue, async () => {
      const current = await d.localMoments.get(moment.id);
      if (!current || current.deletedAt !== null || current.placeId === placeId) return;
      await d.localMoments.put({
        ...current,
        placeId,
        updatedAt: now,
        version: current.version + 1,
        baseVersion: current.baseVersion ?? current.version,
        clientOperationId: opId,
      });
      await d.syncQueue.add({
        operationId: opId,
        entityType: 'moment',
        entityId: current.id,
        operationType: 'update',
        state: 'local_only',
        attempts: 0,
        createdAt: now,
      });
      relinked = true;
    });
    if (relinked) changed += 1;
  }
  return changed;
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

  const d = db();
  // 찾기와 생성도 같은 쓰기 트랜잭션 안에서 한다. 홈 초기화·검색 재렌더가 겹쳐도 두 번째
  // 트랜잭션은 첫 번째 행을 본 뒤 재사용하므로 같은 장소가 둘 생기지 않는다.
  const committed = await d.transaction('rw', d.localPlaces, d.syncQueue, async () => {
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
    await d.localPlaces.add(row);
    await d.syncQueue.add(placeOp(opId, row.id, 'insert', now));
    return row;
  });

  // **read-back으로 확인한 뒤에야 성공이다.** 예외가 없다는 것은 저장의 증거가 아니다.
  const back = await d.localPlaces.get(committed.id);
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
  /**
   * 역지오코딩이 채우는 주소 칸(사용자 요청 ④ — 국가·도시까지).
   *
   * 🔴 사용자가 손으로 적은 이름은 **여기서 건드리지 않는다**(`name`은 별개 필드다).
   * 지오코더가 준 것은 주소일 뿐이고, 그 장소를 뭐라 부를지는 사용자가 정한다
   * (map-place-dev §1 3항 — 지오코더에 없는 곳도 담아야 한다).
   */
  formattedAddress?: string | null;
  countryCode?: string | null;
  country?: string | null;
  region?: string | null;
  city?: string | null;
  district?: string | null;
  postcode?: string | null;
  /** 주소를 어느 지오코더가 줬는가. 사용자가 직접 고친 좌표면 다시 받을 때까지 낡은 값이다. */
  provider?: string | null;
}

export interface PlaceUpdateResult {
  renamedMomentCount: number;
}

type PlaceNamePolicy = 'mirror-linked' | 'legacy-reconcile';

/** 이름 정책은 기본값을 두지 않는다. 사용자 편집과 옛 placeId 분리 소급은 사정권이 다르다. */
async function updatePlaceWithNamePolicy(
  id: string,
  patch: PlacePatch,
  namePolicy: PlaceNamePolicy,
): Promise<PlaceUpdateResult> {
  const d = db();
  const cur = await d.localPlaces.get(id);
  if (!cur || cur.deletedAt !== null) return { renamedMomentCount: 0 };
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
    ...(patch.formattedAddress !== undefined ? { formattedAddress: patch.formattedAddress } : {}),
    ...(patch.countryCode !== undefined ? { countryCode: patch.countryCode } : {}),
    ...(patch.country !== undefined ? { country: patch.country } : {}),
    ...(patch.region !== undefined ? { region: patch.region } : {}),
    ...(patch.city !== undefined ? { city: patch.city } : {}),
    ...(patch.district !== undefined ? { district: patch.district } : {}),
    ...(patch.postcode !== undefined ? { postcode: patch.postcode } : {}),
    ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
    updatedAt: now,
    version: cur.version + 1,
    baseVersion: cur.baseVersion ?? cur.version,
    clientOperationId: opId,
  };
  const mirrored = await d.transaction('rw', d.localPlaces, d.localMoments, d.syncQueue, async () => {
    await d.localPlaces.put(next);
    await d.syncQueue.add(placeOp(opId, id, 'update', now));
    if (patch.name === undefined || namePolicy === 'legacy-reconcile') return null;
    return mirrorLinkedPlaceNameInTransaction(d, id, next.name, now);
  });
  const back = await d.localPlaces.get(id);
  if (!back || back.version !== next.version) throw new Error('내구성 커밋 확인 실패: 장소 수정 read-back 불일치');
  if (mirrored?.placeFound) await verifyLinkedPlaceNameReadBack(id, next.name);
  return { renamedMomentCount: mirrored?.momentIds.length ?? 0 };
}

/**
 * 장소를 고친다.
 *
 * 연결된 동안 **이름은 한 값**이다. 대장에서 이름을 바꾸면 직접 연결된 활성·휴지통 순간의
 * `placeName`도 같은 트랜잭션에서 바뀐다. 반면 좌표는 당시 기록이므로 대장 좌표를 고쳐도
 * 순간 좌표에는 전파하지 않는다.
 */
export async function updatePlace(id: string, patch: PlacePatch): Promise<PlaceUpdateResult> {
  return updatePlaceWithNamePolicy(id, patch, 'mirror-linked');
}

export type DeleteUnusedPlaceResult =
  | { status: 'deleted' }
  | { status: 'missing' | 'already-deleted' }
  | { status: 'linked'; activeMomentCount: number; trashedMomentCount: number };

/**
 * 장소 tombstone의 **유일한 쓰기 문**.
 *
 * 대장 화면의 "미연결 장소 삭제"는 순간 참조 검사와 tombstone+op을 같은 트랜잭션에 둔다.
 * 검사 뒤 삭제를 따로 쓰면 그 사이에 순간이 연결될 수 있고, 그러면 화면의 "미연결" 판정이
 * 이미 낡은 값이 된다(동기화는 사용자 작업 사이에 끼어든다는 sync-offline-dev §1-B의 같은 형태).
 */
async function softDeletePlaceInternal(id: string, onlyIfUnused: boolean): Promise<DeleteUnusedPlaceResult> {
  const d = db();
  const result = await d.transaction('rw', d.localPlaces, d.localMoments, d.syncQueue, async () => {
    const cur = await d.localPlaces.get(id);
    if (!cur) return { status: 'missing' } as const;
    if (cur.deletedAt !== null) return { status: 'already-deleted' } as const;

    if (onlyIfUnused) {
      // 🔴 사진 수가 아니라 **직접 링크된 순간 수**가 삭제 경계다. 사진 없는 글 순간도
      // 사용자 기록이고, 휴지통 순간도 복원될 수 있으므로 둘 다 참조로 센다.
      const linked = await d.localMoments.filter((moment) => moment.placeId === id).toArray();
      if (linked.length) {
        return {
          status: 'linked',
          activeMomentCount: linked.filter((moment) => moment.deletedAt === null).length,
          trashedMomentCount: linked.filter((moment) => moment.deletedAt !== null).length,
        } as const;
      }
    }

    const now = new Date().toISOString();
    const opId = uuid();
    await d.localPlaces.put({
      ...cur,
      deletedAt: now,
      updatedAt: now,
      version: cur.version + 1,
      baseVersion: cur.baseVersion ?? cur.version,
      clientOperationId: opId,
    });
    await d.syncQueue.add(placeOp(opId, id, 'delete', now));
    return { status: 'deleted' } as const;
  });

  if (result.status !== 'deleted') return result;
  const back = await d.localPlaces.get(id);
  if (!back || back.deletedAt === null) throw new Error('내구성 커밋 확인 실패: 장소 삭제 read-back 불일치');
  return result;
}

/**
 * 삭제 — **하드 삭제 없음**(§0). `deletedAt` tombstone만 세운다.
 *
 * 순간들의 링크는 여기서 끊지 않는다. 서버는 `on delete set null`로 영구삭제 때만 끊고,
 * tombstone 동안에는 **되살리면 링크가 그대로 살아난다**(실행취소가 진짜 되돌리기가 되게).
 */
export async function softDeletePlace(id: string): Promise<void> {
  await softDeletePlaceInternal(id, false);
}

/**
 * 직접 연결된 순간이 하나도 없는 장소만 휴지통으로 보낸다.
 *
 * 이름만 같은 순간은 링크가 아니므로 막지 않는다. 반대로 사진이 0장이어도 직접 연결된 순간이
 * 있으면 막는다 — 사진 없는 글 기록도 사용자의 기억이기 때문이다.
 */
export async function deleteUnusedPlace(id: string): Promise<DeleteUnusedPlaceResult> {
  return softDeletePlaceInternal(id, true);
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


// ─────────────────────────────────────────────────────────────────────────────
// 주소 자동 채움 (사용자 결정 2026-08-05 — "자동으로 다")
// ─────────────────────────────────────────────────────────────────────────────
//
// 🔴 **좌표가 기기 밖으로 나간다.** 이 앱의 §0은 개인자료 기본 비공개이므로, 이건 사용자가
//    명시적으로 승인한 예외다(2026-08-05: 주소 자동 입력을 "자동으로 다"로 결정).
//    나가는 것: 위도·경도 한 쌍. 나가지 않는 것: 장소 이름·메모·사진·여행 제목.
//    받는 것: 국가·도시 등 행정 라벨. `docs/PRIVACY.md`에 같은 내용을 적는다.
//
// 저트래픽 예의(map-place-dev §1 6항): **장소 하나당 필요할 때 1회**만 부른다. 목록을 그릴
// 때마다 전수로 부르지 않는다 — Nominatim은 공용 서버다.

/**
 * 좌표로 주소를 받아 대장 항목에 채운다.
 *
 * 🔴 **이름은 건드리지 않는다.** 지오코더가 준 것은 주소일 뿐이고, 그 장소를 뭐라 부를지는
 * 사용자가 정한다 — 사용자가 「집」이라 적은 곳을 「Yunusobod tumani」로 덮으면 안 된다.
 *
 * 실패는 **조용히 넘어간다**(throw하지 않는다). 이건 거들어 주는 기능이라, 주소를 못 받았다고
 * 대장이 안 열리면 편의 기능이 사용자를 막는 셈이다(`reverseGeocode`와 같은 규율).
 *
 * @returns 채웠으면 true. 좌표가 이상하거나 조회 실패면 false.
 */
export async function fillAddressFromCoords(id: string): Promise<boolean> {
  const d = db();
  const cur = await d.localPlaces.get(id);
  if (!cur || cur.deletedAt !== null) return false;
  if (!Number.isFinite(cur.latitude) || !Number.isFinite(cur.longitude)) return false;
  const r = await reverseGeocode(cur.latitude, cur.longitude);
  if (!r) return false;
  await updatePlace(id, {
    formattedAddress: r.displayName,
    countryCode: r.address.countryCode,
    country: r.address.country,
    region: r.address.region,
    city: r.address.city,
    district: r.address.district,
    postcode: r.address.postcode,
    provider: r.provider,
  });
  return true;
}

/**
 * 이 장소를 쓰는 순간들 — 대장이 「고치기 전에 어디에 영향이 가나」를 보여줄 때 쓴다.
 *
 * 🔴 **전 여행을 훑는다.** 장소는 여행에 매이지 않으므로(같은 카페를 여러 여행에서 쓴다)
 * `listMoments(tripId)`로는 답이 안 나온다. 지운 순간은 뺀다.
 *
 * 판정(무엇을 「이 장소」로 볼 것인가)은 `domain/place/registry.ts`가 한다 — 여기서는
 * 모아 오기만 한다(§10 ③ — 사용자에게 나가는 문장을 만드는 로직은 순수 함수로).
 */
export async function allMomentsForPlaceLookup(): Promise<
  { id: string; tripId: string; title: string; occurredAt: string; placeName: string; placeId?: string | null; deletedAt: string | null }[]
> {
  const d = db();
  const rows = await d.localMoments.toArray();
  return rows.map((m) => ({
    id: m.id,
    tripId: m.tripId,
    title: m.title,
    occurredAt: m.occurredAt,
    placeName: m.placeName,
    placeId: m.placeId ?? null,
    deletedAt: m.deletedAt,
  }));
}

/** 장소 기록 모달의 읽기 전용 스냅샷. 저장·큐·동기화는 건드리지 않는다. */
export async function allPlaceRecordMoments(): Promise<
  { id: string; tripId: string; tripTitle: string; title: string; occurredAt: string; placeName: string; placeId?: string | null; deletedAt: string | null }[]
> {
  const d = db();
  const [trips, moments] = await Promise.all([d.localTrips.toArray(), d.localMoments.toArray()]);
  const tripTitles = new Map(trips.filter((t) => t.deletedAt === null).map((t) => [t.id, t.title]));
  return moments.filter((m) => tripTitles.has(m.tripId)).map((m) => ({
    id: m.id, tripId: m.tripId, tripTitle: tripTitles.get(m.tripId)!, title: m.title,
    occurredAt: m.occurredAt, placeName: m.placeName, placeId: m.placeId ?? null, deletedAt: m.deletedAt,
  }));
}

/**
 * 기록 모달을 실제로 열었을 때만 해당 순간들의 썸네일을 읽는다.
 * 대장 진입에서 모든 Blob을 `toArray()`로 꺼내지 않아 긴 여행 기록의 메모리를 불필요하게 쓰지 않는다.
 */
export async function mediaForPlaceRecordMoments(momentIds: readonly string[]): Promise<Map<string, { id: string; thumbBlob: Blob }[]>> {
  const result = new Map<string, { id: string; thumbBlob: Blob }[]>();
  if (!momentIds.length) return result;
  const rows = orderPhotos((await db().localMedia.where('momentId').anyOf([...momentIds]).toArray())
    .filter((item) => item.deletedAt === null));
  for (const item of rows) {
    const existing = result.get(item.momentId);
    const value = { id: item.id, thumbBlob: item.thumbBlob };
    if (existing) existing.push(value);
    else result.set(item.momentId, [value]);
  }
  return result;
}
