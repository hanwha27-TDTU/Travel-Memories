// app/deviceId.ts — 이 기기를 알아보는 **안정적인 이름표**.
//
// 왜(사용자 제안 2026-07-26): 진단 도구에 "저장 상태 확인 및 기기별 현황"을 넣으려면
// "어느 기기가 언제 올렸나"를 알아야 한다. 서버 4개 테이블에 `updated_by_device` 컬럼이
// 처음부터 있었지만 **클라이언트가 한 번도 쓰지 않아 늘 비어 있었다.**
//
// 왜 이게 진단에 중요한가: 2기기 문제("태블릿에서 지웠는데 휴대폰에 남아 있다")를 지금은
// 추측으로 좇는다. 각 기기가 마지막으로 올린 시각이 보이면 **어느 쪽이 뒤처졌는지가 즉시 보인다.**
//
// 개인정보(PRIVACY): 여기서 만드는 것은 **임의의 난수 id와 기기 종류 문자열**뿐이다.
//  · 담는다: 무작위 UUID · '휴대폰/태블릿/PC' · OS 계열 · 브라우저 계열
//  · 담지 않는다: 기기 일련번호·광고 id·정밀 UA 문자열·위치
// 이 값은 사용자 **자기 계정의 행에만** 저장되고 RLS로 자기만 읽는다. 추적 용도가 아니라
// "내 기기 중 어느 것이 뒤처졌나"를 사용자 자신에게 보여주기 위한 것이다.

const KEY = 'bj.deviceId';

/** 이 기기의 안정적 id. localStorage가 막히면 세션 동안만 유지되는 임시 id를 쓴다. */
let memoryFallback: string | null = null;

export function deviceId(): string {
  try {
    const cur = localStorage.getItem(KEY);
    if (cur) return cur;
    const next = crypto.randomUUID();
    localStorage.setItem(KEY, next);
    return next;
  } catch {
    // 프라이빗 모드 등 — 기억 손실이 아니므로 조용히 임시 id로 간다.
    // (이 기기가 매 세션 새 기기로 보이는 것은 정직하게 진단 화면에 적는다.)
    memoryFallback ??= crypto.randomUUID();
    return memoryFallback;
  }
}

/** 화면·목록에 쓰는 짧은 id — 전체를 보여줄 이유가 없다. */
export function shortDeviceId(id: string = deviceId()): string {
  return id.slice(0, 8);
}

/**
 * 사람이 알아보는 기기 이름 — "휴대폰 · Android · Chrome".
 *
 * UA 문자열 전체가 아니라 **분류만** 뽑는다(개인정보 최소화). 판별이 안 되면 '알 수 없음'으로
 * 남긴다 — 추측해서 틀린 이름을 붙이면 사용자가 자기 기기를 못 알아본다.
 */
export function deviceLabel(ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  const kind = /iPad|Tablet/i.test(ua) ? '태블릿' : /Mobi|Android|iPhone/i.test(ua) ? '휴대폰' : 'PC';
  const os = /Android/i.test(ua)
    ? 'Android'
    : /iPhone|iPad|iOS/i.test(ua)
      ? 'iOS'
      : /Mac OS X/i.test(ua)
        ? 'macOS'
        : /Windows/i.test(ua)
          ? 'Windows'
          : /Linux/i.test(ua)
            ? 'Linux'
            : '알 수 없음';
  // 순서가 중요하다 — Edge/Samsung/Opera는 UA에 'Chrome'을 포함한다.
  const browser = /Edg\//i.test(ua)
    ? 'Edge'
    : /SamsungBrowser/i.test(ua)
      ? 'Samsung'
      : /OPR\//i.test(ua)
        ? 'Opera'
        : /Firefox/i.test(ua)
          ? 'Firefox'
          : /Chrome/i.test(ua)
            ? 'Chrome'
            : /Safari/i.test(ua)
              ? 'Safari'
              : '알 수 없음';
  return `${kind} · ${os} · ${browser}`;
}

/** 서버 행에 넣는 값 — `라벨#짧은id`. 한 칸에 담아 컬럼을 늘리지 않는다. */
export function deviceStamp(): string {
  return `${deviceLabel()}#${shortDeviceId()}`;
}

/** 서버에서 읽은 값을 사람이 읽는 형태로 되돌린다. 형식이 달라도 깨지지 않는다. */
export function parseDeviceStamp(stamp: string): { label: string; id: string } {
  const i = stamp.lastIndexOf('#');
  if (i < 0) return { label: stamp, id: '' };
  return { label: stamp.slice(0, i), id: stamp.slice(i + 1) };
}
