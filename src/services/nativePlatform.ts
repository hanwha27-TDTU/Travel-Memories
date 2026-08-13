// services/nativePlatform.ts — 브라우저·Android·Windows 실행 표면 판별의 단일 진실원.
//
// 플랫폼마다 기능을 흉내 내지 않는다. 이 파일은 "어디서 실행 중인가"만 답하고,
// Android 플러그인은 capacitorShell, Windows 명령은 앞으로 별도 Tauri 서비스가 맡는다.

import { isTauri } from '@tauri-apps/api/core';

export type NativePlatform = 'browser' | 'android' | 'windows';

export interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  Plugins?: Record<string, unknown>;
}

/** Android 브리지 원본. 브라우저와 Tauri에서는 null이다. */
export function capacitorBridge(): CapacitorGlobal | null {
  if (typeof window === 'undefined') return null;
  const cap = (window as Window & { Capacitor?: CapacitorGlobal }).Capacitor;
  if (!cap?.isNativePlatform?.()) return null;
  return cap;
}

/** 실행 표면 판정. Tauri가 Android 브리지보다 먼저 자신을 가장하지 않는다는 전제를 두지 않는다. */
export function nativePlatform(): NativePlatform {
  if (capacitorBridge()) return 'android';
  return isTauri() ? 'windows' : 'browser';
}
