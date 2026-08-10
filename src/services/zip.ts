// services/zip.ts — 의존성 없는 ZIP 리더/라이터(store 모드, 무압축).
//
// 왜 무압축(store): 백업의 대부분은 이미 압축된 WebP/JPEG라 다시 deflate해도 이득이 거의 없고,
// store 모드는 구현이 단순·검증 쉽고 되돌리기 안전하다(비타협 원칙 #5). 텍스트(trip.json)는
// 작아서 무압축이어도 무해하다. 프레임워크/라이브러리 미추가(CLAUDE.md).
//
// 지원 범위: 우리가 만든 백업 ZIP만 읽는다(전부 store). method!=0(압축)은 명시적 오류.
// 파일명은 UTF-8(범용 비트 11 세팅)로 한글 여행명을 폴더로 그대로 쓴다.

export interface ZipEntry {
  /** 슬래시로 구분된 경로. 예: "도쿄__a1b2c3d4/photos/x.webp" */
  name: string;
  // ArrayBuffer 위로 고정 — Blob([data]) 구성이 BlobPart 타입을 만족하도록(SharedArrayBuffer 변이 방지).
  data: Uint8Array<ArrayBuffer>;
}

// ── CRC32 (다항식 0xEDB88320) ──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const UTF8 = new TextEncoder();
// DOS 날짜 필드: 1980-01-01 = (year0<<9)|(month1<<5)|day1 = 0x0021. 시각은 0(고정·재현성).
const DOS_DATE = 0x0021;

/** store 모드 ZIP Blob 생성. 시각은 결정적으로 0(재현성·프라이버시). */
/**
 * **이 라이터가 담을 수 있는 한계** — ZIP64 미지원(2026-07-27 명시).
 *
 * 크기·오프셋 필드가 전부 `setUint32`(4 GiB)이고 엔트리 수는 `setUint16`(65,535)이다.
 * 넘으면 **오류가 아니라 잘못된 값이 기록된다** — 열리는 것처럼 보이다가 복원에서 깨지는
 * **조용한 손상**이다. 사진 규모에서는 닿을 수 없어 지금까지 문제가 아니었지만,
 * "백업은 마지막 방어선"이라는 지위에 비해 한계가 어디에도 적혀 있지 않았다(§10 ②).
 *
 * 그래서 **넘으면 만들지 않고 거절한다.** 침묵 절삭·조용한 손상보다 명시적 실패가 낫다
 * (비타협 원칙 #4). 이 한계를 늘리려면 ZIP64 확장 필드가 필요하고, 그건 별도 과제다.
 */
export const ZIP_MAX_TOTAL_BYTES = 0xffff_ffff; // 4 GiB - 1 (uint32 상한)
export const ZIP_MAX_ENTRIES = 0xffff; // 65,535 (uint16 상한)

/** 담을 수 있는가. 못 담으면 **사람이 읽는 이유**를 준다(개수·크기를 숫자로 밝힌다). */
export function zipCapacityError(entries: { name: string; data: { length: number } }[]): string | null {
  if (entries.length > ZIP_MAX_ENTRIES) {
    return `파일이 너무 많아요(${entries.length.toLocaleString()}개). 이 형식은 ${ZIP_MAX_ENTRIES.toLocaleString()}개까지 담을 수 있어요.`;
  }
  // 로컬 헤더·중앙 디렉터리도 자리를 먹지만, 한계 판정은 **바이트 합**으로 충분히 보수적이다.
  const total = entries.reduce((n, e) => n + e.data.length, 0);
  if (total > ZIP_MAX_TOTAL_BYTES) {
    const gb = (total / 1024 ** 3).toFixed(1);
    return `백업이 너무 커요(${gb}GB). 이 형식은 4GB까지 담을 수 있어요 — 여행을 나눠서 백업해 주세요.`;
  }
  return null;
}

export function zipStore(entries: ZipEntry[]): Blob {
  // **조용한 손상 대신 명시적 실패.** 여기서 막지 않으면 uint32/uint16이 넘쳐 잘못된 값이
  // 기록되고, 그 파일은 "받아졌다"고 보이다가 복원할 때 깨진다 — 백업에서 가장 나쁜 실패다.
  const cap = zipCapacityError(entries);
  if (cap) throw new Error(cap);

  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  const seenNames = new Set<string>();

  for (const e of entries) {
    if (seenNames.has(e.name)) throw new Error(`ZIP에 같은 경로가 두 번 있습니다: ${e.name}`);
    seenNames.add(e.name);
    const nameBytes = UTF8.encode(e.name);
    const crc = crc32(e.data);
    const size = e.data.length;

    // 로컬 파일 헤더(30) + 이름 + 데이터
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); // signature
    lh.setUint16(4, 20, true); // version needed
    lh.setUint16(6, 0x0800, true); // flags: UTF-8 이름
    lh.setUint16(8, 0, true); // method: store
    lh.setUint16(10, 0, true); // mod time 00:00:00
    lh.setUint16(12, DOS_DATE, true); // mod date 1980-01-01(고정·재현성)
    lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true); // compressed
    lh.setUint32(22, size, true); // uncompressed
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true); // extra len
    locals.push(new Uint8Array(lh.buffer), nameBytes, e.data);

    // 중앙 디렉터리 헤더(46) + 이름
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); // signature
    ch.setUint16(4, 20, true); // version made by
    ch.setUint16(6, 20, true); // version needed
    ch.setUint16(8, 0x0800, true); // flags
    ch.setUint16(10, 0, true); // method
    ch.setUint16(12, 0, true); // mod time 00:00:00
    ch.setUint16(14, DOS_DATE, true); // mod date 1980-01-01
    ch.setUint32(16, crc, true);
    ch.setUint32(20, size, true);
    ch.setUint32(24, size, true);
    ch.setUint16(28, nameBytes.length, true);
    ch.setUint16(30, 0, true); // extra
    ch.setUint16(32, 0, true); // comment
    ch.setUint16(34, 0, true); // disk start
    ch.setUint16(36, 0, true); // internal attrs
    ch.setUint32(38, 0, true); // external attrs
    ch.setUint32(42, offset, true); // local header offset
    centrals.push(new Uint8Array(ch.buffer), nameBytes);

    offset += 30 + nameBytes.length + size;
  }

  const cdStart = offset;
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);

  // End of central directory(22)
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(4, 0, true);
  eocd.setUint16(6, 0, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, cdStart, true);
  eocd.setUint16(20, 0, true);

  // 단일 버퍼로 이어붙인다(새로 할당한 Uint8Array는 ArrayBuffer 위라 BlobPart 타입 안전).
  const parts = [...locals, ...centrals, new Uint8Array(eocd.buffer)];
  const total = parts.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const b of parts) {
    out.set(b, pos);
    pos += b.length;
  }
  return new Blob([out], { type: 'application/zip' });
}

/** ZIP 매직바이트(PK\x03\x04) 여부 — import에서 JSON/ZIP 구분용. */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** store ZIP을 엔트리 배열로 푼다. 중앙 디렉터리를 진실원으로 순회한다. */
export function unzip(buf: ArrayBuffer): ZipEntry[] {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  if (bytes.length < 22) throw new Error('ZIP 형식이 아닙니다(너무 짧음).');

  // EOCD 서명을 끝에서부터 탐색(코멘트 없으면 22바이트 지점).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP 형식이 아닙니다(EOCD 없음).');

  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const onDisk = view.getUint16(eocd + 8, true);
  const total = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralStart = view.getUint32(eocd + 16, true);
  const commentLength = view.getUint16(eocd + 20, true);
  if (disk !== 0 || centralDisk !== 0 || onDisk !== total) throw new Error('여러 디스크 ZIP은 지원하지 않습니다.');
  if (eocd + 22 + commentLength > bytes.length || centralStart + centralSize > eocd) {
    throw new Error('ZIP 중앙 디렉터리 범위가 손상됐습니다.');
  }
  let p = centralStart;
  const dec = new TextDecoder();
  const out: ZipEntry[] = [];
  const seenNames = new Set<string>();

  for (let i = 0; i < total; i += 1) {
    if (p + 46 > bytes.length) throw new Error('ZIP 중앙 디렉터리가 잘렸습니다.');
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP 중앙 디렉터리 손상.');
    const method = view.getUint16(p + 10, true);
    const expectedCrc = view.getUint32(p + 16, true);
    const compressedSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const lho = view.getUint32(p + 42, true);
    const centralEnd = p + 46 + nameLen + extraLen + commentLen;
    if (centralEnd > centralStart + centralSize || centralEnd > bytes.length) {
      throw new Error('ZIP 중앙 디렉터리 엔트리가 잘렸습니다.');
    }
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (seenNames.has(name)) throw new Error(`ZIP에 같은 경로가 두 번 있습니다: ${name}`);
    seenNames.add(name);

    // 로컬 헤더에서 실제 데이터 위치 계산(로컬 extra 길이는 중앙과 다를 수 있음).
    if (lho + 30 > centralStart || view.getUint32(lho, true) !== 0x04034b50) {
      throw new Error(`${name}: ZIP 로컬 헤더가 손상됐습니다.`);
    }
    const localMethod = view.getUint16(lho + 8, true);
    const localCrc = view.getUint32(lho + 14, true);
    const localCompressedSize = view.getUint32(lho + 18, true);
    const localSize = view.getUint32(lho + 22, true);
    const lNameLen = view.getUint16(lho + 26, true);
    const lExtraLen = view.getUint16(lho + 28, true);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const dataEnd = dataStart + size;

    if (method !== 0) throw new Error(`지원하지 않는 압축 방식(${method}) — 이 앱 백업이 아닙니다.`);
    if (localMethod !== method || compressedSize !== size || localCompressedSize !== compressedSize ||
        localSize !== size || localCrc !== expectedCrc || dataEnd > centralStart) {
      throw new Error(`${name}: ZIP 크기·헤더가 서로 다릅니다(손상).`);
    }
    // 디렉터리 엔트리(이름이 /로 끝남)는 건너뜀.
    if (!name.endsWith('/')) {
      const data = bytes.slice(dataStart, dataEnd);
      if (crc32(data) !== expectedCrc) throw new Error(`${name}: ZIP CRC가 맞지 않습니다(손상).`);
      out.push({ name, data });
    }

    p = centralEnd;
  }
  if (p !== centralStart + centralSize) throw new Error('ZIP 중앙 디렉터리 크기가 맞지 않습니다.');
  return out;
}
