// services/appUpdate.ts — **접속하면 스스로 최신이 되는** 배선.
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 (2026-08-01 사용자: "접속할 때 자동으로 최신 버젼으로 적용되도록 해주세요")
// ─────────────────────────────────────────────────────────────────────────────
// 셸(APK)·설치형 PWA는 앱이 백그라운드에 **살아 있어서** 페이지를 다시 로드할 일이 거의 없다.
// 새 배포는 다음 로드에나 닿는데 그 「다음 로드」가 안 온다 — 배포는 초록인데 화면은 v1.46.
// (서비스워커 탓이 아니다: sw.js는 HTML을 네트워크 우선으로 둔다. 로드 자체가 없는 게 문제다.)
//
// 그래서: 시작·복귀 때 배포에 심어진 신호(version.json — gen-version-file.mjs)를 묻고,
// 새 판이 있으면 **안전할 때** 새로고침한다. 안전하지 않으면(글 쓰는 중·창 열림) 미뤘다가
// **다음 화면 이동(hashchange) 때** 적용한다 — 새 UI 없이 반드시 도달한다.
//
// 🔴 안전 규칙이 이 파일의 핵심이다. 새로고침은 입력 중인 글을 날릴 수 있다(비타협 원칙 #1의
// 이웃 — 아직 저장 안 된 기억). 그래서 「이번 표시 기간에 키보드 입력이 있었나」와 「열린
// 창(overlay)이 있나」를 보고, 하나라도 걸리면 지금은 건드리지 않는다.

import { CHANGELOG } from '../app/changelog';

/** 실행 중인 번들의 버전 — SSOT는 changelog 맨 앞 항목이다. */
export const CURRENT_VERSION: string = CHANGELOG[0]?.version ?? '0';

/** 확인 사이 최소 간격 — 복귀 연타가 네트워크를 두드리지 않게. */
export const CHECK_MIN_MS = 60_000;

/** `1.47` vs `1.46` — 점 구분 숫자 비교(자릿수 달라도 안전). 순수: 유닛이 직접 돌린다. */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string): number[] => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [a, b] = [parse(latest), parse(current)];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/** 지금 확인해도 되나(스로틀). 순수. */
export function shouldCheck(lastAt: number | null, now: number): boolean {
  return lastAt === null || now - lastAt >= CHECK_MIN_MS;
}

/**
 * 지금 새로고침해도 안전한가. 순수(인자로 받은 사실만 본다).
 * — 열린 창(overlay)이 있으면 안 된다: 백업 진행·편집기 등 중간 상태가 산다.
 * — 이번 표시 기간에 키보드 입력이 있었으면 안 된다: 아직 저장 안 된 글일 수 있다.
 */
export function safeToReload(hasOverlay: boolean, typedSinceVisible: boolean): boolean {
  return !hasOverlay && !typedSinceVisible;
}

interface VersionSignal {
  version?: unknown;
}

/** 배포된 신호 파일을 묻는다. 실패(오프라인·404)는 null — 갱신은 속도지 기능이 아니다. */
async function fetchLatest(base: string): Promise<string | null> {
  try {
    // ts 쿼리로 CDN 캐시를 지나친다. sw.js는 version.json을 아예 만지지 않는다(캐시 오염 방지).
    const res = await fetch(`${base}version.json?ts=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as VersionSignal;
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  }
}

/** 같은 버전으로 두 번 새로고침하지 않기 위한 표식(세션 한정) — CDN이 늦으면 루프가 된다. */
const ATTEMPT_KEY = 'bj.update.attempted';

/**
 * 자동 갱신을 배선한다(main.ts에서 1회).
 *
 * 시점: ① 시작 직후 ② 화면 복귀(visibilitychange) ③ 화면 이동(hashchange — 미뤄둔 적용).
 * 적용: 안전하면 즉시 location.reload(), 아니면 pending으로 들고 다음 시점에 다시 시도.
 */
export function wireAutoUpdate(): void {
  let lastCheckAt: number | null = null;
  let typedSinceVisible = false;
  let pending: string | null = null;

  const tryApply = (): void => {
    if (!pending) return;
    if (!safeToReload(document.querySelector('.overlay-base') !== null, typedSinceVisible)) return;
    try {
      if (sessionStorage.getItem(ATTEMPT_KEY) === pending) return; // 이미 시도한 버전 — 루프 차단
      sessionStorage.setItem(ATTEMPT_KEY, pending);
    } catch {
      /* sessionStorage 불가 환경이면 표식 없이 1회 새로고침만 */
    }
    location.reload();
  };

  const check = (): void => {
    const now = Date.now();
    if (!shouldCheck(lastCheckAt, now)) {
      tryApply(); // 신호는 이미 있고 상황만 바뀌었을 수 있다(창 닫힘 등)
      return;
    }
    lastCheckAt = now;
    void fetchLatest(import.meta.env.BASE_URL).then((latest) => {
      if (latest && isNewer(latest, CURRENT_VERSION)) pending = latest;
      tryApply();
    });
  };

  document.addEventListener('keydown', () => {
    typedSinceVisible = true;
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      typedSinceVisible = false; // 새 표시 기간 시작 — 입력 이력도 새로 센다
      check();
    }
  });
  // 화면 이동 = 이전 화면의 입력을 떠났다 — 미뤄둔 갱신을 적용할 안전한 순간.
  window.addEventListener('hashchange', () => {
    typedSinceVisible = false;
    tryApply();
  });

  check(); // 시작 직후 1회 — 「접속할 때 자동으로 최신」의 그 시점
}
