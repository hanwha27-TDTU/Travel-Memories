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
//  - 사진 원본은 읽기만 하고 수정하지 않는다(§0). 고아 행(부모 없는 순간/사진/비용)도 유실 없이 담는다.

import { db, type LocalTrip, type LocalMoment, type LocalMedia, type LocalExpense, type SyncMeta } from '../offline/db';
import { mergeDecision, isEmptyCloudAnomaly } from '../sync/merge';
import { zipStore, unzip, looksLikeZip, type ZipEntry } from './zip';
import { encryptBytes, decryptBytes, isEncryptedEnvelope } from './backupCrypto';
import { requestUnpurge } from './purge';

export const BACKUP_APP_TAG = 'bugeon-journey';
export const BACKUP_VERSION = 1;

/** 백업에 담기는 로컬 전 테이블(사용자 데이터). 두 형식이 이 한 곳에서만 읽는다. */
export interface CollectedRows {
  trips: LocalTrip[];
  moments: LocalMoment[];
  media: LocalMedia[];
  expenses: LocalExpense[];
}

export interface BackupStats {
  trips: number;
  moments: number;
  media: number;
  expenses: number;
}

export interface ImportResult {
  trips: number;
  moments: number;
  media: number;
  expenses: number;
  skippedEmptyGuard: boolean;
  /**
   * 서버 영구삭제 원장에서 **되돌리기를 요청한 건수**(복원이 되살린 id 중 새로 큐에 올린 수).
   * 0이 아니면 "영구삭제했던 것을 되살렸다"는 뜻이라 화면이 그렇게 말해야 한다.
   */
  unpurged?: number;
}

function statsOf(rows: CollectedRows): BackupStats {
  return { trips: rows.trips.length, moments: rows.moments.length, media: rows.media.length, expenses: rows.expenses.length };
}

// ═══════════════ db 접근층: 모든 사용자 데이터 테이블을 여기서만 읽고/병합한다 ═══════════════
// 새 형식(JSON·ZIP)은 반드시 이 둘을 거치므로 어떤 형식도 테이블을 빠뜨릴 수 없다.
// check-backup-coverage 게이트가 export-role/import-role 함수 양쪽에서 전 테이블 참조를 강제한다.

/** export 수집: 전 테이블(tombstone 포함)을 로컬에서 읽는다. */
export async function exportCollectRows(): Promise<CollectedRows> {
  const d = db();
  const [trips, moments, media, expenses] = await Promise.all([
    d.localTrips.toArray(),
    d.localMoments.toArray(),
    d.localMedia.toArray(),
    d.localExpenses.toArray(),
  ]);
  return { trips, moments, media, expenses };
}

/**
 * import 병합: 재구성된 행(미디어 blob 복원 완료)을 mergeDecision으로만 반영한다.
 * 절대 로컬을 통째로 덮어쓰지 않는다 — 빈-데이터 가드로 로컬을 지키고, 각 행은 LWW+tombstone.
 */
export async function importMergeRows(rows: CollectedRows): Promise<ImportResult> {
  const d = db();

  const backupTotal = rows.trips.length + rows.moments.length;
  const [localTrips, localMoments] = await Promise.all([d.localTrips.toArray(), d.localMoments.toArray()]);
  const localActive =
    localTrips.filter((t) => t.deletedAt === null).length +
    localMoments.filter((m) => m.deletedAt === null).length;
  if (isEmptyCloudAnomaly(backupTotal, localActive)) {
    return { trips: 0, moments: 0, media: 0, expenses: 0, skippedEmptyGuard: true, unpurged: 0 };
  }

  let tc = 0;
  let mc = 0;
  let mdc = 0;
  let ec = 0;
  // 복원한 행은 **서버로도 전파돼야** 한다. op를 만들지 않으면 그 기억은 이 기기에만 남고
  // 다른 기기·서버에 영영 닿지 않는다(재해 복구의 절반이 빠진 상태). 2026-07-25 감사 F2.
  /** 이번 복원이 되살린 id들 — 서버 원장에서도 빼야 한다(아래 requestUnpurge). */
  const restoredIds = new Set<string>();
  const enqueue = async (entityType: 'trip' | 'moment' | 'media' | 'expense', row: SyncMeta & { id: string }): Promise<void> => {
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
  const unpurged = await d.transaction('rw', [d.localTrips, d.localMoments, d.localMedia, d.localExpenses, d.syncQueue, d.purgedIds], async () => {
    for (const t of rows.trips) {
      if (mergeDecision(await d.localTrips.get(t.id), t) === 'take-server') {
        await d.localTrips.put(t);
        await enqueue('trip', t);
        tc += 1;
      }
    }
    for (const m of rows.moments) {
      if (mergeDecision(await d.localMoments.get(m.id), m) === 'take-server') {
        await d.localMoments.put(m);
        await enqueue('moment', m);
        mc += 1;
      }
    }
    for (const me of rows.media) {
      if (mergeDecision(await d.localMedia.get(me.id), me) === 'take-server') {
        await d.localMedia.put(me);
        await enqueue('media', me);
        mdc += 1;
      }
    }
    for (const ex of rows.expenses) {
      if (mergeDecision(await d.localExpenses.get(ex.id), ex) === 'take-server') {
        await d.localExpenses.put(ex);
        await enqueue('expense', ex);
        ec += 1;
      }
    }
    // 서버 원장 되돌리기 의사를 **같은 커밋에** 남긴다. 여기서 바로 서버를 부르지 않는 이유:
    // 복원은 오프라인에서도 되고 호출은 실패할 수 있는데, 그냥 넘어가면 다음 동기화가 원장을
    // pull해 **복원한 것을 다시 지운다**(2026-07-26에 실제로 그랬다). 남겨야 재시도된다.
    return requestUnpurge([...restoredIds]);
  });

  return { trips: tc, moments: mc, media: mdc, expenses: ec, skippedEmptyGuard: false, unpurged };
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

type MediaExport = Omit<LocalMedia, 'originalBlob' | 'displayBlob' | 'thumbBlob'> & {
  originalB64: string;
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
  expenses: LocalExpense[];
}

/** 순수: CollectedRows → JSON 문자열(사진 base64 내장). db 접근 없음(왕복 드릴 가능). */
export async function serializeJson(rows: CollectedRows): Promise<string> {
  const mediaOut: MediaExport[] = [];
  for (const m of rows.media) {
    const [o, di, t] = await Promise.all([blobToDataUrl(m.originalBlob), blobToDataUrl(m.displayBlob), blobToDataUrl(m.thumbBlob)]);
    const { originalBlob: _o, displayBlob: _d, thumbBlob: _t, ...rest } = m;
    mediaOut.push({ ...rest, originalB64: o, displayB64: di, thumbB64: t });
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
  };
  return JSON.stringify(file);
}

/** 순수: JSON 문자열 → CollectedRows(미디어 blob 복원). db 접근 없음. */
export function deserializeJson(text: string): CollectedRows {
  let parsed: BackupFile;
  try {
    parsed = JSON.parse(text) as BackupFile;
  } catch {
    throw new Error('백업 파일을 읽을 수 없습니다(JSON 형식 아님).');
  }
  if (!parsed || parsed.app !== BACKUP_APP_TAG || !Array.isArray(parsed.trips)) {
    throw new Error('이 앱의 백업 파일이 아닙니다.');
  }
  const mediaExport = Array.isArray(parsed.media) ? parsed.media : [];
  const media: LocalMedia[] = mediaExport.map((me) => {
    const { originalB64, displayB64, thumbB64, ...rest } = me;
    return { ...rest, originalBlob: b64ToBlob(originalB64), displayBlob: b64ToBlob(displayB64), thumbBlob: b64ToBlob(thumbB64) };
  });
  return {
    trips: parsed.trips,
    moments: Array.isArray(parsed.moments) ? parsed.moments : [],
    media,
    expenses: Array.isArray(parsed.expenses) ? parsed.expenses : [],
  };
}

// ═══════════════════════ 형식 2: 여행별 폴더 ZIP (순수 직렬화) ═══════════════════════

const ZIP_FORMAT = 'zip-per-trip-v1';
const ORPHAN_FOLDER = '_orphans';

type MediaMetaEntry = Omit<LocalMedia, 'originalBlob' | 'displayBlob' | 'thumbBlob'> & {
  displayFile: string;
  thumbFile: string;
  originalFile: string | null;
};

interface TripBundle {
  trip: LocalTrip | null;
  moments: LocalMoment[];
  media: MediaMetaEntry[];
  expenses: LocalExpense[];
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
function fsSafe(s: string, max = 40): string {
  return (s || '')
    .replace(/[\/\\:*?"<>|]/g, '')
    .replace(/\s+/g, '_')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, max)
    .trim();
}

function tripFolderName(trip: LocalTrip): string {
  const base = fsSafe(trip.title || '여행', 60);
  const suffix = trip.id.replace(/-/g, '').slice(0, 8);
  return `${base || '여행'}__${suffix}`;
}

function extForMime(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/heic') return 'heic';
  return 'bin';
}

/** ISO → { date:'YYYYMMDD', time:'HHMM' }. 로컬 시각 기준. 파싱 불가면 '00000000'/'0000'. */
export function stampFromISO(iso: string | null | undefined): { date: string; time: string } {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return { date: '00000000', time: '0000' };
  const d = new Date(t);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return {
    date: `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`,
    time: `${p(d.getHours())}${p(d.getMinutes())}`,
  };
}

/**
 * 백업 사진 파일명(순수): '날짜_시간_제목_용도__id8'. 사람이 알아볼 수 있게.
 * 같은 분·같은 제목이어도 미디어 id 접미로 충돌하지 않는다(복원은 메타 경로로 되읽으므로 안전).
 */
export function photoFileBase(takenAt: string | null | undefined, title: string, mediaId: string): string {
  const { date, time } = stampFromISO(takenAt);
  const t = fsSafe(title, 30) || '사진';
  const id8 = mediaId.replace(/-/g, '').slice(0, 8);
  return `${date}_${time}_${t}__${id8}`;
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
      bundle = { trip: known ? tripById.get(tripId!)! : null, moments: [], media: [], expenses: [] };
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
    const originalFile = includeOriginals ? `photos/${base}_${PURPOSE.original}.${extForMime(me.mime)}` : null;

    entries.push({ name: `${folder}/${displayFile}`, data: await blobBytes(me.displayBlob) });
    entries.push({ name: `${folder}/${thumbFile}`, data: await blobBytes(me.thumbBlob) });
    if (originalFile) entries.push({ name: `${folder}/${originalFile}`, data: await blobBytes(me.originalBlob) });

    const { originalBlob: _o, displayBlob: _d, thumbBlob: _t, ...rest } = me;
    bundle.media.push({ ...rest, displayFile, thumbFile, originalFile });
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
    };
    entries.push({ name: jsonName, data: enc.encode(JSON.stringify(payload)) });
  }

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
  if (manifest.app !== BACKUP_APP_TAG) throw new Error('이 앱의 백업이 아닙니다.');

  const dec = new TextDecoder();
  const trips: LocalTrip[] = [];
  const moments: LocalMoment[] = [];
  const media: LocalMedia[] = [];
  const expenses: LocalExpense[] = [];

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

    if (bundle.trip) trips.push(bundle.trip);
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
      const originalBlob = origData ? new Blob([origData], { type: rest.mime }) : displayBlob;
      media.push({ ...rest, originalBlob, displayBlob, thumbBlob });
    }
  }
  return { trips, moments, media, expenses };
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
  let bytes = new Uint8Array(buf);
  if (isEncryptedEnvelope(bytes)) {
    if (!passphrase) return { trips: 0, moments: 0, media: 0, expenses: 0, skippedEmptyGuard: false, unpurged: 0, needsPassphrase: true };
    const plain = await decryptBytes(bytes, passphrase); // 실패 시 throw(암호 틀림)
    bytes = plain;
  }
  const view = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  if (looksLikeZip(bytes.subarray(0, 4))) return importBackupZip(view);
  return importBackup(new TextDecoder().decode(bytes));
}
