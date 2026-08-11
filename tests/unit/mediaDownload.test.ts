import { describe, expect, it } from 'vitest';
import { photoDownloadFilename, videoDownloadFilename } from '../../src/domain/media/download';

describe('사진·영상 개별 저장 이름', () => {
  it('촬영시각·여행제목·짧은 id와 실제 앱 보관본 형식을 쓴다', () => {
    expect(photoDownloadFilename(
      '2026-08-11T17:43:00', '여름 여행', '12345678-abcd-4000-8000-123456789abc', 'image/webp',
    )).toBe('20260811_1743_여름_여행__12345678.webp');
    expect(videoDownloadFilename(
      '2026-08-11T17:44:00', '여름 여행', 'abcdef12-abcd-4000-8000-123456789abc', 'video/mp4',
    )).toBe('20260811_1744_여름_여행__abcdef12.mp4');
  });

  it('알 수 없는 사진·영상 형식은 거짓 확장자를 붙이지 않는다', () => {
    expect(() => photoDownloadFilename('2026-08-11', '여행', 'photo-id', 'image/heic')).toThrow('사진 형식');
    expect(() => videoDownloadFilename('2026-08-11', '여행', 'video-id', 'video/quicktime')).toThrow('영상 형식');
  });
});
