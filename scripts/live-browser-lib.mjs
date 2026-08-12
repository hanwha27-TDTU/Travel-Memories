// live-browser-lib.mjs — 라이브 게이트가 브라우저를 띄우는 **한 곳**.
//
// 🔴 왜 함수로 뽑았나(§7 2층 — 구조적 강제): 라이브 게이트 셋이 각자 `chromium.launch()`를
// 손으로 부르고 있었고, 그래서 **같은 규율이 세 벌**이었다. 두 벌이 갈라지는 것은 시간 문제이고
// 실제로 갈라졌다 — `verify-authgate-live`는 브라우저 부재를 SKIP으로 접는 형제의 규율을
// 물려받지 못해 죽었고, 하네스는 그 죽음을 **「위반을 찾았다」로 적었다**(M-0145).
//
// 여기 모은 두 규율은 **다음 라이브 게이트가 자동으로 따라온다**:
//
//  ① **없는 세계는 판정하지 말고 말한다**(§18-G). 브라우저 실물이 없으면 `exit 2`(SKIP)로
//     나간다. 예외를 그대로 뱉으면 종료코드가 1이 되고 그건 이 저장소 계약에서 「위반」이다.
//     `playwright` 패키지가 import된다는 사실은 **브라우저가 설치돼 있다는 뜻이 아니다** —
//     CI는 Chromium을 `live-render` job에만 설치한다.
//
//  ② 🔴 **로케일을 가정하지 않는다**(2026-08-12 · M-0146). Chromium은 다운로드 파일명을
//     **프로세스 로케일**로 다듬는데, 로케일이 `POSIX`이면 **비ASCII 이름을 통째로 버리고
//     `download`로 바꾼다.** 이 앱의 사진·영상 저장 파일명에는 여행 제목(한국어)이 들어가므로,
//     그 검사가 **앱과 무관하게** 환경에 따라 빨간불이 됐다. 실측:
//
//       LANG 없음(POSIX) → "download"
//       LANG=C.UTF-8     → "20260801_0000_여행__abcd1234.webm"
//
//     게이트는 **자기가 재는 것을 환경에 맡기지 않는다.** 그래서 로케일을 직접 준다 —
//     그래야 개발 컨테이너와 CI가 **같은 것을 잰다**.

/**
 * 라이브 게이트용 Chromium을 띄운다.
 *
 * @param chromium playwright의 chromium (호출부가 이미 import한 것을 넘긴다)
 * @param opts.gate 게이트 이름 — 실패 문장에 그대로 나간다
 * @param opts.cleanup 실패 시 정리(서버 close·임시 산출물 삭제). 게이트마다 다르므로 받는다
 * @param opts.launchOptions 추가 launch 옵션(있으면 병합)
 */
export async function launchLiveBrowser(chromium, { gate, cleanup, launchOptions = {} }) {
  try {
    return await chromium.launch({
      ...launchOptions,
      env: {
        ...process.env,
        // 파일명·정렬·숫자 표기가 로케일에 좌우되지 않게 고정한다. 값을 바꾸려면
        // 위 ② 실측을 다시 하고 바꾼다 — 이건 취향이 아니라 측정에서 나온 값이다.
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        ...(launchOptions.env ?? {}),
      },
    });
  } catch (e) {
    console.error(
      `${gate}: 브라우저를 띄우지 못했습니다 — ${String(e).split('\n')[0]}\n` +
        '  → 이 실행은 라이브 층을 재지 않았습니다(통과가 아닙니다). `npx playwright install chromium` 후 재실행.',
    );
    try { await cleanup?.(); } catch { /* 정리 실패가 원래 사유를 덮지 않게 한다. */ }
    process.exit(2);
  }
}
