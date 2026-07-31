// media/exif.ts — 최소 JPEG EXIF 리더 (외부 라이브러리 없음, CSP 준수).
// §0 절대규율: 압축 "전에" 촬영시각·GPS를 먼저 읽어 별도 저장한다.
// 실패/미지원은 조용히 빈 결과 — 파이프라인은 계속 진행(파생 시각은 파일 mtime 폴백).

export interface ExifData {
  /**
   * 🔴 **시간대가 없는 벽시계** — `YYYY-MM-DDTHH:mm:ss`. **절대시각이 아니다.**
   *
   * 2026-07-29(M-0049)까지 이 필드는 `takenAt: string`이었고 주석에 *"로컬시간 가정"*이라
   * 적혀 있었다. 그 가정이 결함이었다: `new Date('2026-07-29T19:08:00')`은 **넣는 기기의
   * 시간대**로 해석된다. 베트남에서 찍고 한국 와서 넣으면 절대시각이 **2시간 틀어졌다.**
   * 여행 중엔 안 보이고 집에 와서 넣으면 틀어지는 형태다(§10 ② 상태 의존).
   *
   * 그래서 이 모듈은 **파일이 말한 것만** 돌려준다. 절대시각을 만드는 것은 오프셋을 아는
   * 쪽(인테이크 — 여행 시간대를 안다)의 일이다. 이름을 바꾼 덕에 컴파일러가 호출부를
   * 전부 데려왔다(§7 2층).
   */
  takenAtWall?: string;
  /**
   * EXIF `OffsetTimeOriginal`(0x9011)이 있으면 그 오프셋(분). **가장 강한 근거**다 —
   * 그 카메라가 그 자리에서 적은 값이기 때문이다. 없으면 `undefined`(여행 시간대로 내려간다).
   */
  tzOffsetMin?: number;
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
  // 🔴 **분모 0을 0으로 반올림하지 않는다**(2026-07-31 · M-0057).
  // 예전엔 `d === 0 ? 0 : n / d`였다 — *"못 읽었다"*를 **0도**로 만들었고, 세 자리가 다
  // 그러면 좌표가 **0,0(기니만 앞바다)**이 된다. §8: 모르는 것을 정상으로도 문제로도
  // 반올림하지 않는다. 못 읽으면 **좌표 자체가 없는 것**이다.
  const rat = (i: number): number | null => {
    const n = view.getUint32(p + i * 8, little);
    const d = view.getUint32(p + i * 8 + 4, little);
    return d === 0 ? null : n / d;
  };
  const [deg, min, sec] = [rat(0), rat(1), rat(2)];
  if (deg === null || min === null || sec === null) return undefined;
  return deg + min / 60 + sec / 3600;
}

/** "YYYY:MM:DD HH:MM:SS" → ISO. 실패 시 undefined. */
/**
 * EXIF 표기(`2026:07:29 19:08:00`) → **벽시계**(`2026-07-29T19:08:00`).
 *
 * 🔴 여기서 `new Date(...)`를 부르지 않는다. 그 한 줄이 M-0049였다 — 시간대 없는 문자열을
 * `Date`에 넣으면 **기기 시간대**로 해석되고, 그 순간 절대시각이 조용히 틀어진다.
 */
function exifDateToWall(s: string): string | undefined {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) return undefined;
  const [, y, mo, d, h, mi, se] = m;
  const wall = `${y}-${mo}-${d}T${h}:${mi}:${se}`;
  // 달력상 말이 되는지만 본다(2026-13-45 같은 것을 거른다). 해석은 UTC로 — 여기서 만드는 것은
  // **판정**이지 값이 아니다.
  return Number.isNaN(Date.parse(`${wall}Z`)) ? undefined : wall;
}

/** `+09:00`·`-05:30`·`+00:00` → 분. 형식이 아니면 `undefined`(0으로 반올림하지 않는다). */
export function parseExifOffset(s: string): number | undefined {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) return undefined;
  const [, sign, hh, mm] = m;
  const v = Number(hh) * 60 + Number(mm);
  if (!Number.isFinite(v) || Number(hh) > 14 || Number(mm) > 59) return undefined;
  return sign === '-' ? -v : v;
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
      const wall = exifDateToWall(readAscii(view, tiffStart, dto, little));
      if (wall) out.takenAtWall = wall;
    }
    // OffsetTimeOriginal(0x9011) → OffsetTimeDigitized(0x9012) → OffsetTime(0x9010).
    // 순서는 위 `dto`와 같은 우선순위다 — **촬영 시점의 것**이 가장 강하다(EXIF 2.31+).
    const off = exifIfd.get(0x9011) ?? exifIfd.get(0x9012) ?? exifIfd.get(0x9010);
    if (off && off.type === 2) {
      const min = parseExifOffset(readAscii(view, tiffStart, off, little));
      if (min !== undefined) out.tzOffsetMin = min;
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
      // 🔴 **0,0은 좌표가 아니다**(2026-07-31 · M-0057 · 사용자 실기기).
      //
      // 그 사진은 갤러리에서 「충청북도 청주시 상당구」로 정확히 나오는데 앱에는
      // **0.0000, 0.0000**이 들어갔다. 즉 브라우저가 받은 바이트의 GPS 태그는
      // **지워진 게 아니라 0으로 덮여** 있었다(안드로이드가 앱에 넘기며 가린 것으로 보인다).
      //
      // 0,0은 기니만 앞바다다. 사용자가 **정말 그 바다 한가운데서** 사진을 찍었을 확률보다
      // **태그가 비어 있을** 확률이 압도적이다. 그리고 틀린 좌표를 넣는 것은
      // 좌표를 안 넣는 것보다 **훨씬 나쁘다** — 기억이 엉뚱한 곳에 찍히고, 그건 조용하다.
      // (0,0 하나라도 값이 있는 정상 좌표는 그대로 통과한다 — 막는 것은 **둘 다 0**일 때다.)
      if (lat !== undefined && lng !== undefined && !(lat === 0 && lng === 0)) {
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
