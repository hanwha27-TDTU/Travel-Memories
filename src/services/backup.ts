// services/backup.ts — 전체 백업(내보내기)·복원(가져오기). 비타협 원칙 #1의 완화책:
// 브라우저 축출·사이트데이터 삭제는 앱 통제 밖 → 사용자가 파일로 기억을 보관·이전할 수 있게 한다.
//
// 두 가지 형식(둘 다 tombstone 포함·병합 복원):
//  1) 단일 JSON — 전 여행을 파일 하나에(사진 base64 내장). 조각날 일 없는 가장 안전한 통짜 복원본.
//  2) 여행별 폴더 ZIP — ZIP 안에 여행마다 하위폴더 + 사진을 실제 이미지 파일로. 탐색기에서 바로 보기·개별 복원.
//
// 층 분리(복원 드릴 검증 가능하게):
//  - db 접근층: exportCollectRows(읽기) / importMergeRows(병합) — 유일하게 Dexie를 만진다.
//  - 순수 직렬화층: serializeJson/deserializeJson, serializeZip/deserializeZip — db 없이 바이트↔행.
//    → 순수층이라 export→import 왕복 파리티를 실기기 없이 유닛으로 드릴한다(tests/unit/backupRoundtrip).
//  - 선택적 암호화(backupCrypto): 암호구절이 있으면 바이트 전체를 AES-GCM 봉투로 감싼다.
//
// 규율(SYNC_PROTOCOL 재사용, 손 병합 금지):
//  - 복원은 "교체"가 아니라 "병합". 각 행은 mergeDecision(LWW+tombstone)으로만 반영한다.
//  - 빈-데이터 가드: 백업이 비었는데 로컬에 활성 데이터가 있으면 로컬을 지우지 않는다.
//  - 동기화 전 임시 원본이 있으면 함께 담고, 없으면 클라우드 정본과 같은 표시본만 담는다.

import type { Table } from 'dexie';
import { db, type LocalTrip, type LocalMoment, type LocalMedia, type LocalExpense, type LocalAudio, type LocalPlace, type SyncMeta } from '../offline/db';
import { mergeDecision, isEmptyCloudAnomaly } from '../sync/merge';
import { zipStore, unzip, looksLikeZip, type ZipEntry } from './zip';
import { encryptBytes, decryptBytes, isEncryptedEnvelope } from './backupCrypto';
import { requestUnpurge } from './purge';
// 시각 표기의 SSOT — 서버 경계(rowmap)와 **같은 함수**를 쓴다(§7: 규율은 한 곳에 구현한다).
import { withCanonicalStamps } from '../domain/time';
// 이름 규칙은 **한 곳**에서 온다 — ZIP 폴더·파일명과 R2 객체 키가 같은 규율을 쓴다(§7).
import { tripFolderName as tripFolder, photoFileBase, audioFileBase } from '../domain/media/naming';
import { extForAudioMime } from '../domain/audio/note';

export { photoFileBase, stampFromISO } from '../domain/media/naming';

export const BACKUP_APP_TAG = 'bugeon-journey';
export const BACKUP_VERSION = 1;
/**
 * Browser restore reads the selected file into memory and may create a second
 * buffer while decrypting. Refuse inputs that cannot be handled predictably
 * before allocating or touching IndexedDB.
 */
export const MAX_BACKUP_IMPORT_BYTES = 1024 ** 3; // 1 GiB

function assertSupportedBackupVersion(value: unknown): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error('백업 버전 정보가 올바르지 않습니다.');
  }
  if ((value as number) > BACKUP_VERSION) {
    throw new Error(`이 백업은 더 새로운 앱 형식(v${String(value)})입니다. 앱을 업데이트한 뒤 다시 시도해 주세요.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertSyncRow(value: unknown, domain: string, index: number): asserts value is SyncMeta & { id: string } {
  if (!isRecord(value)) throw new Error(`${domain} ${index + 1}번째 항목이 올바른 객체가 아닙니다.`);
  const label = `${domain} ${index + 1}번째 항목`;
  if (typeof value.id !== 'string' || value.id.trim() === '') throw new Error(`${label}의 id가 올바르지 않습니다.`);
  for (const field of ['createdAt', 'updatedAt'] as const) {
    if (typeof value[field] !== 'string' || !Number.isFinite(Date.parse(value[field] as string))) {
      throw new Error(`${label}의 ${field} 시각이 올바르지 않습니다.`);
    }
  }
  if (!Number.isInteger(value.version) || (value.version as number) < 1) throw new Error(`${label}의 version이 올바르지 않습니다.`);
  if (value.deletedAt !== null && (typeof value.deletedAt !== 'string' || !Number.isFinite(Date.parse(value.deletedAt)))) {
    throw new Error(`${label}의 deletedAt 시각이 올바르지 않습니다.`);
  }
}

function assertRows(rows: CollectedRows): void {
  const domains: [string, unknown][] = [
    ['여행', rows.trips], ['순간', rows.moments], ['사진', rows.media],
    ['비용', rows.expenses], ['소리', rows.audio], ['장소', rows.places],
  ];
  for (const [domain, value] of domains) {
    if (!Array.isArray(value)) throw new Error(`${domain} 목록이 올바르지 않습니다.`);
    value.forEach((row, index) => {
      assertSyncRow(row, domain, index);
      const record = row as unknown as Record<string, unknown>;
      const label = `${domain} ${index + 1}번째 항목`;
      const requireString = (field: string) => {
        if (typeof record[field] !== 'string') throw new Error(`${label}의 ${field} 값이 올바르지 않습니다.`);
      };
      const requireFinite = (field: string) => {
        if (typeof record[field] !== 'number' || !Number.isFinite(record[field])) throw new Error(`${label}의 ${field} 값이 올바르지 않습니다.`);
      };
      if (domain === '여행') {
        ['title', 'startDate', 'endDate', 'status'].forEach(requireString);
      } else if (domain === '순간') {
        ['tripId', 'occurredAt', 'title', 'note', 'emotion', 'placeName'].forEach(requireString);
      } else if (domain === '사진') {
        ['momentId', 'tripId', 'mime', 'takenAt'].forEach(requireString);
        ['width', 'height', 'bytesOriginal', 'bytesDisplay'].forEach(requireFinite);
        for (const field of ['displayBlob', 'thumbBlob']) {
          if (!(record[field] instanceof Blob)) throw new Error(`${label}의 ${field} 값이 올바르지 않습니다.`);
        }
        if (record.originalBlob !== undefined && !(record.originalBlob instanceof Blob)) {
          throw new Error(`${label}의 originalBlob 값이 올바르지 않습니다.`);
        }
      } else if (domain === '비용') {
        ['momentId', 'tripId', 'originalCurrency', 'category', 'note'].forEach(requireString);
        requireFinite('originalAmount');
        if ((record.originalAmount as number) <= 0) throw new Error(`${label}의 originalAmount 값이 올바르지 않습니다.`);
      } else if (domain === '소리') {
        ['momentId', 'tripId', 'mime', 'recordedAt'].forEach(requireString);
        requireFinite('durationSec');
        if (!(record.blob instanceof Blob)) throw new Error(`${label}의 blob 값이 올바르지 않습니다.`);
      } else if (domain === '장소') {
        requireString('name');
        requireFinite('latitude');
        requireFinite('longitude');
        const lat = record.latitude as number;
        const lng = record.longitude as number;
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) throw new Error(`${label}의 좌표가 올바르지 않습니다.`);
      }
    });
  }
}

export function assertBackupImportSize(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes < 0 || bytes > MAX_BACKUP_IMPORT_BYTES) {
    throw new Error('백업 파일이 너무 큽니다. 복원은 1GB 이하 파일만 지원합니다.');
  }
}

/** 백업에 담기는 로컬 전 테이블(사용자 데이터). 두 형식이 이 한 곳에서만 읽는다. */
export interface CollectedRows {
  trips: LocalTrip[];
  moments: LocalMoment[];
  media: LocalMedia[];
  expenses: LocalExpense[];
  /** 오디오 노트(≤60초). 서버에 안 가므로 **백업이 두 번째 계층**이다 — 빠지면 계층이 하나뿐이다. */
  audio: LocalAudio[];
  /**
   * 장소 라이브러리(마이그레이션 0022). 별도 테이블이라 `check-backup-coverage`가 강제한다.
   *
   * 순간의 `placeName`/좌표와 **중복이 아니다**: 저건 그때 그렇게 기록한 사실이고, 이건
   * 사용자가 모아 둔 장소들(메모·분류·고쳐 확정한 좌표 포함)이다. 빠뜨리면 복원한 기기에서
   * 라이브러리만 텅 빈다.
   */
  places: LocalPlace[];
}

export interface BackupStats {
  trips: number;
  moments: number;
  media: number;
  expenses: number;
  audio: number;
  places: number;
}

export interface ImportResult {
  trips: number;
  moments: number;
  media: number;
  expenses: number;
  /** 복원된 오디오 노트 수. 화면이 「소리 N개」로 말한다(조용히 넘기지 않는다). */
  audio: number;
  /** 복원된 장소 수. 형제와 같은 규율 — 조용히 넘기지 않는다. */
  places: number;
  skippedEmptyGuard: boolean;
  /**
   * 서버 영구삭제 원장에서 **되돌리기를 요청한 건수**(복원이 되살린 id 중 새로 큐에 올린 수).
   * 0이 아니면 "영구삭제했던 것을 되살렸다"는 뜻이라 화면이 그렇게 말해야 한다.
   */
  unpurged?: number;
}

function statsOf(rows: CollectedRows): BackupStats {
  return { trips: rows.trips.length, moments: rows.moments.length, media: rows.media.length, expenses: rows.expenses.length, audio: rows.audio.length, places: rows.places.length };
}

// ═══════════════ db 접근층: 모든 사용자 데이터 테이블을 여기서만 읽고/병합한다 ═══════════════
// 새 형식(JSON·ZIP)은 반드시 이 둘을 거치므로 어떤 형식도 테이블을 빠뜨릴 수 없다.
// check-backup-coverage 게이트가 export-role/import-role 함수 양쪽에서 전 테이블 참조를 강제한다.

/** export 수집: 전 테이블(tombstone 포함)을 로컬에서 읽는다. */
export async function exportCollectRows(): Promise<CollectedRows> {
  const d = db();
  const [trips, moments, media, expenses, audio, places] = await Promise.all([
    d.localTrips.toArray(),
    d.localMoments.toArray(),
    d.localMedia.toArray(),
    d.localExpenses.toArray(),
    d.localAudio.toArray(),
    d.localPlaces.toArray(),
  ]);
  return { trips, moments, media, expenses, audio, places };
}


/** 백업 복원이 다루는 도메인 이름. `enqueue`·`mergeDomain`이 같은 어휘를 쓴다. */
type BackupDomain = 'trip' | 'moment' | 'media' | 'expense' | 'audio' | 'place';

/**
 * 한 도메인의 행들을 병합한다 — **여섯 곳에 손으로 쓰던 같은 루프를 한 곳으로**.
 *
 * 🔴 왜 뽑았나(§7 2층 · §11 「게이트가 설계를 밀어준다」): 예전에는 도메인마다 루프를 손으로
 * 복사했고, 그 안에는 **`enqueue`를 부르는 줄**이 있었다. 오디오를 추가할 때 그 줄이 빠져
 * *"복원한 녹음이 이 기기에만 남는"* 상태가 실제로 있었다(M-0033의 형태). 루프가 하나면
 * 다음 도메인은 **빠뜨릴 자리 자체가 없다** — 규율을 조항이 아니라 구조가 지킨다.
 *
 * 트랜잭션 안에서 호출해야 한다(호출부가 그렇게 한다). 반환값은 실제로 반영된 행 수다.
 */
async function mergeDomain<T extends SyncMeta & { id: string }>(
  table: Table<T, string>,
  incoming: readonly T[],
  entityType: BackupDomain,
  enqueue: (entityType: BackupDomain, row: SyncMeta & { id: string }) => Promise<void>,
): Promise<number> {
  let n = 0;
  for (const row of incoming) {
    if (mergeDecision(await table.get(row.id), row) !== 'take-server') continue;
    await table.put(row);
    await enqueue(entityType, row);
    n += 1;
  }
  return n;
}

/**
 * import 병합: 재구성된 행(미디어 blob 복원 완료)을 mergeDecision으로만 반영한다.
 * 절대 로컬을 통째로 덮어쓰지 않는다 — 빈-데이터 가드로 로컬을 지키고, 각 행은 LWW+tombstone.
 */
export async function importMergeRows(incoming: CollectedRows): Promise<ImportResult> {
  const d = db();
  // 시각 표기를 먼저 정규형으로 맞춘다(M-0034). 옛 백업 파일에는 서버 표기(`…48.34+00:00`)가
  // 그대로 들어 있고, 아래 `mergeDecision`은 시각으로 승부를 낸다 — 표기가 섞이면 판정이
  // 표기에 흔들린다. **같은 순간, 다른 표기**일 뿐이라 version·LWW 의미는 바뀌지 않는다.
  const rows: CollectedRows = {
    trips: incoming.trips.map(withCanonicalStamps),
    moments: incoming.moments.map(withCanonicalStamps),
    media: incoming.media.map(withCanonicalStamps),
    expenses: incoming.expenses.map(withCanonicalStamps),
    audio: (incoming.audio ?? []).map(withCanonicalStamps),
    // 옛 백업 파일에는 places가 아예 없다 — 없는 것은 빈 배열이지 결함이 아니다.
    places: (incoming.places ?? []).map(withCanonicalStamps),
  };

  const backupTotal = rows.trips.length + rows.moments.length;
  const [localTrips, localMoments] = await Promise.all([d.localTrips.toArray(), d.localMoments.toArray()]);
  const localActive =
    localTrips.filter((t) => t.deletedAt === null).length +
    localMoments.filter((m) => m.deletedAt === null).length;
  if (isEmptyCloudAnomaly(backupTotal, localActive)) {
    return { trips: 0, moments: 0, media: 0, expenses: 0, audio: 0, places: 0, skippedEmptyGuard: true, unpurged: 0 };
  }

  let tc = 0;
  let mc = 0;
  let mdc = 0;
  let ec = 0;
  let ac = 0;
  let pc = 0;
  // 복원한 행은 **서버로도 전파돼야** 한다. op를 만들지 않으면 그 기억은 이 기기에만 남고
  // 다른 기기·서버에 영영 닿지 않는다(재해 복구의 절반이 빠진 상태). 2026-07-25 감사 F2.
  /** 이번 복원이 되살린 id들 — 서버 원장에서도 빼야 한다(아래 requestUnpurge). */
  const restoredIds = new Set<string>();
  const enqueue = async (entityType: BackupDomain, row: SyncMeta & { id: string }): Promise<void> => {
    await d.syncQueue.add({
      operationId: crypto.randomUUID(),
      entityType,
      entityId: row.id,
      operationType: row.deletedAt !== null ? 'delete' : 'update',
      state: 'local_only',
      attempts: 0,
      createdAt: new Date().toISOString(),
    });
    // 사용자가 명시적으로 복원한 것은 "영구히 치움" 의사보다 우선한다 — 표식을 걷어낸다.
    // (남겨두면 로컬에는 있는데 pull이 계속 무시하는 어긋난 상태가 된다.)
    await d.purgedIds.delete(row.id);
    // ⚠️ **로컬만 걷어내면 안 된다**(2026-07-26 사용자 실기기). 서버 원장이 남아 있으면
    // ① BEFORE INSERT 트리거가 이 push를 거부하고 ② 이어지는 원장 pull이 로컬 행까지 지운다.
    // 복원이 통째로 무효화되는데 **사용자에게는 아무 오류도 안 보인다.**
    // 규칙을 한쪽에만 구현한 §7 비대칭이었다 — 서버 쪽 의사도 같이 남긴다.
    restoredIds.add(row.id);
  };

  // ⚠️ **되돌리기 의사는 행과 같은 커밋에 들어가야 한다**(2026-07-26, v1.03의 수정이 반쪽이었다).
  //
  // v1.03에서 `requestUnpurge`를 이 트랜잭션 **밖**에 두었다. 그 사이가 창이었다:
  //   커밋(행 있음 · 로컬 표식 없음 · **되돌리기 의사 없음**) → [여기서 동기화가 돌면]
  //   → applyPurgedLedger가 보호할 근거를 못 찾고 **방금 되살린 행을 지운다.**
  // 그 창은 이론이 아니다 — 파일 선택 창을 닫으면 `visibilitychange`가 즉시 동기화를 부르고,
  // ZIP 해제·blob 복원은 수 초가 걸린다. 사용자 실기기에서 실제로 그렇게 사라졌다.
  //
  // 그래서 값을 **트랜잭션 콜백의 반환값으로** 받는다. 밖으로 옮기려면 반환 경로가 끊기므로
  // 다음 사람이 무심코 되돌릴 수 없다(§7 2층 — 규율을 구조가 지킨다).
  const unpurged = await d.transaction('rw', [d.localTrips, d.localMoments, d.localMedia, d.localExpenses, d.localAudio, d.localPlaces, d.syncQueue, d.purgedIds], async () => {
    tc = await mergeDomain(d.localTrips, rows.trips, 'trip', enqueue);
    mc = await mergeDomain(d.localMoments, rows.moments, 'moment', enqueue);
    mdc = await mergeDomain(d.localMedia, rows.media, 'media', enqueue);
    ec = await mergeDomain(d.localExpenses, rows.expenses, 'expense', enqueue);
    // 오디오 노트 — **형제와 완전히 같다**(2026-07-27~). 예전 이 자리엔 *"서버로 안 가므로
    // op를 만들지 않는다"*가 적혀 있었고, 소리가 서버로 가게 된 뒤에도 그대로 두면 **복원한
    // 녹음이 이 기기에만 남는다**. 이제 그 실수를 할 자리가 없다 — 루프가 하나뿐이다.
    ac = await mergeDomain(d.localAudio, rows.audio, 'audio', enqueue);
    // 장소 라이브러리(2026-07-30) — 같은 루프를 지나므로 op 생성이 자동으로 따라온다.
    pc = await mergeDomain(d.localPlaces, rows.places, 'place', enqueue);
    // 서버 원장 되돌리기 의사를 **같은 커밋에** 남긴다. 여기서 바로 서버를 부르지 않는 이유:
    // 복원은 오프라인에서도 되고 호출은 실패할 수 있는데, 그냥 넘어가면 다음 동기화가 원장을
    // pull해 **복원한 것을 다시 지운다**(2026-07-26에 실제로 그랬다). 남겨야 재시도된다.
    return requestUnpurge([...restoredIds]);
  });

  return { trips: tc, moments: mc, media: mdc, expenses: ec, audio: ac, places: pc, skippedEmptyGuard: false, unpurged };
}

// ═══════════════ 순수 직렬화층: base64 · blob 유틸(FileReader 미사용 — Node/브라우저 공통) ═══════════════

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const mime = blob.type || 'application/octet-stream';
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

function b64ToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const header = dataUrl.slice(0, comma);
  const b64 = dataUrl.slice(comma + 1);
  const mimeMatch = /data:([^;]+)/.exec(header);
  const mime = mimeMatch ? mimeMatch[1]! : 'application/octet-stream';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

async function blobBytes(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await blob.arrayBuffer());
}

// ═══════════════════════ 형식 1: 단일 JSON (순수 직렬화) ═══════════════════════

/** 오디오 노트의 백업 표현 — blob은 data URL 문자열로. 사진(MediaExport)과 같은 형태. */
type AudioExport = Omit<LocalAudio, 'blob'> & { blobB64: string };

type MediaExport = Omit<LocalMedia, 'originalBlob' | 'displayBlob' | 'thumbBlob'> & {
  /** 동기화 전 임시 원본이 남아 있을 때만. v1 옛 백업과 하위호환한다. */
  originalB64?: string;
  displayB64: string;
  thumbB64: string;
};

export interface BackupFile {
  app: string;
  backupVersion: number;
  exportedAt: string;
  includePhotos: boolean;
  trips: LocalTrip[];
  moments: LocalMoment[];
  media: MediaExport[];
  /** 오디오 노트. 옛 백업 파일에는 없다(하위호환 — 없으면 빈 배열로 읽는다). */
  audio?: AudioExport[];
  expenses: LocalExpense[];
  /** 장소 라이브러리. 옛 백업 파일에는 없다(하위호환 — 없으면 빈 배열로 읽는다). */
  places?: LocalPlace[];
}

/** 순수: CollectedRows → JSON 문자열(사진 base64 내장). db 접근 없음(왕복 드릴 가능). */
export async function serializeJson(rows: CollectedRows): Promise<string> {
  const mediaOut: MediaExport[] = [];
  for (const m of rows.media) {
    const [o, di, t] = await Promise.all([
      m.originalBlob?.size ? blobToDataUrl(m.originalBlob) : Promise.resolve(undefined),
      blobToDataUrl(m.displayBlob),
      blobToDataUrl(m.thumbBlob),
    ]);
    const { originalBlob: _o, displayBlob: _d, thumbBlob: _t, ...rest } = m;
    mediaOut.push({ ...rest, ...(o ? { originalB64: o } : {}), displayB64: di, thumbB64: t });
  }
  // 오디오도 같은 규율로 담는다 — **빠지면 계층이 ①밖에 안 남는다**(서버에 안 가므로).
  const audioOut: AudioExport[] = [];
  for (const a of rows.audio) {
    const b64 = await blobToDataUrl(a.blob);
    const { blob: _b, ...rest } = a;
    audioOut.push({ ...rest, blobB64: b64 });
  }
  const file: BackupFile = {
    app: BACKUP_APP_TAG,
    backupVersion: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    includePhotos: true,
    trips: rows.trips,
    moments: rows.moments,
    media: mediaOut,
    expenses: rows.expenses,
    audio: audioOut,
    // 장소는 blob이 없어 그대로 담긴다(좌표와 글자뿐).
    places: rows.places,
  };
  return JSON.stringify(file);
}

/** 순수: JSON 문자열 → CollectedRows(미디어 blob 복원). db 접근 없음. */
export function deserializeJson(text: string): CollectedRows {
  assertBackupImportSize(text.length);
  let parsed: BackupFile;
  try {
    parsed = JSON.parse(text) as BackupFile;
  } catch {
    throw new Error('백업 파일을 읽을 수 없습니다(JSON 형식 아님).');
  }
  if (!parsed || parsed.app !== BACKUP_APP_TAG || !Array.isArray(parsed.trips)) {
    throw new Error('이 앱의 백업 파일이 아닙니다.');
  }
  assertSupportedBackupVersion(parsed.backupVersion);
  const mediaExport = Array.isArray(parsed.media) ? parsed.media : [];
  const media: LocalMedia[] = mediaExport.map((me) => {
    const { originalB64, displayB64, thumbB64, ...rest } = me;
    return {
      ...rest,
      ...(originalB64 ? { originalBlob: b64ToBlob(originalB64) } : {}),
      displayBlob: b64ToBlob(displayB64),
      thumbBlob: b64ToBlob(thumbB64),
    };
  });
  // 옛 백업 파일에는 audio가 없다 — 없으면 빈 배열(형식 하위호환).
  const audio: LocalAudio[] = (Array.isArray(parsed.audio) ? parsed.audio : []).map((a) => {
    const { blobB64, ...rest } = a;
    return { ...rest, blob: b64ToBlob(blobB64) };
  });
  const rows: CollectedRows = {
    trips: parsed.trips,
    moments: Array.isArray(parsed.moments) ? parsed.moments : [],
    media,
    expenses: Array.isArray(parsed.expenses) ? parsed.expenses : [],
    audio,
    // 옛 백업 파일에는 places가 없다 — 없으면 빈 배열(형식 하위호환).
    places: Array.isArray(parsed.places) ? parsed.places : [],
  };
  assertRows(rows);
  return rows;
}

// ═══════════════════════ 형식 2: 여행별 폴더 ZIP (순수 직렬화) ═══════════════════════

const ZIP_FORMAT = 'zip-per-trip-v1';
/** 최상위 장소 파일 — 장소는 여행의 자식이 아니라 사용자 소유라 폴더 밖에 산다(0022). */
const PLACES_JSON = 'places.json';
const ORPHAN_FOLDER = '_orphans';

type MediaMetaEntry = Omit<LocalMedia, 'originalBlob' | 'displayBlob' | 'thumbBlob'> & {
  displayFile: string;
  thumbFile: string;
  originalFile: string | null;
};

interface TripBundle {
  app?: string;
  backupVersion?: number;
  trip: LocalTrip | null;
  moments: LocalMoment[];
  media: MediaMetaEntry[];
  expenses: LocalExpense[];
  /** 오디오 노트 메타 + ZIP 안 파일명. 소리 파일은 `audio/` 하위에 실제 파일로 넣는다. */
  audio?: (Omit<LocalAudio, 'blob'> & { file: string })[];
}

interface ZipManifest {
  app: string;
  backupVersion: number;
  format: string;
  exportedAt: string;
  includeOriginals: boolean;
  folders: string[];
}

/** 파일시스템 안전 문자열: 금지문자 제거·공백→_·앞뒤 정리. */
/** ZIP 안 여행 폴더명 — R2 폴더와 **같은 규칙**을 쓴다(naming.ts 한 곳). */
function tripFolderName(trip: LocalTrip): string {
  return tripFolder(trip.title, trip.id);
}

function extForMime(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/heic') return 'heic';
  return 'bin';
}



const PURPOSE = { original: '원본', display: '표시본', thumb: '썸네일' } as const;

/** 순수: CollectedRows → ZIP Blob(여행 폴더 + trip.json + photos/ 실제 파일). db 접근 없음. */
export async function serializeZip(rows: CollectedRows, includeOriginals = true): Promise<Blob> {
  const tripById = new Map<string, LocalTrip>(rows.trips.map((t) => [t.id, t]));
  const folderOf = new Map<string, string>();
  for (const t of rows.trips) folderOf.set(t.id, tripFolderName(t));

  const entries: ZipEntry[] = [];
  const bundles = new Map<string, TripBundle>();
  const bundleFor = (tripId: string | null): { folder: string; bundle: TripBundle } => {
    const known = tripId !== null && tripById.has(tripId);
    const key = known ? tripId! : ORPHAN_FOLDER;
    const folder = known ? folderOf.get(tripId!)! : ORPHAN_FOLDER;
    let bundle = bundles.get(key);
    if (!bundle) {
      bundle = { trip: known ? tripById.get(tripId!)! : null, moments: [], media: [], expenses: [], audio: [] };
      bundles.set(key, bundle);
    }
    return { folder, bundle };
  };

  // 사진 제목: 순간 제목 우선, 없으면 여행 제목, 그것도 없으면 '사진'.
  const momentTitle = new Map<string, string>(rows.moments.map((m) => [m.id, m.title]));

  for (const t of rows.trips) bundleFor(t.id);
  for (const m of rows.moments) bundleFor(m.tripId ?? null).bundle.moments.push(m);
  for (const ex of rows.expenses) bundleFor(ex.tripId ?? null).bundle.expenses.push(ex);

  for (const me of rows.media) {
    const { folder, bundle } = bundleFor(me.tripId ?? null);
    const title = momentTitle.get(me.momentId) || (me.tripId ? tripById.get(me.tripId)?.title : '') || '';
    const base = photoFileBase(me.takenAt, title, me.id);
    const displayFile = `photos/${base}_${PURPOSE.display}.webp`;
    const thumbFile = `photos/${base}_${PURPOSE.thumb}.webp`;
    const originalFile = includeOriginals && me.originalBlob?.size
      ? `photos/${base}_${PURPOSE.original}.${extForMime(me.mime)}`
      : null;

    entries.push({ name: `${folder}/${displayFile}`, data: await blobBytes(me.displayBlob) });
    entries.push({ name: `${folder}/${thumbFile}`, data: await blobBytes(me.thumbBlob) });
    if (originalFile && me.originalBlob) entries.push({ name: `${folder}/${originalFile}`, data: await blobBytes(me.originalBlob) });

    const { originalBlob: _o, displayBlob: _d, thumbBlob: _t, ...rest } = me;
    bundle.media.push({ ...rest, displayFile, thumbFile, originalFile });
  }

  // 오디오 노트 — 사진과 **같은 규율**로 실제 파일로 넣는다(탐색기에서 바로 들을 수 있게).
  // 이름·제목 유도 모두 사진과 동일하다: `날짜_시간_제목__id8`, 제목은 **순간 제목 → 여행 제목**.
  // 규칙을 손으로 조립하지 않고 `audioFileBase`(naming.ts SSOT)를 지난다(§1-D).
  for (const a of rows.audio) {
    const { folder, bundle } = bundleFor(a.tripId ?? null);
    const title = momentTitle.get(a.momentId) || (a.tripId ? tripById.get(a.tripId)?.title : '') || '';
    const file = `audio/${audioFileBase(a.recordedAt, title, a.id)}.${extForAudioMime(a.mime)}`;
    entries.push({ name: `${folder}/${file}`, data: await blobBytes(a.blob) });
    const { blob: _b, ...rest } = a;
    bundle.audio!.push({ ...rest, file });
  }

  const folders: string[] = [];
  const enc = new TextEncoder();
  for (const [key, bundle] of bundles) {
    const isOrphan = key === ORPHAN_FOLDER;
    const folder = isOrphan ? ORPHAN_FOLDER : folderOf.get(key)!;
    folders.push(folder);
    const jsonName = isOrphan ? `${ORPHAN_FOLDER}/orphans.json` : `${folder}/trip.json`;
    const payload = {
      app: BACKUP_APP_TAG,
      backupVersion: BACKUP_VERSION,
      trip: bundle.trip,
      moments: bundle.moments,
      media: bundle.media,
      expenses: bundle.expenses,
      audio: bundle.audio ?? [],
    };
    entries.push({ name: jsonName, data: enc.encode(JSON.stringify(payload)) });
  }

  // 🔴 장소는 **여행 폴더에 들어가지 않는다** — 여행의 자식이 아니기 때문이다(0022).
  // 한 장소는 여러 여행에 걸치므로 어느 폴더에 넣어도 거짓말이 된다. 그래서 최상위 파일이다.
  entries.push({ name: PLACES_JSON, data: enc.encode(JSON.stringify({ app: BACKUP_APP_TAG, places: rows.places })) });

  const manifest: ZipManifest = {
    app: BACKUP_APP_TAG,
    backupVersion: BACKUP_VERSION,
    format: ZIP_FORMAT,
    exportedAt: new Date().toISOString(),
    includeOriginals,
    folders,
  };
  entries.push({ name: 'manifest.json', data: enc.encode(JSON.stringify(manifest)) });

  return zipStore(entries);
}

/** 순수: ZIP → CollectedRows(사진 파일에서 blob 재구성). db 접근 없음. */
export function deserializeZip(buf: ArrayBuffer): CollectedRows {
  assertBackupImportSize(buf.byteLength);
  const files = unzip(buf);
  const byName = new Map<string, Uint8Array<ArrayBuffer>>(files.map((f) => [f.name, f.data]));

  const manifestRaw = byName.get('manifest.json');
  if (!manifestRaw) throw new Error('이 앱의 폴더 백업(ZIP)이 아닙니다(manifest 없음).');
  let manifest: ZipManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestRaw)) as ZipManifest;
  } catch {
    throw new Error('manifest.json을 읽을 수 없습니다.');
  }
  if (manifest.app !== BACKUP_APP_TAG || manifest.format !== ZIP_FORMAT) throw new Error('이 앱의 백업이 아닙니다.');
  assertSupportedBackupVersion(manifest.backupVersion);

  const dec = new TextDecoder();
  const trips: LocalTrip[] = [];
  const moments: LocalMoment[] = [];
  const media: LocalMedia[] = [];
  const expenses: LocalExpense[] = [];
  const audio: LocalAudio[] = [];

  // 최상위 장소 파일. **옛 백업에는 없다** — 없으면 빈 배열이고 그건 결함이 아니다.
  const places: LocalPlace[] = (() => {
    const raw = byName.get(PLACES_JSON);
    if (!raw) return [];
    let parsed: { app?: unknown; places?: unknown };
    try {
      parsed = JSON.parse(dec.decode(raw)) as { app?: unknown; places?: unknown };
    } catch {
      throw new Error(`${PLACES_JSON}을 읽을 수 없습니다(손상).`);
    }
    if (parsed.app !== BACKUP_APP_TAG || !Array.isArray(parsed.places)) throw new Error(`${PLACES_JSON} 형식이 올바르지 않습니다.`);
    return parsed.places as LocalPlace[];
  })();

  for (const f of files) {
    const isTrip = f.name.endsWith('/trip.json');
    const isOrphan = f.name === `${ORPHAN_FOLDER}/orphans.json`;
    if (!isTrip && !isOrphan) continue;

    const folder = f.name.slice(0, f.name.lastIndexOf('/'));
    let bundle: TripBundle;
    try {
      bundle = JSON.parse(dec.decode(f.data)) as TripBundle;
    } catch {
      throw new Error(`${f.name}을 읽을 수 없습니다(손상).`);
    }
    if (bundle.app !== BACKUP_APP_TAG) throw new Error(`${f.name}은 이 앱의 백업 조각이 아닙니다.`);
    assertSupportedBackupVersion(bundle.backupVersion);
    if (!Array.isArray(bundle.moments) || !Array.isArray(bundle.media) || !Array.isArray(bundle.expenses)) {
      throw new Error(`${f.name}의 목록 형식이 올바르지 않습니다.`);
    }

    if (bundle.trip) trips.push(bundle.trip);
    // 오디오 — 파일이 없으면 **건너뛴다**(사진과 같은 규율: 반쪽 행을 만들지 않는다).
    for (const meta of bundle.audio ?? []) {
      const { file, ...rest } = meta;
      const data = byName.get(`${folder}/${file}`);
      if (!data) continue;
      audio.push({ ...rest, blob: new Blob([data], { type: rest.mime }) });
    }
    if (Array.isArray(bundle.moments)) moments.push(...bundle.moments);
    if (Array.isArray(bundle.expenses)) expenses.push(...bundle.expenses);

    for (const meta of bundle.media ?? []) {
      const { displayFile, thumbFile, originalFile, ...rest } = meta;
      const displayData = byName.get(`${folder}/${displayFile}`);
      const thumbData = byName.get(`${folder}/${thumbFile}`);
      if (!displayData || !thumbData) continue;
      const displayBlob = new Blob([displayData], { type: 'image/webp' });
      const thumbBlob = new Blob([thumbData], { type: 'image/webp' });
      const origData = originalFile ? byName.get(`${folder}/${originalFile}`) : undefined;
      media.push({
        ...rest,
        ...(origData ? { originalBlob: new Blob([origData], { type: rest.mime }) } : {}),
        displayBlob,
        thumbBlob,
      });
    }
  }
  const rows = { trips, moments, media, expenses, audio, places };
  assertRows(rows);
  return rows;
}

// ═══════════════════════ 공개 API: db + 직렬화 + (선택)암호화 결합 ═══════════════════════

/** 단일 JSON 백업. passphrase가 있으면 AES-GCM 봉투로 암호화. */
export async function exportBackup(_includePhotos = true, passphrase?: string): Promise<{ blob: Blob; stats: BackupStats }> {
  const rows = await exportCollectRows();
  const json = await serializeJson(rows);
  let blob: Blob;
  if (passphrase) {
    const enc = await encryptBytes(new TextEncoder().encode(json), passphrase);
    blob = new Blob([enc], { type: 'application/octet-stream' });
  } else {
    blob = new Blob([json], { type: 'application/json' });
  }
  return { blob, stats: statsOf(rows) };
}

/** 여행별 폴더 ZIP 백업. passphrase가 있으면 ZIP 바이트 전체를 AES-GCM 봉투로 암호화. */
export async function exportBackupZip(includeOriginals = true, passphrase?: string): Promise<{ blob: Blob; stats: BackupStats }> {
  const rows = await exportCollectRows();
  const zipBlob = await serializeZip(rows, includeOriginals);
  let blob: Blob = zipBlob;
  if (passphrase) {
    const enc = await encryptBytes(await blobBytes(zipBlob), passphrase);
    blob = new Blob([enc], { type: 'application/octet-stream' });
  }
  return { blob, stats: statsOf(rows) };
}

export async function importBackup(text: string): Promise<ImportResult> {
  return importMergeRows(deserializeJson(text));
}

export async function importBackupZip(buf: ArrayBuffer): Promise<ImportResult> {
  return importMergeRows(deserializeZip(buf));
}

/**
 * 파일 바이트로 형식을 자동 감지해 복원. 순서: 암호화 봉투 → (복호) → ZIP(PK) → JSON.
 * 암호화 봉투인데 passphrase가 없으면 needsPassphrase로 UI에 알린다(복원 안 함).
 */
export async function importBackupAuto(
  buf: ArrayBuffer,
  passphrase?: string,
): Promise<ImportResult & { needsPassphrase?: boolean }> {
  assertBackupImportSize(buf.byteLength);
  let bytes = new Uint8Array(buf);
  if (isEncryptedEnvelope(bytes)) {
    if (!passphrase) return { trips: 0, moments: 0, media: 0, expenses: 0, audio: 0, places: 0, skippedEmptyGuard: false, unpurged: 0, needsPassphrase: true };
    const plain = await decryptBytes(bytes, passphrase); // 실패 시 throw(암호 틀림)
    assertBackupImportSize(plain.byteLength);
    bytes = plain;
  }
  const view = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  if (looksLikeZip(bytes.subarray(0, 4))) return importBackupZip(view);
  return importBackup(new TextDecoder().decode(bytes));
}
