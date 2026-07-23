// ui/theme.ts — 라이트/다크 테마 + 계절 테마 상태 관리.
// 선택값은 localStorage에 캐시(순수 제어값 — 사용자 기억 데이터는 IndexedDB, 여긴 표시 선호만).
// documentElement의 data-theme / data-season 속성으로 반영하고, CSS가 이를 읽어 스타일링한다.

export type ThemeChoice = 'light' | 'dark';
export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

const THEME_KEY = 'bj.theme';
const SEASON_KEY = 'bj.season';
export const SEASONS: readonly Season[] = ['spring', 'summer', 'autumn', 'winter'] as const;
export const SEASON_LABEL: Record<Season, string> = {
  spring: '🌸 봄',
  summer: '☀️ 여름',
  autumn: '🍁 가을',
  winter: '❄️ 겨울',
};

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // 프라이빗 모드 등
  }
}
function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 저장 실패는 무시(선호값일 뿐) */
  }
}

/** 현재 월(북반구) 기준 계절 — 사용자가 고르지 않았을 때의 기본값. */
function seasonForMonth(month1to12: number): Season {
  if (month1to12 >= 3 && month1to12 <= 5) return 'spring';
  if (month1to12 >= 6 && month1to12 <= 8) return 'summer';
  if (month1to12 >= 9 && month1to12 <= 11) return 'autumn';
  return 'winter';
}

/** 저장된 테마 선택(없으면 null → OS 선호 따름). */
export function storedTheme(): ThemeChoice | null {
  const v = safeGet(THEME_KEY);
  return v === 'light' || v === 'dark' ? v : null;
}

/** 실제 적용 중인 테마(저장값 우선, 없으면 OS 선호). */
export function effectiveTheme(): ThemeChoice {
  const s = storedTheme();
  if (s) return s;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** 현재 계절(저장값 우선, 없으면 이번 달 기준). */
export function currentSeason(): Season {
  const v = safeGet(SEASON_KEY);
  if (v && (SEASONS as readonly string[]).includes(v)) return v as Season;
  return seasonForMonth(new Date().getMonth() + 1);
}

/** 앱 부팅 시 1회: 저장된 선호를 문서에 반영(FOUC 최소화). */
export function initTheme(): void {
  const t = storedTheme();
  if (t) document.documentElement.setAttribute('data-theme', t);
  document.documentElement.setAttribute('data-season', currentSeason());
}

/** 테마를 명시적으로 설정하고 저장. */
export function setTheme(choice: ThemeChoice): void {
  document.documentElement.setAttribute('data-theme', choice);
  safeSet(THEME_KEY, choice);
}

/** 라이트/다크 토글. 반환값 = 적용된 테마. */
export function toggleTheme(): ThemeChoice {
  const next: ThemeChoice = effectiveTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}

/** 계절 설정하고 저장. */
export function setSeason(season: Season): void {
  document.documentElement.setAttribute('data-season', season);
  safeSet(SEASON_KEY, season);
}
