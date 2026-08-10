import { tripFolderName, videoExt, videoObjectName } from '../media/naming';
import { isoInstant, isoInstantOrNull, type WithInstants } from '../time';
import type { LocalVideo } from '../../offline/db';

export interface VideoRow {
  id: string;
  user_id: string;
  moment_id: string;
  trip_id: string;
  storage_path: string | null;
  duration_sec: number;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  taken_at: string | null;
  source: string;
  version: number;
  base_version?: number | null;
  base_canonical_version?: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  client_operation_id: string | null;
  updated_by_device?: string | null;
}

export interface VideoMeta {
  id: string;
  momentId: string;
  tripId: string;
  storagePath: string | null;
  durationSec: number;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  takenAt: string;
  version: number;
  baseVersion: number;
  baseCanonicalVersion: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  clientOperationId?: string;
}

export function toVideoRow(v: LocalVideo, userId: string, storagePath: string | null, device?: string): VideoRow {
  return {
    id: v.id,
    user_id: userId,
    updated_by_device: device ?? null,
    moment_id: v.momentId,
    trip_id: v.tripId,
    storage_path: storagePath,
    duration_sec: v.durationSec,
    mime: v.mime,
    bytes: v.blob?.size ?? 0,
    width: v.width,
    height: v.height,
    taken_at: v.takenAt || null,
    source: 'user',
    version: v.version,
    base_version: v.baseVersion ?? Math.max(0, v.version - 1),
    base_canonical_version: v.baseCanonicalVersion ?? 'legacy',
    created_at: v.createdAt,
    updated_at: v.updatedAt,
    deleted_at: v.deletedAt,
    client_operation_id: v.clientOperationId ?? null,
  };
}

export function fromVideoRow(r: VideoRow): WithInstants<VideoMeta> {
  return {
    id: r.id,
    momentId: r.moment_id,
    tripId: r.trip_id,
    storagePath: r.storage_path,
    durationSec: r.duration_sec ?? 0,
    mime: r.mime || '',
    bytes: r.bytes ?? 0,
    width: r.width ?? 0,
    height: r.height ?? 0,
    takenAt: isoInstant(r.taken_at ?? ''),
    version: r.version,
    baseVersion: r.version,
    baseCanonicalVersion: r.base_canonical_version ?? 'legacy',
    createdAt: isoInstant(r.created_at),
    updatedAt: isoInstant(r.updated_at),
    deletedAt: isoInstantOrNull(r.deleted_at),
    ...(r.client_operation_id ? { clientOperationId: r.client_operation_id } : {}),
  };
}

export function videoStoragePath(
  userId: string,
  video: { id: string; tripId: string; takenAt: string | null; mime: string },
  tripTitle: string | null | undefined,
): string | null {
  const ext = videoExt(video.mime);
  if (!ext) return null;
  const folder = tripFolderName(tripTitle, video.tripId);
  const name = videoObjectName(video.takenAt, tripTitle, video.id);
  return `${userId}/${folder}/${name}.${ext}`;
}
