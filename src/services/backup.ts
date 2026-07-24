// services/backup.ts — 전체 백업(내보내기)·복원(가져오기). 비타협 원칙 #1의 완화책:
// 브라우저 축출·사이트데이터 삭제는 앱 통제 밖 → 사용자가 파일로 기억을 보관·이전할 수 있게 한다.
//
// 두 가지 형식(둘 다 tombstone 포함·병합 복원):
//  1) 단일 JSON — 전 여행을 파일 하나에(사진 base64 내장). 조각날 일 없는 가장 안전한 통짜 복원본.
//  2) 여행별 폴더 ZIP — ZIP 안에 여행마다 하위폴더 + 사진을 실제 이미지 파일로. 탐색기에서 바로 보기·개별 복원.
//
// 규율(SYNC_PROTOCOL 재사용, 손 병합 금지 — 두 형식이 공통 collect/merge 코어를 공유):
//  - 복원은 "교체"가 아니라 "병합". 각 행은 mergeDecision(LWW+tombstone)으로만 반영한다.
//  - 빈-데이터 가드: 백업이 비었는데 로컬에 활성 데이터가 있으면 로컬을 지우지 않는다.
//  - 사진 원본은 읽기만 하고 수정하지 않는다(§0).
//  - 고아 행(부모 여행이 없는 순간/사진/비용)도 유실 없이 담는다(완전성).

import { db, type LocalTrip, type LocalMoment, type LocalMedia, type LocalExpense } from '../offline/db';
import { mergeDecision, isEmptyCloudAnomaly } from '../sync/merge';
import { zipStore, unzip, looksLikeZip, type ZipEntry } from './zip';

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
}

// ── 공통 코어: 모든 사용자 데이터 테이블을 여기서만 읽고(export) / 여기서만 병합한다(import) ──
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

  // 빈-데이터 가드: 백업이 사실상 비었는데 로컬에 활성 데이터가 있으면 반영하지 않는다.
  const backupTotal = rows.trips.length + rows.moments.length;
  const [localTrips, localMoments] = await Promise.all([d.localTrips.toArray(), d.localMoments.toArray()]);
  const localActive =
    localTrips.filter((t) => t.deletedAt === null).length +
    localMoments.filter((m) => m.deletedAt === null).length;
  if (isEmptyCloudAnomaly(backupTotal, localActive)) {
    return { trips: 0, moments: 0, media: 0, expenses: 0, skippedEmptyGuard: true };
  }

  let tc = 0;
  let mc = 0;
  let mdc = 0;
  let ec = 0;
  await d.transaction('rw', d.localTrips, d.localMoments, d.localMedia, d.localExpenses, async () => {
    for (const t of rows.trips) {
      if (mergeDecision(await d.localTrips.get(t.id), t) === 'take-server') {
        await d.localTrips.put(t);
        tc += 1;
      }
    }
    for (const m of rows.moments) {
      if (mergeDecision(await d.localMoments.get(m.id), m) === 'take-server') {
        await d.localMoments.put(m);
        mc += 1;
      }
    }
    for (const me of rows.media) {
      if (mergeDecision(await d.localMedia.get(me.id), me) === 'take-server') {
        await d.localMedia.put(me);
        mdc += 1;
      }
    }
    for (const ex of rows.expenses) {
      if (mergeDecision(await d.localExpenses.get(ex.id), ex) === 'take-server') {
        await d.localExpenses.put(ex);
        ec += 1;
      }
    }
  });
  return { trips: tc, moments: mc, media: mdc, expenses: ec, skippedEmptyGuard: false };
}

// ── blob ↔ base64 (JSON 형식용) ──
function blobToB64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error ?? new Error('사진 읽기 실패'));
    r.readAsDataURL(blob);
  });
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

// ═══════════════════════ 형식 1: 단일 JSON ═══════════════════════

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

/** 전체 백업을 단일 JSON Blob으로. 사진 3종을 base64로 내장해 완전 복원 가능. */
export async function exportBackup(includePhotos = true): Promise<{ blob: Blob; stats: BackupStats }> {
  const rows = await exportCollectRows();

  const mediaOut: MediaExport[] = [];
  if (includePhotos) {
    for (const m of rows.media) {
      const [o, di, t] = await Promise.all([
        blobToB64(m.originalBlob),
        blobToB64(m.displayBlob),
        blobToB64(m.thumbBlob),
      ]);
      const { originalBlob: _o, displayBlob: _d, thumbBlob: _t, ...rest } = m;
      mediaOut.push({ ...rest, originalB64: o, displayB64: di, thumbB64: t });
    }
  }

  const file: BackupFile = {
    app: BACKUP_APP_TAG,
    backupVersion: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    includePhotos,
    trips: rows.trips,
    moments: rows.moments,
    media: mediaOut,
    expenses: rows.expenses,
  };
  const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
  return {
    blob,
    stats: { trips: rows.trips.length, moments: rows.moments.length, media: mediaOut.length, expenses: rows.expenses.length },
  };
}

/** 단일 JSON 백업을 병합 복원. 미디어 blob을 base64에서 복원한 뒤 공통 코어로 병합. */
export async function importBackup(text: string): Promise<ImportResult> {
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
    return {
      ...rest,
      originalBlob: b64ToBlob(originalB64),
      displayBlob: b64ToBlob(displayB64),
      thumbBlob: b64ToBlob(thumbB64),
    };
  });

  return importMergeRows({
    trips: parsed.trips,
    moments: Array.isArray(parsed.moments) ? parsed.moments : [],
    media,
    expenses: Array.isArray(parsed.expenses) ? parsed.expenses : [],
  });
}

// ═══════════════════════ 형식 2: 여행별 폴더 ZIP ═══════════════════════

const ZIP_FORMAT = 'zip-per-trip-v1';
const ORPHAN_FOLDER = '_orphans';

/** 미디어 메타(blob 제외) + ZIP 내 상대 파일 경로. trip.json/orphans.json에 담긴다. */
type MediaMetaEntry = Omit<LocalMedia, 'originalBlob' | 'displayBlob' | 'thumbBlob'> & {
  displayFile: string;
  thumbFile: string;
  originalFile: string | null;
};

interface TripBundle {
  trip: LocalTrip | null; // 고아 묶음은 null
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

/** 파일시스템 안전한 폴더명: 금지문자 제거·공백 압축 + 짧은 id 접미(중복 제목 충돌 방지). */
function tripFolderName(trip: LocalTrip): string {
  const base = (trip.title || '여행')
    .replace(/[\/\\:*?"<>| -]/g, '') // FS 금지문자·제어문자
    .replace(/\s+/g, '_')
    .replace(/\.+$/, '') // 뒤 점 제거(Windows)
    .slice(0, 60)
    .trim();
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

async function blobBytes(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * 여행별 폴더 ZIP 생성. 각 여행 폴더에 trip.json + photos/ (실제 이미지 파일).
 * includeOriginals=true면 원본 사진도 photos/<id>.orig.<ext>로 담아 완전 복구.
 */
export async function exportBackupZip(includeOriginals = true): Promise<{ blob: Blob; stats: BackupStats }> {
  const rows = await exportCollectRows();

  const tripById = new Map<string, LocalTrip>(rows.trips.map((t) => [t.id, t]));
  const folderOf = new Map<string, string>(); // tripId → folder
  for (const t of rows.trips) folderOf.set(t.id, tripFolderName(t));

  const entries: ZipEntry[] = [];
  // tripId(또는 ORPHAN) → 묶음 누적
  const bundles = new Map<string, TripBundle>();
  const bundleFor = (tripId: string | null): { key: string; folder: string; bundle: TripBundle } => {
    const known = tripId && tripById.has(tripId);
    const key = known ? tripId! : ORPHAN_FOLDER;
    const folder = known ? folderOf.get(tripId!)! : ORPHAN_FOLDER;
    let bundle = bundles.get(key);
    if (!bundle) {
      bundle = { trip: known ? tripById.get(tripId!)! : null, moments: [], media: [], expenses: [] };
      bundles.set(key, bundle);
    }
    return { key, folder, bundle };
  };

  // 여행 폴더 먼저 등록(빈 여행도 폴더가 나오도록)
  for (const t of rows.trips) bundleFor(t.id);

  for (const m of rows.moments) bundleFor(m.tripId ?? null).bundle.moments.push(m);
  for (const ex of rows.expenses) bundleFor(ex.tripId ?? null).bundle.expenses.push(ex);

  for (const me of rows.media) {
    const { folder, bundle } = bundleFor(me.tripId ?? null);
    const displayFile = `photos/${me.id}.webp`;
    const thumbFile = `photos/${me.id}.thumb.webp`;
    const originalFile = includeOriginals ? `photos/${me.id}.orig.${extForMime(me.mime)}` : null;

    entries.push({ name: `${folder}/${displayFile}`, data: await blobBytes(me.displayBlob) });
    entries.push({ name: `${folder}/${thumbFile}`, data: await blobBytes(me.thumbBlob) });
    if (originalFile) entries.push({ name: `${folder}/${originalFile}`, data: await blobBytes(me.originalBlob) });

    const { originalBlob: _o, displayBlob: _d, thumbBlob: _t, ...rest } = me;
    bundle.media.push({ ...rest, displayFile, thumbFile, originalFile });
  }

  // 각 묶음의 trip.json / orphans.json 기록
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

  const blob = zipStore(entries);
  return {
    blob,
    stats: { trips: rows.trips.length, moments: rows.moments.length, media: rows.media.length, expenses: rows.expenses.length },
  };
}

/** 여행별 폴더 ZIP을 병합 복원. 각 폴더의 trip.json + 사진 파일에서 행·blob 재구성 후 공통 코어로 병합. */
export async function importBackupZip(buf: ArrayBuffer): Promise<ImportResult> {
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

  // trip.json / orphans.json 전부 순회(폴더명 변경돼도 이름 규칙으로 탐지).
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
      if (!displayData || !thumbData) continue; // 표시본·썸네일 없으면 이 사진은 건너뜀(부분 손상 방어)
      const displayBlob = new Blob([displayData], { type: 'image/webp' });
      const thumbBlob = new Blob([thumbData], { type: 'image/webp' });
      const origData = originalFile ? byName.get(`${folder}/${originalFile}`) : undefined;
      const originalBlob = origData ? new Blob([origData], { type: rest.mime }) : displayBlob; // 원본 없으면 표시본 폴백
      media.push({ ...rest, originalBlob, displayBlob, thumbBlob });
    }
  }

  return importMergeRows({ trips, moments, media, expenses });
}

/** 파일 바이트로 형식을 자동 감지해 복원(ZIP이면 폴더 백업, 아니면 JSON). */
export async function importBackupAuto(buf: ArrayBuffer): Promise<ImportResult> {
  if (looksLikeZip(new Uint8Array(buf.slice(0, 4)))) return importBackupZip(buf);
  return importBackup(new TextDecoder().decode(buf));
}
