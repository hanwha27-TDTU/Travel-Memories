// services/storage.ts — 저장 용량 집계(사진 blob vs 기록 텍스트). 데이터 관리 표시용.
//
// 정직성(§4): 사진은 실제 Blob 크기 합(원본+표시본+썸네일, tombstone 포함 — 실제 점유),
// 텍스트는 blob을 뺀 기록(여행·순간·비용·미디어 메타·동기화 큐)의 UTF-8 JSON 바이트.
// Blob.size는 데이터를 메모리에 올리지 않고 읽는 메타값이라 저렴하다.

import { db } from '../offline/db';

export interface StorageUsage {
  /** 사진 blob 합(원본+표시본+썸네일). */
  photoBytes: number;
  /** 기록(텍스트) 바이트 — blob 제외 JSON. */
  textBytes: number;
  /** 사진(미디어) 행 수(tombstone 포함). */
  photoCount: number;
  /** 브라우저 전체 사용/한도(가능 시). 앱 코드 캐시 등도 포함 → 사진+텍스트보다 크거나 같다. */
  estimate: { usage: number; quota: number } | null;
}

/** 바이트를 사람이 읽는 단위로. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export async function computeStorageUsage(): Promise<StorageUsage> {
  const d = db();
  const [trips, moments, expenses, media, queue] = await Promise.all([
    d.localTrips.toArray(),
    d.localMoments.toArray(),
    d.localExpenses.toArray(),
    d.localMedia.toArray(),
    d.syncQueue.toArray(),
  ]);

  let photoBytes = 0;
  const mediaMeta = media.map((m) => {
    photoBytes += (m.originalBlob?.size ?? 0) + (m.displayBlob?.size ?? 0) + (m.thumbBlob?.size ?? 0);
    // blob을 뺀 메타만 텍스트로 계산(editState·좌표·시각 등).
    const { originalBlob: _o, displayBlob: _dsp, thumbBlob: _t, ...meta } = m;
    return meta;
  });
  const json = JSON.stringify({ trips, moments, expenses, mediaMeta, queue });
  const textBytes = new TextEncoder().encode(json).length;

  let estimate: StorageUsage['estimate'] = null;
  try {
    if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.estimate === 'function') {
      const e = await navigator.storage.estimate();
      if (typeof e.usage === 'number' && typeof e.quota === 'number') {
        estimate = { usage: e.usage, quota: e.quota };
      }
    }
  } catch {
    /* 미지원·차단 시 생략 */
  }

  return { photoBytes, textBytes, photoCount: media.length, estimate };
}
