import { mediaSaveErrorMessage, mediaSaveMessage, saveFileBlob, type MediaSaveKind } from '../services/fileSave';
import { el } from './dom';

export interface ViewerDownload {
  blob: Blob;
  filename: string;
  mime: string;
}

/** 사진·영상 뷰어가 같은 저장 상태 전이와 사용자 문장을 지나게 하는 공용 컨트롤. */
export function createMediaSaveControl(
  kind: MediaSaveKind,
  currentFile: () => ViewerDownload,
): { button: HTMLButtonElement; status: HTMLElement } {
  const button = el('button', 'media-viewer-save', '↓ 저장') as HTMLButtonElement;
  button.type = 'button';
  button.setAttribute('aria-label', `이 ${kind} 앱 보관본 저장`);
  const status = el('div', 'media-viewer-save-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.hidden = true;

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (button.disabled) return;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    status.hidden = true;
    void (async () => {
      try {
        const file = currentFile();
        const receipt = await saveFileBlob(file.blob, file.filename, {
          mime: file.mime,
          description: `Bugeon Journey ${kind}`,
        });
        status.textContent = mediaSaveMessage(receipt, kind);
      } catch (error) {
        status.textContent = mediaSaveErrorMessage(kind, error);
      } finally {
        status.hidden = false;
        button.disabled = false;
        button.removeAttribute('aria-busy');
      }
    })();
  });
  status.addEventListener('click', (event) => event.stopPropagation());
  return { button, status };
}
