// domain/trip/rowmap.ts — Trip의 직렬화 경계 (docs/DATA_MODEL.md 경계 규칙)
// 메모리는 camelCase, DB 행은 snake_case. 두 표기는 이 파일의 toRow/fromRow 안에서만 만난다.
// 다른 어떤 파일에도 trips의 snake_case 키가 나타나면 경계 위반이다.

import { isoInstant, isoInstantOrNull, type WithInstants } from '../time';
import type { LocalTrip } from '../../offline/db';

/** Supabase trips 행 (snake_case — 이 파일 밖에서 사용 금지). */
export interface TripRow {
  id: string;
  user_id: string;
  title: string;
  start_date: string | null;
  time_zone: string | null;
  end_date: string | null;
  status: LocalTrip['status'];
  version: number;
  base_version?: number | null;
  base_canonical_version?: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  client_operation_id: string | null;
  /**
   * 마지막으로 이 행을 **올린 기기**(`라벨#짧은id`). 진단의 "기기별 현황"이 이걸 읽는다.
   *
   * 서버 컬럼은 처음부터 있었지만 클라이언트가 한 번도 쓰지 않아 늘 비어 있었다(2026-07-26 발견).
   * 순수성을 지키려고 값은 **인자로 받는다** — rowmap이 localStorage를 만지지 않는다.
   */
  updated_by_device?: string | null;
}

export function toRow(t: LocalTrip, userId: string, device?: string): TripRow {
  return {
    id: t.id,
    user_id: userId,
    updated_by_device: device ?? null,
    title: t.title,
    start_date: t.startDate || null,
    time_zone: t.timeZone || null,
    end_date: t.endDate || null,
    status: t.status,
    version: t.version,
    base_version: t.baseVersion ?? Math.max(0, t.version - 1),
    base_canonical_version: t.baseCanonicalVersion ?? 'legacy',
    created_at: t.createdAt,
    updated_at: t.updatedAt,
    deleted_at: t.deletedAt,
    client_operation_id: t.clientOperationId ?? null,
  };
}

/**
 * 서버 행 → 로컬 행. 시각은 **반드시 `isoInstant()`를 통과한다**(M-0034) — PostgREST는
 * `…48.34+00:00`, JS는 `…48.340Z`로 같은 순간을 다르게 적고, 이 앱은 시각을 문자열로 비교한다.
 * 반환형이 `WithInstants`라 날것을 넣으면 컴파일이 막는다(§7 2층).
 */
export function fromRow(r: TripRow): WithInstants<LocalTrip> {
  return {
    id: r.id,
    title: r.title,
    startDate: r.start_date ?? '',
    timeZone: r.time_zone ?? '',
    endDate: r.end_date ?? '',
    status: r.status,
    version: r.version,
    baseVersion: r.version,
    baseCanonicalVersion: r.base_canonical_version ?? 'legacy',
    createdAt: isoInstant(r.created_at),
    updatedAt: isoInstant(r.updated_at),
    deletedAt: isoInstantOrNull(r.deleted_at),
    ...(r.client_operation_id ? { clientOperationId: r.client_operation_id } : {}),
  };
}
