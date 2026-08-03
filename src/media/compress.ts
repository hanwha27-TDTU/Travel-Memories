// media/compress.ts — 이미지 압축(표시본 WebP + 썸네일). 원본은 절대 수정하지 않는다(§0).
// 메인 스레드 canvas 사용(모든 브라우저 동작). Worker+OffscreenCanvas 오프로드는 후속 최적화.

export interface CompressedImage {
  blob: Blob;
  width: number;
  height: number;
}

// 🔴 **export하는 이유는 화면이 이 숫자를 손으로 적지 않게 하기 위해서다**(§2 SSOT).
// 가이드 화면이 「표시본(≤1600 WebP)·썸네일(≤320 WebP)」이라고 **손으로** 적어 뒀는데,
// 여기 숫자를 바꾸면 그 문장은 조용히 거짓말이 된다(품질은 이미 0.82→0.90으로 바뀐 적이 있다).
export const DISPLAY_MAX = 1600;
export const THUMB_MAX = 320;
// 표시본 품질 상향(0.82→0.90): 크기(1600px)는 유지해 용량 폭증을 피하면서 선명도만 올린다.
// 측정 근거: 12MP급에서 표시본 장당 ~0.47MB→~0.66MB(+40%). 원본은 별도 보관이라 전체 증가는 ~10%대.
const DISPLAY_QUALITY = 0.9;
const THUMB_QUALITY = 0.8;

function scaledSize(w: number, h: number, maxEdge: number): { w: number; h: number } {
  const long = Math.max(w, h);
  if (long <= maxEdge) return { w, h };
  const ratio = maxEdge / long;
  return { w: Math.round(w * ratio), h: Math.round(h * ratio) };
}

async function toBitmap(source: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    // EXIF 방향(Orientation) 반영: 카메라가 세로로 찍고 방향 플래그만 세운 사진이
    // 눕혀진 채 구워지던 문제(M-exif-orientation). 'from-image'로 픽셀을 바로 세운다.
    // 구형 브라우저가 옵션을 모르면 옵션 없이 폴백.
    try {
      return await createImageBitmap(source, { imageOrientation: 'from-image' });
    } catch {
      return await createImageBitmap(source);
    }
  }
  // 폴백: <img> 디코드(브라우저 기본 image-orientation: from-image로 방향 반영).
  const url = URL.createObjectURL(source);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function encode(
  bmp: ImageBitmap | HTMLImageElement,
  srcW: number,
  srcH: number,
  maxEdge: number,
  quality: number,
): Promise<CompressedImage> {
  const { w, h } = scaledSize(srcW, srcH, maxEdge);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d 컨텍스트를 만들 수 없습니다.');
  ctx.drawImage(bmp, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/webp', quality),
  );
  if (!blob) throw new Error('이미지 인코딩 실패(webp)');
  return { blob, width: w, height: h };
}

/** 원본 Blob → { display(≤1600 WebP), thumb(≤320 WebP) }. 원본은 건드리지 않는다. */
export async function compressForStorage(original: Blob): Promise<{ display: CompressedImage; thumb: CompressedImage }> {
  const bmp = await toBitmap(original);
  const srcW = 'width' in bmp ? bmp.width : 0;
  const srcH = 'height' in bmp ? bmp.height : 0;
  const display = await encode(bmp, srcW, srcH, DISPLAY_MAX, DISPLAY_QUALITY);
  const thumb = await encode(bmp, srcW, srcH, THUMB_MAX, THUMB_QUALITY);
  if ('close' in bmp && typeof bmp.close === 'function') bmp.close();
  return { display, thumb };
}
