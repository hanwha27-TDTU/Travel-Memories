import { afterEach, describe, expect, it } from 'vitest';
import {
  backupSaveMessage,
  mediaSaveErrorMessage,
  mediaSaveMessage,
  saveBackupBlob,
  saveBackupBlobToChosenFolder,
  saveFileBlob,
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

  it('사진 앱 보관본은 Android Download에 정확한 이름과 MIME으로 쓰고 되읽는다', async () => {
    const begins: { filename: string; mime: string; destination: string }[] = [];
    globals.window = {
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: {
          BackupFiles: {
            begin: async (options: { filename: string; mime: string; destination: string }) => {
              begins.push(options);
              return { token: 'photo-token', name: options.filename, destination: 'downloads' };
            },
            append: async () => ({ bytes: 4 }),
            finish: async () => ({ verified: true, bytes: 4, name: begins[0]!.filename, destination: 'downloads' }),
            abort: async () => undefined,
          },
        },
      },
    };

    const receipt = await saveFileBlob(
      new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/webp' }),
      '20260811_1743_여행__12345678.webp',
      { mime: 'image/webp', description: 'Bugeon Journey 사진' },
    );
    expect(begins).toEqual([{
      filename: '20260811_1743_여행__12345678.webp', mime: 'image/webp', destination: 'downloads',
    }]);
    expect(receipt).toMatchObject({ state: 'verified', method: 'android-downloads', bytes: 4 });
    expect(mediaSaveMessage(receipt, '사진')).toContain('사진 앱 보관본을 저장하고 다시 읽어 확인했어요');
  });

  it('0바이트와 MIME·확장자 불일치는 네이티브 문을 열기 전에 거부한다', async () => {
    globals.window = {};
    await expect(saveFileBlob(new Blob([]), 'empty.webp', {
      mime: 'image/webp', description: 'Bugeon Journey 사진',
    })).rejects.toThrow('빈 파일');
    await expect(saveFileBlob(new Blob(['video']), 'wrong.webp', {
      mime: 'video/mp4', description: 'Bugeon Journey 영상',
    })).rejects.toThrow('형식과 확장자가 맞지 않습니다');
    await expect(saveFileBlob(new Blob(['video'], { type: 'video/webm' }), 'wrong.mp4', {
      mime: 'video/mp4', description: 'Bugeon Journey 영상',
    })).rejects.toThrow('바이트 형식과 기록된 형식이 맞지 않습니다');
  });

  it('native read-back 불일치는 abort하고 완료로 반올림하지 않는다', async () => {
    let aborted = 0;
    globals.window = {
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: {
          BackupFiles: {
            begin: async () => ({ token: 'bad-token', name: 'clip.webm', destination: 'downloads' }),
            append: async () => ({ bytes: 5 }),
            finish: async () => ({ verified: true, bytes: 4, name: 'clip.webm', destination: 'downloads' }),
            abort: async () => { aborted += 1; },
          },
        },
      },
    };
    await expect(saveFileBlob(new Blob(['video']), 'clip.webm', {
      mime: 'video/webm', description: 'Bugeon Journey 영상',
    })).rejects.toThrow('원래 바이트와 다릅니다');
    expect(aborted).toBe(1);
  });

  it('native가 검증하지 못했다고 답하면 길이가 같아도 abort한다', async () => {
    let aborted = 0;
    globals.window = {
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: {
          BackupFiles: {
            begin: async () => ({ token: 'unverified-token', name: 'clip.mp4', destination: 'downloads' }),
            append: async () => ({ bytes: 5 }),
            finish: async () => ({ verified: false, bytes: 5, name: 'clip.mp4', destination: 'downloads' }),
            abort: async () => { aborted += 1; },
          },
        },
      },
    };
    await expect(saveFileBlob(new Blob(['video']), 'clip.mp4', {
      mime: 'video/mp4', description: 'Bugeon Journey 영상',
    })).rejects.toThrow('원래 바이트와 다릅니다');
    expect(aborted).toBe(1);
  });

  it('구형 Android가 destination을 생략하면 저장 완료를 선택기 경로로 보수 판정한다', async () => {
    globals.window = {
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: {
          BackupFiles: {
            begin: async () => ({ token: 'old-token', name: 'clip.mp4' }),
            append: async () => ({ bytes: 5 }),
            finish: async () => ({ verified: true, bytes: 5, name: 'clip.mp4' }),
            abort: async () => undefined,
          },
        },
      },
    };
    await expect(saveFileBlob(new Blob(['video']), 'clip.mp4', {
      mime: 'video/mp4', description: 'Bugeon Journey 영상',
    })).resolves.toMatchObject({ state: 'verified', method: 'android-picker' });
  });

  it('브라우저 선택기는 실제 사진 확장자를 제시하고 같은 크기 다른 바이트를 거부한다', async () => {
    let pickerOptions: unknown;
    let aborted = 0;
    globals.window = {
      showSaveFilePicker: async (options: unknown) => {
        pickerOptions = options;
        return {
          createWritable: async () => ({
            write: async () => undefined,
            close: async () => undefined,
            abort: async () => { aborted += 1; },
          }),
          getFile: async () => new File([new Uint8Array([9, 9, 9, 9])], 'picked.webp', { type: 'image/webp' }),
        };
      },
    };
    await expect(saveFileBlob(new Blob([new Uint8Array([1, 2, 3, 4])]), 'photo.webp', {
      mime: 'image/webp', description: 'Bugeon Journey 사진',
    })).rejects.toThrow('원래 바이트와 다릅니다');
    expect(pickerOptions).toMatchObject({
      suggestedName: 'photo.webp',
      types: [{ description: 'Bugeon Journey 사진', accept: { 'image/webp': ['.webp'] } }],
    });
    expect(aborted).toBe(0); // 쓰기는 닫혔고, 저장 뒤 parity 실패라 handle 삭제 권한은 없다.
  });

  it('브라우저 선택기 취소는 파일이 만들어지지 않은 상태로 판정한다', async () => {
    globals.window = {
      showSaveFilePicker: async () => { throw new DOMException('사용자 취소', 'AbortError'); },
    };
    const receipt = await saveFileBlob(new Blob(['photo']), 'photo.webp', {
      mime: 'image/webp', description: 'Bugeon Journey 사진',
    });
    expect(receipt).toEqual({ state: 'cancelled', method: 'browser-picker', filename: 'photo.webp', bytes: 0 });
    expect(mediaSaveMessage(receipt, '사진')).toContain('파일은 만들어지지 않았어요');
  });

  it('브라우저 쓰기 실패는 abort를 시도하고 관측된 오류를 유지한다', async () => {
    let aborted = 0;
    globals.window = {
      showSaveFilePicker: async () => ({
        createWritable: async () => ({
          write: async () => { throw new Error('디스크 쓰기 실패'); },
          close: async () => undefined,
          abort: async () => { aborted += 1; },
        }),
        getFile: async () => new File(['unused'], 'photo.webp', { type: 'image/webp' }),
      }),
    };
    await expect(saveFileBlob(new Blob(['photo']), 'photo.webp', {
      mime: 'image/webp', description: 'Bugeon Journey 사진',
    })).rejects.toThrow('디스크 쓰기 실패');
    expect(aborted).toBe(1);
  });

  it('미디어 실패 문장은 앱 보관본과 관측된 오류를 함께 말한다', () => {
    expect(mediaSaveErrorMessage('영상', new Error('저장 공간이 부족합니다.'))).toBe(
      '영상 앱 보관본을 저장하지 못했어요 · 저장 공간이 부족합니다.',
    );
  });
});
