// services/sync.ts — 동기화 push/pull 오케스트레이션 (docs/SYNC_PROTOCOL.md).
// 핵심 불변식을 코드로: 멱등 upsert(operation) + 정확한 read-back + LWW 서버시각 반영
// + 빈-클라우드 가드 + 병합(교체 아님). 네트워크는 TripsRemote 포트 뒤로 격리해
// 순수 결정 로직(sync/merge.ts)을 직접 테스트할 수 있게 한다(LESSONS §6).

import { db, type SyncQueueItem } from '../offline/db';
import { toRow, fromRow, type TripRow } from '../domain/trip/rowmap';
import { mergeDecision, isEmptyCloudAnomaly, classifyError } from '../sync/merge';
import type { JourneyClient } from './supabase/client';

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

  const localActive = (await d.localTrips.toArray()).filter((t) => t.deletedAt === null).length;
  if (isEmptyCloudAnomaly(serverRows.length, localActive)) {
    return { pulled: 0, skippedEmptyCloud: true }; // 로컬 보존
  }

  let pulled = 0;
  for (const r of serverRows) {
    const server = fromRow(r);
    const local = await d.localTrips.get(server.id);
    if (mergeDecision(local, server) === 'take-server') {
      await d.localTrips.put(server);
      pulled++;
    }
  }
  return { pulled, skippedEmptyCloud: false };
}

/** 로그인/온라인 시 전체 동기화: push 먼저(로컬 우선 전송) → pull 병합. */
export async function runSync(client: JourneyClient, userId: string): Promise<SyncResult> {
  const remote = tripsRemote(client);
  const p = await pushPending(remote, userId);
  const q = await pullTrips(remote);
  return { pushed: p.pushed, failed: p.failed, pulled: q.pulled, skippedEmptyCloud: q.skippedEmptyCloud };
}
