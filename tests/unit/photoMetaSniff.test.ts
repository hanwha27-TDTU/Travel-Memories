// tests/unit/photoMetaSniff.test.ts — **선택기가 보고한 MIME을 믿지 않는다.**
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 (2026-08-01 · 사진 위치 미해결 건의 새 눈 점검에서 발견)
// ─────────────────────────────────────────────────────────────────────────────
// v1.40이 사진 입력의 기본을 **일반 파일 선택기**(SAF)로 뒤집었다 — 갤러리 선택기가 GPS를
// 지우기 때문이다(M-0064). 그런데 `readPhotoMeta`는 EXIF를 읽을지 말지를
// `/jpe?g/i.test(file.type)` — 즉 **그 선택기가 보고한 MIME**으로 정하고 있었다.
//
// SAF 경로의 제공자(다운로드·타 파일관리자·클라우드)는 `file.type`을 **비우거나
// `application/octet-stream`으로** 주는 경우가 있다. 그러면 바이트에 GPS가 멀쩡히 있어도
// EXIF 읽기를 **조용히** 건너뛰었다 — 위치를 살리려고 만든 바로 그 경로가 위치를 버린다.
//
// 같은 파일 안에서도 갈라져 있었다(§7 위반이 신호였다):
//   · 🔬 프로브(`probeJpeg`)는 **바이트를 직접** 킁킁댄다(SOI로 판별) → 「위치 있음」
//   · `mime: file.type || 'image/jpeg'`는 type이 빌 수 있음을 **이미 인정**
//   · 그런데 EXIF 게이트만 type을 믿었다 → 좌표 버림
// 프로브가 「위치 있음」이라 말하는데 장소 칸은 비는 조합 — 0-C 표의 세 번째 갈래
// (「값이 정상인데 앱이 못 읽음 = 파서·배선 결함」)가 실제로 존재했다.
//
// 처방: **바이트가 정한다.** `readJpegExif`가 SOI(0xFFD8)를 스스로 확인하므로 MIME 게이트는
// 애초에 필요 없었다 — JPEG 아닌 바이트는 빈 결과로 끝난다(비용은 256KB 읽기 한 번).
import { describe, it, expect } from 'vitest';
import { readPhotoMeta } from '../../src/services/media';
import { craftJpegWithDate, craftJpegWithGps } from './fixtures/jpegBytes';

/** 진짜 JPEG 바이트를 **선택기가 보고한 type만 바꿔** File로 감싼다. */
const asFile = (buf: ArrayBuffer, type: string): File =>
  new File([new Uint8Array(buf)], '20260731_194400.jpg', { type, lastModified: Date.parse('2026-07-31T19:44:00Z') });

describe('readPhotoMeta — MIME은 선택기의 주장이고, 판별은 바이트가 한다', () => {
  it('🔴 type이 **빈 문자열**이어도(SAF 제공자) GPS를 읽는다', async () => {
    const meta = await readPhotoMeta(asFile(craftJpegWithGps(36, 127), ''), 'Asia/Seoul');
    expect(meta.gpsLat).toBeCloseTo(36, 6);
    expect(meta.gpsLng).toBeCloseTo(127, 6);
  });

  it('🔴 type이 **application/octet-stream**이어도 GPS를 읽는다 — 기본 accept가 바로 이 형식을 섞는다', async () => {
    const meta = await readPhotoMeta(asFile(craftJpegWithGps(36, 127), 'application/octet-stream'), 'Asia/Seoul');
    expect(meta.gpsLat).toBeCloseTo(36, 6);
    expect(meta.gpsLng).toBeCloseTo(127, 6);
  });

  it('type이 비어도 촬영시각을 읽는다(위치와 같은 문을 지난다)', async () => {
    const meta = await readPhotoMeta(asFile(craftJpegWithDate('2026:07:31 19:44:00'), ''), 'Asia/Seoul');
    expect(meta.takenAt).not.toBeNull();
  });

  it('type은 image/jpeg인데 바이트가 JPEG이 아니면 — 빈 결과(주장이 아니라 바이트를 믿는다)', async () => {
    const fake = new File([new Uint8Array([1, 2, 3, 4])], 'fake.jpg', { type: 'image/jpeg' });
    const meta = await readPhotoMeta(fake, 'Asia/Seoul');
    expect(meta.gpsLat).toBeNull();
    expect(meta.takenAt).toBeNull();
  });

  it('정상 신고(image/jpeg) + 정상 바이트는 그대로 읽는다(비공허 확인 · §4)', async () => {
    const meta = await readPhotoMeta(asFile(craftJpegWithGps(36, 127), 'image/jpeg'), 'Asia/Seoul');
    expect(meta.gpsLat).toBeCloseTo(36, 6);
  });
});
