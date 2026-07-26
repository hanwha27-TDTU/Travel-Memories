// services/sync.ts — 동기화 push/pull 오케스트레이션 (docs/SYNC_PROTOCOL.md).
// 핵심 불변식을 코드로: 멱등 upsert(operation) + 정확한 read-back + LWW 서버시각 반영
// + 빈-클라우드 가드 + 병합(교체 아님). 네트워크는 TripsRemote 포트 뒤로 격리해
// 순수 결정 로직(sync/merge.ts)을 직접 테스트할 수 있게 한다(LESSONS §6).

import { db, type SyncQueueItem, type LocalMedia } from '../offline/db';
import { toRow, fromRow, type TripRow } from '../domain/trip/rowmap';
import { toMomentRow, fromMomentRow, type MomentRow } from '../domain/moment/rowmap';
import { toExpenseRow, fromExpenseRow, type ExpenseRow } from '../domain/expense/rowmap';
import { toMediaRow, fromMediaRow, mediaStoragePath, type MediaRow } from '../domain/media/rowmap';
import { compressForStorage } from '../media/compress';
import { mergeDecision, isEmptyCloudAnomaly, classifyError } from '../sync/merge';
import type { JourneyClient } from './supabase/client';
import { r2BlobStore, mediaStoreKind, mediaIdFromPath, type BlobStore } from './r2';
import { deviceStamp } from '../app/deviceId';
import {
  applyPurgedLedger,
  purgedIdSet,
  purgeDomainOf,
  DOMAIN_PURGE,
  PURGE_DOMAINS,
  type PurgeDomain,
} from './purge';

export interface SyncResult {
  pushed: number;
  failed: number;
  pulled: number;
  skippedEmptyCloud: boolean;
}

/** 원격 저장소 포트 — 네트워크 격리(테스트 시 fake 주입). */
export interface TripsRemote {
  upsert(row: TripRow): Promise<{ error?: string | undefined; status?: number | undefined }>;
  getById(id: string): Promise<{ data: TripRow | null; error?: string | undefined; status?: number | undefined }>;
  listAll(): Promise<{ data: TripRow[]; error?: string | undefined }>;
}

/** JourneyClient를 TripsRemote로 감싸는 얇은 어댑터(untested glue). */
export function tripsRemote(client: JourneyClient): TripsRemote {
  return {
    async upsert(row) {
      try {
        const r = await client.from('trips').upsert(row, { onConflict: 'id' });
        return { error: r.error?.message, status: r.status };
      } catch (e) {
        return { error: (e as Error).message }; // 네트워크 throw → status undefined(재시도)
      }
    },
    async getById(id) {
      try {
        const r = await client.from('trips').select('*').eq('id', id).maybeSingle();
        return { data: (r.data as TripRow | null) ?? null, error: r.error?.message, status: r.status };
      } catch (e) {
        return { data: null, error: (e as Error).message };
      }
    },
    async listAll() {
      try {
        const r = await client.from('trips').select('*');
        return { data: (r.data as TripRow[] | null) ?? [], error: r.error?.message };
      } catch (e) {
        return { data: [], error: (e as Error).message };
      }
    },
  };
}

/** 순간 원격 포트 — 네트워크 격리(trips와 대칭). */
export interface MomentsRemote {
  upsert(row: MomentRow): Promise<{ error?: string | undefined; status?: number | undefined }>;
  getById(id: string): Promise<{ data: MomentRow | null; error?: string | undefined; status?: number | undefined }>;
  listAll(): Promise<{ data: MomentRow[]; error?: string | undefined }>;
}

export function momentsRemote(client: JourneyClient): MomentsRemote {
  return {
    async upsert(row) {
      try {
        const r = await client.from('moments').upsert(row, { onConflict: 'id' });
        return { error: r.error?.message, status: r.status };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    async getById(id) {
      try {
        const r = await client.from('moments').select('*').eq('id', id).maybeSingle();
        return { data: (r.data as MomentRow | null) ?? null, error: r.error?.message, status: r.status };
      } catch (e) {
        return { data: null, error: (e as Error).message };
      }
    },
    async listAll() {
      try {
        const r = await client.from('moments').select('*');
        return { data: (r.data as MomentRow[] | null) ?? [], error: r.error?.message };
      } catch (e) {
        return { data: [], error: (e as Error).message };
      }
    },
  };
}

/** 비용 원격 포트 — 네트워크 격리(moments와 대칭). */
export interface ExpensesRemote {
  upsert(row: ExpenseRow): Promise<{ error?: string | undefined; status?: number | undefined }>;
  getById(id: string): Promise<{ data: ExpenseRow | null; error?: string | undefined; status?: number | undefined }>;
  listAll(): Promise<{ data: ExpenseRow[]; error?: string | undefined }>;
}

export function expensesRemote(client: JourneyClient): ExpensesRemote {
  return {
    async upsert(row) {
      try {
        const r = await client.from('expenses').upsert(row, { onConflict: 'id' });
        return { error: r.error?.message, status: r.status };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    async getById(id) {
      try {
        const r = await client.from('expenses').select('*').eq('id', id).maybeSingle();
        return { data: (r.data as ExpenseRow | null) ?? null, error: r.error?.message, status: r.status };
      } catch (e) {
        return { data: null, error: (e as Error).message };
      }
    },
    async listAll() {
      try {
        const r = await client.from('expenses').select('*');
        return { data: (r.data as ExpenseRow[] | null) ?? [], error: r.error?.message };
      } catch (e) {
        return { data: [], error: (e as Error).message };
      }
    },
  };
}

/** 사진 원격 포트 — 메타(테이블) + 표시본(Storage). 원본은 서버에 올리지 않는다(절약 모드·§0). */
export interface MediaRemote {
  upsert(row: MediaRow): Promise<{ error?: string | undefined; status?: number | undefined }>;
  getById(id: string): Promise<{ data: MediaRow | null; error?: string | undefined; status?: number | undefined }>;
  listAll(): Promise<{ data: MediaRow[]; error?: string | undefined }>;
  uploadDisplay(path: string, blob: Blob): Promise<{ error?: string | undefined; status?: number | undefined }>;
  download(path: string): Promise<{ data: Blob | null; error?: string | undefined; status?: number | undefined }>;
  remove(path: string): Promise<{ error?: string | undefined }>;
}

/** 사진 바이트가 사는 Supabase 버킷 이름 — 문자열을 두 곳에 손으로 적지 않는다. */
export const MEDIA_BUCKET = 'journey-media';

/**
 * **Supabase Storage에 실제로 있는 사진 id들**(진단의 파일 대조용).
 *
 * 왜 R2만 보면 안 되는가(2026-07-26 발견): 저장소는 지금 **혼재 상태**다. R2 전환(07-25)
 * 이전에 올린 사진의 바이트는 **여전히 Supabase Storage에 있고**, 그 사실은
 * `docs/HANDOFF.md` Phase 9c에 이미 적혀 있었다("옛 Supabase 객체 스윕은 4번 통과 전까지
 * 하지 않는다 — 혼재 상태"). R2만 훑고 "파일이 없다"고 판정하면 **멀쩡한 사진 여러 장을
 * 문제로 단정하는 거짓 경보**가 된다 — M-0008에서 이미 한 번 저지른 실수다.
 */
export async function supabaseMediaIds(
  client: JourneyClient,
  userId: string,
): Promise<{ ids: string[]; error?: string | undefined }> {
  try {
    const r = await client.storage.from(MEDIA_BUCKET).list(userId, { limit: 1000 });
    if (r.error) return { ids: [], error: r.error.message };
    const ids: string[] = [];
    for (const f of r.data ?? []) {
      const id = mediaIdFromPath(f.name);
      if (id) ids.push(id);
    }
    return { ids };
  } catch (e) {
    return { ids: [], error: (e as Error).message };
  }
}

/**
 * **옛 저장소(Supabase Storage) 전용** 바이트 어댑터.
 *
 * `mediaRemote`는 `VITE_MEDIA_STORE`에 따라 R2로 갈아끼워지므로, R2가 켜진 상태에서
 * *옛 저장소를* 읽을 방법이 없다. 이관(`mediaMigrate`)은 두 저장소를 **동시에** 만져야 하니
 * 여기 하나를 따로 둔다. 환경변수를 보지 않는 것이 이 함수의 요점이다.
 */
export function supabaseBlobStore(client: JourneyClient): BlobStore {
  const bucket = client.storage.from(MEDIA_BUCKET);
  return {
    async uploadDisplay(path, blob) {
      try {
        const r = await bucket.upload(path, blob, { upsert: true, contentType: 'image/webp' });
        return { error: r.error?.message };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    async download(path) {
      try {
        const r = await bucket.download(path);
        return { data: r.data ?? null, error: r.error?.message };
      } catch (e) {
        return { data: null, error: (e as Error).message };
      }
    },
    async remove(path) {
      try {
        const r = await bucket.remove([path]);
        return { error: r.error?.message };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
  };
}

export function mediaRemote(client: JourneyClient): MediaRemote {
  const bucket = client.storage.from(MEDIA_BUCKET);
  // 바이트 3종만 어댑터 교체 가능(ADR-0024). 메타·RLS·병합 규율은 어느 쪽이든 동일하다.
  // 기본값은 Supabase Storage — R2는 VITE_MEDIA_STORE=r2로 **명시적으로만** 켜진다.
  const blobs: BlobStore | null = mediaStoreKind() === 'r2' ? r2BlobStore(client) : null;
  return {
    async upsert(row) {
      try {
        const r = await client.from('media').upsert(row, { onConflict: 'id' });
        return { error: r.error?.message, status: r.status };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    async getById(id) {
      try {
        const r = await client.from('media').select('*').eq('id', id).maybeSingle();
        return { data: (r.data as MediaRow | null) ?? null, error: r.error?.message, status: r.status };
      } catch (e) {
        return { data: null, error: (e as Error).message };
      }
    },
    async listAll() {
      try {
        const r = await client.from('media').select('*');
        return { data: (r.data as MediaRow[] | null) ?? [], error: r.error?.message };
      } catch (e) {
        return { data: [], error: (e as Error).message };
      }
    },
    async uploadDisplay(path, blob) {
      if (blobs) return blobs.uploadDisplay(path, blob);
      try {
        const r = await bucket.upload(path, blob, { upsert: true, contentType: 'image/webp' });
        return { error: r.error?.message };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    async download(path) {
      if (blobs) return blobs.download(path);
      try {
        const r = await bucket.download(path);
        return { data: r.data ?? null, error: r.error?.message };
      } catch (e) {
        return { data: null, error: (e as Error).message };
      }
    },
    async remove(path) {
      if (blobs) return blobs.remove(path);
      try {
        const r = await bucket.remove([path]);
        return { error: r.error?.message };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
  };
}

async function markFail(op: SyncQueueItem, status: number | undefined): Promise<void> {
  const kind = classifyError(status);
  await db().syncQueue.update(op.operationId, {
    state: kind === 'retryable' ? 'retryable_failed' : 'permanent_failed',
    attempts: (op.attempts ?? 0) + 1,
  });
}

/**
 * 대기열의 로컬 작업을 서버에 반영. 각 작업마다:
 * upsert(멱등) → 별도 read-back으로 일치 확인 → 서버시각/version 로컬 반영 → 작업 제거.
 * HTTP 성공/upsert 표현만으로 완료 처리하지 않는다(불변식 5).
 */
export async function pushPending(remote: TripsRemote, userId: string): Promise<{ pushed: number; failed: number }> {
  const d = db();
  const items = (await d.syncQueue.orderBy('createdAt').toArray()).filter(
    (q) => q.state === 'local_only' || q.state === 'retryable_failed',
  );
  let pushed = 0;
  let failed = 0;

  for (const op of items) {
    if (op.entityType !== 'trip') continue;
    const trip = await d.localTrips.get(op.entityId);
    if (!trip) {
      await d.syncQueue.delete(op.operationId); // 로컬에 없는 고아 작업 폐기
      continue;
    }

    const up = await remote.upsert(toRow(trip, userId, deviceStamp()));
    if (up.error) {
      await markFail(op, up.status);
      failed++;
      continue;
    }

    // 정확한 read-back: 같은 레코드를 별도 조회해 확인(불변식 5).
    const back = await remote.getById(trip.id);
    if (back.error || !back.data || back.data.title !== trip.title) {
      await markFail(op, back.status);
      failed++;
      continue;
    }

    // LWW 서버시각 반영 + 작업 원자 제거.
    const serverTrip = fromRow(back.data);
    await d.transaction('rw', d.localTrips, d.syncQueue, async () => {
      const cur = await d.localTrips.get(trip.id);
      if (cur) await d.localTrips.put({ ...cur, updatedAt: serverTrip.updatedAt, version: serverTrip.version });
      await d.syncQueue.delete(op.operationId);
    });
    pushed++;
  }
  return { pushed, failed };
}

/**
 * 서버의 내 여행을 로컬에 병합(교체 아님). 빈-클라우드 가드로 로컬을 지키고,
 * 각 행은 LWW/tombstone 결정으로만 반영한다. 서버에 없는 로컬 행은 지우지 않는다
 * (아직 push 안 된 로컬 전용일 수 있음).
 */
export async function pullTrips(remote: TripsRemote): Promise<{ pulled: number; skippedEmptyCloud: boolean }> {
  const d = db();
  const res = await remote.listAll();
  if (res.error) throw new Error(res.error);
  const serverRows = res.data;

  const purged = await purgedIdSet();
  const localActive = (await d.localTrips.toArray()).filter((t) => t.deletedAt === null).length;
  if (isEmptyCloudAnomaly(serverRows.length, localActive)) {
    return { pulled: 0, skippedEmptyCloud: true }; // 로컬 보존
  }

  let pulled = 0;
  for (const r of serverRows) {
    // 영구삭제된 것은 **서버에 행 자체가 없다**(ADR-0030) — 여기서 볼 일이 없다.
    // 다른 기기의 영구삭제는 pull이 아니라 **서버 원장**(`applyPurgedLedger`)이 알려준다.
    if (purged.has(r.id)) continue; // 이 기기에서 영구히 치운 것 — 되살리지 않는다
    const server = fromRow(r);
    const local = await d.localTrips.get(server.id);
    if (mergeDecision(local, server) === 'take-server') {
      await d.localTrips.put(server);
      pulled++;
    } else {
      await requeueIfServerStillActive('trip', local, server);
    }
  }
  return { pulled, skippedEmptyCloud: false };
}

/** 순간 대기열 push(trips와 대칭: 멱등 upsert → read-back → 서버시각 반영 → 작업 제거). */
export async function pushPendingMoments(
  remote: MomentsRemote,
  userId: string,
): Promise<{ pushed: number; failed: number }> {
  const d = db();
  const items = (await d.syncQueue.orderBy('createdAt').toArray()).filter(
    (q) => q.state === 'local_only' || q.state === 'retryable_failed',
  );
  let pushed = 0;
  let failed = 0;

  for (const op of items) {
    if (op.entityType !== 'moment') continue;
    const moment = await d.localMoments.get(op.entityId);
    if (!moment) {
      await d.syncQueue.delete(op.operationId);
      continue;
    }

    const up = await remote.upsert(toMomentRow(moment, userId, deviceStamp()));
    if (up.error) {
      await markFail(op, up.status);
      failed++;
      continue;
    }

    const back = await remote.getById(moment.id);
    if (back.error || !back.data || back.data.title !== moment.title) {
      await markFail(op, back.status);
      failed++;
      continue;
    }

    const serverMoment = fromMomentRow(back.data);
    await d.transaction('rw', d.localMoments, d.syncQueue, async () => {
      const cur = await d.localMoments.get(moment.id);
      if (cur) await d.localMoments.put({ ...cur, updatedAt: serverMoment.updatedAt, version: serverMoment.version });
      await d.syncQueue.delete(op.operationId);
    });
    pushed++;
  }
  return { pushed, failed };
}

/** 서버의 내 순간을 로컬에 병합(교체 아님, 빈-클라우드 가드, LWW/tombstone). */
export async function pullMoments(remote: MomentsRemote): Promise<{ pulled: number; skippedEmptyCloud: boolean }> {
  const d = db();
  const res = await remote.listAll();
  if (res.error) throw new Error(res.error);
  const serverRows = res.data;

  const purged = await purgedIdSet();
  const localActive = (await d.localMoments.toArray()).filter((m) => m.deletedAt === null).length;
  if (isEmptyCloudAnomaly(serverRows.length, localActive)) {
    return { pulled: 0, skippedEmptyCloud: true };
  }

  let pulled = 0;
  for (const r of serverRows) {
    // 영구삭제된 것은 **서버에 행 자체가 없다**(ADR-0030) — 여기서 볼 일이 없다.
    // 다른 기기의 영구삭제는 pull이 아니라 **서버 원장**(`applyPurgedLedger`)이 알려준다.
    if (purged.has(r.id)) continue; // 이 기기에서 영구히 치운 것 — 되살리지 않는다
    const server = fromMomentRow(r);
    const local = await d.localMoments.get(server.id);
    if (mergeDecision(local, server) === 'take-server') {
      await d.localMoments.put(server);
      pulled++;
    } else {
      await requeueIfServerStillActive('moment', local, server);
    }
  }
  return { pulled, skippedEmptyCloud: false };
}

/** 비용 대기열 push(moments와 대칭: 멱등 upsert → read-back → 서버시각 반영 → 작업 제거). */
export async function pushPendingExpenses(
  remote: ExpensesRemote,
  userId: string,
): Promise<{ pushed: number; failed: number }> {
  const d = db();
  const items = (await d.syncQueue.orderBy('createdAt').toArray()).filter(
    (q) => q.state === 'local_only' || q.state === 'retryable_failed',
  );
  let pushed = 0;
  let failed = 0;

  for (const op of items) {
    if (op.entityType !== 'expense') continue;
    const expense = await d.localExpenses.get(op.entityId);
    if (!expense) {
      await d.syncQueue.delete(op.operationId);
      continue;
    }

    const up = await remote.upsert(toExpenseRow(expense, userId, deviceStamp()));
    if (up.error) {
      await markFail(op, up.status);
      failed++;
      continue;
    }

    const back = await remote.getById(expense.id);
    if (back.error || !back.data || back.data.original_amount !== expense.originalAmount) {
      await markFail(op, back.status);
      failed++;
      continue;
    }

    const serverExpense = fromExpenseRow(back.data);
    await d.transaction('rw', d.localExpenses, d.syncQueue, async () => {
      const cur = await d.localExpenses.get(expense.id);
      if (cur) await d.localExpenses.put({ ...cur, updatedAt: serverExpense.updatedAt, version: serverExpense.version });
      await d.syncQueue.delete(op.operationId);
    });
    pushed++;
  }
  return { pushed, failed };
}

/** 서버의 내 비용을 로컬에 병합(교체 아님, 빈-클라우드 가드, LWW/tombstone). */
export async function pullExpenses(remote: ExpensesRemote): Promise<{ pulled: number; skippedEmptyCloud: boolean }> {
  const d = db();
  const res = await remote.listAll();
  if (res.error) throw new Error(res.error);
  const serverRows = res.data;

  const purged = await purgedIdSet();
  const localActive = (await d.localExpenses.toArray()).filter((e) => e.deletedAt === null).length;
  if (isEmptyCloudAnomaly(serverRows.length, localActive)) {
    return { pulled: 0, skippedEmptyCloud: true };
  }

  let pulled = 0;
  for (const r of serverRows) {
    // 영구삭제된 것은 **서버에 행 자체가 없다**(ADR-0030) — 여기서 볼 일이 없다.
    // 다른 기기의 영구삭제는 pull이 아니라 **서버 원장**(`applyPurgedLedger`)이 알려준다.
    if (purged.has(r.id)) continue; // 이 기기에서 영구히 치운 것 — 되살리지 않는다
    const server = fromExpenseRow(r);
    const local = await d.localExpenses.get(server.id);
    if (mergeDecision(local, server) === 'take-server') {
      await d.localExpenses.put(server);
      pulled++;
    } else {
      await requeueIfServerStillActive('expense', local, server);
    }
  }
  return { pulled, skippedEmptyCloud: false };
}

/**
 * 사진 push(추가전용): 활성이면 표시본을 Storage에 올리고(원본은 안 올림), 메타 행을 upsert →
 * read-back → 서버시각 반영 → 작업 제거. tombstone이면 업로드 없이 메타만(Storage는 고아 스윕으로 정리).
 */
export async function pushPendingMedia(remote: MediaRemote, userId: string): Promise<{ pushed: number; failed: number }> {
  const d = db();
  const items = (await d.syncQueue.orderBy('createdAt').toArray()).filter(
    (q) => q.state === 'local_only' || q.state === 'retryable_failed',
  );
  let pushed = 0;
  let failed = 0;

  for (const op of items) {
    if (op.entityType !== 'media') continue;
    const media = await d.localMedia.get(op.entityId);
    if (!media) {
      await d.syncQueue.delete(op.operationId);
      continue;
    }
    const path = mediaStoragePath(userId, media.id);
    if (media.deletedAt === null) {
      const up = await remote.uploadDisplay(path, media.displayBlob); // 표시본만(원본 미업로드)
      if (up.error) {
        await markFail(op, up.status);
        failed++;
        continue;
      }
    }
    const res = await remote.upsert(toMediaRow(media, userId, path, deviceStamp()));
    if (res.error) {
      await markFail(op, res.status);
      failed++;
      continue;
    }
    const back = await remote.getById(media.id);
    if (back.error || !back.data) {
      await markFail(op, back.status);
      failed++;
      continue;
    }
    const server = fromMediaRow(back.data);
    await d.transaction('rw', d.localMedia, d.syncQueue, async () => {
      const cur = await d.localMedia.get(media.id);
      if (cur) await d.localMedia.put({ ...cur, updatedAt: server.updatedAt, version: server.version });
      await d.syncQueue.delete(op.operationId);
    });
    // ⚠️ 여기서 바이트를 지우지 않는다(정책 변경 2026-07-26, 사용자 결정).
    //
    // 예전에는 tombstone을 밀면서 곧바로 `remote.remove(path)`로 서버 사진을 지웠다. 그러면
    // **휴지통에 있는 동안 사진이 이미 서버에 없다.** 복원은 "사본을 아직 가진 기기가 다시
    // 올리는" 방식이라, 그 기기에서 사이트데이터를 지웠거나 애초에 그 사진을 안 받은 기기에서만
    // 복원하면 **사진이 영영 안 돌아왔다.** 휴지통이 사진에 대해서는 휴지통이 아니었다
    // (비타협 원칙 #1과 정면으로 어긋난다).
    //
    // 이제 바이트는 **영구삭제(휴지통 비우기) 시점에만** 지운다 — `pushPurges`가 담당한다.
    // 대가는 휴지통에 머무는 동안의 저장 공간뿐이고, R2 무료 한도 10GB에서 무시할 수준이다.
    pushed++;
  }
  return { pushed, failed };
}

/**
 * 사진 pull(비파괴): 서버가 더 최신일 때만 반영. tombstone은 로컬 blob을 지우지 않고 deletedAt만 세팅
 * (로컬에 없으면 skip). 활성은 표시본을 다운로드해 재구성하되 다운로드 실패 시 로컬을 그대로 둔다.
 * 원본은 소비 기기에 없으므로 표시본을 원본 폴백으로 둔다(절약 모드). GPS는 서버에 없어 로컬 값 유지.
 */
export async function pullMedia(remote: MediaRemote): Promise<{ pulled: number; skippedEmptyCloud: boolean }> {
  const d = db();
  const res = await remote.listAll();
  if (res.error) throw new Error(res.error);
  const rows = res.data;

  const purged = await purgedIdSet();
  const localActive = (await d.localMedia.toArray()).filter((m) => m.deletedAt === null).length;
  if (isEmptyCloudAnomaly(rows.length, localActive)) {
    return { pulled: 0, skippedEmptyCloud: true };
  }

  let pulled = 0;
  let swept = 0; // 로컬에 없는 서버 고아를 정리한 수(진단·로그용)
  for (const r of rows) {
    // 영구삭제된 것은 **서버에 행 자체가 없다**(ADR-0030) — 여기서 볼 일이 없다.
    // 다른 기기의 영구삭제는 pull이 아니라 **서버 원장**(`applyPurgedLedger`)이 알려준다.
    if (purged.has(r.id)) continue; // 이 기기에서 영구히 치운 것 — 되살리지 않는다
    const server = fromMediaRow(r);
    const local = await d.localMedia.get(server.id);
    if (mergeDecision(local, server) !== 'take-server') {
      await requeueIfServerStillActive('media', local, server);
      continue;
    }

    // ── 서버 기준 고아 스윕 ──────────────────────────────────────────────
    // **로컬에 행 자체가 없는데** 서버는 활성이고, 그 여행이 이 기기에서 영구삭제된 경우.
    // 로컬 행이 없으므로 대기열 op를 만들 수도, `pushPendingMedia`가 처리할 수도 없다 —
    // 재큐잉으로는 **원리적으로 닿지 않는 사각지대**다(사용자가 겪은 바로 그 상태).
    // 여기서만 직접 tombstone을 밀고 바이트를 지운다. 되살려 로컬에 만들지 않는다.
    if (!local && server.deletedAt === null && purged.has(r.trip_id)) {
      const res = await remote.upsert({ ...r, deleted_at: new Date().toISOString(), version: r.version + 1 });
      if (!res.error) {
        if (server.storagePath) await remote.remove(server.storagePath);
        swept++;
      }
      continue; // 되살리지 않는다
    }

    if (server.deletedAt !== null) {
      // tombstone — blob 파괴 없이 삭제 표시만. 로컬에 없으면 만들 blob이 없고 필요도 없어 skip.
      if (local) {
        await d.localMedia.put({ ...local, deletedAt: server.deletedAt, version: server.version, updatedAt: server.updatedAt });
        pulled++;
      }
      continue;
    }

    if (!server.storagePath) continue; // 아직 표시본 업로드 전 → skip(다음 sync)
    const dl = await remote.download(server.storagePath);
    if (dl.error || !dl.data) continue; // 다운로드 실패 → 로컬 보존(비파괴), 다음에 재시도
    const display = dl.data;
    let thumbBlob: Blob = display;
    try {
      thumbBlob = (await compressForStorage(display)).thumb.blob;
    } catch {
      /* 썸네일 재생성 실패 시 표시본으로 폴백 */
    }
    const next: LocalMedia = {
      id: server.id,
      momentId: server.momentId,
      tripId: server.tripId,
      mime: 'image/webp',
      originalBlob: local?.originalBlob ?? display, // 소비 기기엔 원본 없음 → 표시본 폴백
      displayBlob: display,
      thumbBlob,
      width: server.width,
      height: server.height,
      takenAt: server.takenAt,
      gpsLat: local?.gpsLat ?? null,
      gpsLng: local?.gpsLng ?? null,
      bytesOriginal: local?.bytesOriginal ?? display.size,
      bytesDisplay: display.size,
      version: server.version,
      createdAt: server.createdAt,
      updatedAt: server.updatedAt,
      deletedAt: null,
      ...(local?.editState ? { editState: local.editState } : {}),
    };
    await d.localMedia.put(next);
    pulled++;
  }
  if (swept) console.info(`서버 고아 정리: 사진 ${swept}건(로컬에 없어 재큐잉이 닿지 못하던 것)`);
  return { pulled, skippedEmptyCloud: false };
}

/**
 * 로그인/온라인 시 전체 동기화. push 먼저(로컬 우선 전송) → pull 병합.
 * push 순서: 여행 → 순간 → 사진·비용(자식의 복합 FK가 서버의 부모 존재를 요구).
 */
/**
 * 일회성 정합 복구 — cascade op 누락 결함(2026-07-25, `trips.ts`)의 **이미 발생한 피해**를 되돌린다.
 *
 * 그 결함으로 여행을 지운 사용자는 로컬에 tombstone이 있는데 **대기열 op가 없는** 사진·비용을
 * 갖게 됐다. op가 없으면 push가 영원히 일어나지 않으므로, 코드를 고치는 것만으로는 서버 행이
 * 활성으로 남고 R2 객체도 잔류한다 — 그래서 재큐잉이 필요하다.
 *
 * 안전성: 데이터를 지우지 않는다(대기열에 op를 넣을 뿐). push는 멱등이라 이미 반영된 항목을
 * 한 번 더 밀어도 결과가 같고, tombstone→tombstone은 좀비 트리거의 검사 대상이 아니다.
 * 정상 상태에서 재실행되면 대상이 0이지만, 완료된 tombstone까지 다시 밀지 않도록 호출부에서
 * 1회만 실행한다.
 */
export async function requeueOrphanTombstones(): Promise<{ media: number; expenses: number }> {
  const d = db();
  const queued = new Set((await d.syncQueue.toArray()).map((q) => `${q.entityType}:${q.entityId}`));
  const now = new Date().toISOString();
  let media = 0;
  let expenses = 0;

  for (const m of await d.localMedia.toArray()) {
    if (m.deletedAt === null || queued.has(`media:${m.id}`)) continue;
    await d.syncQueue.add({
      operationId: crypto.randomUUID(),
      entityType: 'media',
      entityId: m.id,
      operationType: 'delete',
      state: 'local_only',
      attempts: 0,
      createdAt: now,
    });
    media++;
  }
  for (const e of await d.localExpenses.toArray()) {
    if (e.deletedAt === null || queued.has(`expense:${e.id}`)) continue;
    await d.syncQueue.add({
      operationId: crypto.randomUUID(),
      entityType: 'expense',
      entityId: e.id,
      operationType: 'delete',
      state: 'local_only',
      attempts: 0,
      createdAt: now,
    });
    expenses++;
  }
  return { media, expenses };
}

/**
 * **서버가 아직 살아 있는데 로컬은 지운 상태**면 삭제를 다시 대기열에 올린다.
 *
 * 왜 pull에 두나: pull은 이미 서버 상태를 받아왔으므로 **추가 비용 0으로 정확히** 판정할 수
 * 있다. "로컬 tombstone + 서버 활성" = 그 삭제가 서버에 도달하지 못했다는 **직접 증거**다.
 *
 * ⚠️ 설계 이력(2026-07-25): 처음에는 `requeueOrphanTombstones`를 **1회만** 실행했다("완료된
 * tombstone까지 매번 다시 밀지 않도록"). 그 대가로 **표식이 찍힌 뒤에 생긴 고아는 영영 잡히지
 * 않았고**, 사용자는 지운 사진이 R2에 남는 것을 계속 봤다. 로컬만 보면 "이미 서버에 갔는지"를
 * 알 수 없다는 게 뿌리였다 — 서버와 대조하면 그 모호함이 사라진다.
 */
async function requeueIfServerStillActive(
  entityType: 'trip' | 'moment' | 'media' | 'expense',
  local: { id: string; deletedAt: string | null } | undefined,
  server: { deletedAt: string | null },
): Promise<void> {
  if (!local || local.deletedAt === null || server.deletedAt !== null) return;
  const d = db();
  const already = (await d.syncQueue.where('entityId').equals(local.id).toArray()).some(
    (q) => q.entityType === entityType,
  );
  if (already) return;
  await d.syncQueue.add({
    operationId: crypto.randomUUID(),
    entityType,
    entityId: local.id,
    operationType: 'delete',
    state: 'local_only',
    attempts: 0,
    createdAt: new Date().toISOString(),
  });
}


/** 정합 복구 1회 실행 표식. 완료된 tombstone까지 매번 다시 밀지 않도록 잠근다. */
const REPAIR_KEY = 'bj.repair.cascadeOps.v1';

/**
 * 실패로 박힌 작업을 다시 시도 가능한 상태로 되돌린다(진단 화면의 [실패 재시도]).
 *
 * ⚠️ push는 `local_only`·`retryable_failed`만 처리하므로 `permanent_failed`는 **영원히 큐에
 * 남아 아무 일도 하지 않으면서**, 영구삭제 사전 조건까지 막는다(대기 작업으로 세어진다).
 * 사용자가 스스로 풀 수단이 없던 자리다. 데이터를 바꾸지 않고 상태만 되돌린다.
 */
/**
 * 영구삭제 전파 포트 — **행을 실제로 지우고, 지운 id만 원장에 남긴다**(ADR-0030).
 *
 * 왜 바뀌었나(사용자 결정 2026-07-26): *"의도를 가지고 삭제하는건데 서버에 왜 살려두나요?
 * … 2번 이상 클릭으로 삭제한거라면 영원히 복구가 안되도록 기록줄까지도 삭제시켜야."*
 *
 * ADR-0027이 행을 남긴 **유일한 이유는 좀비 방지**였다("사정 모르는 다른 기기가 다시 올린다").
 * 그런데 그건 "행을 남긴다"가 아니라 **"서버가 재삽입을 거부한다"**로 푸는 게 옳다 —
 * `journey.purged_ids` 원장 + BEFORE INSERT 트리거(마이그레이션 0012)가 그 일을 한다.
 * 그러면 자료를 살려둘 이유가 사라진다. 원장엔 **id·소유자·시각만** 남고 제목·메모·좌표·금액은
 * 서버에서 사라진다.
 *
 * 도메인별 함수를 네 벌 만들지 않는다 — 등록부(DOMAIN_PURGE)의 테이블 이름만 갈아끼운다
 * (CLAUDE.md §7 "규칙을 한 곳에만 구현한다").
 */
export interface PurgeRemote {
  /**
   * 원장에 id를 적는다(멱등 — 이미 있으면 무시). **자료를 지우기 전에** 적어야 한다:
   * 지운 뒤에 적으면 그 사이에 다른 기기가 자기 사본을 다시 올릴 수 있다.
   */
  ledgerAdd(ids: string[]): Promise<{ error?: string | undefined }>;
  /** read-back — 성공 응답이 아니라 **되읽어** 확인한다(데이터 안전 불변식). */
  ledgerHas(id: string): Promise<{ found: boolean; error?: string | undefined }>;
  /** 서버 원장 전체. 다른 기기의 영구삭제는 pull이 아니라 **여기서** 배운다(행이 없으므로). */
  ledgerAll(): Promise<{ ids: string[]; error?: string | undefined }>;
  /**
   * 그 여행에 딸린 **서버의 자식 id 전부**(`trip_id = X`).
   *
   * 왜 서버에 묻는가(실제 결함 M-0016, 2026-07-26 사용자 신고에서 발견): `purgeTripPermanently`는
   * 자식을 **로컬 Dexie에서만** 찾는다. tombstone된 사진은 그 기기에 로컬 행이 없을 수 있다 —
   * `pullMedia`가 "로컬에 없는 tombstone은 만들지 않는다"(비파괴 규율)로 건너뛰기 때문이다.
   * 그래서 여행 "R2 테스트"를 영구삭제했을 때 **사진 하나만 서버에 남았다.**
   * 로컬이 못 보는 자식은 **서버가 안다.**
   */
  familyIds(tripId: string): Promise<{ ids: string[]; error?: string | undefined }>;
  /** 그 여행 사진의 서버 경로들. **행을 지우기 전에** 물어야 한다 — 행이 사라지면 경로도 사라진다. */
  familyMediaPaths(tripId: string): Promise<{ paths: string[]; error?: string | undefined }>;
  /** 사진 하나의 서버 경로. 위와 같은 이유로 **지우기 전에** 묻는다. */
  mediaPath(id: string): Promise<{ path: string | null; error?: string | undefined }>;
  /** 행을 **하드 삭제**한다(§0의 "하드 삭제 없음"에 대한 유일한 예외 — ADR-0030). */
  hardDelete(domain: PurgeDomain, id: string): Promise<{ error?: string | undefined }>;
  /** 그 여행의 자식 행 전부를 하드 삭제한다(등록부를 돌므로 새 도메인이 자동으로 따라온다). */
  hardDeleteFamily(tripId: string): Promise<{ error?: string | undefined }>;
  /** read-back — 그 행이 아직 서버에 있는가(false여야 완료). */
  stillThere(domain: PurgeDomain, id: string): Promise<{ found: boolean; error?: string | undefined }>;
  /** read-back — 그 가족에 남은 행 수(0이어야 완료). */
  remainingInFamily(tripId: string): Promise<{ count: number; error?: string | undefined }>;
}

/** 원장 테이블 이름 — 문자열을 여러 곳에 손으로 적지 않는다. */
const LEDGER = 'purged_ids';

export function purgeRemote(client: JourneyClient): PurgeRemote {
  /** 자식 도메인만 훑는다(여행 자신은 호출부가 따로 처리). 등록부 기반이라 형제가 자동으로 따라온다. */
  const childDomains = (): PurgeDomain[] => PURGE_DOMAINS.filter((d) => d !== 'trip');

  return {
    async ledgerAdd(ids) {
      if (!ids.length) return {};
      try {
        // ON CONFLICT DO NOTHING — 멱등. user_id는 서버 기본값(auth.uid())이 채운다.
        const r = await client
          .from(LEDGER)
          .upsert(ids.map((id) => ({ id })), { onConflict: 'id', ignoreDuplicates: true });
        return { error: r.error?.message };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    async ledgerHas(id) {
      try {
        const r = await client.from(LEDGER).select('id').eq('id', id).maybeSingle();
        return { found: r.data !== null, error: r.error?.message };
      } catch (e) {
        return { found: false, error: (e as Error).message };
      }
    },
    async ledgerAll() {
      try {
        const r = await client.from(LEDGER).select('id');
        if (r.error) return { ids: [], error: r.error.message };
        return { ids: ((r.data ?? []) as { id: string }[]).map((x) => x.id) };
      } catch (e) {
        return { ids: [], error: (e as Error).message };
      }
    },
    async familyIds(tripId) {
      try {
        const ids: string[] = [];
        for (const d of childDomains()) {
          const r = await client.from(DOMAIN_PURGE[d].remoteTable).select('id').eq('trip_id', tripId);
          if (r.error) return { ids: [], error: `${DOMAIN_PURGE[d].remoteTable}: ${r.error.message}` };
          for (const x of (r.data ?? []) as { id: string }[]) ids.push(x.id);
        }
        return { ids };
      } catch (e) {
        return { ids: [], error: (e as Error).message };
      }
    },
    async familyMediaPaths(tripId) {
      try {
        const r = await client.from('media').select('storage_path').eq('trip_id', tripId).not('storage_path', 'is', null);
        if (r.error) return { paths: [], error: r.error.message };
        const paths = ((r.data ?? []) as { storage_path: string | null }[])
          .map((x) => x.storage_path)
          .filter((p): p is string => Boolean(p));
        return { paths };
      } catch (e) {
        return { paths: [], error: (e as Error).message };
      }
    },
    async mediaPath(id) {
      try {
        const r = await client.from('media').select('storage_path').eq('id', id).maybeSingle();
        const row = r.data as { storage_path: string | null } | null;
        return { path: row?.storage_path ?? null, error: r.error?.message };
      } catch (e) {
        return { path: null, error: (e as Error).message };
      }
    },
    async hardDelete(domain, id) {
      try {
        const r = await client.from(DOMAIN_PURGE[domain].remoteTable).delete().eq('id', id);
        return { error: r.error?.message };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    async hardDeleteFamily(tripId) {
      try {
        for (const d of childDomains()) {
          const r = await client.from(DOMAIN_PURGE[d].remoteTable).delete().eq('trip_id', tripId);
          if (r.error) return { error: `${DOMAIN_PURGE[d].remoteTable}: ${r.error.message}` };
        }
        return {};
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    async stillThere(domain, id) {
      try {
        const r = await client.from(DOMAIN_PURGE[domain].remoteTable).select('id').eq('id', id).maybeSingle();
        return { found: r.data !== null, error: r.error?.message };
      } catch (e) {
        return { found: false, error: (e as Error).message };
      }
    },
    async remainingInFamily(tripId) {
      try {
        let count = 0;
        for (const d of childDomains()) {
          const r = await client
            .from(DOMAIN_PURGE[d].remoteTable)
            .select('id', { count: 'exact', head: true })
            .eq('trip_id', tripId);
          if (r.error) return { count: -1, error: `${DOMAIN_PURGE[d].remoteTable}: ${r.error.message}` };
          count += r.count ?? 0;
        }
        return { count };
      } catch (e) {
        return { count: -1, error: (e as Error).message };
      }
    },
  };
}

/** 사진 바이트를 지우는 최소 포트 — 영구삭제가 쓰는 유일한 파괴 경로. */
export interface BytesRemote {
  remove(path: string): Promise<{ error?: string | undefined }>;
}

/**
 * 영구삭제 작업을 서버로 밀어 **자료를 실제로 지운다**(ADR-0030).
 *
 * 기존 도메인 push 루프가 이걸 처리하면 안 된다 — 영구삭제는 로컬 행을 이미 지웠으므로
 * 그 루프들은 "로컬에 없는 고아 작업"으로 보고 **조용히 폐기**한다(그러면 전파가 영영 안 된다).
 * entityType을 `purge:*`로 두어 기존 루프(`if (op.entityType !== 'trip') continue`)가
 * 구조적으로 건너뛰게 했다 — 네 곳에 "purge는 빼라"를 손으로 적지 않는다.
 *
 * **순서가 곧 안전이다.** 되돌릴 수 없는 일을 하기 전에 필요한 것을 먼저 읽는다:
 *   ① 지우기 전에 묻는다(자식 id·사진 경로) — 행이 사라지면 함께 사라지는 정보다.
 *   ② 원장 먼저 적는다 — 지운 뒤에 적으면 그 틈에 다른 기기가 다시 올린다.
 *   ③ 행을 지운다(자식 → 부모).
 *   ④ 되읽어 확인한다 — 200 응답이 아니라 **없어졌는지**를 본다.
 *   ⑤ 사진 바이트를 지운다(최선노력 — 실패해도 남는 건 잉여 파일일 뿐 기억 손실이 아니다).
 */
export async function pushPurges(remote: PurgeRemote, bytes?: BytesRemote): Promise<{ pushed: number; failed: number }> {
  const d = db();
  const items = (await d.syncQueue.orderBy('createdAt').toArray()).filter(
    (q) => (q.state === 'local_only' || q.state === 'retryable_failed') && purgeDomainOf(q.entityType) !== null,
  );
  let pushed = 0;
  let failed = 0;

  for (const op of items) {
    const domain = purgeDomainOf(op.entityType);
    if (!domain) continue;

    // ① 지우기 **전에** 묻는다.
    const paths: string[] = [];
    const ledgerIds: string[] = [op.entityId];
    if (domain === 'trip') {
      const fam = await remote.familyIds(op.entityId);
      if (fam.error) {
        await markFail(op, undefined);
        failed++;
        continue;
      }
      ledgerIds.push(...fam.ids);
      const fp = await remote.familyMediaPaths(op.entityId);
      if (fp.error) {
        await markFail(op, undefined);
        failed++;
        continue;
      }
      paths.push(...fp.paths);
    } else if (domain === 'media') {
      const mp = await remote.mediaPath(op.entityId);
      if (mp.error) {
        await markFail(op, undefined);
        failed++;
        continue;
      }
      if (mp.path) paths.push(mp.path);
    }

    // ② 원장 먼저. 여행이면 자식 id까지 함께 — 자식도 재삽입이 막혀야 한다.
    const led = await remote.ledgerAdd(ledgerIds);
    if (led.error) {
      await markFail(op, undefined);
      failed++;
      continue;
    }
    const back = await remote.ledgerHas(op.entityId);
    if (back.error || !back.found) {
      await markFail(op, undefined);
      failed++;
      continue;
    }

    // ③ 행을 지운다. 자식 먼저 — FK가 있어도 순서가 맞는다.
    if (domain === 'trip') {
      const fd = await remote.hardDeleteFamily(op.entityId);
      if (fd.error) {
        await markFail(op, undefined);
        failed++;
        continue;
      }
    }
    const hd = await remote.hardDelete(domain, op.entityId);
    if (hd.error) {
      await markFail(op, undefined);
      failed++;
      continue;
    }

    // ④ read-back. 서버에 애초에 행이 없었어도(한 번도 동기화 안 된 기록) 여기서 통과한다 —
    //    실패로 두면 그 작업이 영원히 큐에 남아 다음 영구삭제의 사전조건까지 막는다.
    const left = await remote.stillThere(domain, op.entityId);
    if (left.error || left.found) {
      await markFail(op, undefined);
      failed++;
      continue;
    }
    if (domain === 'trip') {
      const lf = await remote.remainingInFamily(op.entityId);
      if (lf.error || lf.count > 0) {
        await markFail(op, undefined);
        failed++;
        continue;
      }
    }

    // ⑤ **여기가 사진 바이트를 지우는 유일한 자리다**(정책 2026-07-26).
    //    휴지통에 있는 동안은 서버에 남겨 두었다가, 휴지통을 비울 때 지운다 —
    //    그래야 휴지통이 진짜 휴지통이고, 어느 기기에서 복원해도 사진이 돌아온다.
    if (bytes) {
      for (const p of paths) {
        const rm = await bytes.remove(p);
        if (rm.error) console.error(`영구삭제: 사진 파일 삭제 실패 ${p} — ${rm.error}`);
      }
    }

    await d.syncQueue.delete(op.operationId);
    pushed++;
  }
  return { pushed, failed };
}

export async function retryFailedOps(): Promise<number> {
  const d = db();
  const stuck = (await d.syncQueue.toArray()).filter((q) => q.state === 'permanent_failed');
  for (const q of stuck) await d.syncQueue.update(q.operationId, { state: 'local_only', attempts: 0 });
  return stuck.length;
}

/**
 * 정합 복구를 **강제로** 다시 실행한다(진단 화면의 [정리 실행] 버튼용).
 * 1회 표식을 지우고 재큐잉하므로, 표식이 이미 찍힌 뒤에 생긴 고아도 잡을 수 있다.
 */
export async function forceRepairCascadeOps(): Promise<{ media: number; expenses: number }> {
  try {
    localStorage.removeItem(REPAIR_KEY);
  } catch {
    /* 표식을 못 지워도 아래 재큐잉 자체는 동작한다. */
  }
  return requeueOrphanTombstones();
}

async function repairCascadeOpsOnce(): Promise<void> {
  try {
    if (localStorage.getItem(REPAIR_KEY)) return;
  } catch {
    return; // localStorage 불가(프라이빗 모드 등) — 복구를 건너뛴다. 동기화 자체엔 영향 없음.
  }
  const r = await requeueOrphanTombstones();
  if (r.media || r.expenses) console.info(`정합 복구: 사진 ${r.media}건 · 비용 ${r.expenses}건 재큐잉`);
  try {
    localStorage.setItem(REPAIR_KEY, new Date().toISOString());
  } catch {
    /* 표식 저장 실패는 무해 — 다음 동기화에서 한 번 더 돌 뿐이고 push는 멱등이다. */
  }
}

export async function runSync(client: JourneyClient, userId: string): Promise<SyncResult> {
  // push보다 **먼저** 돈다 — 재큐잉된 op가 이번 동기화에서 바로 처리되도록.
  await repairCascadeOpsOnce();
  const remote = tripsRemote(client);
  const mRemote = momentsRemote(client);
  const eRemote = expensesRemote(client);
  const dRemote = mediaRemote(client);
  const p = await pushPending(remote, userId);
  const pm = await pushPendingMoments(mRemote, userId);
  const pd = await pushPendingMedia(dRemote, userId);
  const pe = await pushPendingExpenses(eRemote, userId);
  // 영구삭제 전파는 **pull보다 먼저** — 이번 동기화에서 다른 기기가 바로 알 수 있게.
  const pRemote = purgeRemote(client);
  const pp = await pushPurges(pRemote, dRemote);

  // 다른 기기의 영구삭제를 배운다(ADR-0030). 행이 서버에서 사라졌으므로 pull은 그 사실을
  // 볼 수 없다 — **원장만이** 알려준다. pull보다 먼저 적용해 이 기기의 사본을 먼저 치운다.
  //
  // 원장 조회 실패는 동기화를 멈추지 않는다: 못 배운 대가는 "이 기기에 사본이 잠시 더 남는다"
  // 뿐이고, 서버 행은 이미 없으므로 되살아나지 않는다. 다만 조용히 넘기지 않고 남긴다.
  const ledger = await pRemote.ledgerAll();
  if (ledger.error) console.error(`영구삭제 원장 조회 실패 — ${ledger.error}`);
  else await applyPurgedLedger(ledger.ids);

  const q = await pullTrips(remote);
  const qm = await pullMoments(mRemote);
  const qd = await pullMedia(dRemote);
  const qe = await pullExpenses(eRemote);
  return {
    pushed: p.pushed + pm.pushed + pd.pushed + pe.pushed + pp.pushed,
    failed: p.failed + pm.failed + pd.failed + pe.failed + pp.failed,
    pulled: q.pulled + qm.pulled + qd.pulled + qe.pulled,
    skippedEmptyCloud: q.skippedEmptyCloud || qm.skippedEmptyCloud || qd.skippedEmptyCloud || qe.skippedEmptyCloud,
  };
}
