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

// ── 판정 기록기와 그 대조군 (2026-08-13 · M-0155) ─────────────────────────────
//
// 🔴 왜 여기 있나: 라이브 게이트 셋은 **대조군이 아예 없었다.** 그런데 모집단을 세는
//    정규식이 `{ slow: true, name: … }` 모양을 놓쳐 **세어지지도 않아서**, 판정문은
//    그 사실을 모른 채 「전부 갖췄다」고 말했다(v2.27로 배포됨).
//
// 🔴 무엇을 대조군으로 삼아야 하는가: 라이브 게이트에서 **가장 조용한 고장은 기록기가
//    실패를 안 세는 것**이다. 그러면 무슨 일이 있어도 초록이 나온다 — 실제로 이 저장소의
//    `verify-diagnostics-live` 첫 판이 **허브를 못 열었는데 PASS를 찍었다.**
//    그러므로 대조군은 「기록기가 실패를 실제로 센다」를 증명해야 한다.
//
// 🔴 왜 게이트마다 손으로 쓰지 않나: 같은 판정을 세 번 쓰면 갈라진다(M-0060).
//    구현은 여기 하나뿐이고, 대조군도 **그 진짜 구현을 돌려서** 증명한다 —
//    복사본을 시험하면 진짜가 깨져도 초록이다.

/**
 * 라이브 게이트의 판정 기록기를 만든다.
 *
 * @param {(line: string) => void} [sink] 출력 함수(기본 `console.log`)
 * @returns 라벨·통과여부·상세를 받는 `check` 함수. `check.stats()`로 집계를 읽는다.
 */
export function makeCheck(sink = console.log) {
  let failed = 0;
  let checked = 0;
  const check = (label, ok, detail = '') => {
    checked++;
    if (!ok) failed++;
    sink(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  };
  check.stats = () => ({ failed, checked });
  return check;
}

/**
 * 위 기록기가 **실제로 실패를 세는지** 증명한다 — 라이브 게이트의 대조군(§4).
 *
 * 실패하면 던진다. 호출부는 `runSelfTest`로 감싸서 사유를 적고 `exit 2`로 나간다(§18-G).
 */
export function proveCheckCounts() {
  const lines = [];
  const check = makeCheck((l) => lines.push(l));
  check('통과 사례', true);
  check('실패 사례', false, '상세');
  const { failed, checked } = check.stats();
  if (checked !== 2) throw new Error(`SELF-TEST 실패: 판정 횟수를 못 셈(${checked} ≠ 2).`);
  if (failed !== 1) throw new Error(`SELF-TEST 실패: **실패를 못 셈**(${failed} ≠ 1) — 이 게이트는 무슨 일이 있어도 초록을 낸다.`);
  if (!lines[0].startsWith('  ✓')) throw new Error('SELF-TEST 실패: 통과를 통과로 안 적는다.');
  if (!lines[1].startsWith('  ✗')) throw new Error('SELF-TEST 실패: 실패를 실패로 안 적는다(화면이 거짓말한다).');
  if (!lines[1].includes('상세')) throw new Error('SELF-TEST 실패: 실패 사유를 안 적는다 — 왜 빨간불인지 알 수 없다.');
}

// ── 컨테이너 수준 가로 넘침 (2026-08-13 · 외부 프롬프트 모음에서 흡수) ────────────
//
// 🔴 왜 문서 지표로는 안 되나: 조상 중에 `overflow-x: auto|scroll`이 있으면 **그 조상이
//    넘침을 삼킨다.** 그러면 `documentElement.scrollWidth - clientWidth`는 **영원히 0**이고,
//    그 0은 「안 넘친다」가 아니라 **「내 지표가 그 축을 안 본다」**이다.
//    이 저장소는 넘침을 거의 전부 문서 지표로 재고 있었다(10곳 실측).
//
// 🔴 왜 이 앱에 걸리나: 부모에 `flex-wrap`이 있어도 **자식 묶음에 없으면 그 자식은 통째로
//    안 접힌다.** 실측: `display:flex` 181곳 중 `flex-wrap`은 47곳. 그리고 홈 칩 줄은
//    이미 6개이고 인계서가 *"7번째를 더하지 않았다 — 이 저장소는 그 자리에서 이미 데였다"*
//    고 적고 있다. **컨트롤을 하나 더할 때가 임계다.**
//
// 🔴 지금은 위반이 0이다(320·375 실측). 그러므로 이것은 **결함 발견기가 아니라 회귀
//    차단기**다 — 그 사실을 호출부가 판정문에 적어야 한다(§8: 안 나온 것과 없는 것은 다르다).

/** 의도된 가로 스크롤은 이 표식으로 뺀다 — 표식 없는 넘침은 전부 위반이다. */
export const XSCROLL_OPT_OUT = 'data-allow-xscroll';

/**
 * 열려 있는 화면의 **모든 요소**를 훑어 가로로 넘치는 컨테이너를 찾는다.
 *
 * 손으로 고른 선택자 목록을 쓰지 않는다 — 그런 목록은 **자라지 않아서**, 새 화면이 생기면
 * 조용히 범위 밖이 된다(이 저장소가 반복해서 당한 형태).
 *
 * @param page playwright 페이지
 * @param tolerance 반올림 여유(기본 2px)
 * @returns `{ sel, over, overflowX }[]` — 빈 배열이면 위반 없음
 */
export function scanOverflowContainers(page, tolerance = 2) {
  return page.evaluate(
    ([optOut, tol]) => {
      const out = [];
      for (const el of document.querySelectorAll('*')) {
        if (el.closest(`[${optOut}]`)) continue; // 의도된 가로 스크롤
        if (el.clientWidth === 0) continue; // 안 보이는 것은 재지 않는다(0은 통과가 아니다)
        const over = el.scrollWidth - el.clientWidth;
        if (over <= tol) continue;
        const name =
          el.tagName.toLowerCase() +
          (typeof el.className === 'string' && el.className.trim()
            ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.')
            : '');
        out.push({ sel: name, over, overflowX: getComputedStyle(el).overflowX });
      }
      return out;
    },
    [XSCROLL_OPT_OUT, tolerance],
  );
}

/**
 * 대조군(§4) — 스캐너가 **실제로 넘침을 잡는지** 진짜 DOM에 심어서 증명한다.
 *
 * 🔴 순수 함수를 시험하는 것으로는 부족하다. 이 검사의 위험은 판정식이 아니라
 *    **측정이 실제 화면에서 도는가**이고, 그건 심어 봐야만 안다.
 *    심은 것은 반드시 되돌린다 — 대조군이 본 검사를 오염시키면 안 된다.
 */
export async function proveOverflowScanner(page) {
  const before = await scanOverflowContainers(page);
  await page.evaluate(() => {
    const box = document.createElement('div');
    box.id = '__overflow_probe__';
    box.style.cssText = 'width:50px;overflow:hidden;';
    const wide = document.createElement('div');
    wide.style.cssText = 'width:9999px;height:1px;';
    box.appendChild(wide);
    document.body.appendChild(box);
  });
  const during = await scanOverflowContainers(page);
  await page.evaluate(() => document.getElementById('__overflow_probe__')?.remove());
  const after = await scanOverflowContainers(page);

  if (during.length <= before.length) {
    throw new Error('SELF-TEST 실패: 넘치는 상자를 심었는데 스캐너가 못 잡았다 — 이 축은 공허하다.');
  }
  if (after.length !== before.length) {
    throw new Error('SELF-TEST 실패: 대조군이 심은 것을 못 치웠다 — 본 검사가 오염된다.');
  }
}
