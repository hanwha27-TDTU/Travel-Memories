import { afterEach, describe, expect, it } from 'vitest';
import { nativePlatform } from '../../src/services/nativePlatform';

type RuntimeWindow = {
  Capacitor?: { isNativePlatform?: () => boolean; Plugins?: Record<string, unknown> };
};

const runtimeGlobal = globalThis as typeof globalThis & { window?: RuntimeWindow; isTauri?: boolean };

function setWindow(value: RuntimeWindow): void {
  Object.defineProperty(globalThis, 'window', { value, configurable: true, writable: true });
}

afterEach(() => {
  delete runtimeGlobal.window;
  delete runtimeGlobal.isTauri;
});

describe('nativePlatform — 실행 표면 SSOT', () => {
  it('일반 웹은 browser다', () => {
    setWindow({});
    expect(nativePlatform()).toBe('browser');
  });

  it('Capacitor 네이티브 브리지가 있으면 android다', () => {
    setWindow({ Capacitor: { isNativePlatform: () => true, Plugins: {} } });
    expect(nativePlatform()).toBe('android');
  });

  it('Tauri 내부 표식이 있으면 windows다', () => {
    setWindow({});
    runtimeGlobal.isTauri = true;
    expect(nativePlatform()).toBe('windows');
  });
});
