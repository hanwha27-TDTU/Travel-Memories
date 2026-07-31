// services/here.ts — 브라우저에게 **지금 어디인지** 묻는 얇은 문 하나.
//
// 판정·문장은 전부 `domain/place/here.ts`(순수)에 있다. 여기 있는 것은 **브라우저 API를
// 약속(Promise)으로 바꾸는 일**뿐이다 — 그래야 판정이 유닛으로 잠기고(§10 ③), 화면은
// 콜백 지옥 없이 `await` 한 줄로 쓴다.
//
// 🔴 **던지지 않는다.** 위치는 *거들어 주는* 기능이라, 실패가 순간 저장을 막으면 안 된다.
// 실패는 값으로 돌려주고(`fail`), 화면이 그 사유에 맞는 문장을 고른다.

import type { HereFail } from '../domain/place/here';

export interface HereReading {
  coord: { lat: number; lng: number } | null;
  /** GPS 정확도(반지름 m). 모르면 null — 0으로 반올림하지 않는다(§8). */
  accuracyM: number | null;
  fail: HereFail | null;
}

const FAIL_BY_CODE: Record<number, HereFail> = {
  1: 'denied', // PERMISSION_DENIED
  2: 'unavailable', // POSITION_UNAVAILABLE
  3: 'timeout', // TIMEOUT
};

/**
 * 지금 위치를 한 번 읽는다.
 *
 * @param timeoutMs 기다릴 시간. 기본 12초 — 실외 GPS 최초 고정(cold fix)은 10초를 넘기는
 *   일이 흔하다. 너무 짧게 잡으면 **되는 상황을 안 된다고 말하게 된다.**
 *
 * `enableHighAccuracy: true`인 이유: 이 값은 **기억이 찍힐 자리**다. wifi 측위의 2km와
 * GPS의 10m는 사용자에게 전혀 다른 이야기이고, 어느 쪽인지는 `accuracyM`이 말해 준다.
 * `maximumAge: 60_000` — 1분 안에 읽은 값이 있으면 재사용한다(버튼 연타에 GPS를 다시
 * 깨우지 않는다). 1분은 걸어서 100m가 안 되는 시간이라 「지금 여기」의 뜻을 해치지 않는다.
 */
export function readHere(timeoutMs = 12_000): Promise<HereReading> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return Promise.resolve({ coord: null, accuracyM: null, fail: 'unsupported' });
  }
  return new Promise<HereReading>((resolve) => {
    let done = false;
    const finish = (r: HereReading): void => {
      if (done) return;
      done = true;
      resolve(r);
    };
    // 🔴 브라우저가 콜백을 영영 안 부르는 경우가 실제로 있다(권한 대화상자를 띄운 채 방치).
    // 그러면 버튼이 「위치 찾는 중…」에 **잠긴 채 남는다**(§13 4항 ④가 금지하는 상태).
    const guard = setTimeout(() => finish({ coord: null, accuracyM: null, fail: 'timeout' }), timeoutMs + 1_000);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(guard);
        const { latitude, longitude, accuracy } = pos.coords;
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          finish({ coord: null, accuracyM: null, fail: 'unavailable' });
          return;
        }
        finish({
          coord: { lat: latitude, lng: longitude },
          accuracyM: Number.isFinite(accuracy) ? accuracy : null,
          fail: null,
        });
      },
      (err) => {
        clearTimeout(guard);
        finish({ coord: null, accuracyM: null, fail: FAIL_BY_CODE[err.code] ?? 'unavailable' });
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 },
    );
  });
}
