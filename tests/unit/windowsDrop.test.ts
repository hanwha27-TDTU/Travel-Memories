import { describe, expect, it } from 'vitest';
import {
  isDroppedPhoto,
  isWindowsPlatform,
  partitionDroppedPhotos,
  photoDropIntent,
} from '../../src/domain/media/windowsDrop';

describe('Windows 사진 드롭 경계', () => {
  it('Windows platform 또는 UA에서만 켜진다', () => {
    expect(isWindowsPlatform('Win32', '')).toBe(true);
    expect(isWindowsPlatform('Linux x86_64', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(true);
    expect(isWindowsPlatform('Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64)')).toBe(false);
    expect(isWindowsPlatform('iPhone', 'Mozilla/5.0 (iPhone)')).toBe(false);
  });

  it('MIME 사진과 MIME이 빈 사진 확장자를 모두 받는다', () => {
    expect(isDroppedPhoto({ name: 'one.png', type: 'image/png' })).toBe(true);
    expect(isDroppedPhoto({ name: 'camera.JPG', type: '' })).toBe(true);
    expect(isDroppedPhoto({ name: 'phone.HEIC', type: 'application/octet-stream' })).toBe(true);
    expect(isDroppedPhoto({ name: 'notes.pdf', type: 'application/pdf' })).toBe(false);
  });

  it('여러 장의 순서를 유지하고 사진이 아닌 파일을 분리한다', () => {
    const files = [
      { name: '1.jpg', type: '' },
      { name: 'readme.txt', type: 'text/plain' },
      { name: '2.webp', type: 'image/webp' },
    ];
    const result = partitionDroppedPhotos(files);
    expect(result.photos.map((file) => file.name)).toEqual(['1.jpg', '2.webp']);
    expect(result.rejected.map((file) => file.name)).toEqual(['readme.txt']);
  });

  it('한 장을 빈 영역에 놓을 때만 새 순간 작성으로 분기한다', () => {
    expect(photoDropIntent(0, false)).toBe('none');
    expect(photoDropIntent(1, false)).toBe('new-moment');
    expect(photoDropIntent(1, true)).toBe('existing-moment');
    expect(photoDropIntent(3, false)).toBe('existing-moment');
  });
});
