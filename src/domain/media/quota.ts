// domain/media/quota.ts — **저장 공간 사전점검**(순수 함수).
//
// ── 왜 이 파일이 생겼나 (2026-07-27) ──────────────────────────────────
// `docs/MEDIA_PIPELINE.md:42-43`이 계약으로 적어 뒀다:
//   *"저장공간 사전점검(preflight)… quota가 부족하면 일부만 `staged`로 수용하고
//     나머지는 `quota_blocked`로 남긴다."*
// 그런데 **인테이크에 그 점검이 없었다.** `navigator.storage.estimate()`를 부르는 곳은
// 표시용 두 곳(`storage.ts`·`envReport.ts`)뿐이었고 `quota_blocked` 상태는 코드에 없었다.
//
// 결과가 무엇인가: quota를 넘으면 Dexie 쓰기가 `QuotaExceededError`로 실패하는데, 그건
// **사진만 못 넣는 게 아니다** — 그 시점부터 순간·비용 같은 텍스트 기억의 저장까지 막힌다.
// 비타협 원칙 #1("기억을 잃지 않는다")의 가장 조용한 위반 경로다.
//
// 규율: **막되, 왜 막았는지 숫자로 말한다.** 그리고 **모르면 막지 않는다** — `estimate()`를
// 지원하지 않는 브라우저에서 저장을 거부하면 멀쩡한 기기에서 앱을 못 쓰게 된다(§8).

/** 브라우저가 알려준 저장 현황. 지원하지 않으면 둘 다 null. */
export interface StorageEstimateLike {
  usage: number | null;
  quota: number | null;
}

export type QuotaLevel = 'ok' | 'tight' | 'blocked' | 'unknown';

export interface QuotaVerdict {
  level: QuotaLevel;
  /** 사용자에게 그대로 보여줄 한 줄. `ok`·`unknown`이면 빈 문자열(침묵이 정상 — §8). */
  message: string;
  /** 이 저장을 진행해도 되는가. `unknown`은 **진행**한다(모르는 것으로 막지 않는다). */
  allow: boolean;
}

/** 사람이 읽는 크기. 소수 한 자리까지 — 「0.0MB」로 반올림해 0을 보여주지 않는다. */
export function humanBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)}B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)}KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  return `${(n / 1024 ** 3).toFixed(1)}GB`;
}

/** 이 비율을 넘기면 저장을 막는다. 여유를 조금 남겨야 텍스트 기억이 계속 저장된다. */
export const BLOCK_RATIO = 0.95;
/** 이 비율을 넘기면 경고하되 진행한다. 진단의 「저장 공간 사용률」 기대값과 같은 값. */
export const WARN_RATIO = 0.8;

/**
 * 이만큼 더 넣어도 되는가.
 *
 * @param needBytes 이번에 넣으려는 바이트(원본+파생본 추정 합).
 * @param est 브라우저가 알려준 현황.
 *
 * 판정 규칙:
 *  · `quota`를 모르면 **`unknown` + 진행** — 모르는 것을 문제로도 정상으로도 반올림하지 않는다.
 *  · 넣은 뒤가 95%를 넘으면 **`blocked`** — 진행하면 다른 기억까지 저장 못 하게 된다.
 *  · 넣은 뒤가 80%를 넘으면 **`tight`** — 진행하되 백업을 권한다.
 */
export function quotaVerdict(needBytes: number, est: StorageEstimateLike): QuotaVerdict {
  if (est.quota === null || est.quota <= 0 || est.usage === null) {
    return { level: 'unknown', message: '', allow: true };
  }
  const after = est.usage + Math.max(0, needBytes);
  const ratio = after / est.quota;
  if (ratio > BLOCK_RATIO) {
    const free = Math.max(0, est.quota * BLOCK_RATIO - est.usage);
    return {
      level: 'blocked',
      // 무엇을·왜·얼마나를 전부 숫자로 말한다. "저장 실패"만 띄우면 사용자가 할 일이 없다.
      message:
        `저장 공간이 부족해요 — 이만큼(${humanBytes(needBytes)})을 더 넣으면 한도를 넘습니다. ` +
        `지금 ${humanBytes(est.usage)} / ${humanBytes(est.quota)} 사용 중이고 여유는 ${humanBytes(free)}예요. ` +
        `[데이터 관리]에서 백업을 받은 뒤 오래된 여행을 정리해 주세요.`,
      allow: false,
    };
  }
  if (ratio > WARN_RATIO) {
    return {
      level: 'tight',
      message: `저장 공간이 곧 찹니다 — 넣고 나면 ${Math.round(ratio * 100)}%예요(정상 80% 미만). 백업을 받아 두세요.`,
      allow: true,
    };
  }
  return { level: 'ok', message: '', allow: true };
}

/**
 * 사진 한 장이 로컬에서 차지할 바이트의 **보수적 추정**.
 *
 * `LocalMedia`는 blob을 셋 들고 있다(원본·표시본·썸네일). 표시본·썸네일은 원본보다 훨씬
 * 작지만(실측: 12MP에서 표시본 약 0.66MB), 사전점검은 **넉넉히 잡는 쪽이 안전**하다 —
 * 적게 잡아 통과시켰다가 커밋에서 터지면 그게 바로 막으려던 실패다.
 */
export function estimateLocalBytes(fileSize: number): number {
  return Math.round(fileSize * 1.35);
}
