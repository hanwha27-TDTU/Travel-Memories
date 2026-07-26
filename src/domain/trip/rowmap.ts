// domain/trip/rowmap.ts — Trip의 직렬화 경계 (docs/DATA_MODEL.md 경계 규칙)
// 메모리는 camelCase, DB 행은 snake_case. 두 표기는 이 파일의 toRow/fromRow 안에서만 만난다.
// 다른 어떤 파일에도 trips의 snake_case 키가 나타나면 경계 위반이다.

import type { LocalTrip } from '../../offline/db';

/** Supabase trips 행 (snake_case — 이 파일 밖에서 사용 금지). */
export interface TripRow {
  id: string;
  user_id: string;
  title: string;
  start_date: string | null;
  end_date: string | null;
  status: LocalTrip['status'];
  version: number;
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
    end_date: t.endDate || null,
    status: t.status,
    version: t.version,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
    deleted_at: t.deletedAt,
    client_operation_id: t.clientOperationId ?? null,
  };
}

export function fromRow(r: TripRow): LocalTrip {
  return {
    id: r.id,
    title: r.title,
    startDate: r.start_date ?? '',
    endDate: r.end_date ?? '',
    status: r.status,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
    ...(r.client_operation_id ? { clientOperationId: r.client_operation_id } : {}),
  };
}
