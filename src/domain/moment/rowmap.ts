// domain/moment/rowmap.ts — Moment의 직렬화 경계 (docs/DATA_MODEL.md 경계 규칙)
// 메모리는 camelCase, DB 행은 snake_case. 두 표기는 이 파일의 함수 안에서만 만난다.

import type { LocalMoment } from '../../offline/db';

/** Supabase journey.moments 행 (snake_case — 이 파일 밖에서 사용 금지). */
export interface MomentRow {
  id: string;
  user_id: string;
  trip_id: string;
  occurred_at: string | null;
  title: string;
  note: string;
  emotion: string;
  place_name: string;
  place_lat: number | null;
  place_lng: number | null;
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
}

export function toMomentRow(m: LocalMoment, userId: string): MomentRow {
  return {
    id: m.id,
    user_id: userId,
    trip_id: m.tripId,
    occurred_at: m.occurredAt || null,
    title: m.title,
    note: m.note,
    emotion: m.emotion,
    place_name: m.placeName,
    place_lat: m.placeLat ?? null,
    place_lng: m.placeLng ?? null,
    version: m.version,
    created_at: m.createdAt,
    updated_at: m.updatedAt,
    deleted_at: m.deletedAt,
    client_operation_id: m.clientOperationId ?? null,
  };
}

export function fromMomentRow(r: MomentRow): LocalMoment {
  return {
    id: r.id,
    tripId: r.trip_id,
    occurredAt: r.occurred_at ?? '',
    title: r.title,
    note: r.note,
    emotion: r.emotion,
    placeName: r.place_name,
    placeLat: r.place_lat,
    placeLng: r.place_lng,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
    ...(r.client_operation_id ? { clientOperationId: r.client_operation_id } : {}),
  };
}
