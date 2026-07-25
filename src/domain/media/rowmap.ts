// domain/media/rowmap.ts — Media의 직렬화 경계 (docs/DATA_MODEL.md·PRIVACY).
// 서버엔 표시본 메타만 간다. 원본 Blob은 로컬 전용(절약 모드·§0), GPS는 민감 PII라 미동기화(PRIVACY).
// check-schema-parity 게이트가 MediaRow 필드 ⊆ journey.media 컬럼을 강제한다.

import type { LocalMedia } from '../../offline/db';

/** Supabase journey.media 행 (snake_case — 이 파일 밖에서 사용 금지). blob은 담지 않는다. */
export interface MediaRow {
  id: string;
  user_id: string;
  moment_id: string;
  trip_id: string;
  storage_path: string | null;
  width: number;
  height: number;
  taken_at: string | null;
  bytes_display: number;
  source: string;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  client_operation_id: string | null;
  /**
   * 영구삭제 표식(ADR-0027) — 어느 기기에서 휴지통을 비운 시각.
   *
   * **선택 필드다.** toRow()는 이 키를 절대 담지 않는다 — 담으면 평범한 upsert가 다른 기기의
   * 영구삭제를 `null`로 덮어써 지운 것이 되살아난다. 읽기 전용으로만 쓴다(pull이 본다).
   */
  purged_at?: string | null;
  /** 마지막으로 이 행을 올린 기기(`라벨#짧은id`) — 진단의 "기기별 현황"이 읽는다. 값은 인자로 받는다. */
  updated_by_device?: string | null;
}

/** 행에서 복원되는 메타(블롭 제외). pull이 여기에 다운로드한 blob을 붙여 LocalMedia를 만든다. */
export interface MediaMeta {
  id: string;
  momentId: string;
  tripId: string;
  storagePath: string | null;
  width: number;
  height: number;
  takenAt: string;
  bytesDisplay: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  clientOperationId?: string;
}

export function toMediaRow(m: LocalMedia, userId: string, storagePath: string | null, device?: string): MediaRow {
  return {
    id: m.id,
    user_id: userId,
    updated_by_device: device ?? null,
    moment_id: m.momentId,
    trip_id: m.tripId,
    storage_path: storagePath,
    width: m.width,
    height: m.height,
    taken_at: m.takenAt || null,
    bytes_display: m.bytesDisplay,
    source: 'user',
    version: m.version,
    created_at: m.createdAt,
    updated_at: m.updatedAt,
    deleted_at: m.deletedAt,
    client_operation_id: m.clientOperationId ?? null,
  };
}

export function fromMediaRow(r: MediaRow): MediaMeta {
  return {
    id: r.id,
    momentId: r.moment_id,
    tripId: r.trip_id,
    storagePath: r.storage_path,
    width: r.width,
    height: r.height,
    takenAt: r.taken_at ?? '',
    bytesDisplay: r.bytes_display,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
    ...(r.client_operation_id ? { clientOperationId: r.client_operation_id } : {}),
  };
}

/** Storage 경로 규약: '{userId}/{mediaId}.webp'. 버킷 RLS가 첫 폴더=uid를 요구한다. */
export function mediaStoragePath(userId: string, mediaId: string): string {
  return `${userId}/${mediaId}.webp`;
}
