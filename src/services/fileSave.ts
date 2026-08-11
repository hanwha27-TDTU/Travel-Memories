// services/fileSave.ts — 백업 Blob을 사용자가 고른 실제 파일로 저장하고 가능한 표면에서는 되읽는다.
//
// `<a download>`는 다운로드 요청만 만들 뿐 저장 위치·완료·실물 바이트를 알려주지 않는다.
// Android 셸은 SAF 문서를 청크로 쓰고 네이티브에서 SHA-256 read-back, 지원 브라우저는
// File System Access API로 쓴 뒤 Blob 조각을 다시 대조한다. 둘 다 없을 때만 기존 다운로드로
// 내려가며, 그 결과는 절대 "저장 완료"로 부르지 않는다(§8 정직한 완료).

import { backupFileWriter } from './capacitorShell';

const CHUNK_BYTES = 256 * 1024;

export type BackupSaveReceipt =
  | { state: 'verified'; method: 'android-downloads' | 'android-picker' | 'browser-picker'; filename: string; bytes: number }
  | { state: 'requested'; method: 'browser-download'; filename: string; bytes: number }
  | { state: 'cancelled'; method: 'android-picker' | 'browser-picker'; filename: string; bytes: 0 };

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
): Promise<BackupSaveReceipt | null> {
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
    if (!done.verified || done.bytes !== blob.size) throw new Error('저장한 백업을 다시 읽었더니 원래 바이트와 다릅니다.');
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

async function saveWithBrowserPicker(blob: Blob, filename: string, mime: string): Promise<BackupSaveReceipt | null> {
  const picker = (window as SavePickerWindow).showSaveFilePicker;
  if (!picker) return null;
  let handle: WritableFileHandle;
  try {
    const extension = filename.endsWith('.enc') ? '.enc' : filename.endsWith('.json') ? '.json' : '.zip';
    handle = await picker.call(window, {
      suggestedName: filename,
      types: [{ description: 'Bugeon Journey 백업', accept: { [mime]: [extension] } }],
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
  if (!(await exactBlobParity(blob, saved))) throw new Error('저장한 백업을 다시 읽었더니 원래 바이트와 다릅니다.');
  return { state: 'verified', method: 'browser-picker', filename: saved.name || filename, bytes: saved.size };
}

function requestBrowserDownload(blob: Blob, filename: string): BackupSaveReceipt {
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

async function saveBackupBlobAt(
  blob: Blob,
  filename: string,
  androidDestination: 'downloads' | 'picker',
): Promise<BackupSaveReceipt> {
  const mime = filename.endsWith('.enc') ? 'application/octet-stream' : filename.endsWith('.json') ? 'application/json' : 'application/zip';
  return (await saveWithAndroid(blob, filename, mime, androidDestination))
    ?? (await saveWithBrowserPicker(blob, filename, mime))
    ?? requestBrowserDownload(blob, filename);
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
