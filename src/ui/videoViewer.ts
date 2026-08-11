import type { LocalVideo } from '../offline/db';
import { videoDownloadFilename } from '../domain/media/download';
import { el } from './dom';
import { createMediaSaveControl } from './mediaSave';

export function openVideoViewer(item: LocalVideo, tripTitle: string): void {
  const url = URL.createObjectURL(item.blob);
  const overlay = el('div', 'video-viewer');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '여행 영상');
  const close = el('button', 'video-viewer-close', '✕') as HTMLButtonElement;
  close.type = 'button';
  close.setAttribute('aria-label', '영상 닫기');
  const video = el('video', 'video-viewer-player') as HTMLVideoElement;
  video.src = url;
  video.controls = true;
  video.playsInline = true;
  video.preload = 'metadata';
  const save = createMediaSaveControl('영상', () => ({
    blob: item.blob,
    mime: item.mime,
    filename: videoDownloadFilename(item.takenAt, tripTitle, item.id, item.mime),
  }));
  const actions = el('div', 'media-viewer-actions');
  actions.append(save.button);

  const dispose = (): void => {
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') dispose();
  };
  close.addEventListener('click', dispose);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) dispose();
  });
  document.addEventListener('keydown', onKey);
  overlay.append(close, video, actions, save.status);
  document.body.appendChild(overlay);
  close.focus();
}
