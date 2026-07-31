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


/**
 * 🔴 **GPS 태그가 「0으로 덮여」 온 JPEG**(2026-07-31 · M-0057 재현).
 *
 * 사용자 실기기에서 실제로 일어난 일이다: 갤러리는 그 사진을 「청주시 상당구」로 정확히
 * 보여주는데 **브라우저가 받은 바이트**의 GPS 태그는 전부 0이었다. 태그가 **지워진 게
 * 아니라 0으로 덮여** 온 것이고, 옛 파서는 그 0을 **좌표로 믿어** 순간에 「0.0000, 0.0000」을
 * 넣었다. 그래서 **진짜 바이트로** 재현해 파서가 스스로 거절하게 한다(§4 — DOM/모의 주입은
 * 내 주입을 재는 공허한 검사다).
 *
 * @param zeroDenominator true면 분모까지 0(더 나쁜 형태) — 옛 코드가 `d===0 ? 0`으로
 *   **못 읽은 것을 0도로 반올림**하던 자리다.
 */
function craftJpegWithGps(latDeg: number, lngDeg: number, zeroDenominator = false): ArrayBuffer {
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
function prependXmpApp1(jpeg: ArrayBuffer): ArrayBuffer {
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

describe('readJpegExif — APP1이 여럿일 때 (2026-08-01)', () => {
  // 🔴 예전 코드는 첫 APP1이 Exif가 **아니면 그 자리에서 `return {}`** 했다.
  // 그래서 XMP가 앞에 오는 사진은 **촬영시각도 위치도 통째로** 못 읽었고, 사용자에게는
  // 「앱이 못 읽는다」로 보였다 — 못 읽은 게 아니라 **첫 칸만 보고 돌아선 것**이다.
  //
  // APP1은 여러 개일 수 있고, 사진이 편집기·클라우드·메신저를 거치면 순서가 바뀐다.
  // 그리고 이 앱의 사진은 대부분 그런 경로를 지난다.
  it('🔴 XMP APP1이 **앞에 있어도** 뒤의 Exif를 찾아낸다', () => {
    const withXmp = prependXmpApp1(craftJpegWithGps(37, 127));
    const r = readJpegExif(withXmp);
    expect(r.gpsLat).toBeCloseTo(37, 6);
    expect(r.gpsLng).toBeCloseTo(127, 6);
  });

  it('Exif가 정말 없으면 조용히 빈 결과(오탐 없이)', () => {
    // XMP만 있고 Exif APP1이 없는 JPEG
    const onlyXmp = new Uint8Array(prependXmpApp1(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer));
    expect(readJpegExif(onlyXmp.buffer)).toEqual({});
  });
});

describe('readJpegExif', () => {
  // 🔴 2026-07-29(M-0049): 이 케이스는 **옛 결함을 정상으로 못박고 있었다.**
  // 기대값이 `new Date('2020-01-02T03:04:05')` — 즉 *검사를 돌리는 기기의 시간대*로 해석한
  // 값이었다. 검사와 코드가 같은 실수를 하고 있으니 영원히 초록이었다.
  // 전제가 바뀌면 **케이스부터 뒤집는다**(§11 ②). 통과시키려고 로직을 되돌리지 않는다.
  it('DateTimeOriginal을 **벽시계 그대로** 준다(절대시각으로 바꾸지 않는다)', () => {
    const exif = readJpegExif(craftJpegWithDate('2020:01:02 03:04:05'));
    expect(exif.takenAtWall).toBe('2020-01-02T03:04:05');
    // 시간대를 모르는 파일이므로 오프셋은 **없다** — 0으로 반올림하지 않는다.
    expect(exif.tzOffsetMin).toBeUndefined();
  });

  it('JPEG가 아니면 빈 결과', () => {
    expect(readJpegExif(new Uint8Array([1, 2, 3, 4]).buffer)).toEqual({});
  });

  it('EXIF 없는 JPEG(SOI만)도 안전하게 빈 결과', () => {
    expect(readJpegExif(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer)).toEqual({});
  });
});

describe('readJpegExif — GPS (M-0057)', () => {
  it('정상 좌표는 그대로 읽는다(파서가 죽지 않았다는 비공허 확인 · §4)', () => {
    const e = readJpegExif(craftJpegWithGps(37, 127));
    expect(e.gpsLat).toBe(37);
    expect(e.gpsLng).toBe(127);
  });

  it('🔴 GPS 태그가 **0으로 덮여** 오면 좌표로 믿지 않는다 — 사용자 순간에 0,0이 실제로 들어갔다', () => {
    const e = readJpegExif(craftJpegWithGps(0, 0));
    expect(e.gpsLat).toBeUndefined();
    expect(e.gpsLng).toBeUndefined();
  });

  it('🔴 분모가 0이면 **0도로 반올림하지 않는다**(§8 — 못 읽은 것은 없는 것)', () => {
    const e = readJpegExif(craftJpegWithGps(37, 127, true));
    expect(e.gpsLat).toBeUndefined();
    expect(e.gpsLng).toBeUndefined();
  });

  it('한쪽만 0인 좌표는 **정상이다**(적도·본초자오선은 실재한다)', () => {
    expect(readJpegExif(craftJpegWithGps(0, 127)).gpsLng).toBe(127);
    expect(readJpegExif(craftJpegWithGps(37, 0)).gpsLat).toBe(37);
  });
});
