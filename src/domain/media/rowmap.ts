// domain/media/rowmap.ts — Media의 직렬화 경계 (docs/DATA_MODEL.md·PRIVACY).
// 서버엔 표시본 메타만 간다. 원본 Blob은 로컬 전용(절약 모드·§0).
//
// 🔴 **GPS는 2026-08-01부터 동기화한다**([user-decided] · 마이그레이션 0024). 예전 주석은
// *"GPS는 민감 PII라 미동기화"*였는데, 그 결과 **폰에서 넣은 사진의 좌표를 태블릿에서 볼 수
// 없었다** — 사용자가 정한 원칙(*"모든 기기에서 모든 정보를"*)에 어긋나는 빚이었다.
// 사생활 계약은 그대로다: **R2에 올라가는 사진 파일은 여전히 EXIF가 벗겨진 재인코딩본**이고
// (`check-exif-strip-on-share`), 좌표는 **파일이 아니라 RLS로 잠긴 컬럼**으로 간다.
// check-schema-parity 게이트가 MediaRow 필드 ⊆ journey.media 컬럼을 강제한다.

import { tripFolderName, mediaObjectName } from './naming';
import { isoInstant, isoInstantOrNull, type WithInstants } from '../time';
import type { LocalMedia } from '../../offline/db';

/** Supabase journey.media 행 (snake_case — 이 파일 밖에서 사용 금지). blob은 담지 않는다. */
export interface MediaRow {
  id: string;
  user_id: string;
  moment_id: string;
  trip_id: string;
  storage_path: string | null;
  /** EXIF 촬영 위치. NULL = 위치 없음/미상 — **0으로 반올림하지 않는다**(M-0057). */
  gps_lat: number | null;
  gps_lng: number | null;
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
  /** 마지막으로 이 행을 올린 기기(`라벨#짧은id`) — 진단의 "기기별 현황"이 읽는다. 값은 인자로 받는다. */
  updated_by_device?: string | null;
}

/** 행에서 복원되는 메타(블롭 제외). pull이 여기에 다운로드한 blob을 붙여 LocalMedia를 만든다. */
export interface MediaMeta {
  id: string;
  momentId: string;
  tripId: string;
  storagePath: string | null;
  gpsLat: number | null;
  gpsLng: number | null;
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
    gps_lat: m.gpsLat,
    gps_lng: m.gpsLng,
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

/** 서버 행 → 메타. 시각은 반드시 `isoInstant()`를 통과한다(M-0034 — `domain/time.ts` 참조). */
export function fromMediaRow(r: MediaRow): WithInstants<MediaMeta> {
  return {
    id: r.id,
    momentId: r.moment_id,
    tripId: r.trip_id,
    storagePath: r.storage_path,
    // 옛 서버 행에는 이 컬럼이 없다(`undefined`) — **`null`과 같이 「모름」으로 읽는다.**
    // 「모름」이 로컬의 진짜 값을 덮지 않게 하는 것은 pull의 몫이다(`pullMedia` 참조).
    gpsLat: r.gps_lat ?? null,
    gpsLng: r.gps_lng ?? null,
    width: r.width,
    height: r.height,
    // ⚠️ **촬영 시각도 서버에서 온다** — M-0034를 고칠 때 이 줄을 빠뜨렸다(자기점검 2026-07-27).
    // 이 값은 R2 객체 이름의 앞부분이 되고 사진 정렬에도 쓰인다. 비어 있으면(`''`) 그대로 둔다.
    takenAt: isoInstant(r.taken_at ?? ''),
    bytesDisplay: r.bytes_display,
    version: r.version,
    createdAt: isoInstant(r.created_at),
    updatedAt: isoInstant(r.updated_at),
    deletedAt: isoInstantOrNull(r.deleted_at),
    ...(r.client_operation_id ? { clientOperationId: r.client_operation_id } : {}),
  };
}

/**
 * Storage 경로 규약: `{userId}/{여행폴더}/{날짜_시간_제목__id32}.webp`.
 *
 * **첫 칸은 반드시 userId다.** 그게 이 앱의 인가 모델 전체다 — Edge Function은 검증된 sub로
 * `prefix`를 만들고 `key.startsWith(prefix)`가 아닌 키는 목록·삭제 어디에도 넣지 않는다.
 * 사용자가 *"폴더명을 여행 제목으로"*라고 했을 때 여행 폴더를 **그 안**에 넣은 이유가 이것이다.
 * 최상위를 제목으로 바꾸면 남의 파일을 못 건드리게 하는 근거가 사라진다.
 *
 * 이름 규칙 자체는 `domain/media/naming.ts` 한 곳에 있다(ZIP 백업과 공유).
 */
export function mediaStoragePath(
  userId: string,
  media: { id: string; tripId: string; takenAt: string | null },
  tripTitle: string | null | undefined,
): string {
  const folder = tripFolderName(tripTitle, media.tripId);
  const name = mediaObjectName(media.takenAt, tripTitle, media.id);
  return `${userId}/${folder}/${name}.webp`;
}
