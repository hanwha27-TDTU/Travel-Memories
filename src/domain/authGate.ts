// domain/authGate.ts — 「이 기기의 기록을 볼 자격이 있는가」의 **유일한 판정**.
//
// 🔴 왜 한 곳인가(§7 2층 — 구조적 강제): M-0102를 고칠 때 이 판정이 **두 곳에 손으로**
// 있었다 — `home.ts`의 목록 잠금과 `main.ts`의 딥링크 가드. 같은 규율을 두 곳에 손으로
// 구현한 순간 드리프트는 시간 문제이고, 이 판정이 갈라지면 **한쪽이 우회로가 된다**
// (목록만 잠그고 딥링크를 열어 두면 뒤로가기·북마크로 그대로 보인다 — 실제로 그 상태였다).
//
// 그리고 순수 함수라 **앱이 자기 배선을 스스로 확인할 수 있다** — 「세션·로그인」 진단이
// 알려진 입력을 먹여 기대한 답이 나오는지 잰다. 배선이 조용히 끊기면 사용자 기기에서 빨개진다.

/**
 * 이 기기에 남은 기록을 화면에 보여도 되는가.
 *
 * - 클라우드를 쓰지 않는 배포: **언제나 예.** 「다른 계정」이라는 개념 자체가 없다.
 * - 클라우드 배포: 로그인해야 예. 로그아웃은 「이 계정의 기록을 볼 자격」의 경계다.
 *
 * 🔴 **가리는 것과 지우는 것은 다른 일이다**(비타협 원칙 #1). 이 함수가 `false`를 줘도
 * Dexie의 자료는 그대로 남고, 다시 로그인하면 같은 것이 보인다.
 */
export function canViewLocalRecords(cloudConfigured: boolean, signedIn: boolean): boolean {
  if (!cloudConfigured) return true;
  return signedIn;
}

/**
 * 배선 자가확인용 **알려진 입력·기대 출력** 표.
 *
 * 진단 도구가 이걸 그대로 돌려 판정한다 — 표를 여기 두는 이유는 도구가 자기 기대값을 손으로
 * 적으면 그 자체가 두 번째 사본이 되기 때문이다(§7 SSOT). 새 갈래가 생기면 여기만 늘린다.
 */
export const AUTH_GATE_CASES: { cloudConfigured: boolean; signedIn: boolean; expected: boolean; why: string }[] = [
  { cloudConfigured: true, signedIn: true, expected: true, why: '로그인했으면 보인다' },
  { cloudConfigured: true, signedIn: false, expected: false, why: '🔴 로그아웃하면 가려진다' },
  { cloudConfigured: false, signedIn: false, expected: true, why: '클라우드를 안 쓰면 가릴 상대가 없다' },
  { cloudConfigured: false, signedIn: true, expected: true, why: '클라우드를 안 쓰면 언제나 보인다' },
];

// ────────────────────────────────────────────────────────────────────────────
// 「보는 것」과 「하는 것」은 다른 판정이다 (T-020 · ADR-0063)
//
// 🔴 왜 함수를 하나 더 두나: M-0102 뒤 이 파일은 **판정**을 한 곳에 모았지만, 그 판정을
// **어느 표면에 거는가**는 여전히 표면마다 손으로 배선됐다(홈 목록·딥링크 가드 둘뿐).
// 그래서 「데이터 관리」는 묻지 않은 채로 남았고, 화면에서 가린 자료가 백업 파일로는
// 나갔다 — 판정의 SSOT가 곧 적용의 SSOT는 아니다(HANDOFF-0153).
//
// 그리고 답은 「전부 잠금」이 아니다. 로그인이 안 될 때 기억을 꺼낼 **마지막 문**은 남겨야
// 한다(비타협 원칙 #1·#5 — 복구 가능성). 그래서 동작마다 갈린다.

/**
 * 데이터 관리 화면이 로컬 자료에 하는 동작.
 *
 * 🔴 **새 동작을 만들면 이 유니온에 넣어야 하고, 넣으면 아래 분류에서 빠뜨릴 수 없다** —
 * `Record<LocalDataAction, …>`이라 한 줄만 빠져도 컴파일이 실패한다(§7 2층 구조적 강제).
 * 산문으로 "새 동작도 분류하세요"라고 적는 것과, 안 하면 빌드가 깨지는 것은 다른 일이다.
 */
export type LocalDataAction = 'export' | 'restore' | 'purge';

/**
 * 동작마다 로그인을 요구하는가. **기본값을 두지 않는다** — 새 형제가 조용히 열린 쪽으로
 * 태어나면 그게 이 결함의 재발이다(M-0060의 「기본값 금지」와 같은 규율).
 */
const NEEDS_SIGN_IN: Record<LocalDataAction, boolean> = {
  // 🔴 내보내기는 **일부러 연다**(사용자 결정 2026-08-12 · ADR-0063). 로그인이 안 되는
  // 상황(서버 장애·계정 문제·비행기 모드)에서 기억을 꺼낼 마지막 수단이고, 이 동작은
  // 자료를 **읽기만** 한다. 이 자리를 "일관성"을 이유로 잠그지 마라 — 잠그는 순간
  // 복구 경로가 사라진다.
  export: false,
  // 복원은 로컬 자료를 **덮어쓴다**. 남의 기기에서 임의 파일을 밀어 넣을 수 있으면 안 된다.
  restore: true,
  // 영구삭제는 되돌릴 수 없다(ADR-0030 — 서버 행까지 실제로 지운다).
  purge: true,
};

/**
 * 이 동작을 지금 실행해도 되는가.
 *
 * - 클라우드를 쓰지 않는 배포: **언제나 예.** 「다른 계정」 개념이 없다(`canViewLocalRecords`와 같은 전제).
 * - 클라우드 배포: 위 분류가 로그인을 요구하는 동작만 로그인 뒤에 열린다.
 */
export function canRunLocalDataAction(
  action: LocalDataAction,
  cloudConfigured: boolean,
  signedIn: boolean,
): boolean {
  if (!cloudConfigured) return true;
  if (!NEEDS_SIGN_IN[action]) return true;
  return signedIn;
}

/** 동작 잠금의 자가확인 표. 위 표와 같은 이유로 여기 둔다(도구가 기대값을 손으로 적으면 두 번째 사본이다). */
export const LOCAL_DATA_ACTION_CASES: {
  action: LocalDataAction;
  cloudConfigured: boolean;
  signedIn: boolean;
  expected: boolean;
  why: string;
}[] = [
  { action: 'export', cloudConfigured: true, signedIn: false, expected: true, why: '🔴 내보내기는 로그아웃에도 열린다 — 기억을 꺼낼 마지막 문' },
  { action: 'export', cloudConfigured: true, signedIn: true, expected: true, why: '내보내기는 로그인해도 당연히 된다' },
  { action: 'restore', cloudConfigured: true, signedIn: false, expected: false, why: '🔴 복원은 로그아웃에서 막힌다 — 로컬 자료를 덮어쓴다' },
  { action: 'restore', cloudConfigured: true, signedIn: true, expected: true, why: '복원은 로그인하면 된다' },
  { action: 'purge', cloudConfigured: true, signedIn: false, expected: false, why: '🔴 영구삭제는 로그아웃에서 막힌다 — 되돌릴 수 없다' },
  { action: 'purge', cloudConfigured: true, signedIn: true, expected: true, why: '영구삭제는 로그인하면 된다' },
  { action: 'restore', cloudConfigured: false, signedIn: false, expected: true, why: '클라우드를 안 쓰면 가릴 상대가 없다' },
  { action: 'purge', cloudConfigured: false, signedIn: false, expected: true, why: '클라우드를 안 쓰면 영구삭제도 막을 상대가 없다' },
];

/**
 * 표를 전부 돌려 어긋난 갈래를 돌려준다. 비어 있으면 배선이 살아 있는 것이다.
 *
 * 🔴 **두 표를 여기서 함께 돈다.** 그래야 이 함수를 이미 쓰고 있는 진단(`sessionState.ts`)이
 * 새 규칙을 **자동으로 따라온다** — 소비처를 손으로 고쳐야 한다면 그게 §7이 말하는 누락의 씨앗이다.
 */
export function authGateMismatches(): string[] {
  const view = AUTH_GATE_CASES.filter((c) => canViewLocalRecords(c.cloudConfigured, c.signedIn) !== c.expected);
  const act = LOCAL_DATA_ACTION_CASES.filter(
    (c) => canRunLocalDataAction(c.action, c.cloudConfigured, c.signedIn) !== c.expected,
  );
  return [...view.map((c) => c.why), ...act.map((c) => c.why)];
}
