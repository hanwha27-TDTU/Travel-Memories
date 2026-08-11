import { photoFileBase, videoExt, videoFileBase } from './naming';

function photoExt(mime: string): string | null {
  const normalized = mime.toLowerCase();
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('avif')) return 'avif';
  return null;
}

export function photoDownloadFilename(
  takenAt: string,
  tripTitle: string,
  mediaId: string,
  mime: string,
): string {
  const extension = photoExt(mime);
  if (!extension) throw new Error('저장할 사진 형식을 확인할 수 없습니다.');
  return `${photoFileBase(takenAt, tripTitle, mediaId)}.${extension}`;
}

export function videoDownloadFilename(
  takenAt: string,
  tripTitle: string,
  videoId: string,
  mime: string,
): string {
  const extension = videoExt(mime);
  if (!extension) throw new Error('저장할 영상 형식을 확인할 수 없습니다.');
  return `${videoFileBase(takenAt, tripTitle, videoId)}.${extension}`;
}
