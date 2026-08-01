// tests/unit/nativePhotos.test.ts — 셸 브리지의 **웹 쪽 절반**(ADR-0036).
//
// 네이티브 절반(OriginalPhotosPlugin.java)은 이 환경에서 돌릴 수 없다 — 그 층은 실기기
// 확인이 유일하고, 정직하게 그렇게 적는다(§13 3항). 여기서 재는 것은:
//   ① base64 → File 변환이 바이트를 보존하는가(한 바이트라도 어긋나면 EXIF가 통째로 깨진다)
//   ② 크롬(브리지 없음)에서는 **아무것도 바뀌지 않는가** — 이게 이 설계의 절반이다
import { describe, it, expect, afterEach } from 'vitest';
import { b64ToFile, pickIntoInput, pickedVia } from '../../src/services/nativePhotos';
import { shellState } from '../../src/services/capacitorShell';

// Node 환경(vitest 기본)에는 window·document가 없다 — 그게 오히려 첫 검사다:
// 브리지는 window 없이도 조용히 null이어야 한다(셸일 리 없으므로).
const g = globalThis as { window?: unknown; DataTransfer?: unknown };

afterEach(() => {
  delete g.window;
  delete g.DataTransfer;
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

// ─────────────────────────────────────────────────────────────────────────────
// 🔬 경로 사실 (M-0069) — 관측 창의 「경로」 줄이 읽는 것들.
// 셸 첫 실기기 보고에서 스크린샷 한 장으로 셸/PWA조차 못 갈랐다(실제로는 APK 미설치).
// ─────────────────────────────────────────────────────────────────────────────
describe('shellState — 어느 문인가', () => {
  it('window가 없으면 browser(셸일 리 없다)', () => {
    expect(shellState()).toBe('browser');
  });

  it('Capacitor가 있어도 isNativePlatform이 false면 browser(웹 빌드 오염 방지와 같은 규율)', () => {
    g.window = { Capacitor: { isNativePlatform: () => false, Plugins: { OriginalPhotos: {} } } };
    expect(shellState()).toBe('browser');
  });

  it('셸 + 플러그인 → shell', () => {
    g.window = { Capacitor: { isNativePlatform: () => true, Plugins: { OriginalPhotos: {} } } };
    expect(shellState()).toBe('shell');
  });

  it('🔴 셸인데 플러그인이 없으면 shell-no-plugin — 옛 APK를 새 APK와 구별한다', () => {
    g.window = { Capacitor: { isNativePlatform: () => true, Plugins: {} } };
    expect(shellState()).toBe('shell-no-plugin');
  });
});

describe('pickedVia — 네이티브 문이 말한 사실이 파일 이름으로 남는다', () => {
  const stubInput = (): HTMLInputElement =>
    ({ files: null, dispatchEvent: () => true }) as unknown as HTMLInputElement;

  const shellWith = (photos: unknown[]): void => {
    g.window = {
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: { OriginalPhotos: { pick: () => Promise.resolve({ photos }) } },
      },
    };
    // Node에는 DataTransfer가 없다 — 주입 경로가 도는 데 필요한 최소만 흉내 낸다.
    g.DataTransfer = class {
      items = { add: (): void => {} };
      files = null;
    };
  };

  it('승격 실패의 original·reason이 **그대로** 남는다(가공하면 대조할 수 없다)', async () => {
    shellWith([{ name: 'a.jpg', data: btoa('x'), original: false, reason: 'getMediaUri-null' }]);
    await pickIntoInput(stubInput());
    expect(pickedVia('a.jpg')).toEqual({ original: false, reason: 'getMediaUri-null' });
  });

  it('빈 이름은 File 폴백 이름(photo.jpg)으로 기록된다 — 관측 창이 그 이름으로 되찾는다', async () => {
    shellWith([{ name: '', data: btoa('x'), original: true, reason: '' }]);
    await pickIntoInput(stubInput());
    expect(pickedVia('photo.jpg')).toEqual({ original: true, reason: '' });
  });

  it('🔴 reason을 안 보내는 옛 플러그인은 「모름」으로 뭉개지 않고 그 사실을 적는다(M-0060의 규율)', async () => {
    shellWith([{ name: 'b.jpg', data: btoa('x'), original: false }]);
    await pickIntoInput(stubInput());
    expect(pickedVia('b.jpg')?.reason).toContain('옛 플러그인');
  });

  it('네이티브 문을 거치지 않은 파일은 null — 있었던 일을 지어내지 않는다', () => {
    expect(pickedVia('never-picked.jpg')).toBeNull();
  });
});
