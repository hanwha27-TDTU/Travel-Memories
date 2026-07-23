// services/backup.ts — 전체 백업(내보내기)·복원(가져오기). 비타협 원칙 #1의 완화책:
// 브라우저 축출·사이트데이터 삭제는 앱 통제 밖 → 사용자가 파일로 기억을 보관·이전할 수 있게 한다.
//
// 규율(SYNC_PROTOCOL 재사용, 손 병합 금지):
//  - 복원은 "교체"가 아니라 "병합". 각 행은 mergeDecision(LWW+tombstone)으로만 반영한다.
//  - 빈-데이터 가드: 백업이 비었는데 로컬에 활성 데이터가 있으면 로컬을 지우지 않는다.
//  - tombstone도 함께 내보낸다(삭제가 다른 기기/복원본으로 전파되도록).
//  - 사진 원본은 읽기만 하고 수정하지 않는다(§0).

import { db, type LocalTrip, type LocalMoment, type LocalMedia, type LocalExpense } from '../offline/db';
import { mergeDecision, isEmptyCloudAnomaly } from '../sync/merge';

export const BACKUP_APP_TAG = 'bugeon-journey';
export const BACKUP_VERSION = 1;

/** 미디어 직렬화형: Blob 3종을 data URL(base64)로 치환. 나머지 필드는 그대로. */
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

export interface BackupStats {
  trips: number;
  moments: number;
  media: number;
  expenses: number;
}

function blobToB64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error ?? new Error('사진 읽기 실패'));
    r.readAsDataURL(blob);
  });
}

/** data URL(base64) → Blob. mime는 URL 헤더에서 복원. */
function b64ToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const header = dataUrl.slice(0, comma);
  const b64 = dataUrl.slice(comma + 1);
  const mimeMatch = /data:([^;]+)/.exec(header);
  const mime = mimeMatch ? mimeMatch[1]! : 'application/octet-stream';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/**
 * 전체 백업을 JSON Blob으로 만든다(다운로드용). tombstone 포함 전 행을 담는다.
 * includePhotos=true면 사진 3종(원본·표시본·썸네일)을 base64로 함께 담아 완전 복원 가능.
 */
export async function exportBackup(includePhotos = true): Promise<{ blob: Blob; stats: BackupStats }> {
  const d = db();
  const [trips, moments, media, expenses] = await Promise.all([
    d.localTrips.toArray(),
    d.localMoments.toArray(),
    d.localMedia.toArray(),
    d.localExpenses.toArray(),
  ]);

  const mediaOut: MediaExport[] = [];
  if (includePhotos) {
    for (const m of media) {
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
    trips,
    moments,
    media: mediaOut,
    expenses,
  };
  const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
  return {
    blob,
    stats: { trips: trips.length, moments: moments.length, media: mediaOut.length, expenses: expenses.length },
  };
}

export interface ImportResult {
  trips: number;
  moments: number;
  media: number;
  expenses: number;
  skippedEmptyGuard: boolean;
}

/**
 * 백업 JSON 텍스트를 병합 복원. 절대 로컬을 통째로 덮어쓰지 않는다:
 * 각 행은 mergeDecision(LWW+tombstone)으로만 반영하고, 빈-데이터 가드로 로컬을 지킨다.
 */
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

  const d = db();
  const moments = Array.isArray(parsed.moments) ? parsed.moments : [];
  const media = Array.isArray(parsed.media) ? parsed.media : [];
  const expenses = Array.isArray(parsed.expenses) ? parsed.expenses : [];

  // 빈-데이터 가드: 백업이 사실상 비었는데 로컬에 활성 데이터가 있으면 반영하지 않는다.
  const backupTotal = parsed.trips.length + moments.length;
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
    for (const t of parsed.trips) {
      if (mergeDecision(await d.localTrips.get(t.id), t) === 'take-server') {
        await d.localTrips.put(t);
        tc += 1;
      }
    }
    for (const m of moments) {
      if (mergeDecision(await d.localMoments.get(m.id), m) === 'take-server') {
        await d.localMoments.put(m);
        mc += 1;
      }
    }
    for (const me of media) {
      if (mergeDecision(await d.localMedia.get(me.id), me) === 'take-server') {
        const { originalB64, displayB64, thumbB64, ...rest } = me;
        const row: LocalMedia = {
          ...rest,
          originalBlob: b64ToBlob(originalB64),
          displayBlob: b64ToBlob(displayB64),
          thumbBlob: b64ToBlob(thumbB64),
        };
        await d.localMedia.put(row);
        mdc += 1;
      }
    }
    for (const ex of expenses) {
      if (mergeDecision(await d.localExpenses.get(ex.id), ex) === 'take-server') {
        await d.localExpenses.put(ex);
        ec += 1;
      }
    }
  });
  return { trips: tc, moments: mc, media: mdc, expenses: ec, skippedEmptyGuard: false };
}
