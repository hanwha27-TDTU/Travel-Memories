// tests/unit/exif.test.ts — EXIF 리더 비공허 검증(§0: 압축 전 촬영시각 추출).
// 최소 JPEG+EXIF 바이트를 직접 구성해 DateTimeOriginal 파싱을 확인한다.
import { describe, it, expect } from 'vitest';
import { readJpegExif } from '../../src/media/exif';

/** 리틀엔디안 TIFF에 DateTimeOriginal 하나만 담은 최소 JPEG APP1 버퍼. */
function craftJpegWithDate(dateStr: string): ArrayBuffer {
  const str = `${dateStr}\0`; // ASCII, NUL 종단
  const strLen = str.length;
  // TIFF 레이아웃: [header8][IFD0 18][ExifIFD 18][string]
  const tiff = new Uint8Array(8 + 18 + 18 + strLen);
  const dv = new DataView(tiff.buffer);
  // header (little-endian)
  tiff[0] = 0x49; tiff[1] = 0x49; // 'II'
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true); // IFD0 at 8
  // IFD0
  dv.setUint16(8, 1, true); // 1 entry
  dv.setUint16(10, 0x8769, true); // ExifIFD pointer
  dv.setUint16(12, 4, true); // LONG
  dv.setUint32(14, 1, true);
  dv.setUint32(18, 26, true); // Exif IFD at 26
  dv.setUint32(22, 0, true); // next IFD
  // Exif IFD at 26
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 0x9003, true); // DateTimeOriginal
  dv.setUint16(30, 2, true); // ASCII
  dv.setUint32(32, strLen, true);
  dv.setUint32(36, 44, true); // string at 44
  dv.setUint32(40, 0, true);
  // string at 44
  for (let i = 0; i < strLen; i += 1) tiff[44 + i] = str.charCodeAt(i);

  // JPEG 래퍼: SOI + APP1(len, "Exif\0\0", tiff)
  const app1Len = 2 + 6 + tiff.length;
  const out = new Uint8Array(2 + 2 + 2 + 6 + tiff.length);
  const ov = new DataView(out.buffer);
  ov.setUint16(0, 0xffd8, false); // SOI
  ov.setUint16(2, 0xffe1, false); // APP1
  ov.setUint16(4, app1Len, false); // big-endian length
  out.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 6); // "Exif\0\0"
  out.set(tiff, 12);
  return out.buffer;
}

describe('readJpegExif', () => {
  it('DateTimeOriginal을 ISO로 추출한다', () => {
    const exif = readJpegExif(craftJpegWithDate('2020:01:02 03:04:05'));
    expect(exif.takenAt).toBe(new Date('2020-01-02T03:04:05').toISOString());
  });

  it('JPEG가 아니면 빈 결과', () => {
    expect(readJpegExif(new Uint8Array([1, 2, 3, 4]).buffer)).toEqual({});
  });

  it('EXIF 없는 JPEG(SOI만)도 안전하게 빈 결과', () => {
    expect(readJpegExif(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer)).toEqual({});
  });
});
