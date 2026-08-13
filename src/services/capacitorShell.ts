// services/capacitorShell.ts — **Capacitor 전역 접근의 단일 진실원**(§7 2층).
//
// 셸 감지와 플러그인 접근이 여기 한 곳에만 있다. 파일마다 각자 `window.Capacitor`를
// 읽기 시작하면 감지 규칙이 손으로 두 벌이 되고, 그 순간 드리프트는 시간 문제다
// (M-0060이 정확히 그 형태였다 — 형제 조건이 손으로 갈라져 한쪽만 고쳐졌다).
//
// 크롬(브리지 없음)에서는 모든 함수가 조용히 null/'browser'를 준다 — 웹 경로 무손대가
// 셸 설계의 절반이다(ADR-0036).

import type { PersistSurface } from '../domain/persistAdvice';

export type ShellState = 'browser' | 'shell' | 'shell-no-plugin';

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  Plugins?: Record<string, unknown>;
}

function capacitor(): CapacitorGlobal | null {
  if (typeof window === 'undefined') return null; // 유닛(Node)·SSR — 셸일 리 없다
  const cap = (window as Window & { Capacitor?: CapacitorGlobal }).Capacitor;
  if (!cap?.isNativePlatform?.()) return null;
  return cap;
}

/** 셸 안에서만 플러그인을 돌려준다. 크롬에서는 언제나 null. */
export function shellPlugin<T>(name: string): T | null {
  return (capacitor()?.Plugins?.[name] as T | undefined) ?? null;
}

/**
 * 어느 문인가 — 🔬 관측 창의 「경로」 줄(M-0069)과 로그인 리다이렉트 분기가 읽는다.
 *
 * 기준 플러그인은 OriginalPhotos다: 셸의 존재 이유가 그 문이므로(ADR-0036), 셸인데
 * 그 문이 없으면 「옛 APK」(shell-no-plugin)로 적는다 — 재설치가 답인 상태다.
 */
export function shellState(): ShellState {
  const cap = capacitor();
  if (!cap) return 'browser';
  return cap.Plugins?.OriginalPhotos ? 'shell' : 'shell-no-plugin';
}

/** Chromium/WebView가 공개하는 renderer JS heap 한도. 없으면 추측하지 않고 undefined. */
export function rendererHeapSizeLimit(): number | undefined {
  if (typeof performance === 'undefined') return undefined;
  const value = (performance as Performance & { memory?: { jsHeapSizeLimit?: number } }).memory?.jsHeapSizeLimit;
  return Number.isFinite(value) && (value as number) > 0 ? value : undefined;
}

/**
 * 🎨 런처 아이콘 전환기 (ADR-0038) — **셸에만 있다.**
 * 웹/PWA에서는 `null`(설치 시 아이콘이 고정되므로 원리적으로 불가). 화면은 이 값이 null이면
 * 아이콘 섹션 자체를 그리지 않는다 — 크롬에서 「안 되는 버튼」을 보여주지 않는다(§5).
 */
export interface IconSwitcher {
  available(): Promise<{ keys: string[]; current: string }>;
  getIcon(): Promise<{ current: string }>;
  setIcon(opts: { key: string }): Promise<{ current: string }>;
}

export function iconSwitcher(): IconSwitcher | null {
  return shellPlugin<IconSwitcher>('IconSwitcher');
}

/** Android에 큰 앱 파일을 청크로 쓰고, 닫은 뒤 다시 읽어 검증하는 셸 문. wire 이름은 구형 APK 호환 때문에 유지한다. */
export interface BackupFileWriter {
  begin(options: {
    filename: string;
    mime: string;
    destination: 'downloads' | 'picker';
  }): Promise<{
    cancelled?: boolean;
    token?: string;
    name?: string;
    destination?: 'downloads' | 'picker';
  }>;
  append(options: { token: string; data: string; sha256: string }): Promise<{ bytes: number }>;
  finish(options: { token: string }): Promise<{
    verified: boolean;
    bytes: number;
    name: string;
    destination?: 'downloads' | 'picker';
  }>;
  abort(options: { token: string }): Promise<void>;
}

export function backupFileWriter(): BackupFileWriter | null {
  return shellPlugin<BackupFileWriter>('BackupFiles');
}

/**
 * 🔎 **지금 어느 문으로 실행 중인가** — 셸/설치된 PWA/브라우저 탭(T-005).
 *
 * 왜 여기인가: 셸 감지가 이미 이 파일의 SSOT다(머리말). 「설치됐는가」를 다른 파일에서 따로
 * 읽기 시작하면 감지 규칙이 손으로 두 벌이 되고, 그게 M-0060의 형태다 — **같은 판정을 두 번
 * 쓰면 갈라진다.** 그래서 표면 판정 전체를 한 함수로 둔다.
 *
 * PWA 판정: `display-mode: standalone`. iOS Safari는 이 미디어 쿼리 대신 `navigator.standalone`을
 * 쓰므로 둘 다 본다 — 한쪽만 보면 아이폰 사용자에게 「설치 안 됨」으로 보인다.
 */
export function persistSurface(): PersistSurface {
  if (shellState() !== 'browser') return 'shell';
  if (typeof window === 'undefined') return 'browser-tab'; // 유닛(Node) — 탭으로 읽는다
  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return standalone ? 'installed-pwa' : 'browser-tab';
}
