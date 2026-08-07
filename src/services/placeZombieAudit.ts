// services/placeZombieAudit.ts — 장소 재생성(좀비) 후보의 읽기 전용 서버·로컬 대조.
//
// 휴지통의 tombstone과 같은 장소가 다른 UUID로 다시 활성화되면 삭제 승리가 ID 경계에서
// 끊긴다. 이 감사는 그 흔적을 읽기만 한다. 후보는 의도적 재등록일 수도 있으므로 자동
// 삭제하거나 큐를 만들지 않는다.

import { findPlaceZombieCandidates, type PlaceZombieCandidate, type PlaceZombieRow } from '../domain/placeZombieVerdict';
import { db } from '../offline/db';
import { fetchAllRows } from './canonicalSync';
import type { JourneyClient } from './supabase/client';

interface RemotePlaceRow {
  id?: unknown;
  name?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  deleted_at?: unknown;
  updated_at?: unknown;
}

export interface PlaceZombieAudit {
  generation: string;
  local: PlaceZombieCandidate[];
  server: PlaceZombieCandidate[];
  localRows: number;
  serverRows: number;
}

async function generation(client: JourneyClient): Promise<string> {
  const r = await client.from('sync_meta').select('canonical_version').maybeSingle();
  if (r.error) throw new Error(`최종본 세대 조회 실패: ${r.error.message}`);
  const value = (r.data as { canonical_version?: unknown } | null)?.canonical_version;
  if (typeof value !== 'string') throw new Error('최종본 세대를 확인할 수 없습니다.');
  return value;
}

function remotePlace(row: RemotePlaceRow): PlaceZombieRow | null {
  if (
    typeof row.id !== 'string' ||
    typeof row.name !== 'string' ||
    typeof row.latitude !== 'number' ||
    typeof row.longitude !== 'number' ||
    (row.deleted_at !== null && typeof row.deleted_at !== 'string') ||
    typeof row.updated_at !== 'string'
  ) return null;
  return {
    id: row.id,
    name: row.name,
    latitude: row.latitude,
    longitude: row.longitude,
    deletedAt: row.deleted_at,
    updatedAt: row.updated_at,
  };
}

/**
 * canonical_version 전후를 함께 읽어 한 세대의 스냅샷만 판정한다.
 * 중간에 다른 기기가 최종본을 바꾸면 후보를 추측하지 않고 caller가 unknown으로 보인다.
 */
export async function auditPlaceZombies(client: JourneyClient): Promise<PlaceZombieAudit> {
  const before = await generation(client);
  const [localRows, remote] = await Promise.all([
    db().localPlaces.toArray(),
    fetchAllRows<RemotePlaceRow>(client, 'places'),
  ]);
  if (remote.error) throw new Error(`장소 대장 조회 실패: ${remote.error}`);
  const after = await generation(client);
  if (before !== after) throw new Error('대조 중 최종본 세대가 바뀌었습니다. 다시 확인해 주세요.');

  const local = localRows.map((row) => ({
    id: row.id,
    name: row.name,
    latitude: row.latitude,
    longitude: row.longitude,
    deletedAt: row.deletedAt,
    updatedAt: row.updatedAt,
  }));
  const server = remote.data.map(remotePlace).filter((row): row is PlaceZombieRow => row !== null);
  if (server.length !== remote.data.length) throw new Error('서버 장소 행의 필수 값을 모두 읽지 못했습니다.');

  return {
    generation: before,
    local: findPlaceZombieCandidates(local),
    server: findPlaceZombieCandidates(server),
    localRows: local.length,
    serverRows: server.length,
  };
}
