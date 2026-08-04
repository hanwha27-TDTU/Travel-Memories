// domain/media/windowsDrop.ts — Windows 파일 드롭의 순수 판정.
// DOM 이벤트는 화면이 소유하고, OS·파일 판정만 여기서 유닛으로 잠그다.

export interface DroppedFileLike {
  name: string;
  type: string;
}

const PHOTO_EXT = /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i;

/** Windows를 나타내는 platform 또는 UA 중 하나만 있어도 활성화한다. */
export function isWindowsPlatform(platform: string, userAgent: string): boolean {
  return /^win/i.test(platform.trim()) || /windows/i.test(userAgent);
}

/**
 * File Explorer가 MIME을 비워 넘기는 사진도 받는다.
 * 파일 타입은 바이트의 증명이 아니므로, 최종 디코드·EXIF 판정은 기존 인테이크가 한다.
 */
export function isDroppedPhoto(file: DroppedFileLike): boolean {
  return file.type.toLowerCase().startsWith('image/') || PHOTO_EXT.test(file.name);
}

/** 다중 드롭 순서를 유지한 채 사진과 나머지를 가른다. */
export function partitionDroppedPhotos<T extends DroppedFileLike>(files: readonly T[]): {
  photos: T[];
  rejected: T[];
} {
  const photos: T[] = [];
  const rejected: T[] = [];
  for (const file of files) (isDroppedPhoto(file) ? photos : rejected).push(file);
  return { photos, rejected };
}

export type PhotoDropIntent = 'new-moment' | 'existing-moment' | 'none';

/** 한 장을 빈 영역에 놓는 경우만 새 순간 작성으로 분기한다. */
export function photoDropIntent(photoCount: number, directlyOnMoment: boolean): PhotoDropIntent {
  if (photoCount < 1) return 'none';
  if (photoCount === 1 && !directlyOnMoment) return 'new-moment';
  return 'existing-moment';
}
