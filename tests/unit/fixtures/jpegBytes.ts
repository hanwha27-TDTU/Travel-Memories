// tests/unit/fixtures/jpegBytes.ts — **진짜 JPEG 바이트를 만드는 공용 픽스처.**
//
// 왜 공용인가(§2 SSOT): 같은 바이트 조립을 exif.test.ts와 readPhotoMeta 검사가 각자
// 손으로 들고 있으면, 파서가 바뀔 때 한쪽 픽스처만 따라가고 다른 쪽은 옛 전제를 못박은
// 채 초록으로 남는다(§11 ② — 셀프테스트가 옛 전제를 못박는다). 바이트는 여기 한 곳에서만.
//
// 왜 모의(mock)가 아니라 진짜 바이트인가(§4): DOM/모의 주입은 **내 주입을 재는** 공허한
// 검사다. 파서가 실제로 읽는 것은 바이트이므로, 검사도 바이트를 준다.

/** 리틀엔디안 TIFF에 DateTimeOriginal 하나만 담은 최소 JPEG APP1 버퍼. */
export function craftJpegWithDate(dateStr: string): ArrayBuffer {
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

/**
 * 🔴 **GPS 태그가 「0으로 덮여」 온 JPEG**(2026-07-31 · M-0057 재현).
 *
 * 사용자 실기기에서 실제로 일어난 일이다: 갤러리는 그 사진을 「청주시 상당구」로 정확히
 * 보여주는데 **브라우저가 받은 바이트**의 GPS 태그는 전부 0이었다. 태그가 **지워진 게
 * 아니라 0으로 덮여** 온 것이고, 옛 파서는 그 0을 **좌표로 믿어** 순간에 「0.0000, 0.0000」을
 * 넣었다. 그래서 **진짜 바이트로** 재현해 파서가 스스로 거절하게 한다(§4).
 *
 * @param zeroDenominator true면 분모까지 0(더 나쁜 형태) — 옛 코드가 `d===0 ? 0`으로
 *   **못 읽은 것을 0도로 반올림**하던 자리다.
 */
export function craftJpegWithGps(latDeg: number, lngDeg: number, zeroDenominator = false): ArrayBuffer {
  const den = zeroDenominator ? 0 : 1;
  // TIFF: [header8][IFD0 2엔트리=30][GPS IFD 4엔트리=54][lat 24][lng 24]
  const GPS_OFF = 8 + 30;
  const LAT_OFF = GPS_OFF + 54;
  const LNG_OFF = LAT_OFF + 24;
  const tiff = new Uint8Array(LNG_OFF + 24);
  const dv = new DataView(tiff.buffer);
  tiff[0] = 0x49; tiff[1] = 0x49; // 'II' little-endian
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true);
  // IFD0: GPSInfoIFDPointer 하나
  dv.setUint16(8, 1, true);
  dv.setUint16(10, 0x8825, true); dv.setUint16(12, 4, true);
  dv.setUint32(14, 1, true); dv.setUint32(18, GPS_OFF, true);
  dv.setUint32(22, 0, true);
  // GPS IFD: Ref/좌표 넷
  let o = GPS_OFF;
  dv.setUint16(o, 4, true); o += 2;
  const entry = (tag: number, type: number, count: number, valueOrOffset: number): void => {
    dv.setUint16(o, tag, true); dv.setUint16(o + 2, type, true);
    dv.setUint32(o + 4, count, true); dv.setUint32(o + 8, valueOrOffset, true);
    o += 12;
  };
  dv.setUint16(o, 0x0001, true); dv.setUint16(o + 2, 2, true);
  dv.setUint32(o + 4, 2, true); tiff[o + 8] = 0x4e; tiff[o + 9] = 0; o += 12; // 'N'
  entry(0x0002, 5, 3, LAT_OFF);
  dv.setUint16(o, 0x0003, true); dv.setUint16(o + 2, 2, true);
  dv.setUint32(o + 4, 2, true); tiff[o + 8] = 0x45; tiff[o + 9] = 0; o += 12; // 'E'
  entry(0x0004, 5, 3, LNG_OFF);
  dv.setUint32(o, 0, true);
  const dms = (off: number, v: number): void => {
    dv.setUint32(off, Math.floor(v) * den, true); dv.setUint32(off + 4, den, true);
    dv.setUint32(off + 8, 0, true); dv.setUint32(off + 12, den, true);
    dv.setUint32(off + 16, 0, true); dv.setUint32(off + 20, den, true);
  };
  dms(LAT_OFF, latDeg);
  dms(LNG_OFF, lngDeg);

  const app1Len = 2 + 6 + tiff.length;
  const out = new Uint8Array(2 + 2 + 2 + 6 + tiff.length);
  const ov = new DataView(out.buffer);
  ov.setUint16(0, 0xffd8, false);
  ov.setUint16(2, 0xffe1, false);
  ov.setUint16(4, app1Len, false);
  out.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 6);
  out.set(tiff, 12);
  return out.buffer;
}

/**
 * **앞에 XMP APP1을 하나 끼워 넣는다** — 실제 사진이 편집기·클라우드·메신저를 거치면
 * 흔히 생기는 배치다. `craftJpegWithGps`가 만든 JPEG의 SOI 바로 뒤에 삽입한다.
 */
export function prependXmpApp1(jpeg: ArrayBuffer): ArrayBuffer {
  const src = new Uint8Array(jpeg);
  const ns = new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>');
  const segLen = 2 + ns.length; // 길이 필드 2 + 본문
  const out = new Uint8Array(src.length + 2 + segLen);
  const ov = new DataView(out.buffer);
  ov.setUint16(0, 0xffd8, false); // SOI
  ov.setUint16(2, 0xffe1, false); // APP1 (XMP)
  ov.setUint16(4, segLen, false);
  out.set(ns, 6);
  out.set(src.subarray(2), 6 + ns.length); // 원래 SOI 뒤(=Exif APP1부터)를 이어 붙인다
  return out.buffer;
}
