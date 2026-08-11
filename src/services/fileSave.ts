// services/fileSave.ts — 앱 Blob을 사용자가 고른 실제 파일로 저장하고 가능한 표면에서는 되읽는다.
//
// `<a download>`는 다운로드 요청만 만들 뿐 저장 위치·완료·실물 바이트를 알려주지 않는다.
// Android 셸은 SAF 문서를 청크로 쓰고 네이티브에서 SHA-256 read-back, 지원 브라우저는
// File System Access API로 쓴 뒤 Blob 조각을 다시 대조한다. 둘 다 없을 때만 기존 다운로드로
// 내려가며, 그 결과는 절대 "저장 완료"로 부르지 않는다(§8 정직한 완료).

import { backupFileWriter } from './capacitorShell';

const CHUNK_BYTES = 256 * 1024;

export type FileSaveReceipt =
  | { state: 'verified'; method: 'android-downloads' | 'android-picker' | 'browser-picker'; filename: string; bytes: number }
  | { state: 'requested'; method: 'browser-download'; filename: string; bytes: number }
  | { state: 'cancelled'; method: 'android-picker' | 'browser-picker'; filename: string; bytes: 0 };

/** 기존 백업 호출부의 공개 타입 이름은 호환을 위해 유지한다. */
export type BackupSaveReceipt = FileSaveReceipt;

export interface FileSaveOptions {
  mime: string;
  description: string;
  androidDestination?: 'downloads' | 'picker';
}

interface WritableFileHandle {
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void>; abort?(): Promise<void> }>;
  getFile(): Promise<File>;
}

interface SavePickerWindow extends Window {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<WritableFileHandle>;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function exactBlobParity(a: Blob, b: Blob): Promise<boolean> {
  if (a.size !== b.size) return false;
  for (let offset = 0; offset < a.size; offset += CHUNK_BYTES) {
    const end = Math.min(a.size, offset + CHUNK_BYTES);
    const [aa, bb] = await Promise.all([
      a.slice(offset, end).arrayBuffer(),
      b.slice(offset, end).arrayBuffer(),
    ]);
    const left = new Uint8Array(aa);
    const right = new Uint8Array(bb);
    for (let i = 0; i < left.length; i += 1) {
      if (left[i] !== right[i]) return false;
    }
  }
  return true;
}

async function saveWithAndroid(
  blob: Blob,
  filename: string,
  mime: string,
  destination: 'downloads' | 'picker',
): Promise<FileSaveReceipt | null> {
  const writer = backupFileWriter();
  if (!writer) return null;
  const started = await writer.begin({ filename, mime, destination });
  if (started.cancelled) return { state: 'cancelled', method: 'android-picker', filename, bytes: 0 };
  if (!started.token) throw new Error('Android 저장 문이 파일 토큰을 돌려주지 않았습니다.');
  const token = started.token;
  try {
    for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
      const chunk = await blob.slice(offset, Math.min(blob.size, offset + CHUNK_BYTES)).arrayBuffer();
      const bytes = new Uint8Array(chunk);
      // 네이티브가 받은 바이트끼리만 비교하면 브리지에서 생긴 동일 길이 변조를 못 잡는다.
      // JS 원본 청크 digest를 별도 전달해 append 전에 결박하고, finish는 다시 저장 URI를 읽는다.
      await writer.append({ token, data: bytesToBase64(bytes), sha256: await sha256Hex(chunk) });
    }
    const done = await writer.finish({ token });
    if (!done.verified || done.bytes !== blob.size) throw new Error('저장한 파일을 다시 읽었더니 원래 바이트와 다릅니다.');
    const actualDestination = done.destination ?? started.destination ?? 'picker';
    return {
      state: 'verified',
      method: actualDestination === 'downloads' ? 'android-downloads' : 'android-picker',
      filename: done.name || filename,
      bytes: done.bytes,
    };
  } catch (error) {
    try { await writer.abort({ token }); } catch { /* 실패한 문서만 네이티브 쪽에서 제거를 시도한다. */ }
    throw error;
  }
}

function extensionOf(filename: string): string {
  const match = /\.[a-z0-9]+$/i.exec(filename);
  if (!match) throw new Error('저장할 파일 이름에 확장자가 없습니다.');
  return match[0]!.toLowerCase();
}

const MIME_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  'application/zip': ['.zip'],
  'application/json': ['.json'],
  'application/octet-stream': ['.enc'],
  'image/webp': ['.webp'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/avif': ['.avif'],
  'video/mp4': ['.mp4'],
  'video/webm': ['.webm'],
};

function assertMimeExtension(mime: string, extension: string): void {
  const allowed = MIME_EXTENSIONS[mime];
  if (!allowed?.includes(extension)) {
    throw new Error(`파일 형식과 확장자가 맞지 않습니다: ${mime} / ${extension}`);
  }
}

async function saveWithBrowserPicker(
  blob: Blob,
  filename: string,
  mime: string,
  description: string,
): Promise<FileSaveReceipt | null> {
  const picker = (window as SavePickerWindow).showSaveFilePicker;
  if (!picker) return null;
  let handle: WritableFileHandle;
  try {
    const extension = extensionOf(filename);
    handle = await picker.call(window, {
      suggestedName: filename,
      types: [{ description, accept: { [mime]: [extension] } }],
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { state: 'cancelled', method: 'browser-picker', filename, bytes: 0 };
    }
    throw error;
  }
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    try { await writable.abort?.(); } catch { /* 원래 저장 오류를 유지한다. */ }
    throw error;
  }
  const saved = await handle.getFile();
  if (!(await exactBlobParity(blob, saved))) throw new Error('저장한 파일을 다시 읽었더니 원래 바이트와 다릅니다.');
  return { state: 'verified', method: 'browser-picker', filename: saved.name || filename, bytes: saved.size };
}

function requestBrowserDownload(blob: Blob, filename: string): FileSaveReceipt {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { state: 'requested', method: 'browser-download', filename, bytes: blob.size };
}

/**
 * 백업·사진·영상이 공유하는 저장 문. Android와 지원 브라우저는 쓴 파일을 되읽고,
 * 일반 브라우저의 anchor fallback은 저장 요청으로만 판정한다.
 */
export async function saveFileBlob(
  blob: Blob,
  filename: string,
  options: FileSaveOptions,
): Promise<FileSaveReceipt> {
  if (blob.size <= 0) throw new Error('빈 파일은 저장할 수 없습니다.');
  const extension = extensionOf(filename);
  const mime = options.mime.split(';', 1)[0]?.trim() || 'application/octet-stream';
  const blobMime = blob.type.split(';', 1)[0]?.trim();
  if (blobMime && blobMime !== mime) {
    throw new Error(`파일 바이트 형식과 기록된 형식이 맞지 않습니다: ${blobMime} / ${mime}`);
  }
  assertMimeExtension(mime, extension);
  const destination = options.androidDestination ?? 'downloads';
  return (await saveWithAndroid(blob, filename, mime, destination))
    ?? (await saveWithBrowserPicker(blob, filename, mime, options.description))
    ?? requestBrowserDownload(blob, filename);
}

async function saveBackupBlobAt(
  blob: Blob,
  filename: string,
  androidDestination: 'downloads' | 'picker',
): Promise<BackupSaveReceipt> {
  const mime = filename.endsWith('.enc') ? 'application/octet-stream' : filename.endsWith('.json') ? 'application/json' : 'application/zip';
  return saveFileBlob(blob, filename, {
    mime,
    description: 'Bugeon Journey 백업',
    androidDestination,
  });
}

/** Android는 취소될 수 있는 선택기 없이 Download/Bugeon Journey에 저장하고, 그 밖의 표면은 가능한 저장 문을 쓴다. */
export async function saveBackupBlob(blob: Blob, filename: string): Promise<BackupSaveReceipt> {
  return saveBackupBlobAt(blob, filename, 'downloads');
}

/** Android에서 사용자가 다른 폴더를 직접 고르고 싶을 때만 SAF 선택기를 연다. */
export async function saveBackupBlobToChosenFolder(blob: Blob, filename: string): Promise<BackupSaveReceipt> {
  return saveBackupBlobAt(blob, filename, 'picker');
}

export function backupSaveMessage(receipt: BackupSaveReceipt): string {
  if (receipt.state === 'cancelled') {
    return '저장 창이 닫혀 백업 파일은 만들어지지 않았어요. 다시 누르고 폴더를 고른 뒤 화면의 [저장]을 눌러 주세요.';
  }
  if (receipt.state === 'verified') {
    const location = receipt.method === 'android-downloads'
      ? '기기 내 저장공간/Download/Bugeon Journey'
      : receipt.method === 'android-picker'
        ? '선택한 Android 폴더'
        : '선택한 폴더';
    return `저장하고 다시 읽어 확인했어요 · ${receipt.filename} · ${location}`;
  }
  return `다운로드를 요청했어요 · ${receipt.filename} · 브라우저가 정한 다운로드 폴더(보통 Android의 Download). 실제 저장 여부는 파일 앱에서 확인해 주세요.`;
}

export type MediaSaveKind = '사진' | '영상';

/** 뷰어 저장 결과 문장은 호출부에서 조립하지 않고 이 순수 함수 한 곳에서 판정한다. */
export function mediaSaveMessage(receipt: FileSaveReceipt, kind: MediaSaveKind): string {
  if (receipt.state === 'cancelled') {
    return `${kind} 앱 보관본 저장을 취소했어요. 파일은 만들어지지 않았어요.`;
  }
  if (receipt.state === 'verified') {
    const location = receipt.method === 'android-downloads'
      ? '기기 내 저장공간/Download/Bugeon Journey'
      : receipt.method === 'android-picker'
        ? '선택한 Android 폴더'
        : '선택한 폴더';
    return `${kind} 앱 보관본을 저장하고 다시 읽어 확인했어요 · ${receipt.filename} · ${location}`;
  }
  return `${kind} 앱 보관본 다운로드를 요청했어요 · ${receipt.filename} · 브라우저가 정한 다운로드 폴더. 실제 저장 여부는 파일 앱에서 확인해 주세요.`;
}

export function mediaSaveErrorMessage(kind: MediaSaveKind, error: unknown): string {
  const detail = error instanceof Error && error.message.trim() ? error.message.trim() : '확인할 수 없는 오류';
  return `${kind} 앱 보관본을 저장하지 못했어요 · ${detail}`;
}
