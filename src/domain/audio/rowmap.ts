// domain/audio/rowmap.ts — 오디오 노트의 직렬화 경계 (docs/DATA_MODEL.md · 마이그레이션 0019).
//
// ── 사진과 하나만 다르다 ──────────────────────────────────────────────
// 사진은 입력 파일 대신 EXIF가 제거된 **표시본을 앱 정본**으로 올린다(ADR-0046). 소리는 **원본이 곧
// 유일본**이라 그것을 올린다 — 60초 opus가 ~100KB로 표시본 사진(~300KB)보다 가볍다.
// 즉 "가공본만 올린다"는 규칙은 사진의 사정이지 소리의 사정이 아니다(§7 — 비대칭은 설계
// 단계에서 심사하고 이유를 적는다). 나머지 규율(LWW·tombstone·좀비 차단·기기 스탬프)은 같다.
//
// blob은 행에 담지 않는다 — 바이트는 R2로 가고 행에는 **착지한 키**만 적는다.
// `check-schema-parity` 게이트가 AudioRow 필드 ⊆ journey.audio 컬럼을 강제한다.

import { tripFolderName, audioObjectName, audioExt } from '../media/naming';
import { isoInstant, isoInstantOrNull, type WithInstants } from '../time';
import type { LocalAudio } from '../../offline/db';

/** Supabase journey.audio 행 (snake_case — 이 파일 밖에서 사용 금지). blob은 담지 않는다. */
export interface AudioRow {
  id: string;
  user_id: string;
  moment_id: string;
  trip_id: string;
  storage_path: string | null;
  duration_sec: number;
  mime: string;
  bytes: number;
  recorded_at: string | null;
  source: string;
  version: number;
  base_version?: number | null;
  base_canonical_version?: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  client_operation_id: string | null;
  /** 마지막으로 이 행을 올린 기기(`라벨#짧은id`) — 진단의 "기기별 현황"이 읽는다. */
  updated_by_device?: string | null;
}

/** 행에서 복원되는 메타(바이트 제외). pull이 여기에 내려받은 blob을 붙여 LocalAudio를 만든다. */
export interface AudioMeta {
  id: string;
  momentId: string;
  tripId: string;
  storagePath: string | null;
  durationSec: number;
  mime: string;
  bytes: number;
  recordedAt: string;
  version: number;
  baseVersion: number;
  baseCanonicalVersion: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  clientOperationId?: string;
}

export function toAudioRow(
  a: LocalAudio,
  userId: string,
  storagePath: string | null,
  device?: string,
): AudioRow {
  return {
    id: a.id,
    user_id: userId,
    updated_by_device: device ?? null,
    moment_id: a.momentId,
    trip_id: a.tripId,
    storage_path: storagePath,
    duration_sec: a.durationSec,
    mime: a.mime,
    // 바이트 수는 blob에서 읽는다 — 사용자가 적는 값이 아니라 **사실**이다.
    bytes: a.blob?.size ?? 0,
    recorded_at: a.recordedAt || null,
    source: 'user',
    version: a.version,
    base_version: a.baseVersion ?? Math.max(0, a.version - 1),
    base_canonical_version: a.baseCanonicalVersion ?? 'legacy',
    created_at: a.createdAt,
    updated_at: a.updatedAt,
    deleted_at: a.deletedAt,
    client_operation_id: a.clientOperationId ?? null,
  };
}

/**
 * 서버 행 → 메타. 시각은 **반드시** `isoInstant()`를 통과한다(M-0034).
 *
 * 왜 한 줄도 빼면 안 되나: 서버는 `…48.34+00:00`, 로컬은 `…48.340Z`로 **같은 순간을 다르게**
 * 적는다. 문자열로 비교하는 자리(정렬·`mergeDecision`·진단의 시간 역전)가 그 차이를 시간
 * 차이로 읽는다. 사진에서 `taken_at` 한 줄을 빠뜨려 실제로 그 사고가 났다 — 여기서는
 * `recorded_at`이 같은 자리다(R2 파일 이름의 앞부분이 되고 칩 정렬 기준이다).
 */
export function fromAudioRow(r: AudioRow): WithInstants<AudioMeta> {
  return {
    id: r.id,
    momentId: r.moment_id,
    tripId: r.trip_id,
    storagePath: r.storage_path,
    durationSec: r.duration_sec ?? 0,
    mime: r.mime || '',
    bytes: r.bytes ?? 0,
    recordedAt: isoInstant(r.recorded_at ?? ''),
    version: r.version,
    baseVersion: r.version,
    baseCanonicalVersion: r.base_canonical_version ?? 'legacy',
    createdAt: isoInstant(r.created_at),
    updatedAt: isoInstant(r.updated_at),
    deletedAt: isoInstantOrNull(r.deleted_at),
    ...(r.client_operation_id ? { clientOperationId: r.client_operation_id } : {}),
  };
}

/**
 * Storage 경로 규약: `{userId}/{여행폴더}/{날짜_시간_제목__id32}.{ext}`.
 *
 * **사진과 같은 폴더에 나란히 산다.** 다른 폴더로 가르고 싶은 모양이지만 그러면 안 된다 —
 * 사용자가 콘솔에서 한 여행을 열면 그 여행의 자료가 **한 자리에** 있어야 하고, 그게 폴더명을
 * 여행 제목으로 바꾼 이유였다(2026-07-27). 종류는 확장자가 말한다.
 *
 * **첫 칸은 반드시 userId다** — 그게 이 앱의 인가 모델 전체다(`mediaStoragePath` 머리주석).
 *
 * 확장자를 모르는 형식이면 **null**이다. 그때는 올리지 않는다 — 거짓 확장자를 붙이면
 * 재생기가 잘못된 디코더를 고르고, `mediaIdOfKey`도 그 키를 못 읽어 「설명할 수 없는 파일」이
 * 된다. 모르는 것을 아는 척하지 않는다(비타협 원칙 #4).
 */
export function audioStoragePath(
  userId: string,
  audio: { id: string; tripId: string; recordedAt: string | null; mime: string },
  tripTitle: string | null | undefined,
): string | null {
  const ext = audioExt(audio.mime);
  if (!ext) return null;
  const folder = tripFolderName(tripTitle, audio.tripId);
  const name = audioObjectName(audio.recordedAt, tripTitle, audio.id);
  return `${userId}/${folder}/${name}.${ext}`;
}
