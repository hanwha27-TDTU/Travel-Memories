// domain/moment/rowmap.ts — Moment의 직렬화 경계 (docs/DATA_MODEL.md 경계 규칙)
// 메모리는 camelCase, DB 행은 snake_case. 두 표기는 이 파일의 함수 안에서만 만난다.

import { isoInstant, isoInstantOrNull, type WithInstants } from '../time';
import type { LocalMoment } from '../../offline/db';

/** Supabase journey.moments 행 (snake_case — 이 파일 밖에서 사용 금지). */
export interface MomentRow {
  id: string;
  user_id: string;
  trip_id: string;
  occurred_at: string | null;
  tz_offset_min: number | null;
  title: string;
  note: string;
  emotion: string;
  companion_names?: string | null;
  place_name: string;
  place_lat: number | null;
  place_lng: number | null;
  /** 장소 라이브러리 링크(선택 · 0023). 없는 것이 정상 — 자유 입력 장소는 링크가 없다. */
  place_id: string | null;
  version: number;
  base_version?: number | null;
  base_canonical_version?: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  client_operation_id: string | null;
  /** 마지막으로 이 행을 올린 기기(`라벨#짧은id`) — 진단의 "기기별 현황"이 읽는다. 값은 인자로 받는다. */
  updated_by_device?: string | null;
}

export function toMomentRow(m: LocalMoment, userId: string, device?: string): MomentRow {
  return {
    id: m.id,
    user_id: userId,
    updated_by_device: device ?? null,
    trip_id: m.tripId,
    occurred_at: m.occurredAt || null,
    tz_offset_min: typeof m.tzOffsetMin === 'number' ? m.tzOffsetMin : null,
    title: m.title,
    note: m.note,
    emotion: m.emotion,
    companion_names: m.companionNames ?? '',
    place_name: m.placeName,
    place_lat: m.placeLat ?? null,
    place_lng: m.placeLng ?? null,
    place_id: m.placeId ?? null,
    version: m.version,
    base_version: m.baseVersion ?? Math.max(0, m.version - 1),
    base_canonical_version: m.baseCanonicalVersion ?? 'legacy',
    created_at: m.createdAt,
    updated_at: m.updatedAt,
    deleted_at: m.deletedAt,
    client_operation_id: m.clientOperationId ?? null,
  };
}

/** 서버 행 → 로컬 행. 시각은 반드시 `isoInstant()`를 통과한다(M-0034 — `domain/time.ts` 참조). */
export function fromMomentRow(r: MomentRow): WithInstants<LocalMoment> {
  return {
    id: r.id,
    tripId: r.trip_id,
    // ⚠️ **발생 시각도 서버에서 온다** — M-0034를 고칠 때 이 줄을 빠뜨렸다(자기점검 2026-07-27).
    // 타임라인 정렬이 `(a.occurredAt || a.createdAt).localeCompare(...)`로 **문자열 비교**를 하므로
    // 표기가 섞이면 같은 순간의 순서가 표기에 흔들린다. 비어 있으면(`''`) 그대로 둔다.
    occurredAt: isoInstant(r.occurred_at ?? ''),
    tzOffsetMin: typeof r.tz_offset_min === 'number' ? r.tz_offset_min : null,
    title: r.title,
    note: r.note,
    emotion: r.emotion,
    companionNames: r.companion_names ?? '',
    placeName: r.place_name,
    placeLat: r.place_lat,
    placeLng: r.place_lng,
    placeId: r.place_id ?? null,
    version: r.version,
    baseVersion: r.version,
    baseCanonicalVersion: r.base_canonical_version ?? 'legacy',
    createdAt: isoInstant(r.created_at),
    updatedAt: isoInstant(r.updated_at),
    deletedAt: isoInstantOrNull(r.deleted_at),
    ...(r.client_operation_id ? { clientOperationId: r.client_operation_id } : {}),
  };
}
