import { describe, expect, it } from 'vitest';
import { fitVideoSize, validateVideoSource, MAX_VIDEO_SOURCE_BYTES } from '../../src/media/video';
import { videoExt, videoObjectName, VIDEO_EXTS } from '../../src/domain/media/naming';
import { VIDEO_EXTS as EDGE_VIDEO_EXTS, isVideoKey } from '../../supabase/functions/media-sign/index';

describe('영상 저장 정책', () => {
  it('가로·세로 모두 긴 변 1280px 안에서 짝수 크기로 줄인다', () => {
    expect(fitVideoSize(3840, 2160)).toEqual({ width: 1280, height: 720 });
    expect(fitVideoSize(1080, 1920)).toEqual({ width: 720, height: 1280 });
  });

  it('영상이 아니거나 250MB를 넘는 원본을 커밋 전에 거부한다', () => {
    expect(() => validateVideoSource({ size: 1, type: 'image/jpeg' } as File)).toThrow('영상 파일');
    expect(() => validateVideoSource({ size: MAX_VIDEO_SOURCE_BYTES + 1, type: 'video/mp4' } as File)).toThrow('250MB');
  });

  it('브라우저와 Edge의 확장자 계약 및 webm 종류 표식을 맞춘다', () => {
    expect([...VIDEO_EXTS]).toEqual([...EDGE_VIDEO_EXTS]);
    expect(videoExt('video/mp4')).toBe('mp4');
    const id = '11111111-2222-4333-8444-555555555555';
    const name = videoObjectName('2026-08-10T10:00:00.000Z', '여행', id);
    expect(isVideoKey(`user/folder/${name}.webm`)).toBe(true);
    expect(isVideoKey(`user/folder/20260810_1000_소리__${id.replaceAll('-', '')}.webm`)).toBe(false);
  });
});
