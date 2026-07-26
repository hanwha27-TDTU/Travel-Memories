// services/media.ts — 사진 추가(로컬우선, 3a). §0 규율을 코드로:
//  1) 압축 "전에" EXIF(촬영시각·GPS)를 먼저 읽어 별도 저장한다.
//  2) 원본 Blob은 그대로 보관하고 절대 수정/삭제하지 않는다.
// 클라우드 업로드(압축본·썸네일)는 후속(3b).

import { db, type LocalMedia, type SyncQueueItem } from '../offline/db';
import { readJpegExif } from '../media/exif';
import { compressForStorage } from '../media/compress';
import type { EditState } from '../media/editor-core';

function uuid(): string {
  return crypto.randomUUID();
}

/** 'media' 동기화 op 하나(moments/expenses와 동일 형태). */
function mediaOp(
  operationId: string,
  entityId: string,
  operationType: SyncQueueItem['operationType'],
  createdAt: string,
): SyncQueueItem {
  return { operationId, entityType: 'media', entityId, operationType, state: 'local_only', attempts: 0, createdAt };
}

export interface AddPhotoTarget {
  momentId: string;
  tripId: string;
}

/**
 * 사진 1장을 순간에 추가. EXIF 우선 추출 → 압축본·썸네일 생성 → 로컬 내구성 커밋 + read-back.
 * 원본(file)은 그대로 originalBlob으로 보관한다.
 * editedBlob이 있으면(비파괴 편집 결과) 압축본·썸네일은 그것에서 파생하되,
 * EXIF(촬영시각·GPS)는 항상 "원본"에서 읽는다(§0 — 편집은 메타데이터를 잃지 않는다).
 */
/**
 * EXIF를 담기에 넉넉한 **앞부분만** 읽는다. JPEG의 APP1(EXIF)은 규격상 SOI 바로 뒤에 오므로
 * 256KB면 내장 썸네일까지 들어간다. 사진 9장을 고른 순간 전체를 통째로 읽으면 수십 MB가
 * 한꺼번에 뜨는데, 이 앱은 **저메모리 기기**를 전제한다.
 */
const EXIF_HEAD_BYTES = 256 * 1024;

export interface PhotoMeta {
  /** 촬영시각(ISO). EXIF → 파일 수정시각 → 지금 순으로 **폴백하되 지어내지 않는다**. */
  takenAt: string;
  gpsLat: number | null;
  gpsLng: number | null;
}

/**
 * 사진 한 장의 촬영 메타를 읽는다.
 *
 * **왜 한 곳인가(§7)**: 이 값은 두 곳에서 쓰인다 — ① 인테이크가 `LocalMedia.takenAt`에 넣고
 * 그게 **R2 파일 이름**이 된다 ② 순간 생성 화면이 **발생 시각 기본값**을 추측한다.
 * 두 곳이 서로 다르게 읽으면 *사진 파일은 7/16인데 그 사진이 달린 순간은 7/27*이 된다 —
 * 앱이 자기 안에서 다른 말을 하는 상태다(2026-07-27 사용자가 실제로 밟았다).
 */
export async function readPhotoMeta(file: File): Promise<PhotoMeta> {
  let takenAt = new Date(file.lastModified || Date.now()).toISOString();
  let gpsLat: number | null = null;
  let gpsLng: number | null = null;
  if (/jpe?g/i.test(file.type)) {
    try {
      const exif = readJpegExif(await file.slice(0, EXIF_HEAD_BYTES).arrayBuffer());
      if (exif.takenAt) takenAt = exif.takenAt;
      if (exif.gpsLat !== undefined && exif.gpsLng !== undefined) {
        gpsLat = exif.gpsLat;
        gpsLng = exif.gpsLng;
      }
    } catch {
      /* EXIF 실패는 무시 — 폴백(파일 수정시각)을 쓴다. 없는 값을 지어내지 않는다. */
    }
  }
  return { takenAt, gpsLat, gpsLng };
}

export async function addPhotoToMoment(
  file: File,
  target: AddPhotoTarget,
  editedBlob?: Blob,
  editState?: EditState,
): Promise<LocalMedia> {
  if (!target.momentId || !target.tripId) throw new Error('순간 정보가 없습니다.');

  // 1) EXIF 먼저(압축 전) — `readPhotoMeta` 한 곳에서. 화면의 시각 추측도 **같은 함수**를 쓴다.
  const { takenAt, gpsLat, gpsLng } = await readPhotoMeta(file);

  // 2) 압축(원본은 인자로만 읽고 수정하지 않음). 편집본이 있으면 그것을 파생 소스로.
  const { display, thumb } = await compressForStorage(editedBlob ?? file);

  const now = new Date().toISOString();
  const opId = uuid();
  const media: LocalMedia = {
    id: uuid(),
    momentId: target.momentId,
    tripId: target.tripId,
    mime: file.type || 'image/jpeg',
    originalBlob: file,
    displayBlob: display.blob,
    thumbBlob: thumb.blob,
    width: display.width,
    height: display.height,
    takenAt,
    gpsLat,
    gpsLng,
    bytesOriginal: file.size,
    bytesDisplay: display.blob.size,
    version: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    clientOperationId: opId,
    ...(editState ? { editState } : {}),
  };

  const d = db();
  await d.transaction('rw', d.localMedia, d.syncQueue, async () => {
    await d.localMedia.add(media);
    await d.syncQueue.add(mediaOp(opId, media.id, 'insert', now));
  });

  const back = await d.localMedia.get(media.id);
  if (!back || back.thumbBlob.size === 0) {
    throw new Error('내구성 커밋 확인 실패: 사진 read-back 불일치');
  }
  return back;
}

/**
 * 사진 1장 삭제 — 하드 삭제 금지(§0): deletedAt tombstone만 세팅한다. 원본 Blob은
 * 그대로 보존되므로(삭제해도 파괴 아님) 되살리기가 완전 복원한다. version+1로 LWW 기준.
 * 미디어는 로컬 전용(3a)이라 sync 큐 op를 만들지 않는다 — 처리 주체가 없어 대기열에
 * 영구 잔류하고 pendingSyncCount만 부풀린다. 클라우드 동기화는 후속(3b)에서 추가.
 */
export async function softDeleteMediaLocalFirst(id: string): Promise<void> {
  const d = db();
  const cur = await d.localMedia.get(id);
  if (!cur || cur.deletedAt !== null) throw new Error('사진을 찾을 수 없습니다.');
  const now = new Date().toISOString();
  const opId = uuid();
  await d.transaction('rw', d.localMedia, d.syncQueue, async () => {
    await d.localMedia.put({ ...cur, deletedAt: now, version: cur.version + 1, updatedAt: now, baseVersion: cur.version, clientOperationId: opId });
    await d.syncQueue.add(mediaOp(opId, id, 'delete', now));
  });
  const back = await d.localMedia.get(id);
  if (!back || back.deletedAt === null) throw new Error('내구성 커밋 확인 실패: 사진 삭제 read-back 불일치');
}

/** 사진 되살리기(실행취소) — deletedAt=null 복원. version+1로 삭제를 이긴다(LWW). */
export async function restoreMediaLocalFirst(id: string): Promise<void> {
  const d = db();
  const cur = await d.localMedia.get(id);
  if (!cur) throw new Error('사진을 찾을 수 없습니다.');
  const now = new Date().toISOString();
  const opId = uuid();
  await d.transaction('rw', d.localMedia, d.syncQueue, async () => {
    await d.localMedia.put({ ...cur, deletedAt: null, version: cur.version + 1, updatedAt: now, baseVersion: cur.version, clientOperationId: opId });
    await d.syncQueue.add(mediaOp(opId, id, 'update', now));
  });
  const back = await d.localMedia.get(id);
  if (!back || back.deletedAt !== null) throw new Error('내구성 커밋 확인 실패: 사진 되살리기 read-back 불일치');
}

/**
 * 저장된 사진 재편집 — 비파괴. 원본 Blob·EXIF(촬영시각·GPS)는 그대로 두고, 편집 결과에서
 * 표시본·썸네일만 다시 만든다(§0 — 원본 불변). editState를 저장해 다음 재편집 때 이어서 조정.
 * 미디어는 로컬 전용이라 sync 큐 op 없음(동기화 후속). version+1(LWW).
 */
export async function reeditMediaLocalFirst(
  id: string,
  editedBlob: Blob,
  editState?: EditState,
): Promise<LocalMedia> {
  const d = db();
  const cur = await d.localMedia.get(id);
  if (!cur || cur.deletedAt !== null) throw new Error('사진을 찾을 수 없습니다.');

  const { display, thumb } = await compressForStorage(editedBlob);
  const now = new Date().toISOString();
  const opId = uuid();
  // editState 키를 제거한 base에서 시작 → 새 편집상태가 있으면만 다시 넣는다(없으면 키 자체가 빠져 초기화).
  const { editState: _prev, ...base } = cur;
  const next: LocalMedia = {
    ...base,
    displayBlob: display.blob,
    thumbBlob: thumb.blob,
    width: display.width,
    height: display.height,
    bytesDisplay: display.blob.size,
    version: cur.version + 1,
    updatedAt: now,
    baseVersion: cur.version,
    clientOperationId: opId,
    ...(editState ? { editState } : {}),
  };
  await d.transaction('rw', d.localMedia, d.syncQueue, async () => {
    await d.localMedia.put(next);
    await d.syncQueue.add(mediaOp(opId, id, 'update', now));
  });
  const back = await d.localMedia.get(id);
  if (!back || back.version !== next.version || back.thumbBlob.size === 0) {
    throw new Error('내구성 커밋 확인 실패: 사진 재편집 read-back 불일치');
  }
  return back;
}

/** 현재 표시본을 90°(시계방향) 회전한 새 Blob(PNG·무손실 중간본). 원본은 건드리지 않는다. */
async function rotate90Blob(source: Blob): Promise<Blob> {
  let bmp: ImageBitmap | HTMLImageElement;
  let w: number;
  let h: number;
  if (typeof createImageBitmap === 'function') {
    try {
      bmp = await createImageBitmap(source, { imageOrientation: 'from-image' });
    } catch {
      bmp = await createImageBitmap(source);
    }
    w = (bmp as ImageBitmap).width;
    h = (bmp as ImageBitmap).height;
  } else {
    const url = URL.createObjectURL(source);
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    URL.revokeObjectURL(url);
    bmp = img;
    w = img.naturalWidth;
    h = img.naturalHeight;
  }
  const canvas = document.createElement('canvas');
  canvas.width = h; // 90° 회전 → 가로·세로 스왑
  canvas.height = w;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d 컨텍스트를 만들 수 없습니다.');
  ctx.translate(h / 2, w / 2);
  ctx.rotate(Math.PI / 2); // 시계방향 90°
  ctx.drawImage(bmp, -w / 2, -h / 2);
  if ('close' in bmp && typeof (bmp as ImageBitmap).close === 'function') (bmp as ImageBitmap).close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
  if (!blob) throw new Error('회전 인코딩 실패');
  return blob;
}

/**
 * 저장된 사진을 90°(시계방향) 회전 — 비파괴. 보이는 표시본을 그대로 돌려 눕힌 사진을 세운다.
 * 원본 Blob·EXIF는 그대로(§0). 표시본·썸네일만 다시 만들고 version+1(LWW). 로컬 전용(sync 후속).
 */
export async function rotateMediaLocalFirst(id: string): Promise<LocalMedia> {
  const d = db();
  const cur = await d.localMedia.get(id);
  if (!cur || cur.deletedAt !== null) throw new Error('사진을 찾을 수 없습니다.');

  const rotated = await rotate90Blob(cur.displayBlob);
  const { display, thumb } = await compressForStorage(rotated);
  const now = new Date().toISOString();
  const opId = uuid();
  const next: LocalMedia = {
    ...cur,
    displayBlob: display.blob,
    thumbBlob: thumb.blob,
    width: display.width,
    height: display.height,
    bytesDisplay: display.blob.size,
    version: cur.version + 1,
    updatedAt: now,
    baseVersion: cur.version,
    clientOperationId: opId,
  };
  await d.transaction('rw', d.localMedia, d.syncQueue, async () => {
    await d.localMedia.put(next);
    await d.syncQueue.add(mediaOp(opId, id, 'update', now));
  });
  const back = await d.localMedia.get(id);
  if (!back || back.version !== next.version || back.thumbBlob.size === 0) {
    throw new Error('내구성 커밋 확인 실패: 사진 회전 read-back 불일치');
  }
  return back;
}

/** 여행의 활성 사진(순간별 그룹용). tombstone 제외. */
export async function listMediaByTrip(tripId: string): Promise<LocalMedia[]> {
  const rows = await db().localMedia.where('tripId').equals(tripId).toArray();
  return rows.filter((m) => m.deletedAt === null);
}
