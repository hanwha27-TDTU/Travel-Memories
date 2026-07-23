// media/exif.ts — 최소 JPEG EXIF 리더 (외부 라이브러리 없음, CSP 준수).
// §0 절대규율: 압축 "전에" 촬영시각·GPS를 먼저 읽어 별도 저장한다.
// 실패/미지원은 조용히 빈 결과 — 파이프라인은 계속 진행(파생 시각은 파일 mtime 폴백).

export interface ExifData {
  takenAt?: string; // ISO 8601 (로컬시간 가정 — 원본 문자열 기반)
  gpsLat?: number;
  gpsLng?: number;
}

interface Entry {
  type: number;
  count: number;
  valueOffset: number; // 엔트리 값 시작(절대 오프셋)
}

function readEntries(view: DataView, tiffStart: number, ifdOffset: number, little: boolean): Map<number, Entry> {
  const map = new Map<number, Entry>();
  const base = tiffStart + ifdOffset;
  if (base + 2 > view.byteLength) return map;
  const count = view.getUint16(base, little);
  for (let i = 0; i < count; i += 1) {
    const e = base + 2 + i * 12;
    if (e + 12 > view.byteLength) break;
    const tag = view.getUint16(e, little);
    const type = view.getUint16(e + 2, little);
    const cnt = view.getUint32(e + 4, little);
    map.set(tag, { type, count: cnt, valueOffset: e + 8 });
  }
  return map;
}

function typeSize(type: number): number {
  // 1:BYTE 2:ASCII 3:SHORT 4:LONG 5:RATIONAL 7:UNDEFINED 10:SRATIONAL
  return type === 3 ? 2 : type === 4 ? 4 : type === 5 || type === 10 ? 8 : 1;
}

function valuePtr(view: DataView, tiffStart: number, e: Entry, little: boolean): number {
  const total = typeSize(e.type) * e.count;
  return total <= 4 ? e.valueOffset : tiffStart + view.getUint32(e.valueOffset, little);
}

function readAscii(view: DataView, tiffStart: number, e: Entry, little: boolean): string {
  const p = valuePtr(view, tiffStart, e, little);
  let s = '';
  for (let i = 0; i < e.count && p + i < view.byteLength; i += 1) {
    const c = view.getUint8(p + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/** RATIONAL 3쌍(도/분/초)을 십진도로. */
function readDMS(view: DataView, tiffStart: number, e: Entry, little: boolean): number | undefined {
  if ((e.type !== 5 && e.type !== 10) || e.count < 3) return undefined;
  const p = valuePtr(view, tiffStart, e, little);
  const rat = (i: number): number => {
    const n = view.getUint32(p + i * 8, little);
    const d = view.getUint32(p + i * 8 + 4, little);
    return d === 0 ? 0 : n / d;
  };
  return rat(0) + rat(1) / 60 + rat(2) / 3600;
}

/** "YYYY:MM:DD HH:MM:SS" → ISO. 실패 시 undefined. */
function exifDateToIso(s: string): string | undefined {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) return undefined;
  const [, y, mo, d, h, mi, se] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${se}`;
  return Number.isNaN(Date.parse(iso)) ? undefined : new Date(iso).toISOString();
}

function parseTiff(view: DataView, tiffStart: number): ExifData {
  if (tiffStart + 8 > view.byteLength) return {};
  const bo = view.getUint16(tiffStart, false);
  const little = bo === 0x4949; // 'II'
  if (!little && bo !== 0x4d4d) return {};
  const ifd0 = view.getUint32(tiffStart + 4, little);
  const e0 = readEntries(view, tiffStart, ifd0, little);

  const out: ExifData = {};

  const exifPtr = e0.get(0x8769);
  if (exifPtr) {
    const exifIfd = readEntries(view, tiffStart, view.getUint32(exifPtr.valueOffset, little), little);
    const dto = exifIfd.get(0x9003) ?? exifIfd.get(0x9004); // DateTimeOriginal | DateTimeDigitized
    if (dto && dto.type === 2) {
      const iso = exifDateToIso(readAscii(view, tiffStart, dto, little));
      if (iso) out.takenAt = iso;
    }
  }

  const gpsPtr = e0.get(0x8825);
  if (gpsPtr) {
    const gps = readEntries(view, tiffStart, view.getUint32(gpsPtr.valueOffset, little), little);
    const latE = gps.get(0x0002);
    const lngE = gps.get(0x0004);
    const latRef = gps.get(0x0001);
    const lngRef = gps.get(0x0003);
    if (latE && lngE) {
      const lat = readDMS(view, tiffStart, latE, little);
      const lng = readDMS(view, tiffStart, lngE, little);
      if (lat !== undefined && lng !== undefined) {
        const latSign = latRef && readAscii(view, tiffStart, latRef, little).startsWith('S') ? -1 : 1;
        const lngSign = lngRef && readAscii(view, tiffStart, lngRef, little).startsWith('W') ? -1 : 1;
        out.gpsLat = lat * latSign;
        out.gpsLng = lng * lngSign;
      }
    }
  }
  return out;
}

/** JPEG ArrayBuffer에서 EXIF(촬영시각·GPS) 추출. JPEG 아님/EXIF 없음/파싱 실패 → {}. */
export function readJpegExif(buf: ArrayBuffer): ExifData {
  const view = new DataView(buf);
  if (view.byteLength < 4 || view.getUint16(0, false) !== 0xffd8) return {};
  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    const marker = view.getUint16(offset, false);
    if ((marker & 0xff00) !== 0xff00) break;
    const size = view.getUint16(offset + 2, false);
    if (marker === 0xffe1) {
      const start = offset + 4;
      // "Exif\0\0"
      if (
        start + 6 <= view.byteLength &&
        view.getUint32(start, false) === 0x45786966 &&
        view.getUint16(start + 4, false) === 0x0000
      ) {
        try {
          return parseTiff(view, start + 6);
        } catch {
          return {};
        }
      }
      return {};
    }
    offset += 2 + size;
  }
  return {};
}
