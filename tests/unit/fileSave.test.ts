import { afterEach, describe, expect, it } from 'vitest';
import {
  backupSaveMessage,
  saveBackupBlob,
  saveBackupBlobToChosenFolder,
  type BackupSaveReceipt,
} from '../../src/services/fileSave';

const globals = globalThis as { window?: unknown };

afterEach(() => {
  delete globals.window;
});

describe('백업 저장 판정 문장', () => {
  it('되읽기까지 끝난 저장만 완료형으로 말한다', () => {
    const receipt: BackupSaveReceipt = {
      state: 'verified', method: 'android-picker', filename: '20260810_0231_Bugeon-Journey.zip', bytes: 123,
    };
    expect(backupSaveMessage(receipt)).toBe(
      '저장하고 다시 읽어 확인했어요 · 20260810_0231_Bugeon-Journey.zip · 선택한 Android 폴더',
    );
  });

  it('Android 기본 백업은 Download 폴더를 지목하고 각 원본 청크와 native read-back을 검증한다', async () => {
    const appended: { data: string; sha256: string }[] = [];
    const destinations: string[] = [];
    const size = 300 * 1024;
    const source = new Uint8Array(size);
    for (let i = 0; i < source.length; i += 1) source[i] = i % 251;
    globals.window = {
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: {
          BackupFiles: {
            begin: async ({ destination }: { destination: string }) => {
              destinations.push(destination);
              return { token: 't1', name: 'saved.zip', destination: 'downloads' };
            },
            append: async ({ data, sha256 }: { data: string; sha256: string }) => {
              appended.push({ data, sha256 });
              return { bytes: appended.reduce((sum, chunk) => sum + atob(chunk.data).length, 0) };
            },
            finish: async () => ({ verified: true, bytes: size, name: 'saved.zip', destination: 'downloads' }),
            abort: async () => undefined,
          },
        },
      },
    };

    const receipt = await saveBackupBlob(new Blob([source]), '20260810_0231_Bugeon-Journey.zip');
    expect(receipt).toMatchObject({ state: 'verified', method: 'android-downloads', bytes: size });
    expect(destinations).toEqual(['downloads']);
    expect(appended).toHaveLength(2);
    for (const chunk of appended) {
      const bytes = Uint8Array.from(atob(chunk.data), (char) => char.charCodeAt(0));
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const hex = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      expect(chunk.sha256).toBe(hex);
    }
  });

  it('다른 폴더 백업만 Android 선택기를 열고 취소를 파일 생성 실패로 명확히 말한다', async () => {
    const destinations: string[] = [];
    globals.window = {
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: {
          BackupFiles: {
            begin: async ({ destination }: { destination: string }) => {
              destinations.push(destination);
              return { cancelled: true };
            },
          },
        },
      },
    };

    const receipt = await saveBackupBlobToChosenFolder(new Blob(['backup']), 'backup.zip');
    expect(destinations).toEqual(['picker']);
    expect(receipt).toEqual({ state: 'cancelled', method: 'android-picker', filename: 'backup.zip', bytes: 0 });
    expect(backupSaveMessage(receipt)).toContain('백업 파일은 만들어지지 않았어요');
    expect(backupSaveMessage(receipt)).toContain('[저장]');
  });

  it('anchor fallback은 저장했다고 단정하지 않고 기본 다운로드 폴더와 확인 행동을 말한다', () => {
    const receipt: BackupSaveReceipt = {
      state: 'requested', method: 'browser-download', filename: '20260810_0231_Bugeon-Journey.zip', bytes: 123,
    };
    const message = backupSaveMessage(receipt);
    expect(message).toContain('다운로드를 요청했어요');
    expect(message).toContain('보통 Android의 Download');
    expect(message).toContain('실제 저장 여부는 파일 앱에서 확인');
    expect(message).not.toContain('저장했어요');
  });

  it('선택기 취소는 파일이 생기지 않았고 다음에 무엇을 눌러야 하는지 말한다', () => {
    expect(backupSaveMessage({
      state: 'cancelled', method: 'browser-picker', filename: 'backup.zip', bytes: 0,
    })).toBe('저장 창이 닫혀 백업 파일은 만들어지지 않았어요. 다시 누르고 폴더를 고른 뒤 화면의 [저장]을 눌러 주세요.');
  });
});
