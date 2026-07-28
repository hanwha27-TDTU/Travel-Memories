// services/sync.ts — 동기화 push/pull 오케스트레이션 (docs/SYNC_PROTOCOL.md).
// 핵심 불변식을 코드로: 멱등 upsert(operation) + 정확한 read-back + LWW 서버시각 반영
// + 빈-클라우드 가드 + 병합(교체 아님). 네트워크는 TripsRemote 포트 뒤로 격리해
// 순수 결정 로직(sync/merge.ts)을 직접 테스트할 수 있게 한다(LESSONS §6).

import type { Table } from 'dexie';
import { db, type SyncQueueItem, type LocalMedia, type LocalAudio, type SyncMeta } from '../offline/db';
// 시각 표기의 SSOT — rowmap(서버 경계)·백업 복원과 **같은 함수**를 쓴다(§7: 규율은 한 곳에).
import { withCanonicalStamps } from '../domain/time';
import { toRow, fromRow, type TripRow } from '../domain/trip/rowmap';
import { toMomentRow, fromMomentRow, type MomentRow } from '../domain/moment/rowmap';
import { toExpenseRow, fromExpenseRow, type ExpenseRow } from '../domain/expense/rowmap';
import { toMediaRow, fromMediaRow, mediaStoragePath, type MediaRow } from '../domain/media/rowmap';
import { toAudioRow, fromAudioRow, audioStoragePath, type AudioRow } from '../domain/audio/rowmap';
import { compressForStorage } from '../media/compress';
import { mergeDecision, isEmptyCloudAnomaly, classifyError, retryDelayMs, isRetryDue } from '../sync/merge';
import type { JourneyClient } from './supabase/client';
import { r2BlobStore } from './r2';
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

export function mediaRemote(client: JourneyClient): MediaRemote {
  // 바이트 3종은 **R2 하나뿐**이다(v0.86). 메타·RLS·병합 규율은 저장소와 무관하게 동일하다.
  // 옛 Supabase Storage 경로는 이관을 마치고 제거했다 — 사진 8장을 옮기고 되읽어 확인한 뒤였다.
  const blobs = r2BlobStore(client);
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
    uploadDisplay: (path, blob) => blobs.uploadDisplay(path, blob),
    download: (path) => blobs.download(path),
    remove: (path) => blobs.remove(path),
  };
}

/**
 * 소리 원격 포트 — 메타(journey.audio) + **원본 바이트**(R2).
 *
 * 사진과 하나만 다르다: 사진은 표시본만 올리고 원본은 로컬에 남기지만(절약 모드),
 * 소리는 **원본이 곧 유일본**이라 그것을 올린다. 그래서 `uploadDisplay`가 아니라 `upload`다 —
 * 이름이 다른 것 자체가 그 차이를 말한다.
 */
export interface AudioRemote {
  upsert(row: AudioRow): Promise<{ error?: string | undefined; status?: number | undefined }>;
  getById(id: string): Promise<{ data: AudioRow | null; error?: string | undefined; status?: number | undefined }>;
  listAll(): Promise<{ data: AudioRow[]; error?: string | undefined }>;
  upload(path: string, blob: Blob, contentType: string): Promise<{ error?: string | undefined; status?: number | undefined }>;
  download(path: string): Promise<{ data: Blob | null; error?: string | undefined; status?: number | undefined }>;
  remove(path: string): Promise<{ error?: string | undefined }>;
}

export function audioRemote(client: JourneyClient): AudioRemote {
  const blobs = r2BlobStore(client); // 사진과 **같은 버킷·같은 인가 모델**(첫 칸은 검증된 sub)
  return {
    async upsert(row) {
      try {
        const r = await client.from('audio').upsert(row, { onConflict: 'id' });
        return { error: r.error?.message, status: r.status };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    async getById(id) {
      try {
        const r = await client.from('audio').select('*').eq('id', id).maybeSingle();
        return { data: (r.data as AudioRow | null) ?? null, error: r.error?.message, status: r.status };
      } catch (e) {
        return { data: null, error: (e as Error).message };
      }
    },
    async listAll() {
      try {
        const r = await client.from('audio').select('*');
        return { data: (r.data as AudioRow[] | null) ?? [], error: r.error?.message };
      } catch (e) {
        return { data: [], error: (e as Error).message };
      }
    },
    upload: (path, blob, contentType) => blobs.upload(path, blob, contentType),
    download: (path) => blobs.download(path),
    remove: (path) => blobs.remove(path),
  };
}

async function markFail(op: SyncQueueItem, status: number | undefined): Promise<void> {
  const kind = classifyError(status);
  const attempts = (op.attempts ?? 0) + 1;
  await db().syncQueue.update(op.operationId, {
    state: kind === 'retryable' ? 'retryable_failed' : 'permanent_failed',
    attempts,
    // **다음 시도 시각을 적는다**(2026-07-27). 예전엔 `attempts`만 올리고 아무도 읽지 않아,
    // 실패한 op이 `autoSync` 트리거(online·visibilitychange·5분 주기)마다 **즉시** 재시도됐다.
    // 계약은 `docs/SYNC_PROTOCOL.md:31`에 처음부터 있었다 — 코드가 따라가지 않았을 뿐이다.
    nextRetryAt: new Date(Date.now() + retryDelayMs(attempts)).toISOString(),
  });
}

/** 지금 밀어도 되는 op만 남긴다(백오프 대기 중인 것은 이번 회차에 건너뛴다). */
function dueOps(items: SyncQueueItem[]): SyncQueueItem[] {
  const now = new Date().toISOString();
  return items.filter((q) => isRetryDue(q, now));
}

/**
 * 대기열의 로컬 작업을 서버에 반영. 각 작업마다:
 * upsert(멱등) → 별도 read-back으로 일치 확인 → 서버시각/version 로컬 반영 → 작업 제거.
 * HTTP 성공/upsert 표현만으로 완료 처리하지 않는다(불변식 5).
 */
export async function pushPending(remote: TripsRemote, userId: string): Promise<{ pushed: number; failed: number }> {
  const d = db();
  const items = dueOps(
    (await d.syncQueue.orderBy('createdAt').toArray()).filter(
      (q) => q.state === 'local_only' || q.state === 'retryable_failed',
    ),
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
  const items = dueOps(
    (await d.syncQueue.orderBy('createdAt').toArray()).filter(
      (q) => q.state === 'local_only' || q.state === 'retryable_failed',
    ),
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
  const items = dueOps(
    (await d.syncQueue.orderBy('createdAt').toArray()).filter(
      (q) => q.state === 'local_only' || q.state === 'retryable_failed',
    ),
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
  const items = dueOps(
    (await d.syncQueue.orderBy('createdAt').toArray()).filter(
      (q) => q.state === 'local_only' || q.state === 'retryable_failed',
    ),
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
    // **경로는 기억한 것을 쓴다.** 다시 계산하면 여행 제목이 바뀐 뒤의 재전송이 다른 키로
    // 올라가 옛 파일이 고아로 남는다(그리고 앱은 그걸 '문제'로 띄운다). 바이트가 착지한 키가
    // 곧 진실이므로, 처음 한 번만 만들고 그 뒤로는 저장된 값을 따른다.
    const trip = await d.localTrips.get(media.tripId);
    const path = media.storagePath ?? mediaStoragePath(userId, media, trip?.title ?? null);
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
      // 경로도 **같은 커밋에** 기억한다(M-0033의 교훈 — "곧 이어서 쓸 것"은 없는 것과 같다).
      if (cur) await d.localMedia.put({ ...cur, storagePath: path, updatedAt: server.updatedAt, version: server.version });
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
 * 소리 push — 사진과 **같은 순서·같은 규율**이다:
 * 활성이면 원본 바이트를 올리고 → 메타 upsert → read-back → 서버시각 반영 → 작업 제거.
 * tombstone이면 업로드 없이 메타만(바이트는 영구삭제 때만 지운다 — `pushPurges`).
 *
 * 🔴 확장자를 모르는 형식(`audioStoragePath`가 null)은 **올리지 않고 op을 남긴다.** 지우면
 * 그 소리는 영영 서버에 못 가면서 아무도 그 사실을 모른다. 남겨 두면 진단의 「서버에 없는
 * 소리」가 그걸 말한다(모르는 것을 처리한 척하지 않는다 — 비타협 원칙 #4).
 */
export async function pushPendingAudio(remote: AudioRemote, userId: string): Promise<{ pushed: number; failed: number }> {
  const d = db();
  const items = dueOps(
    (await d.syncQueue.orderBy('createdAt').toArray()).filter(
      (q) => q.state === 'local_only' || q.state === 'retryable_failed',
    ),
  );
  let pushed = 0;
  let failed = 0;

  for (const op of items) {
    if (op.entityType !== 'audio') continue;
    const audio = await d.localAudio.get(op.entityId);
    if (!audio) {
      await d.syncQueue.delete(op.operationId);
      continue;
    }
    // 경로는 **기억한 것을 쓴다**(사진과 같은 이유 — 제목을 바꿔도 키가 안 움직인다).
    const trip = await d.localTrips.get(audio.tripId);
    const path = audio.storagePath ?? audioStoragePath(userId, audio, trip?.title ?? null);
    if (!path) {
      await markFail(op, 400); // permanent — 형식이 바뀌지 않는 한 다시 시도해도 같다
      failed++;
      continue;
    }
    if (audio.deletedAt === null) {
      const up = await remote.upload(path, audio.blob, audio.mime || 'application/octet-stream');
      if (up.error) {
        await markFail(op, up.status);
        failed++;
        continue;
      }
    }
    const res = await remote.upsert(toAudioRow(audio, userId, path, deviceStamp()));
    if (res.error) {
      await markFail(op, res.status);
      failed++;
      continue;
    }
    const back = await remote.getById(audio.id);
    if (back.error || !back.data) {
      await markFail(op, back.status);
      failed++;
      continue;
    }
    const server = fromAudioRow(back.data);
    await d.transaction('rw', d.localAudio, d.syncQueue, async () => {
      const cur = await d.localAudio.get(audio.id);
      // 경로도 **같은 커밋에** 기억한다(M-0033 — "곧 이어서 쓸 것"은 없는 것과 같다).
      if (cur) await d.localAudio.put({ ...cur, storagePath: path, updatedAt: server.updatedAt, version: server.version });
      await d.syncQueue.delete(op.operationId);
    });
    pushed++;
  }
  return { pushed, failed };
}

/**
 * 소리 pull(비파괴) — 사진과 같은 규율. 서버가 더 최신일 때만 반영하고, tombstone은 로컬
 * blob을 지우지 않고 `deletedAt`만 세운다(로컬에 없으면 skip). 활성은 바이트를 내려받아
 * 재구성하되 **다운로드 실패 시 로컬을 그대로 둔다**(비파괴, 불변식 #8).
 */
export async function pullAudio(remote: AudioRemote): Promise<{ pulled: number; skippedEmptyCloud: boolean }> {
  const d = db();
  const res = await remote.listAll();
  if (res.error) throw new Error(res.error);
  const rows = res.data;

  const purged = await purgedIdSet();
  const localActive = (await d.localAudio.toArray()).filter((a) => a.deletedAt === null).length;
  if (isEmptyCloudAnomaly(rows.length, localActive)) {
    return { pulled: 0, skippedEmptyCloud: true };
  }

  let pulled = 0;
  for (const r of rows) {
    if (purged.has(r.id)) continue; // 이 기기에서 영구히 치운 것 — 되살리지 않는다
    const server = fromAudioRow(r);
    const local = await d.localAudio.get(server.id);
    if (mergeDecision(local, server) !== 'take-server') {
      await requeueIfServerStillActive('audio', local, server);
      continue;
    }
    if (server.deletedAt !== null) {
      // tombstone — blob 파괴 없이 삭제 표시만. 로컬에 없으면 만들 바이트가 없고 필요도 없다.
      if (local) {
        await d.localAudio.put({ ...local, deletedAt: server.deletedAt, version: server.version, updatedAt: server.updatedAt });
        pulled++;
      }
      continue;
    }
    if (!server.storagePath) continue; // 아직 업로드 전 → 다음 동기화에서
    // 로컬에 이미 바이트가 있으면 **다시 받지 않는다.** 같은 바이트를 매번 내려받는 것은
    // 낭비이고(egress), 소리는 편집되지 않으므로 키가 같으면 내용도 같다.
    let blob = local?.blob;
    if (!blob || blob.size === 0 || local?.storagePath !== server.storagePath) {
      const dl = await remote.download(server.storagePath);
      if (dl.error || !dl.data) continue; // 실패 → 로컬 보존(비파괴), 다음에 재시도
      blob = dl.data;
    }
    const next: LocalAudio = {
      id: server.id,
      momentId: server.momentId,
      tripId: server.tripId,
      blob,
      mime: server.mime || local?.mime || 'audio/webm',
      durationSec: server.durationSec,
      recordedAt: server.recordedAt,
      version: server.version,
      createdAt: server.createdAt,
      updatedAt: server.updatedAt,
      deletedAt: null,
      storagePath: server.storagePath,
    };
    await d.localAudio.put(next);
    pulled++;
  }
  return { pulled, skippedEmptyCloud: false };
}

/**
 * 로그인/온라인 시 전체 동기화. push 먼저(로컬 우선 전송) → pull 병합.
 * push 순서: 여행 → 순간 → 사진·비용·소리(자식의 복합 FK가 서버의 부모 존재를 요구).
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
 * **소리를 처음으로 서버에 올려보내기 위한 백필**(2026-07-27, 일회성).
 *
 * 왜 필요한가(§9 4단계 — *"옛 방식으로 만들어진 것을 누가 데려오는가?"*): v1.14~v1.19 동안
 * 만들어진 오디오 노트에는 **큐 op가 애초에 존재한 적이 없다.** 코드에 push/pull을 붙이는
 * 것만으로는 그 행들이 영원히 로컬에만 남는다 — 앱은 조용하고 사용자는 "소리도 이제 동기화된다"는
 * 말을 믿는다. M-0023이 정확히 그 형태였다(방식을 바꿨는데 옛것을 아무도 데려오지 않았다).
 *
 * 대상은 **큐에 audio op이 없는 모든 로컬 소리 행**이다. tombstone도 포함한다 — 지운 사실도
 * 서버가 알아야 한다(안 그러면 다른 기기에서 살아 있는 채로 내려온다).
 *
 * 안전성: 자료를 바꾸지 않고 큐에만 넣는다. push는 멱등이라 이미 반영된 것을 한 번 더 밀어도
 * 결과가 같다. 그래서 표식이 사라진 뒤 다시 돌아도 손해가 없다(재업로드 비용뿐이고, 소리는
 * 60초 상한이라 가볍다).
 *
 * @returns 이번에 새로 큐에 넣은 수.
 */
export async function backfillAudioOps(): Promise<number> {
  const d = db();
  const queued = new Set(
    (await d.syncQueue.toArray()).filter((q) => q.entityType === 'audio').map((q) => q.entityId),
  );
  const now = new Date().toISOString();
  let added = 0;
  for (const a of await d.localAudio.toArray()) {
    if (queued.has(a.id)) continue;
    await d.syncQueue.add({
      operationId: crypto.randomUUID(),
      entityType: 'audio',
      entityId: a.id,
      // tombstone이면 'delete', 아니면 'insert' — push는 둘을 같은 upsert로 처리하지만
      // 큐 화면·진단이 이 값을 사람에게 보여주므로 **사실대로** 적는다.
      operationType: a.deletedAt === null ? 'insert' : 'delete',
      state: 'local_only',
      attempts: 0,
      createdAt: now,
    });
    added++;
  }
  return added;
}

/** 소리 백필 1회 실행 표식. 되돌려야 하면 `.v2`로 올려 전 기기가 한 번 더 돌게 한다. */
const AUDIO_BACKFILL_KEY = 'bj.repair.audioSync.v1';

async function backfillAudioOnce(): Promise<void> {
  try {
    if (localStorage.getItem(AUDIO_BACKFILL_KEY)) return;
  } catch {
    return; // localStorage 불가 — 진단의 「서버에 없는 소리」가 대신 말한다.
  }
  const n = await backfillAudioOps();
  if (n) console.info(`소리 동기화 백필: ${n}건을 큐에 넣었어요(로컬에만 있던 녹음).`);
  try {
    localStorage.setItem(AUDIO_BACKFILL_KEY, new Date().toISOString());
  } catch {
    /* 표식 저장 실패는 무해 — 다음 동기화에서 한 번 더 돌 뿐이고 이 작업은 멱등이다. */
  }
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
  entityType: 'trip' | 'moment' | 'media' | 'expense' | 'audio',
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
/** 시각 표기 1회 정리 표식(M-0034). 되돌려야 하면 `.v2`로 올려 전 기기가 한 번 더 돌게 한다. */
const STAMP_KEY = 'bj.repair.stampFormat.v1';

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
   * **백업 복원 전용** — 원장에서 id를 뺀다(0017의 `journey.unpurge_ids`).
   *
   * 왜 필요한가(2026-07-26 사용자 실기기): 백업을 복원했는데 서버 원장이 그대로라
   * BEFORE INSERT 트리거가 push를 거부했고, 이어서 원장 pull이 **로컬 행까지 지웠다.**
   * 사용자에겐 아무 오류도 안 보였다 — 복원이 조용히 무효화됐다.
   *
   * 로컬 표식만 걷어내고 서버는 그대로 둔 **한쪽만 구현한 규칙**이 원인이다(§7 비대칭).
   * 테이블 DELETE 권한은 여전히 없다 — 이 좁은 문으로만 지난다.
   */
  ledgerRemove(ids: string[]): Promise<{ removed: number; error?: string | undefined }>;
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
  /**
   * 그 여행에 딸린 **바이트를 가진 모든 자식**의 서버 경로들. **행을 지우기 전에** 물어야
   * 한다 — 행이 사라지면 경로도 사라진다.
   *
   * 🔴 예전엔 `familyMediaPaths`(사진 전용)였다. 소리가 R2로 가면서 그 이름이 곧 결함이 됐다 —
   * 여행을 영구삭제하면 사진 파일만 지워지고 **소리 파일은 R2에 영영 남는다.** 그래서 등록부
   * (`DOMAIN_PURGE[d].hasRemoteBytes`)를 도는 형태로 바꿨다: 다음 형제가 자동으로 따라온다(§7).
   */
  familyBytePaths(tripId: string): Promise<{ paths: string[]; error?: string | undefined }>;
  /** 자식 하나의 서버 경로. 위와 같은 이유로 **지우기 전에** 묻는다. */
  bytePath(domain: PurgeDomain, id: string): Promise<{ path: string | null; error?: string | undefined }>;
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

/**
 * 원장(`purged_ids`) 접근만 모은 조각. `purgeRemote`가 120줄 상한(`check-fn-size`)에 걸려
 * 쪼갰는데, 결과적으로 경계가 맞아떨어졌다 — **원장은 "무엇을 지웠나"의 기록**이고
 * 나머지(familyIds·mediaPath·hardDelete)는 **"무엇을 지울까"의 조회·실행**이다. 다른 관심사다.
 */
function ledgerOps(client: JourneyClient): Pick<PurgeRemote, 'ledgerAdd' | 'ledgerHas' | 'ledgerAll' | 'ledgerRemove'> {
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
    async ledgerRemove(ids) {
      if (!ids.length) return { removed: 0 };
      try {
        const r = await client.rpc('unpurge_ids', { p_ids: ids });
        if (r.error) return { removed: 0, error: r.error.message };
        return { removed: typeof r.data === 'number' ? r.data : 0 };
      } catch (e) {
        return { removed: 0, error: (e as Error).message };
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
  };
}

export function purgeRemote(client: JourneyClient): PurgeRemote {
  /** 자식 도메인만 훑는다(여행 자신은 호출부가 따로 처리). 등록부 기반이라 형제가 자동으로 따라온다. */
  const childDomains = (): PurgeDomain[] => PURGE_DOMAINS.filter((d) => d !== 'trip');

  return {
    ...ledgerOps(client),
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
    async familyBytePaths(tripId) {
      try {
        const paths: string[] = [];
        // 바이트를 가진 도메인 **전부**를 등록부에서 뽑는다 — 손으로 'media'라 적지 않는다.
        for (const dm of PURGE_DOMAINS.filter((x) => DOMAIN_PURGE[x].hasRemoteBytes)) {
          const t = DOMAIN_PURGE[dm].remoteTable;
          const r = await client.from(t).select('storage_path').eq('trip_id', tripId).not('storage_path', 'is', null);
          if (r.error) return { paths: [], error: `${t}: ${r.error.message}` };
          for (const x of (r.data ?? []) as { storage_path: string | null }[]) {
            if (x.storage_path) paths.push(x.storage_path);
          }
        }
        return { paths };
      } catch (e) {
        return { paths: [], error: (e as Error).message };
      }
    },
    async bytePath(domain, id) {
      if (!DOMAIN_PURGE[domain].hasRemoteBytes) return { path: null }; // 바이트가 없는 도메인
      try {
        const r = await client.from(DOMAIN_PURGE[domain].remoteTable).select('storage_path').eq('id', id).maybeSingle();
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
      const fp = await remote.familyBytePaths(op.entityId);
      if (fp.error) {
        await markFail(op, undefined);
        failed++;
        continue;
      }
      paths.push(...fp.paths);
    } else if (DOMAIN_PURGE[domain].hasRemoteBytes) {
      // 사진이든 소리든 **바이트를 가진 도메인이면** 경로를 먼저 묻는다(도메인 이름을 적지 않는다).
      const mp = await remote.bytePath(domain, op.entityId);
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

    // ⑤ **여기가 사진·소리 바이트를 지우는 유일한 자리다**(정책 2026-07-26).
    //    휴지통에 있는 동안은 서버에 남겨 두었다가, 휴지통을 비울 때 지운다 —
    //    그래야 휴지통이 진짜 휴지통이고, 어느 기기에서 복원해도 사진이 돌아온다.
    if (bytes) {
      for (const p of paths) {
        const rm = await bytes.remove(p);
        if (rm.error) console.error(`영구삭제: 저장소 파일 삭제 실패 ${p} — ${rm.error}`);
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
    // 시각 표기 정리도 **같은 버튼**이 다시 돌게 한다(M-0034). 따로 버튼을 만들면 사용자가
    // "어느 정리를 눌러야 하나"를 알아야 하고, 그건 앱이 대신할 일이다(§12).
    localStorage.removeItem(STAMP_KEY);
  } catch {
    /* 표식을 못 지워도 아래 재큐잉 자체는 동작한다. */
  }
  await normalizeStamps();
  // 소리 백필도 **같은 버튼**이 다시 돌게 한다 — 사용자가 "어느 정리를 눌러야 하나"를
  // 알아야 하는 상태를 만들지 않는다(§12).
  try {
    localStorage.removeItem(AUDIO_BACKFILL_KEY);
  } catch {
    /* 표식을 못 지워도 아래 백필 자체는 동작한다. */
  }
  const audio = await backfillAudioOps();
  if (audio) console.info(`소리 동기화 백필: ${audio}건 재큐잉`);
  return requeueOrphanTombstones();
}

/**
 * **이미 저장된 행의 시각 표기를 정규형으로 맞춘다**(M-0034, 2026-07-27).
 *
 * 왜 코드 수정만으로 부족한가: `isoInstant()`는 *앞으로* 들어올 값을 막을 뿐이고, 서버 표기
 * (`…48.34+00:00`)로 **이미 박힌 행은 그대로 남는다.** 사용자 기기에 사진 9건이 그 상태였고
 * 진단이 그걸 「시간 역전」으로 띄웠다. 방식을 바꾸는 커밋의 필수 질문 — *"옛 방식으로 만들어진
 * 것을 누가 데려오는가?"* — 의 답이 이 함수다(§9 4단계).
 *
 * 안전성: **같은 순간, 다른 표기**다. version·deletedAt 유무·LWW 결과가 바뀌지 않으므로
 * 사용자 편집이 아니고 **sync op를 만들지 않는다**(만들면 전 기기가 무의미한 push를 돈다).
 * blob은 건드리지 않는다 — `update()`로 시각 3칸만 다시 쓴다.
 */
async function normalizeTableStamps(table: Table<SyncMeta & { id: string }, string>): Promise<number> {
  // ⚠️ **읽기와 쓰기가 한 트랜잭션 안이어야 한다**(자기점검 2026-07-27). 처음엔 `each`로 다
  // 훑은 뒤 트랜잭션 **밖에서** `update`를 돌렸다. 그 사이에 복원·동기화가 같은 행을 고치면
  // 내 `update`가 **읽던 시점의 옛 값**으로 되돌린다(읽기-수정-쓰기의 고전적 창).
  //
  // 이건 M-0033과 **같은 부류**다 — 이 세션에서 그 사고를 직접 기록해 놓고 같은 형태를 또
  // 만들었다. 그리고 §1-B가 이미 말한다: *"이 함수가 `await`에서 멈춘 사이에 동기화가 돌면,
  // 지금 커밋된 상태는 어떻게 보이는가?"* — 읽기-수정-쓰기에는 언제나 이 질문이 걸린다.
  return table.db.transaction('rw', table, async () => {
    const patches: { id: string; patch: Partial<SyncMeta> }[] = [];
    // `each`는 커서라 blob을 한 행씩만 들고 있는다(사진 테이블을 통째로 메모리에 올리지 않는다).
    await table.each((r) => {
      const next = withCanonicalStamps(r);
      if (next.createdAt === r.createdAt && next.updatedAt === r.updatedAt && next.deletedAt === r.deletedAt) return;
      patches.push({ id: r.id, patch: { createdAt: next.createdAt, updatedAt: next.updatedAt, deletedAt: next.deletedAt } });
    });
    for (const p of patches) await table.update(p.id, p.patch);
    return patches.length;
  });
}

/** 로컬 테이블 전부 — 형제를 손으로 세지 않는다(§7). 고친 행 수를 돌려준다. */
export async function normalizeStamps(): Promise<number> {
  const d = db();
  const tables = [d.localTrips, d.localMoments, d.localMedia, d.localExpenses, d.localAudio] as unknown as Table<SyncMeta & { id: string }, string>[];
  let fixed = 0;
  for (const t of tables) fixed += await normalizeTableStamps(t);
  return fixed;
}

async function normalizeStampsOnce(): Promise<void> {
  try {
    if (localStorage.getItem(STAMP_KEY)) return;
  } catch {
    return; // localStorage 불가 — 건너뛴다. 진단의 「시각 표기가 표준형이 아님」이 대신 말한다.
  }
  const n = await normalizeStamps();
  if (n) console.info(`시각 표기 정리: ${n}건을 표준 표기로 다시 적음(같은 순간, 다른 표기)`);
  try {
    localStorage.setItem(STAMP_KEY, new Date().toISOString());
  } catch {
    /* 표식 저장 실패는 무해 — 다음 동기화에서 한 번 더 돌 뿐이고 이 변환은 멱등이다. */
  }
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

/**
 * **복원이 되살린 id를 서버 원장에서 뺀다.** 다른 push·pull보다 **먼저** 돌아야 한다 —
 * 원장이 남아 있으면 ① BEFORE INSERT 트리거가 복원 push를 거부하고 ② 이어지는 원장 pull이
 * 로컬 행까지 지운다. 2026-07-26에 정확히 그 순서로 사용자의 복원이 무효화됐다.
 *
 * 실패하면 **op을 남긴다**(지우지 않는다). 남겨야 다음 동기화가 다시 시도하고, 그동안
 * `applyPurgedLedger`가 이 id들을 건너뛴다. 조용히 포기하면 복원이 또 사라진다.
 */
export async function pushUnpurges(remote: PurgeRemote): Promise<{ pushed: number; failed: number }> {
  const d = db();
  const ops = (await d.syncQueue.toArray()).filter((q) => q.operationType === 'unpurge');
  if (!ops.length) return { pushed: 0, failed: 0 };

  const ids = [...new Set(ops.map((o) => o.entityId))];
  const r = await remote.ledgerRemove(ids);
  if (r.error) {
    console.error(`복원: 영구삭제 원장 되돌리기 실패 — ${r.error}`);
    return { pushed: 0, failed: ops.length };
  }

  // read-back — 지웠다는 응답이 아니라 **원장을 다시 읽어** 확인한다(데이터 안전 불변식).
  const after = await remote.ledgerAll();
  if (after.error) {
    console.error(`복원: 원장 되읽기 실패 — ${after.error}`);
    return { pushed: 0, failed: ops.length };
  }
  const still = new Set(after.ids);
  const done = ops.filter((o) => !still.has(o.entityId));
  for (const o of done) await d.syncQueue.delete(o.operationId);
  await revivePushOps(done.map((o) => o.entityId));
  return { pushed: done.length, failed: ops.length - done.length };
}

/**
 * **원장에 막혀 죽은 전파 op을 되살린다.**
 *
 * 왜 필요한가: 트리거가 거부한 응답은 4xx라 `classifyError`가 **'permanent'**로 본다 →
 * op이 `permanent_failed`가 되고 push는 그 상태를 **영원히 건너뛴다.** 그래서 나중에 원장을
 * 되돌리는 데 성공해도 **그 행은 두 번 다시 올라가지 않는다** — 사용자에겐 여전히 아무 일도
 * 일어나지 않는 것처럼 보인다.
 *
 * 그 판정은 그 순간에는 옳았다. 틀린 것은 **판정을 영구로 굳힌 것**이다: 거부의 사유가
 * 방금 사라졌으므로 이건 재시도 가능한 실패가 된다. 사유가 사라진 것을 아는 곳이 여기뿐이라
 * 되살리는 일도 여기서 한다(§7 — 규칙을 아는 한 곳이 책임진다).
 *
 * 되살리기는 **이번 동기화 안에서** 효과가 있다 — `pushUnpurges`가 다른 push보다 먼저 돌기
 * 때문이다. 즉 원장을 푼 그 자리에서 복원한 행이 바로 올라간다.
 */
async function revivePushOps(ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const d = db();
  const target = new Set(ids);
  const dead = (await d.syncQueue.toArray()).filter(
    (q) => target.has(q.entityId) && (q.state === 'permanent_failed' || q.state === 'retryable_failed'),
  );
  for (const q of dead) await d.syncQueue.update(q.operationId, { state: 'local_only', attempts: 0 });
  if (dead.length) console.info(`복원: 원장에 막혀 있던 전파 작업 ${dead.length}건을 다시 큐에 넣었어요.`);
  return dead.length;
}

export async function runSync(client: JourneyClient, userId: string): Promise<SyncResult> {
  // push보다 **먼저** 돈다 — 재큐잉된 op가 이번 동기화에서 바로 처리되도록.
  await repairCascadeOpsOnce();
  // 표기 정리도 **병합보다 먼저**다(M-0034). 아래 pull이 `mergeDecision`으로 승부를 내는데,
  // 로컬에 옛 표기가 남아 있으면 같은 순간을 두 표기로 재게 된다.
  await normalizeStampsOnce();
  // 소리는 v1.20 이전에 만들어진 것에 큐 op이 **아예 없다** — 코드만 고치면 그 행들은 영원히
  // 안 올라간다. push보다 먼저 돌아 이번 동기화에서 바로 처리되게 한다.
  await backfillAudioOnce();
  const remote = tripsRemote(client);
  const mRemote = momentsRemote(client);
  const eRemote = expensesRemote(client);
  const dRemote = mediaRemote(client);
  const aRemote = audioRemote(client);
  // **복원 되돌리기가 가장 먼저다.** 원장이 남아 있으면 아래 push가 트리거에 막힌다.
  const pRemote0 = purgeRemote(client);
  const pu = await pushUnpurges(pRemote0);
  const p = await pushPending(remote, userId);
  const pm = await pushPendingMoments(mRemote, userId);
  const pd = await pushPendingMedia(dRemote, userId);
  const pe = await pushPendingExpenses(eRemote, userId);
  // 소리는 **순간 뒤**여야 한다 — 복합 FK `(moment_id,user_id)`가 서버의 부모를 요구한다.
  const pa = await pushPendingAudio(aRemote, userId);
  // 영구삭제 전파는 **pull보다 먼저** — 이번 동기화에서 다른 기기가 바로 알 수 있게.
  const pRemote = pRemote0;
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
  const qa = await pullAudio(aRemote);
  return {
    pushed: pu.pushed + p.pushed + pm.pushed + pd.pushed + pe.pushed + pa.pushed + pp.pushed,
    failed: pu.failed + p.failed + pm.failed + pd.failed + pe.failed + pa.failed + pp.failed,
    pulled: q.pulled + qm.pulled + qd.pulled + qe.pulled + qa.pulled,
    skippedEmptyCloud:
      q.skippedEmptyCloud || qm.skippedEmptyCloud || qd.skippedEmptyCloud || qe.skippedEmptyCloud || qa.skippedEmptyCloud,
  };
}
