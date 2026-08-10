export const VIDEO_ACCEPT = 'video/mp4,video/webm,video/quicktime,video/x-matroska';
export const MAX_VIDEO_SECONDS = 60;
export const MAX_VIDEO_SOURCE_BYTES = 250 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
export const VIDEO_MAX_LONG_EDGE = 1280;
export const VIDEO_MAX_FRAME_RATE = 30;

export interface VideoInfo {
  durationSec: number;
  width: number;
  height: number;
}

export interface PreparedVideo extends VideoInfo {
  blob: Blob;
  posterBlob: Blob;
  mime: 'video/mp4' | 'video/webm';
  bytesOriginal: number;
}

export interface VideoProgress {
  phase: '검사' | '변환' | '포스터';
  ratio: number;
}

export function fitVideoSize(width: number, height: number, maxLongEdge = VIDEO_MAX_LONG_EDGE): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('영상 크기를 확인할 수 없어요.');
  }
  const scale = Math.min(1, maxLongEdge / Math.max(width, height));
  const even = (value: number): number => Math.max(2, Math.round(value * scale / 2) * 2);
  return { width: even(width), height: even(height) };
}

export function validateVideoSource(file: Pick<File, 'size' | 'type'>): void {
  if (!file.type.startsWith('video/')) throw new Error('영상 파일만 추가할 수 있어요.');
  if (file.size <= 0) throw new Error('빈 영상 파일은 저장할 수 없어요.');
  if (file.size > MAX_VIDEO_SOURCE_BYTES) throw new Error('원본 영상은 250MB 이하만 추가할 수 있어요.');
}

function validateVideoInfo(info: VideoInfo): void {
  if (!Number.isFinite(info.durationSec) || info.durationSec <= 0) throw new Error('영상 길이를 확인할 수 없어요.');
  if (info.durationSec > MAX_VIDEO_SECONDS + 0.05) throw new Error('영상은 60초 이하만 저장할 수 있어요.');
  fitVideoSize(info.width, info.height);
}

async function inputInfo(file: Blob): Promise<VideoInfo> {
  const { ALL_FORMATS, BlobSource, Input } = await import('mediabunny');
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw new Error('재생 가능한 영상 트랙이 없어요.');
    const [durationSec, width, height] = await Promise.all([
      input.computeDuration([video]),
      video.getDisplayWidth(),
      video.getDisplayHeight(),
    ]);
    return { durationSec, width, height };
  } finally {
    input.dispose();
  }
}

async function transcodeAttempt(
  file: Blob,
  info: VideoInfo,
  format: 'mp4' | 'webm',
  onProgress?: (progress: VideoProgress) => void,
): Promise<Blob | null> {
  const {
    ALL_FORMATS,
    BlobSource,
    BufferTarget,
    Conversion,
    Input,
    Mp4OutputFormat,
    Output,
    WebMOutputFormat,
  } = await import('mediabunny');
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const target = new BufferTarget();
  const outputFormat = format === 'mp4'
    ? new Mp4OutputFormat({ fastStart: 'in-memory' })
    : new WebMOutputFormat();
  const output = new Output({ format: outputFormat, target });
  const size = fitVideoSize(info.width, info.height);
  try {
    const conversion = await Conversion.init({
      input,
      output,
      tracks: 'primary',
      video: {
        codec: format === 'mp4' ? 'avc' : 'vp9',
        width: size.width,
        height: size.height,
        fit: 'contain',
        frameRate: VIDEO_MAX_FRAME_RATE,
        bitrate: 2_400_000,
        keyFrameInterval: 2,
        forceTranscode: true,
        allowRotationMetadata: false,
      },
      audio: {
        codec: format === 'mp4' ? 'aac' : 'opus',
        bitrate: 128_000,
        forceTranscode: true,
      },
      tags: {},
      showWarnings: false,
    });
    if (!conversion.isValid || conversion.utilizedTracks.length === 0) return null;
    conversion.onProgress = (ratio) => onProgress?.({ phase: '변환', ratio });
    await conversion.execute();
    if (!target.buffer) throw new Error('영상 변환 결과를 만들지 못했어요.');
    return new Blob([target.buffer], { type: format === 'mp4' ? 'video/mp4' : 'video/webm' });
  } catch (error) {
    if (error instanceof Error && /memory|allocation/i.test(error.message)) {
      throw new Error('기기 메모리가 부족해 영상을 줄이지 못했어요. 더 짧은 영상을 선택해 주세요.');
    }
    return null;
  } finally {
    input.dispose();
  }
}

function waitFor(target: EventTarget, event: string, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      target.removeEventListener(event, done);
      reject(new Error('영상 미리보기를 만드는 데 시간이 너무 오래 걸려요.'));
    }, timeoutMs);
    const done = (): void => {
      window.clearTimeout(timer);
      resolve();
    };
    target.addEventListener(event, done, { once: true });
  });
}

export async function createVideoPoster(blob: Blob): Promise<Blob> {
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.playsInline = true;
  try {
    video.src = url;
    await waitFor(video, 'loadedmetadata');
    video.currentTime = Math.min(Math.max(video.duration / 2, 0), 5);
    await waitFor(video, 'seeked');
    const size = fitVideoSize(video.videoWidth, video.videoHeight, 640);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('영상 미리보기를 만들 수 없는 브라우저예요.');
    ctx.drawImage(video, 0, 0, size.width, size.height);
    const poster = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.78));
    if (!poster?.size) throw new Error('영상 미리보기를 만들지 못했어요.');
    return poster;
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

export async function prepareVideo(
  file: File,
  onProgress?: (progress: VideoProgress) => void,
): Promise<PreparedVideo> {
  validateVideoSource(file);
  onProgress?.({ phase: '검사', ratio: 0 });
  const sourceInfo = await inputInfo(file);
  validateVideoInfo(sourceInfo);
  onProgress?.({ phase: '검사', ratio: 1 });

  const mp4 = await transcodeAttempt(file, sourceInfo, 'mp4', onProgress);
  const converted = mp4 ?? await transcodeAttempt(file, sourceInfo, 'webm', onProgress);
  if (!converted) {
    throw new Error('이 기기는 영상 용량 줄이기를 지원하지 않아요. Chrome을 최신화한 뒤 다시 시도해 주세요.');
  }
  if (converted.size > MAX_VIDEO_BYTES) {
    throw new Error('줄인 영상이 25MB를 넘어요. 더 짧은 영상을 선택해 주세요.');
  }
  const info = await inputInfo(converted);
  validateVideoInfo(info);
  onProgress?.({ phase: '포스터', ratio: 0 });
  const posterBlob = await createVideoPoster(converted);
  onProgress?.({ phase: '포스터', ratio: 1 });
  return {
    ...info,
    blob: converted,
    posterBlob,
    mime: converted.type === 'video/mp4' ? 'video/mp4' : 'video/webm',
    bytesOriginal: file.size,
  };
}
