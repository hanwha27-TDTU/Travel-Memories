// services/trips.ts — 여행 로컬우선 저장 (docs/SYNC_PROTOCOL.md thin slice)
// "저장 완료" = 내구성 로컬 커밋: Dexie 트랜잭션으로 entity+operation을 원자적으로
// 쓰고, 같은 키를 즉시 되읽어(read-back) 일치를 확인한 뒤에만 완료를 반환한다.
// 서버 push는 인증(Google OAuth, Phase 1 후속)이 붙기 전까지 대기열에만 쌓인다 —
// sync_queue가 그 대기열이며, 유실되지 않는다.

import { db, type LocalTrip, type SyncQueueItem, type PurgedId } from '../offline/db';
import { purgeMarks, purgeOpType, type PurgeDomain } from './purge';

function uuid(): string {
  return crypto.randomUUID();
}

export interface CreateTripInput {
  title: string;
  startDate?: string;
  endDate?: string;
}

/**
 * 여행 생성 — 내구성 로컬 커밋 + 정확한 read-back.
 * 반환된 시점 = SYNC_PROTOCOL의 "내구성 로컬 커밋 이후"(앱 원인 유실 0 범위 시작점).
 */
export async function createTripLocalFirst(input: CreateTripInput): Promise<LocalTrip> {
  const title = input.title.trim();
  if (!title) throw new Error('제목이 비어 있습니다.');

  const now = new Date().toISOString();
  const trip: LocalTrip = {
    id: uuid(),
    title,
    startDate: input.startDate ?? '',
    endDate: input.endDate ?? '',
    status: 'planned',
    version: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    clientOperationId: uuid(),
  };
  const op: SyncQueueItem = {
    operationId: trip.clientOperationId!,
    entityType: 'trip',
    entityId: trip.id,
    operationType: 'insert',
    state: 'local_only',
    attempts: 0,
    createdAt: now,
  };

  const d = db();
  // entity + operation 원자적 커밋 — 하나만 남는 상태를 만들지 않는다.
  await d.transaction('rw', d.localTrips, d.syncQueue, async () => {
    await d.localTrips.add(trip);
    await d.syncQueue.add(op);
  });

  // 정확한 read-back: 트랜잭션 성공 반환을 믿지 않고 같은 키를 되읽어 확인(불변식 5).
  const [readTrip, readOp] = await Promise.all([
    d.localTrips.get(trip.id),
    d.syncQueue.get(op.operationId),
  ]);
  if (!readTrip || readTrip.title !== trip.title || !readOp) {
    throw new Error('내구성 커밋 확인 실패: read-back 불일치 — 저장을 완료로 표시하지 않음');
  }
  return readTrip;
}

/** 단일 여행 조회(활성만; tombstone/없음은 null). */
export async function getTrip(id: string): Promise<LocalTrip | null> {
  const t = await db().localTrips.get(id);
  return t && t.deletedAt === null ? t : null;
}

export interface UpdateTripPatch {
  title?: string;
  startDate?: string;
  endDate?: string;
  status?: LocalTrip['status'];
  /**
   * 여행 시간대(IANA id). `''` = 미지정 — **비우는 것도 사용자의 선택**이므로 빈 문자열을
   * 「값 없음」으로 뭉개지 않는다(`!== undefined`로 판단한다).
   */
  timeZone?: string;
}

/**
 * 여행 수정 — 내구성 로컬 커밋 + 정확한 read-back + 동기화 대기열(update).
 * version을 올리고 updatedAt을 갱신한다(LWW 기준). 서버 push는 기존 파이프라인이 처리.
 */
export async function updateTripLocalFirst(id: string, patch: UpdateTripPatch): Promise<LocalTrip> {
  const d = db();
  const cur = await d.localTrips.get(id);
  if (!cur || cur.deletedAt !== null) throw new Error('여행을 찾을 수 없습니다.');

  const now = new Date().toISOString();
  const opId = uuid();
  const next: LocalTrip = {
    ...cur,
    ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
    ...(patch.startDate !== undefined ? { startDate: patch.startDate } : {}),
    ...(patch.endDate !== undefined ? { endDate: patch.endDate } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.timeZone !== undefined ? { timeZone: patch.timeZone } : {}),
    version: cur.version + 1,
    updatedAt: now,
    baseVersion: cur.version,
    clientOperationId: opId,
  };
  if (!next.title) throw new Error('제목이 비어 있습니다.');

  const op: SyncQueueItem = {
    operationId: opId,
    entityType: 'trip',
    entityId: id,
    operationType: 'update',
    state: 'local_only',
    attempts: 0,
    createdAt: now,
  };

  await d.transaction('rw', d.localTrips, d.syncQueue, async () => {
    await d.localTrips.put(next);
    await d.syncQueue.add(op);
  });

  const readTrip = await d.localTrips.get(id);
  if (!readTrip || readTrip.version !== next.version) {
    throw new Error('내구성 커밋 확인 실패: read-back 불일치');
  }
  return readTrip;
}

/**
 * 여행과 함께 tombstone된 자식 id 묶음. **복원은 이 묶음을 통째로 받는다.**
 *
 * ⚠️ 결함 이력(2026-07-25): 예전 시그니처는 `restoreTripLocalFirst(id, momentIds, mediaIds, expenseIds = [])`
 * 였고, **기본값이 호출부의 누락을 조용히 삼켰다** — 두 화면 모두 expenseIds를 넘기지 않아
 * 여행 삭제 후 실행취소를 눌러도 **비용이 복원되지 않았다**(여행이 활성으로 돌아오므로 휴지통에도
 * 나타나지 않아 복구 경로가 사라졌다). 묶음 타입으로 바꿔 누락을 컴파일 오류로 만든다 —
 * 새 자식 종류가 생겨도 컴파일러가 모든 호출부를 잡는다.
 */
export interface TripChildren {
  momentIds: string[];
  mediaIds: string[];
  expenseIds: string[];
  /**
   * 오디오 노트. **형제에게는 대칭과 공정이 기본값이다**(CLAUDE.md §7, 2026-07-27) —
   * 함께 지워지고 함께 살아난다. 이 필드가 없던 동안 순간·여행을 지워도 소리만 활성으로 남았다.
   *
   * 2026-07-27~ 소리도 **서버로 간다**. 그래서 마지막 남았던 예외(큐 op를 안 만든다)도
   * 사라졌다 — 아래 `childOp`가 네 종류를 **같은 자리에서** 만든다.
   */
  audioIds: string[];
}

/**
 * cascade가 다루는 자식 종류. **여기 한 곳에 적는다** — 삭제·복원 두 `childOp`가 같은 타입을
 * 받으므로, 종류를 하나 더하면 두 곳이 함께 컴파일러의 감시를 받는다(§7 2층).
 */
type ChildEntity = 'moment' | 'media' | 'expense' | 'audio';

/**
 * 여행 삭제 — 하드 삭제 금지(§0): deletedAt tombstone. 순간·사진·비용·소리까지 같은 트랜잭션에서
 * cascade tombstone하고, **네 종류 모두 sync 큐 op(delete)를 만든다.**
 *
 * ⚠️ 결함 이력(2026-07-25): 예전 주석은 "미디어는 로컬 전용이라 op를 만들지 않는다"였다.
 * 그 전제는 사진·비용 동기화가 생기면서 무너졌는데 이 함수만 갱신되지 않아, **여행을 지워도
 * 서버 사진 행이 활성으로 남고 R2 객체도 지워지지 않았다**(실측으로 확인). 순간 삭제
 * (`softDeleteMomentLocalFirst`)는 처음부터 올바랐다 — 같은 규율을 두 곳에 손으로 구현한 것이
 * 뿌리다. 형제 위치를 함께 고쳤고 유닛으로 잠갔다(tests/unit/cascadeOps.test.ts).
 *
 * 되살리기가 정확히 이 자식들만 복원하도록 id 목록을 반환한다.
 * 되살리기·삭제 모두 version+1로 LWW에서 최신이 이긴다.
 */
export async function softDeleteTripLocalFirst(id: string): Promise<TripChildren> {
  const d = db();
  const cur = await d.localTrips.get(id);
  if (!cur || cur.deletedAt !== null) throw new Error('여행을 찾을 수 없습니다.');

  const now = new Date().toISOString();
  const tripOpId = uuid();
  const tombstonedTrip: LocalTrip = {
    ...cur,
    deletedAt: now,
    version: cur.version + 1,
    updatedAt: now,
    baseVersion: cur.version,
    clientOperationId: tripOpId,
  };

  const moments = (await d.localMoments.where('tripId').equals(id).toArray()).filter(
    (m) => m.deletedAt === null,
  );
  const media = (await d.localMedia.where('tripId').equals(id).toArray()).filter(
    (m) => m.deletedAt === null,
  );
  const expenses = (await d.localExpenses.where('tripId').equals(id).toArray()).filter(
    (e) => e.deletedAt === null,
  );
  const audio = (await d.localAudio.where('tripId').equals(id).toArray()).filter(
    (a) => a.deletedAt === null,
  );
  const momentIds = moments.map((m) => m.id);
  const mediaIds = media.map((m) => m.id);
  const expenseIds = expenses.map((e) => e.id);
  const audioIds = audio.map((a) => a.id);

  // 자식 op는 **tombstone하는 종류 전부**에 대해 만든다. 하나라도 빠지면 그 종류만 서버에
  // 활성으로 남아 다른 기기에서 되살아나고(사진은 R2 객체까지 잔류) 원인이 보이지 않는다.
  const childOp = (entityType: ChildEntity, entityId: string): SyncQueueItem => ({
    operationId: uuid(),
    entityType,
    entityId,
    operationType: 'delete',
    state: 'local_only',
    attempts: 0,
    createdAt: now,
  });
  const ops: SyncQueueItem[] = [
    { operationId: tripOpId, entityType: 'trip', entityId: id, operationType: 'delete', state: 'local_only', attempts: 0, createdAt: now },
    ...moments.map((m) => childOp('moment', m.id)),
    ...media.map((m) => childOp('media', m.id)),
    ...expenses.map((e) => childOp('expense', e.id)),
    ...audio.map((a) => childOp('audio', a.id)),
  ];

  // 표 6개는 Dexie의 가변인자 오버로드 한도를 넘어 배열 형태를 쓴다(동작은 같다).
  await d.transaction('rw', [d.localTrips, d.localMoments, d.localMedia, d.localExpenses, d.localAudio, d.syncQueue], async () => {
    await d.localTrips.put(tombstonedTrip);
    for (const m of moments) await d.localMoments.put({ ...m, deletedAt: now, version: m.version + 1, updatedAt: now });
    for (const m of media) await d.localMedia.put({ ...m, deletedAt: now, version: m.version + 1, updatedAt: now });
    for (const e of expenses) await d.localExpenses.put({ ...e, deletedAt: now, version: e.version + 1, updatedAt: now });
    // 오디오도 형제다 — 함께 사라지고, **서버에도 그 사실이 간다**(위 ops에 audio 포함).
    for (const a of audio) await d.localAudio.put({ ...a, deletedAt: now, version: a.version + 1, updatedAt: now });
    for (const op of ops) await d.syncQueue.add(op);
  });

  const back = await d.localTrips.get(id);
  if (!back || back.deletedAt === null) throw new Error('내구성 커밋 확인 실패: 여행 삭제 read-back 불일치');
  return { momentIds, mediaIds, expenseIds, audioIds };
}

/** 여행 되살리기(실행취소) — 여행 + 삭제 시 함께 tombstone된 순간·사진·비용·소리를 복원. version+1로 LWW 승리. */
export async function restoreTripLocalFirst(id: string, children: TripChildren): Promise<LocalTrip> {
  const { momentIds, mediaIds, expenseIds, audioIds } = children;
  const d = db();
  const cur = await d.localTrips.get(id);
  if (!cur) throw new Error('여행을 찾을 수 없습니다.');

  const now = new Date().toISOString();
  const tripOpId = uuid();
  const restored: LocalTrip = {
    ...cur,
    deletedAt: null,
    version: cur.version + 1,
    updatedAt: now,
    baseVersion: cur.version,
    clientOperationId: tripOpId,
  };
  // 삭제와 **대칭**이어야 한다. 복원 op가 빠지면 서버에는 tombstone이 남아, 다음 pull에서
  // 되살린 것이 도로 지워진다(사용자 눈에는 "복원이 안 되는" 것으로 보인다).
  const childOp = (entityType: ChildEntity, entityId: string): SyncQueueItem => ({
    operationId: uuid(),
    entityType,
    entityId,
    operationType: 'update',
    state: 'local_only',
    attempts: 0,
    createdAt: now,
  });
  const ops: SyncQueueItem[] = [
    { operationId: tripOpId, entityType: 'trip', entityId: id, operationType: 'update', state: 'local_only', attempts: 0, createdAt: now },
    ...momentIds.map((mid) => childOp('moment', mid)),
    ...mediaIds.map((mid) => childOp('media', mid)),
    ...expenseIds.map((eid) => childOp('expense', eid)),
    ...audioIds.map((aid) => childOp('audio', aid)),
  ];

  // 소리를 되살리려면 `localAudio`도 **트랜잭션 범위 안에** 있어야 한다. 빠지면 Dexie가
  // NotFoundError를 던져 **복원 전체가 실패**한다 — 삭제 쪽만 고치고 여기를 빠뜨리면
  // "지우기는 되는데 되살리기가 안 되는" 비대칭이 된다(§7).
  await d.transaction('rw', [d.localTrips, d.localMoments, d.localMedia, d.localExpenses, d.localAudio, d.syncQueue], async () => {
    await d.localTrips.put(restored);
    for (const mid of momentIds) {
      const m = await d.localMoments.get(mid);
      if (m) await d.localMoments.put({ ...m, deletedAt: null, version: m.version + 1, updatedAt: now });
    }
    for (const mid of mediaIds) {
      const m = await d.localMedia.get(mid);
      if (m) await d.localMedia.put({ ...m, deletedAt: null, version: m.version + 1, updatedAt: now });
    }
    for (const eid of expenseIds) {
      const e = await d.localExpenses.get(eid);
      if (e) await d.localExpenses.put({ ...e, deletedAt: null, version: e.version + 1, updatedAt: now });
    }
    for (const aid of audioIds) {
      const a = await d.localAudio.get(aid);
      if (a) await d.localAudio.put({ ...a, deletedAt: null, version: a.version + 1, updatedAt: now });
    }
    for (const op of ops) await d.syncQueue.add(op);
  });

  const back = await d.localTrips.get(id);
  if (!back || back.deletedAt !== null) throw new Error('내구성 커밋 확인 실패: 여행 되살리기 read-back 불일치');
  return back;
}

/** 휴지통 — 삭제(tombstone)된 여행 목록. 최근 삭제 먼저. */
export async function listDeletedTrips(): Promise<LocalTrip[]> {
  const d = db();
  const all = await d.localTrips.orderBy('updatedAt').reverse().toArray();
  return all.filter((t) => t.deletedAt !== null);
}

/**
 * 휴지통에서 여행 복원 — 여행 + 그 여행의 현재 tombstone된 순간·사진을 함께 되살린다.
 * (삭제 시 어떤 자식이 함께 지워졌는지는 영속하지 않으므로, 복구 우선 원칙(§5)에 따라
 * 그 여행에 딸린 삭제된 자식을 모두 되살린다.) version+1로 LWW 승리.
 */
export async function restoreTripFromTrash(id: string): Promise<LocalTrip> {
  const d = db();
  const moments = (await d.localMoments.where('tripId').equals(id).toArray()).filter((m) => m.deletedAt !== null);
  const media = (await d.localMedia.where('tripId').equals(id).toArray()).filter((m) => m.deletedAt !== null);
  const expenses = (await d.localExpenses.where('tripId').equals(id).toArray()).filter((e) => e.deletedAt !== null);
  const audio = (await d.localAudio.where('tripId').equals(id).toArray()).filter((a) => a.deletedAt !== null);
  return restoreTripLocalFirst(id, {
    momentIds: moments.map((m) => m.id),
    mediaIds: media.map((m) => m.id),
    expenseIds: expenses.map((e) => e.id),
    audioIds: audio.map((a) => a.id),
  });
}

/** 대기 중인 동기화 작업이 남아 영구삭제를 진행할 수 없을 때. UI가 문구를 구분해 안내한다. */
export class PendingSyncError extends Error {
  constructor(public readonly count: number) {
    super(`아직 서버에 반영되지 않은 변경이 ${count}건 있습니다. 먼저 동기화해 주세요.`);
    this.name = 'PendingSyncError';
  }
}

/**
 * 영구 삭제 — 이 기기의 저장공간을 실제로 비운다(여행+순간+사진+비용 로컬 하드 삭제).
 *
 * ⚠️ 결함 이력(2026-07-25, A안 채택): 예전에는 로컬 행만 지우고 서버에 아무것도 알리지 않았다.
 * `mergeDecision`은 **로컬에 없으면 무조건 서버를 채택**하므로(`if (!local) take-server`)
 * 다음 pull에서 그대로 되살아났다. 특히 *동기화 전에* 영구삭제하면 큐의 op가 고아가 되어
 * 폐기되고(서버는 **활성** 그대로) **지운 여행이 통째로 부활**했다.
 *
 * 두 가지로 막는다:
 *  1) **사전 조건** — 이 여행·자식에 대기 중인 op가 하나라도 있으면 거부한다(PendingSyncError).
 *     op가 없다 = tombstone이 이미 서버에 반영됐다는 뜻이므로, 서버에 활성 행이 남는 갈래가 사라진다.
 *  2) **영구삭제 표식** — 지운 id를 `purgedIds`에 남기고 pull이 그 id를 건너뛴다.
 *     서버 행은 `pushPurges`가 **하드 삭제**한다(ADR-0030) — 자료를 남기지 않는다. 좀비는
 *     서버 원장(`journey.purged_ids`) + BEFORE INSERT 트리거가 막는다(§0의 유일한 예외).
 *
 * 되돌릴 수 없다. tombstone된 여행에만 적용한다.
 */
export async function purgeTripPermanently(id: string): Promise<void> {
  const d = db();
  const cur = await d.localTrips.get(id);
  if (!cur) return;
  if (cur.deletedAt === null) throw new Error('삭제되지 않은 여행은 영구 삭제할 수 없습니다.');

  const moments = await d.localMoments.where('tripId').equals(id).toArray();
  const media = await d.localMedia.where('tripId').equals(id).toArray();
  const expenses = await d.localExpenses.where('tripId').equals(id).toArray();
  // 소리도 이 여행의 가족이다 — 로컬 바이트도, 서버 행도, R2 객체도 함께 사라져야 한다.
  // (v1.14~v1.19 동안은 표식·전파 op가 없었다. 그때도 로컬 바이트는 지웠는데, 그건
  //  「이 기기의 저장공간을 실제로 비운다」가 이 함수의 정의이기 때문이다. 이제 서버까지 간다.)
  const audio = await d.localAudio.where('tripId').equals(id).toArray();

  // ① 사전 조건: 이 여행 가족에 대기 중인 동기화 작업이 있으면 진행하지 않는다.
  //    (permanent_failed도 포함해 센다 — 실패한 채 남은 것도 "서버에 반영 안 됨"이다.)
  //    소리 id도 **함께 센다** — 소리에도 op가 생겼으므로 이 조건은 이제 실제로 일한다.
  //    (op가 없던 시절에도 여기 세어 두었다: 조건에서 빼면 op가 생겨도 아무도 모른다.)
  const ids = new Set<string>([
    id,
    ...moments.map((m) => m.id),
    ...media.map((m) => m.id),
    ...expenses.map((e) => e.id),
    ...audio.map((a) => a.id),
  ]);
  const pending = (await d.syncQueue.toArray()).filter((q) => ids.has(q.entityId));
  if (pending.length) throw new PendingSyncError(pending.length);

  const now = new Date().toISOString();
  // 도메인 × id 목록을 **한 번만** 만든다 — 표식·전파 op·하드 삭제가 모두 같은 목록을 쓴다.
  // 예전엔 이 셋이 각자 자기 목록을 갖고 있어서 한 곳만 빠지는 사고가 반복됐다(§7).
  const targets: { id: string; domain: PurgeDomain }[] = [
    { id, domain: 'trip' },
    ...moments.map((m) => ({ id: m.id, domain: 'moment' as const })),
    ...media.map((m) => ({ id: m.id, domain: 'media' as const })),
    ...expenses.map((e) => ({ id: e.id, domain: 'expense' as const })),
    ...audio.map((a) => ({ id: a.id, domain: 'audio' as const })),
  ];
  const marks: PurgedId[] = purgeMarks(targets, now);
  // ③ **서버에서 실제로 지운다**(ADR-0030) — 서버 행을 하드 삭제하는 작업을 큐에 넣는다.
  //    이게 없으면 영구삭제가 이 기기에서만 일어나 다른 기기 휴지통엔 그대로 남는다
  //    (사용자 지적 2026-07-26: "다른 기기에서 휴지통을 비웠으면 연동기기에서도 사라져야").
  const purgeOps: SyncQueueItem[] = targets.map((t) => ({
    operationId: uuid(),
    entityType: purgeOpType(t.domain),
    entityId: t.id,
    operationType: 'purge',
    state: 'local_only',
    attempts: 0,
    createdAt: now,
  }));

  // 표 7개는 Dexie의 가변인자 오버로드 한도를 넘어 배열 형태를 쓴다(동작은 같다).
  await d.transaction('rw', [d.localTrips, d.localMoments, d.localMedia, d.localExpenses, d.localAudio, d.purgedIds, d.syncQueue], async () => {
    // ② 표식을 **먼저** 넣는다. 중간에 실패해도 "지웠는데 표식이 없어 되살아나는" 창이 생기지 않는다.
    await d.purgedIds.bulkPut(marks);
    for (const op of purgeOps) await d.syncQueue.add(op);
    if (media.length) await d.localMedia.bulkDelete(media.map((m) => m.id));
    if (expenses.length) await d.localExpenses.bulkDelete(expenses.map((e) => e.id));
    if (audio.length) await d.localAudio.bulkDelete(audio.map((a) => a.id));
    if (moments.length) await d.localMoments.bulkDelete(moments.map((m) => m.id));
    await d.localTrips.delete(id);
  });

  const back = await d.localTrips.get(id);
  if (back) throw new Error('영구 삭제 확인 실패: 행이 남아 있음');
  // 바이트가 실제로 사라졌는지 **되읽어** 확인한다(성공 반환을 믿지 않는다).
  const audioLeft = await d.localAudio.where('tripId').equals(id).count();
  if (audioLeft) throw new Error('영구 삭제 확인 실패: 소리 행이 남아 있음');
  if (!(await d.purgedIds.get(id))) throw new Error('영구 삭제 확인 실패: 표식이 남지 않음');
  const queuedPurges = (await d.syncQueue.toArray()).filter((q) => q.operationType === 'purge').length;
  if (queuedPurges < targets.length) {
    throw new Error('영구 삭제 확인 실패: 다른 기기에 알릴 작업이 큐에 남지 않음');
  }
}

/** 홈 목록 (tombstone·보관 제외 — deletedAt/status는 filter, M-0005). */
export async function listTrips(): Promise<LocalTrip[]> {
  const d = db();
  const all = await d.localTrips.orderBy('updatedAt').reverse().toArray();
  return all.filter((t) => t.deletedAt === null && t.status !== 'archived');
}

/** 보관함 목록 (보관 상태만, tombstone 제외). */
export async function listArchivedTrips(): Promise<LocalTrip[]> {
  const d = db();
  const all = await d.localTrips.orderBy('updatedAt').reverse().toArray();
  return all.filter((t) => t.deletedAt === null && t.status === 'archived');
}

/** 동기화 대기 중인 작업 수 (UI 상태 표시용 — false/null 과적재 금지, 숫자로 반환). */
/**
 * 아직 서버에 못 간 작업 수.
 *
 * ⚠️ 결함 이력(2026-07-25): 예전에는 `local_only`만 셌다 → **실패한 작업(`retryable_failed`·
 * `permanent_failed`)이 숨어서**, 화면은 "동기화됨"인데 실제로는 서버에 못 간 변경이 쌓여
 * 있을 수 있었다. 미완료는 상태와 무관하게 전부 센다 — 사용자가 모르는 채로 잃는 것이 없게.
 */
export async function pendingSyncCount(): Promise<number> {
  return db().syncQueue.count();
}
