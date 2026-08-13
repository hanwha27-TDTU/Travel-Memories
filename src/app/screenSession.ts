// app/screenSession.ts — **한 번에 한 화면만 살아 있게** 하는 한 곳.
//
// 🔴 왜 별도 모듈인가(2026-08-13 · 외부 리뷰 지적 #2·#3): 이 규율이 `main.ts` 안에 있으면
//    **검사할 수 없다.** `main.ts`는 진입점이라 유닛이 부를 수 없고, 실제로 기존 라우터 유닛은
//    **경로 파싱만** 보고 있었다 — 리뷰어가 정확히 그 점을 지적했다.
//    §10 ③이 그 처방을 이미 적어 뒀다: *"사용자에게 가는 로직은 순수 함수로 뽑아라.
//    그래야 검사할 수 있다."*
//
// 무엇을 푸는가 — 두 결함이 한 원인에서 나왔다. 라우터가 「지금 어느 화면인가」를 아무 데도
// 안 적고 있었다.
//
//  ① **늦게 온 Promise가 새 화면을 덮는다.** 여행 상세는 인증 확인을 기다린 뒤 그리는데,
//     그 사이 사용자가 뒤로 가면 먼저 시작한 확인이 나중에 끝나 **옛 화면을 다시 그린다.**
//     🔴 홈 화면은 이 함정을 이미 알고 세대 카운터를 쓰고 있었다(`refreshGeneration`) —
//     라우터만 그 형제 규율을 안 물려받았다(§7 비대칭).
//
//  ② **떠난 화면의 구독이 살아남는다.** 홈의 인증·동기화 구독은 홈을 **다시 그릴 때만**
//     해지됐다. 홈 → 상세로 가면 그대로 남아 떼어낸 DOM을 참조했다.
//
// 처방은 하나다: 세대를 세고, 새 화면을 그리기 전에 이전 화면을 정리한다.

/** 화면이 라우터에게 돌려주는 정리 함수. 반환형이 계약이라 새 화면도 내놓을 수밖에 없다(§7 2층). */
export type ScreenDispose = () => void;

export interface ScreenHandle {
  /** 이 세대가 아직 현재인가 — 늦게 끝난 비동기가 그리기 전에 반드시 묻는다. */
  isCurrent: () => boolean;
  /** 화면의 정리 함수를 라우터에 맡긴다. 늦게 온 것은 **맡기지 않고 즉시 정리**한다. */
  mount: (dispose: ScreenDispose) => void;
}

export interface ScreenSession {
  /** 새 화면을 시작한다 — 이전 화면을 정리하고 새 세대를 연다. */
  begin: () => ScreenHandle;
  /** 지금 살아 있는 화면을 정리한다(앱 종료·테스트 정리용). */
  disposeCurrent: () => void;
  /** 지금까지 연 화면 수 — 검사가 세대 진행을 확인할 때 쓴다. */
  generation: () => number;
}

/**
 * 화면 세션을 만든다. **상태를 모듈 전역이 아니라 클로저에 둔다** — 그래야 유닛이 서로
 * 간섭하지 않고 여러 개를 나란히 세워 볼 수 있다.
 */
export function createScreenSession(): ScreenSession {
  let generation = 0;
  let disposeCurrent: ScreenDispose = () => undefined;

  return {
    generation: () => generation,
    disposeCurrent: () => {
      disposeCurrent();
      disposeCurrent = () => undefined;
    },
    begin: () => {
      const mine = ++generation;
      disposeCurrent();
      disposeCurrent = () => undefined;
      return {
        isCurrent: () => mine === generation,
        mount: (dispose) => {
          // 🔴 늦게 도착한 화면이 **현재 화면의 정리 함수를 덮어쓰지 않게** 한다.
          //    덮어쓰면 진짜 현재 화면이 영영 정리되지 않는다 — 고치려던 누수를 다시 만드는 셈이다.
          if (mine === generation) disposeCurrent = dispose;
          else dispose();
        },
      };
    },
  };
}
