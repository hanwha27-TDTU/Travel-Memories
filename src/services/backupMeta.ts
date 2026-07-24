// services/backupMeta.ts — "마지막 백업 시각" 관측 가능화(DR 감사관 교정 #1).
//
// 신선도(freshness)는 저장소가 못 보는 값이라 감사관이 HOLD의 근거로 삼았다. 앱이 마지막
// 백업 시각을 기록·표시하면 사용자가 "얼마나 오래됐는지"를 볼 수 있어 신선도가 관측 가능해진다.
// 이건 캐시 성격 메타(기억 자체가 아님)라 localStorage에 둔다(사이트데이터 삭제 시 사라져도 무해).
// 정직: 이건 "파일을 실제로 만들어 다운로드한 시각"이지 "사용자가 안전히 보관했다"는 보장은 아니다.

const KEY = 'bugeon:lastBackupAt';

export function recordBackupNow(): void {
  try {
    localStorage.setItem(KEY, new Date().toISOString());
  } catch {
    /* localStorage 불가(프라이빗 모드 등) — 무시. 백업 자체엔 영향 없음. */
  }
}

export function getLastBackupAt(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** 마지막 백업으로부터 지난 일수(정수). 없거나 파싱 불가면 null. */
export function backupAgeDays(iso: string | null, now = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

/** 사람이 읽는 신선도 문구. STALE_DAYS 이상이면 권고를 붙일 수 있게 stale 플래그도 준다. */
export const STALE_DAYS = 14;

export function backupFreshness(iso: string | null, now = Date.now()): { text: string; stale: boolean; never: boolean } {
  const age = backupAgeDays(iso, now);
  if (age === null) return { text: '아직 백업한 적이 없어요', stale: true, never: true };
  if (age === 0) return { text: '마지막 백업: 오늘', stale: false, never: false };
  if (age === 1) return { text: '마지막 백업: 어제', stale: false, never: false };
  return { text: `마지막 백업: ${age}일 전`, stale: age >= STALE_DAYS, never: false };
}
