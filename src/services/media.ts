// services/media.ts — 사진 추가(로컬우선, 3a). §0 규율을 코드로:
//  1) 압축 "전에" EXIF(촬영시각·GPS)를 먼저 읽어 별도 저장한다.
//  2) 원본 Blob은 그대로 보관하고 절대 수정/삭제하지 않는다.
// 클라우드 업로드(압축본·썸네일)는 후속(3b).

import { db, type LocalMedia } from '../offline/db';
import { readJpegExif } from '../media/exif';
import { compressForStorage } from '../media/compress';

function uuid(): string {
  return crypto.randomUUID();
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
export async function addPhotoToMoment(
  file: File,
  target: AddPhotoTarget,
  editedBlob?: Blob,
): Promise<LocalMedia> {
  if (!target.momentId || !target.tripId) throw new Error('순간 정보가 없습니다.');

  // 1) EXIF 먼저(압축 전). JPEG가 아니거나 없으면 파일 mtime 폴백.
  let takenAt = new Date(file.lastModified || Date.now()).toISOString();
  let gpsLat: number | null = null;
  let gpsLng: number | null = null;
  if (/jpe?g/i.test(file.type)) {
    try {
      const exif = readJpegExif(await file.arrayBuffer());
      if (exif.takenAt) takenAt = exif.takenAt;
      if (exif.gpsLat !== undefined && exif.gpsLng !== undefined) {
        gpsLat = exif.gpsLat;
        gpsLng = exif.gpsLng;
      }
    } catch {
      /* EXIF 실패는 무시 — 폴백 사용 */
    }
  }

  // 2) 압축(원본은 인자로만 읽고 수정하지 않음). 편집본이 있으면 그것을 파생 소스로.
  const { display, thumb } = await compressForStorage(editedBlob ?? file);

  const now = new Date().toISOString();
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
  };

  const d = db();
  await d.localMedia.add(media);

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
  await d.localMedia.put({ ...cur, deletedAt: now, version: cur.version + 1, updatedAt: now });
  const back = await d.localMedia.get(id);
  if (!back || back.deletedAt === null) throw new Error('내구성 커밋 확인 실패: 사진 삭제 read-back 불일치');
}

/** 사진 되살리기(실행취소) — deletedAt=null 복원. version+1로 삭제를 이긴다(LWW). */
export async function restoreMediaLocalFirst(id: string): Promise<void> {
  const d = db();
  const cur = await d.localMedia.get(id);
  if (!cur) throw new Error('사진을 찾을 수 없습니다.');
  const now = new Date().toISOString();
  await d.localMedia.put({ ...cur, deletedAt: null, version: cur.version + 1, updatedAt: now });
  const back = await d.localMedia.get(id);
  if (!back || back.deletedAt !== null) throw new Error('내구성 커밋 확인 실패: 사진 되살리기 read-back 불일치');
}

/** 여행의 활성 사진(순간별 그룹용). tombstone 제외. */
export async function listMediaByTrip(tripId: string): Promise<LocalMedia[]> {
  const rows = await db().localMedia.where('tripId').equals(tripId).toArray();
  return rows.filter((m) => m.deletedAt === null);
}
