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

/** 표를 전부 돌려 어긋난 갈래를 돌려준다. 비어 있으면 배선이 살아 있는 것이다. */
export function authGateMismatches(): string[] {
  return AUTH_GATE_CASES.filter((c) => canViewLocalRecords(c.cloudConfigured, c.signedIn) !== c.expected).map(
    (c) => c.why,
  );
}
