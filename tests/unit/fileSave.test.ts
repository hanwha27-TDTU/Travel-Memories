import { afterEach, describe, expect, it } from 'vitest';
import { backupSaveMessage, saveBackupBlob, type BackupSaveReceipt } from '../../src/services/fileSave';

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

  it('Android 브리지에 각 원본 청크의 SHA-256을 함께 보내고 native read-back만 통과시킨다', async () => {
    const appended: { data: string; sha256: string }[] = [];
    const size = 300 * 1024;
    const source = new Uint8Array(size);
    for (let i = 0; i < source.length; i += 1) source[i] = i % 251;
    globals.window = {
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: {
          BackupFiles: {
            begin: async () => ({ token: 't1', name: 'saved.zip' }),
            append: async ({ data, sha256 }: { data: string; sha256: string }) => {
              appended.push({ data, sha256 });
              return { bytes: appended.reduce((sum, chunk) => sum + atob(chunk.data).length, 0) };
            },
            finish: async () => ({ verified: true, bytes: size, name: 'saved.zip' }),
            abort: async () => undefined,
          },
        },
      },
    };

    const receipt = await saveBackupBlob(new Blob([source]), '20260810_0231_Bugeon-Journey.zip');
    expect(receipt).toMatchObject({ state: 'verified', method: 'android-picker', bytes: size });
    expect(appended).toHaveLength(2);
    for (const chunk of appended) {
      const bytes = Uint8Array.from(atob(chunk.data), (char) => char.charCodeAt(0));
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const hex = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      expect(chunk.sha256).toBe(hex);
    }
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

  it('선택기 취소는 기기 기록이 바뀌지 않았다고 말한다', () => {
    expect(backupSaveMessage({
      state: 'cancelled', method: 'browser-picker', filename: 'backup.zip', bytes: 0,
    })).toBe('저장을 취소했어요. 기기의 기록은 바뀌지 않았습니다.');
  });
});
