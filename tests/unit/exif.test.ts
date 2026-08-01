// tests/unit/exif.test.ts — EXIF 리더 비공허 검증(§0: 압축 전 촬영시각 추출).
// 최소 JPEG+EXIF 바이트를 직접 구성해 DateTimeOriginal 파싱을 확인한다.
import { describe, it, expect } from 'vitest';
import { probeJpeg, readJpegExif } from '../../src/media/exif';
// 바이트 조립은 공용 픽스처에서(§2) — readPhotoMeta 검사(photoMetaSniff)와 같은 바이트를 쓴다.
import { craftJpegWithDate, craftJpegWithGps, prependXmpApp1 } from './fixtures/jpegBytes';

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

// ─────────────────────────────────────────────────────────────────────────────
// 🔬 probeJpeg — **관측 도구가 세 상태를 실제로 가르는가** (2026-08-01 · M-0066)
//
// 이 도구의 값은 「가른다」에 있다. 세 상태의 처방이 정반대이기 때문이다:
//   위치 칸 없음   → 카메라 설정
//   값이 0/0       → 전달 경로(선택기·메신저)
//   값이 정상      → **내 파서 결함**
// 못 가르면 사용자는 또 나에게 묻고, 나는 또 추측한다 — 그게 지난 나흘이었다.
// ─────────────────────────────────────────────────────────────────────────────
describe('probeJpeg — 판정하지 않고 관측한다', () => {
  it('🔴 값이 정상이면 value + **원자료 그대로**(가공하면 대조할 수 없다)', () => {
    const p = probeJpeg(craftJpegWithGps(37, 127));
    expect(p.isJpeg).toBe(true);
    expect(p.gps).toBe('value');
    expect(p.gpsRaw).toContain('37/1');
  });

  it('🔴 분모가 0이면 zeroed — 「없음」과 **구별한다**(처방이 정반대다)', () => {
    const p = probeJpeg(craftJpegWithGps(37, 127, true));
    expect(p.gps).toBe('zeroed');
    expect(p.gpsRaw).toContain('0/0'); // 사람이 눈으로 확인할 근거
  });

  it('JPEG이 아니면 그 사실만 말한다(지어내지 않는다)', () => {
    const p = probeJpeg(new Uint8Array([1, 2, 3, 4]).buffer);
    expect(p.isJpeg).toBe(false);
    expect(p.gps).toBe('no-ifd');
  });

  it('🔴 APP1이 여럿이면 **순서대로** 적는다(M-0063이 여기서 보인다)', () => {
    const p = probeJpeg(prependXmpApp1(craftJpegWithGps(37, 127)));
    expect(p.app1).toEqual(['xmp', 'exif']);
    expect(p.gps).toBe('value'); // 앞 칸에 속지 않는다
  });
});
