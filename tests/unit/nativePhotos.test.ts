// tests/unit/nativePhotos.test.ts — 셸 브리지의 **웹 쪽 절반**(ADR-0036).
//
// 네이티브 절반(OriginalPhotosPlugin.java)은 이 환경에서 돌릴 수 없다 — 그 층은 실기기
// 확인이 유일하고, 정직하게 그렇게 적는다(§13 3항). 여기서 재는 것은:
//   ① base64 → File 변환이 바이트를 보존하는가(한 바이트라도 어긋나면 EXIF가 통째로 깨진다)
//   ② 크롬(브리지 없음)에서는 **아무것도 바뀌지 않는가** — 이게 이 설계의 절반이다
import { describe, it, expect, afterEach } from 'vitest';
import { b64ToFile, pickIntoInput } from '../../src/services/nativePhotos';

// Node 환경(vitest 기본)에는 window·document가 없다 — 그게 오히려 첫 검사다:
// 브리지는 window 없이도 조용히 null이어야 한다(셸일 리 없으므로).
const g = globalThis as { window?: unknown };

afterEach(() => {
  delete g.window;
});

describe('b64ToFile — 바이트 보존', () => {
  it('🔴 바이트가 한 개도 안 바뀐다(EXIF는 25바이트만 달라도 다른 사진이다 — M-0059)', async () => {
    const src = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);
    const b64 = btoa(String.fromCharCode(...src));
    const f = b64ToFile('a.jpg', b64);
    expect([...new Uint8Array(await f.arrayBuffer())]).toEqual([...src]);
    expect(f.name).toBe('a.jpg');
  });

  it('MIME을 지어내지 않는다 — 판별은 readPhotoMeta의 바이트 스니핑 몫이다(M-0067)', () => {
    expect(b64ToFile('a.jpg', btoa('x')).type).toBe('');
  });

  it('이름이 비면 폴백을 준다(빈 이름 파일은 ZIP 백업 경로에서 깨진다)', () => {
    expect(b64ToFile('', btoa('x')).name).toBe('photo.jpg');
  });
});

describe('pickIntoInput — 크롬에서는 비켜선다', () => {
  it('🔴 window 자체가 없어도(false) — 기존 경로에 손대지 않는다(이게 설계의 절반이다)', async () => {
    // input은 건드리기 전에 반환해야 하므로 빈 객체로 충분하다 — 만지면 여기서 터진다.
    expect(await pickIntoInput({} as HTMLInputElement)).toBe(false);
  });

  it('Capacitor 전역이 있어도 isNativePlatform이 false면 비켜선다(웹 빌드 오염 방지)', async () => {
    g.window = { Capacitor: { isNativePlatform: () => false, Plugins: {} } };
    expect(await pickIntoInput({} as HTMLInputElement)).toBe(false);
  });

  it('브리지가 있으면 pick을 부르고 true — 사진 0장(취소)이어도 input은 안 만진다', async () => {
    g.window = {
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: { OriginalPhotos: { pick: () => Promise.resolve({ photos: [] }) } },
      },
    };
    expect(await pickIntoInput({} as HTMLInputElement)).toBe(true);
  });
});
