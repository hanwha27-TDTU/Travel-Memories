// domain/persistAdvice.ts — 「저장소 보호」가 **거절됐을 때 무엇을 말할 것인가**(T-005).
//
// 왜 순수 함수인가: 이 자리는 자료구조가 옳아도 **문장만 틀릴 수 있는** 부류다(§10 ③).
// 그리고 이 저장소에서 그 부류가 가장 자주 샌다 — M-0021·M-0022·M-0046·M-0048이 전부
// 「계산은 맞고 사용자에게 나가는 말이 틀린」 결함이었다. DOM 클로저 안에 있으면 갈래를
// 검사할 수 없으므로 판정과 문장을 여기로 뽑는다.
//
// 🔴 이 파일이 고치는 것은 **M-0048과 같은 형태**다: 앱이 아는 것을 판정에 안 쓰고 있었다.
// 거절 안내가 언제나 *"메뉴(⋮) → 홈 화면에 추가"* 하나였는데,
//   · **APK 셸**에서 그 메뉴는 **없다** — 이미 설치된 앱에게 설치하라고 말하고 있었다.
//   · **이미 설치한 PWA**에게도 같은 말을 해서, 그 사용자는 **막다른 곳**에 남았다(§7-D).
// 설치 상태는 앱이 `display-mode`와 셸 감지로 **이미 알 수 있는 값**이다.
//
// 🔴 원인을 단정하지 않는다(§8 · M-0056). 크롬이 왜 거절했는지는 **관측할 수 없다** —
// 공개된 판단 신호(설치·북마크·사용 빈도·알림 권한)를 *가능성으로* 말하고, 어떤 경우에도
// 참인 행동(백업)을 마지막에 둔다. 「~때문입니다」는 이 파일에서 금지이고 유닛이 잡는다.

/** 앱이 지금 어느 문으로 실행 중인가 — 「설치됨」의 세 갈래는 사용자가 할 일이 서로 다르다. */
export type PersistSurface =
  /** 안드로이드 APK(Capacitor 셸) — 이미 설치된 앱이다. 브라우저 메뉴가 없다. */
  | 'shell'
  /** 홈 화면에 추가된 PWA(standalone) — 설치는 했는데 크롬이 아직 안 준 상태. */
  | 'installed-pwa'
  /** 그냥 브라우저 탭 — 설치가 아직 남은 카드다. */
  | 'browser-tab';

export interface PersistContext {
  surface: PersistSurface;
  /** `navigator.storage.persist`가 이 브라우저에 있는가. */
  canPersist: boolean;
}

/** 「저장소 보호」 요청 결과를 사용자 문장 하나로. `granted`면 표면과 무관하게 같은 말이다. */
export function persistResultNote(ctx: PersistContext, granted: boolean): string {
  if (granted) return '보호가 적용됐어요. 브라우저가 임의로 지우지 않습니다.';
  return `${refusalReason(ctx)} ${BACKUP_FALLBACK}`;
}

/** 어떤 표면에서도 참인 마지막 행동 — 거절 문장이 막다른 곳에서 끝나지 않게 한다(§7-D). */
const BACKUP_FALLBACK = '그래도 안 되면 괜찮습니다: 가장 확실한 보호는 [데이터 관리 › 백업]으로 파일을 받아두는 것입니다.';

/**
 * 표면별 다음 행동. **원인이 아니라 해 볼 것**을 말한다.
 *
 * 크롬이 공개한 판단 신호가 여럿이므로 여럿을 말하고 **더 흔한 것을 먼저** 둔다(§8 · M-0056).
 */
function refusalReason(ctx: PersistContext): string {
  if (!ctx.canPersist) {
    return '이 브라우저에는 저장소 보호를 요청하는 기능이 없어요.';
  }
  switch (ctx.surface) {
    case 'shell':
      // 🔴 APK에게 「홈 화면에 추가」를 말하면 사용자는 없는 메뉴를 찾아 헤맨다.
      // 이 표면에서 우리가 **관측한 사실**은 「설치된 앱으로 실행 중」뿐이므로 거기까지만 적는다.
      return '이 기기에서는 앱으로 설치해 쓰고 있어요 — 이 요청은 브라우저가 판단하는 것이라 거절될 수 있습니다.';
    case 'installed-pwa':
      // 이미 설치했는데도 거절 — 옛 문장은 여기서 「설치하세요」로 끝나 막다른 곳이었다.
      return '이미 앱으로 설치돼 있는데도 브라우저가 아직 허락하지 않았어요. 크롬은 이 사이트를 자주 쓰는지도 함께 보므로, 며칠 쓰다 다시 눌러 보면 허락될 수 있어요(북마크에 추가해 두는 것도 신호가 됩니다).';
    case 'browser-tab':
      return '브라우저가 아직 허락하지 않았어요. 크롬은 "이 사이트를 중요하게 쓴다"고 판단해야 허락합니다 — 메뉴(⋮) → 홈 화면에 추가로 앱처럼 설치한 뒤 다시 눌러 보세요.';
  }
}

/**
 * 진단 지표로 보여줄 「지금 어디서 실행 중인가」.
 *
 * 왜 지표인가: 사용자가 *"설치는 했는데 왜 안 되지"*를 물을 때, 앱이 **자기가 무엇으로 보이는지**를
 * 말해 주지 않으면 그 질문에 답할 방법이 없다(§12 — 앱이 아는 것을 말하지 않으면 사람이 나른다).
 */
export function surfaceLabel(surface: PersistSurface): string {
  switch (surface) {
    case 'shell':
      return '설치된 앱(APK)';
    case 'installed-pwa':
      return '홈 화면에 추가된 앱';
    case 'browser-tab':
      return '브라우저 탭';
  }
}

/**
 * 이 표면에서 「저장소 보호」가 **의미 있는 질문인가**.
 *
 * 🔴 안드로이드 셸에서는 앱 자료가 브라우저의 공간 회수 대상이 아니라고 알려져 있지만,
 * 이 앱은 그것을 **재본 적이 없다.** 그래서 「안전하다」고 말하지 않고 판정을 `unknown`으로
 * 두되(§8 — 모르는 것을 정상으로 반올림하지 않는다), 사용자에게는 표면 이름과 백업 경로를
 * 준다. 재는 방법이 생기면 이 함수부터 고친다.
 */
export function persistIsMeaningful(surface: PersistSurface): boolean {
  return surface !== 'shell';
}

/**
 * 🔴 **앱이 스스로 한 번 요청할 것인가**(§12 — 사람에게 대신 시키던 일을 앱이 한다).
 *
 * 지금까지는 사용자가 **진단 화면을 찾아 들어가 버튼을 눌러야만** 요청이 갔다. 그런데
 * 크롬은 이 요청에 **프롬프트를 띄우지 않는다** — 설치·사용 빈도 같은 신호로 조용히 판단한다.
 * 즉 설치된 표면에서는 *물어볼 것이 없고*, 사용자를 화면으로 보낼 이유도 없다.
 *
 * 그런데 **모든 표면에서 자동으로 하지는 않는다**:
 *   · `browser-tab` — 아직 설치 전이라 거절이 거의 확실하고, **파이어폭스는 여기서 권한
 *     대화상자를 띄운다.** 앱을 처음 연 사람에게 맥락 없는 팝업을 던지는 것은
 *     「기억 앱」이 할 일이 아니다. 그 표면에서는 지금처럼 **사용자가 누를 때만** 간다.
 *   · 설치된 표면(`shell`·`installed-pwa`) — 이미 「이 앱을 쓰겠다」는 의사가 표현된 자리다.
 *
 * 그리고 **한 번만** 시도한다. 거절이 반복되는 브라우저(파이어폭스 계열)에서 매 실행마다
 * 대화상자를 띄우면 그건 앱이 사용자를 괴롭히는 것이다 — 이후는 진단 화면의 버튼이 맡는다.
 */
export function shouldAutoRequestPersist(
  ctx: PersistContext & { persisted: boolean | null; alreadyTried: boolean },
): boolean {
  if (!ctx.canPersist) return false;
  if (ctx.persisted === true) return false; // 이미 보호됨 — 물을 것이 없다
  if (ctx.alreadyTried) return false; // 조용한 한 번으로 끝낸다
  return ctx.surface !== 'browser-tab';
}

/**
 * 🔴 「저장소 안전」의 **판정 한 문장**. `unknown`일 때 **왜 모르는지**가 문장에 담겨야 한다(§7-E).
 *
 * 왜 이 함수가 생겼나(M-0113 · 사용자 태블릿 캡처): 예전 판은 `unknown`이면 무조건
 * **「이 브라우저는 저장 용량을 알려주지 않아요」**라고 말했다. 그런데 v1.84에서 셸의 persist를
 * `unknown`으로 두자 **용량을 아는 기기에서도** 그 문장이 나갔다 — 바로 아래 줄이
 * 「사용 0%」라고 적혀 있는데 위에서는 용량을 모른다고 했다. **한 화면이 자기와 모순됐다.**
 *
 * 근본형: `unknown`의 **이유가 여럿인데 문장은 하나**였다. 판정 등급은 이유를 안 들고 다닌다 —
 * 그러니 문장을 등급이 아니라 **이유**에서 만든다.
 */
export interface StorageHeadlineInput {
  level: 'ok' | 'todo' | 'problem' | 'unknown';
  surface: PersistSurface;
  /** 용량을 읽을 수 있었는가(usage·quota 둘 다). */
  quotaKnown: boolean;
}

export function storageHeadline(i: StorageHeadlineInput): string {
  if (i.level === 'problem') return '저장 공간이 부족해요 — 지금 백업을 받으세요';
  if (i.level === 'todo') return '저장소 보호를 켜면 더 안전해요';
  if (i.level === 'ok') return '브라우저가 이 기기의 기록을 임의로 지우지 않습니다';
  // ── unknown: 이유를 순서대로 가른다. **더 구체적인 이유가 이긴다.** ──
  if (!i.quotaKnown) return '이 브라우저는 저장 용량을 알려주지 않아요';
  if (!persistIsMeaningful(i.surface)) return '설치된 앱이라 브라우저 보호 여부를 아직 재보지 못했어요';
  return '지금은 저장소 상태를 판정할 수 없어요';
}

/**
 * 🔴 **「왜 아직 미적용인가」에 답하는 한 줄** (T-005 · 사용자 태블릿 2026-08-06).
 *
 * 화면이 「미적용 · 확인 불가」라고만 말하면 사용자는 *"앱이 물어보긴 한 건가?"*에서 멈춘다.
 * 그 상태로는 이 과제가 **영원히 열려 있다.** 앱은 물어본 사실을 알고 있으므로 말해야 한다(§12).
 *
 * 🔴 **거절을 「영영 안 된다」로 읽지 않는다**(§8). 크롬은 사용 빈도도 함께 보므로 나중에
 * 허락할 수 있다 — 그래서 문장은 *그때 그랬다*로 적고, 다시 눌러 볼 길을 닫지 않는다.
 */
export function persistAskNote(ask: { granted: boolean; auto: boolean; when: string } | null, surface: PersistSurface): string {
  if (!ask) {
    return surface === 'browser-tab'
      ? '아직 요청하지 않았어요 — [저장소 보호 요청]을 누르면 브라우저에 물어봅니다.'
      : '아직 요청 기록이 없어요 — [저장소 보호 요청]을 누르면 물어봅니다.';
  }
  if (ask.granted) return `${ask.when}에 요청해 허락받았어요.`;
  const who = ask.auto ? '앱이 시작할 때 한 번 요청했지만' : '요청했지만';
  return `${ask.when}에 ${who} 브라우저가 허락하지 않았어요. 나중에 다시 눌러 보면 허락될 수도 있어요.`;
}
