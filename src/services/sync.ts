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
import { r2BlobStore, mediaStoreKind, type BlobStore } from './r2';

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

export function mediaRemote(client: JourneyClient): MediaRemote {
  const bucket = client.storage.from('journey-media');
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

    const up = await remote.upsert(toRow(trip, userId));
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

    const up = await remote.upsert(toMomentRow(moment, userId));
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

    const up = await remote.upsert(toExpenseRow(expense, userId));
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
    const res = await remote.upsert(toMediaRow(media, userId, path));
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
    // 고아 스윕(DEL-CONTRACT): tombstone이 서버에 반영됐으면 표시본 Storage 객체를 정리한다.
    // 최선노력 — 실패해도 tombstone은 이미 durable하므로 op는 이미 제거됐고 유실 위험 없음(잉여만 남음).
    if (media.deletedAt !== null) await remote.remove(path);
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

/**
 * 영구삭제 표식 조회 — pull이 이 id를 건너뛴다.
 *
 * 없으면 `purgeTripPermanently`가 만든 표식이 장식이 되고, 서버 tombstone을 다시 받아와
 * **휴지통에 되살아난다**(A안의 핵심 절반이 여기다). 네 pull 함수가 **모두** 써야 한다.
 */
async function purgedIdSet(): Promise<Set<string>> {
  return new Set((await db().purgedIds.toArray()).map((p) => p.id));
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
  const q = await pullTrips(remote);
  const qm = await pullMoments(mRemote);
  const qd = await pullMedia(dRemote);
  const qe = await pullExpenses(eRemote);
  return {
    pushed: p.pushed + pm.pushed + pd.pushed + pe.pushed,
    failed: p.failed + pm.failed + pd.failed + pe.failed,
    pulled: q.pulled + qm.pulled + qd.pulled + qe.pulled,
    skippedEmptyCloud: q.skippedEmptyCloud || qm.skippedEmptyCloud || qd.skippedEmptyCloud || qe.skippedEmptyCloud,
  };
}
