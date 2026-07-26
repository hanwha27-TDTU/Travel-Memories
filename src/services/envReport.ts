// services/envReport.ts — **개발자가 볼 수 없는 실행 환경**을 관측 가능하게 만든다.
//
// 연역(무엇을 만들지 임의로 고르지 않았다): "내가 못 보는 것" 중 **기억을 잃거나 사용자를
// 막는 것**만 고른다.
//
//  ① 저장 용량·축출 위험 — 브라우저가 데이터를 축출하면 **앱 밖 원인의 유일한 기억 손실**이다
//     (비타협 원칙 #1의 예외 항목). persist() 여부는 그 위험의 직접 지표다. → 최우선.
//  ② 기능 지원 — WebP·OffscreenCanvas·IndexedDB·WebGL·Service Worker가 없으면 사진 처리·지도·
//     오프라인이 조용히 대체경로로 빠진다. "왜 느리지/왜 안 되지"의 답이 여기 있다.
//  ③ 기기 시계·시간대 — 날짜가 하루 밀리던 결함(M-utc-slice)의 판단 근거. 서명 URL 만료·
//     환율 기준일도 시계에 걸린다.
//  ④ 화면·표시 — 반응형 문제 신고 시 추측 대신 실측 폭·DPR로 판단한다.
//  ⑤ 앱 버전·서비스워커 — "새로고침했는데 안 바뀐다"(옛 번들 캐시)의 판별.
//  ⑥ 네트워크 상태 — 오프라인이면 동기화 실패가 정상이다. 그걸 결함으로 오진하지 않기 위해.
//
// 개인정보: 여기서 모으는 것은 **기기·브라우저 성질**뿐이다. 사용자가 적은 글·사진·위치·
// 이메일은 담지 않는다. 진단 요약 복사도 같은 규율을 따른다.

export interface EnvReport {
  app: { version: string; base: string; mediaStore: string };
  device: { ua: string; platform: string; languages: string; online: boolean };
  screen: { w: number; h: number; dpr: number; orientation: string };
  clock: { nowIso: string; tzOffsetMin: number; tz: string };
  storage: { usage: number | null; quota: number | null; persisted: boolean | null; canPersist: boolean };
  features: Record<string, boolean>;
  sw: { supported: boolean; controlled: boolean; scope: string | null };
}

/** 기능 하나를 안전하게 탐지한다 — 탐지 자체가 예외를 던지면 '미지원'으로 본다. */
function has(fn: () => boolean): boolean {
  try {
    return fn();
  } catch {
    return false;
  }
}

export async function collectEnv(appVersion: string): Promise<EnvReport> {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };

  let usage: number | null = null;
  let quota: number | null = null;
  let persisted: boolean | null = null;
  const canPersist = has(() => typeof navigator.storage?.persist === 'function');
  try {
    if (navigator.storage?.estimate) {
      const e = await navigator.storage.estimate();
      usage = e.usage ?? null;
      quota = e.quota ?? null;
    }
    if (navigator.storage?.persisted) persisted = await navigator.storage.persisted();
  } catch {
    /* 미지원 브라우저 — null로 남긴다(추측하지 않는다) */
  }

  let sw = { supported: 'serviceWorker' in navigator, controlled: false, scope: null as string | null };
  try {
    if (navigator.serviceWorker) {
      sw = {
        supported: true,
        controlled: navigator.serviceWorker.controller !== null,
        scope: (await navigator.serviceWorker.getRegistration())?.scope ?? null,
      };
    }
  } catch {
    /* 무시 */
  }

  return {
    app: {
      version: appVersion,
      base: import.meta.env.BASE_URL,
      mediaStore: 'Cloudflare R2',
    },
    device: {
      ua: navigator.userAgent.slice(0, 180),
      platform: nav.userAgentData?.platform ?? '(알 수 없음)',
      languages: navigator.languages?.join(', ') ?? navigator.language,
      online: navigator.onLine,
    },
    screen: {
      w: window.innerWidth,
      h: window.innerHeight,
      dpr: window.devicePixelRatio,
      orientation: window.innerWidth >= window.innerHeight ? '가로' : '세로',
    },
    clock: {
      nowIso: new Date().toISOString(),
      tzOffsetMin: -new Date().getTimezoneOffset(),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    storage: { usage, quota, persisted, canPersist },
    sw,
    features: {
      IndexedDB: has(() => 'indexedDB' in window),
      'Web Worker': has(() => typeof Worker !== 'undefined'),
      OffscreenCanvas: has(() => typeof OffscreenCanvas !== 'undefined'),
      'WebP 인코딩': has(() => document.createElement('canvas').toDataURL('image/webp').startsWith('data:image/webp')),
      createImageBitmap: has(() => typeof createImageBitmap === 'function'),
      WebGL: has(() => Boolean(document.createElement('canvas').getContext('webgl'))),
      'Service Worker': has(() => 'serviceWorker' in navigator),
      'Crypto.subtle': has(() => typeof crypto?.subtle?.digest === 'function'),
      '클립보드 쓰기': has(() => typeof navigator.clipboard?.writeText === 'function'),
      'Storage.persist': canPersist,
    },
  };
}

/** 축출 위험 판정 — 남은 여유와 persist 상태로 사람이 읽을 결론을 만든다. */
export function evictionRisk(r: EnvReport): { level: 'ok' | 'info' | 'error'; text: string } {
  const { usage, quota, persisted, canPersist } = r.storage;
  if (usage === null || quota === null || quota === 0) {
    return { level: 'info', text: '이 브라우저는 저장 용량을 알려주지 않아요. 백업을 주기적으로 받아두시면 안전합니다.' };
  }
  const pct = Math.round((usage / quota) * 100);
  if (persisted) {
    return { level: 'ok', text: `저장소가 보호됨(persist) · 사용 ${pct}%. 브라우저가 임의로 지우지 않습니다.` };
  }
  if (pct >= 80) {
    return {
      level: 'error',
      // ⚠️ 여기에 마크다운 강조(**…**)를 쓰지 마라. 이 문자열은 textContent로 그려지므로
      // 별표가 화면에 그대로 찍힌다(2026-07-26 적대적 리뷰가 잡은 실제 결함). 강조가 필요하면
      // 문자열이 아니라 판정 level로 표현한다. 게이트: scripts/check-verdict-symmetry.mjs
      text: `사용 ${pct}% — 여유가 적어요. 브라우저는 공간이 부족하면 앱 데이터를 지울 수 있습니다. 지금 백업을 받고, [저장소 보호 요청]을 눌러 주세요.`,
    };
  }
  return {
    level: 'info',
    text: `사용 ${pct}% · 저장소 보호 미적용${canPersist ? ' — [저장소 보호 요청]을 누르면 브라우저에 요청합니다.' : '(이 브라우저는 요청 기능이 없어요)'}`,
  };
}

/** 브라우저에 "이 데이터를 함부로 지우지 말라"고 요청한다. 거절될 수 있다(브라우저 재량). */
export async function requestPersist(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
