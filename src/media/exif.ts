// media/exif.ts — 최소 JPEG EXIF 리더 (외부 라이브러리 없음, CSP 준수).
// §0 절대규율: 압축 "전에" 촬영시각·GPS를 먼저 읽어 별도 저장한다.
// 실패/미지원은 조용히 빈 결과 — 파이프라인은 계속 진행(파생 시각은 파일 mtime 폴백).

// 「진짜 좌표인가」의 단일 판정 — 파서·프로브·다운스트림이 모두 이 한 함수를 지난다(H-3).
import { isRealCoord } from '../domain/place/coordInput';

/**
 * EXIF를 읽을 때 파일 앞에서 **얼마를 읽는가** — 저장 경로와 🔬 관측 창이 **반드시 같은 값**을 쓴다.
 *
 * 🔴 왜 여기 한 곳인가(H-2 · 2026-08-01 감사): 예전엔 저장 경로가 256KB(`media.ts`), 🔬 창이
 * 512KB(`tripDetail.ts`)를 손으로 따로 썼다. 그 사이에 EXIF가 앉으면 — APP1은 여러 개일 수 있고
 * 사진이 편집기·클라우드·메신저를 거치면 Exif가 XMP 뒤로 밀린다(이 앱 사진 대부분이 그런 경로다)
 * — 🔬는 "위치 있음 → **앱 결함입니다, 이 줄을 보내 주세요**"라고 말하는데 저장 경로는 좌표를
 * 못 봐서 안 넣었다. **앱이 스스로를 결함이라 오신고**한 것이다(나흘 걸린 GPS 사가의 재발 지점).
 *
 * 두 창이 같은 상수를 쓰면 그 갈라짐이 원리적으로 불가능하다. 값은 **큰 쪽(512KB)**으로 통일한다
 * — 앞부분 한 번 더 읽는 비용은 싸고, XMP-앞 사진의 좌표를 저장 경로가 놓치지 않는 것이 값지다.
 * `check-exif-order` 검사 E가 두 호출부가 이 상수를 쓰는지(손 매직넘버가 없는지) 지킨다.
 */
export const EXIF_HEAD_BYTES = 512 * 1024;

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
      // **지워진 게 아니라 0으로 덮여** 있었다.
      //
      // ⚠️ 여기 원래 *"(안드로이드가 앱에 넘기며 가린 것으로 보인다)"*가 붙어 있었다.
      // **원인 단정이었고 틀렸다**(M-0059) — 실측해 보니 ①카메라가 GPS 못 잡으면 `0/0`을
      // 그대로 적고 ②전달 경로(채팅 업로드 등)도 값을 0으로 덮는다. **왜 0인지는 여기서
      // 알 수 없고, 알 필요도 없다** — 이 함수가 할 일은 「0,0은 좌표가 아니다」뿐이다(§8).
      //
      // 0,0은 기니만 앞바다다. 사용자가 **정말 그 바다 한가운데서** 사진을 찍었을 확률보다
      // **태그가 비어 있을** 확률이 압도적이다. 그리고 틀린 좌표를 넣는 것은
      // 좌표를 안 넣는 것보다 **훨씬 나쁘다** — 기억이 엉뚱한 곳에 찍히고, 그건 조용하다.
      // (0,0 하나라도 값이 있는 정상 좌표는 그대로 통과한다 — 막는 것은 **둘 다 0**일 때다.)
      // 「진짜 좌표인가」는 단 하나의 함수(isRealCoord)가 판정한다(H-3). 여기 값은 부호 적용
      // 전 크기(위도 0~90·경도 0~180)라 범위 검사에 그대로 걸리고, 0,0을 거른다(M-0057 기니만).
      if (isRealCoord(lat, lng)) {
        const latSign = latRef && readAscii(view, tiffStart, latRef, little).startsWith('S') ? -1 : 1;
        const lngSign = lngRef && readAscii(view, tiffStart, lngRef, little).startsWith('W') ? -1 : 1;
        out.gpsLat = (lat as number) * latSign; // isRealCoord가 유한 수임을 보장(두 인자라 타입가드 불가)
        out.gpsLng = (lng as number) * lngSign;
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
      // 🔴 **여기서 포기하지 않는다**(2026-08-01). 예전엔 `return {}`였다 — 첫 APP1이
      // Exif가 **아니면**(XMP `http://ns.adobe.com/xap/1.0/`가 대표적이다) 그 자리에서
      // 손을 놓았고, **뒤에 있는 진짜 Exif를 영영 못 봤다.**
      //
      // APP1은 **여러 개일 수 있다.** 표준 순서는 Exif가 먼저지만, 사진이 편집기·클라우드·
      // 메신저를 거치면 순서가 바뀐다 — 그리고 이 앱의 사진은 대부분 그런 경로를 지난다.
      // 그때 증상은 **촬영시각도 위치도 통째로 없음**이고, 사용자에게는 「앱이 못 읽는다」로
      // 보인다. 못 읽은 게 아니라 **첫 칸만 보고 돌아선 것**이다.
      //
      // 넘어가는 비용은 없다 — 아래 `offset += 2 + size`가 이 세그먼트를 건너뛴다.
    }
    offset += 2 + size;
  }
  return {};
}

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 **앱이 실제로 무엇을 받았는지 앱이 말한다** (2026-08-01 · M-0066)
// ─────────────────────────────────────────────────────────────────────────────
// 사용자: *"계속 안되네..해시값을 계속 앱 내에서 바꾸는 듯?"*
//
// 나는 나흘 동안 **추측으로** 원인을 좁혔다 — 파서, 읽기 순서, 선택기, 전달 경로.
// 그때마다 사용자가 스크린샷을 찍어 날랐고, 나는 그 스크린샷을 보고 또 추측했다.
// §12가 금지하는 바로 그 상태다: **앱이 아는 것을 말하지 않아 사람이 대신 나른다.**
//
// 그래서 이 함수는 **판정하지 않는다.** 사실만 돌려준다 — 이 바이트에 무엇이 있었나.
// 판정(왜 없나)은 위에서 이미 네 번 틀렸다. 여기서는 **관측만** 한다(§8).
//
// 이 하나로 세 가설이 갈린다:
//   · GPS IFD가 **아예 없다**        → 카메라가 위치를 안 적었다(위치 태그 꺼짐)
//   · IFD는 있는데 값이 **0/0**      → 누군가 지우고 넘겼다(선택기·전달 경로)
//   · 값이 **정상인데 앱이 못 읽음** → **내 파서 결함.** 그 자리를 고친다

/** 이 바이트에서 관측한 사실. **판정이 아니다.** */
export interface ExifProbe {
  /** JPEG 시작 표식(SOI)이 있는가. 없으면 HEIC·PNG 등이라 이 파서로는 못 읽는다. */
  isJpeg: boolean;
  /** APP1 세그먼트 종류를 **순서대로**. 첫 칸이 Exif가 아니어도 뒤를 본다(M-0063). */
  app1: Array<'exif' | 'xmp' | 'other'>;
  /** 촬영시각(벽시계). 있으면 **파서가 EXIF를 제대로 읽었다는 증거**다. */
  takenAtWall?: string;
  /**
   * GPS 태그의 상태 — 이 앱의 나흘이 걸린 자리.
   *  · `'no-ifd'`   GPS IFD 자체가 없다
   *  · `'zeroed'`   IFD는 있는데 값이 전부 0/0 — **누군가 비웠다**
   *  · `'value'`    쓸 수 있는 좌표가 있다
   */
  gps: 'no-ifd' | 'zeroed' | 'value';
  /** 사람이 눈으로 볼 원자료 한 줄(`N 36/1,36/1,32809680/1000000`). 추측을 막는다. */
  gpsRaw?: string;
}

/** RATIONAL 3쌍을 `n/d,n/d,n/d`로 — 가공하지 않고 **적힌 그대로**. */
function rawRationals(view: DataView, tiffStart: number, e: Entry, little: boolean): string {
  const p = valuePtr(view, tiffStart, e, little);
  const parts: string[] = [];
  for (let i = 0; i < Math.min(e.count, 3); i += 1) {
    if (p + i * 8 + 8 > view.byteLength) break;
    parts.push(`${view.getUint32(p + i * 8, little)}/${view.getUint32(p + i * 8 + 4, little)}`);
  }
  return parts.join(',');
}

export function probeJpeg(buf: ArrayBuffer): ExifProbe {
  const view = new DataView(buf);
  const out: ExifProbe = { isJpeg: false, app1: [], gps: 'no-ifd' };
  if (view.byteLength < 4 || view.getUint16(0, false) !== 0xffd8) return out;
  out.isJpeg = true;

  let tiffStart = -1;
  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    const marker = view.getUint16(offset, false);
    if ((marker & 0xff00) !== 0xff00) break;
    const size = view.getUint16(offset + 2, false);
    if (marker === 0xffe1) {
      const start = offset + 4;
      const isExif =
        start + 6 <= view.byteLength &&
        view.getUint32(start, false) === 0x45786966 &&
        view.getUint16(start + 4, false) === 0x0000;
      let kind: 'exif' | 'xmp' | 'other' = 'other';
      if (isExif) kind = 'exif';
      else if (start + 4 <= view.byteLength && view.getUint32(start, false) === 0x68747470) kind = 'xmp'; // 'http'
      out.app1.push(kind);
      if (isExif && tiffStart < 0) tiffStart = start + 6;
    }
    offset += 2 + size;
  }
  if (tiffStart < 0) return out;

  try {
    const bo = view.getUint16(tiffStart, false);
    const little = bo === 0x4949;
    if (!little && bo !== 0x4d4d) return out;
    const e0 = readEntries(view, tiffStart, view.getUint32(tiffStart + 4, little), little);

    const exifPtr = e0.get(0x8769);
    if (exifPtr) {
      const exifIfd = readEntries(view, tiffStart, view.getUint32(exifPtr.valueOffset, little), little);
      const dto = exifIfd.get(0x9003) ?? exifIfd.get(0x9004);
      if (dto && dto.type === 2) {
        const wall = exifDateToWall(readAscii(view, tiffStart, dto, little));
        if (wall) out.takenAtWall = wall;
      }
    }

    const gpsPtr = e0.get(0x8825);
    if (!gpsPtr) return out;
    const gps = readEntries(view, tiffStart, view.getUint32(gpsPtr.valueOffset, little), little);
    const latE = gps.get(0x0002);
    const lngE = gps.get(0x0004);
    if (!latE || !lngE) return out; // IFD는 있는데 좌표 항목이 없다 = 없는 것과 같다
    const ref = gps.get(0x0001) ? readAscii(view, tiffStart, gps.get(0x0001)!, little) : '';
    out.gpsRaw = `${ref || '(ref없음)'} ${rawRationals(view, tiffStart, latE, little)}`;
    const lat = readDMS(view, tiffStart, latE, little);
    const lng = readDMS(view, tiffStart, lngE, little);
    out.gps = isRealCoord(lat, lng) ? 'value' : 'zeroed'; // 같은 단일 판정(H-3)
  } catch {
    /* 못 읽으면 관측을 거기까지만 — 지어내지 않는다 */
  }
  return out;
}
