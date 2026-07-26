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
//  · 담는다: 무작위 UUID · '휴대폰/태블릿/PC' · OS 계열 · 브라우저 계열 · (사용자가 지은 이름)
//  · 담지 않는다: 기기 일련번호·광고 id·정밀 UA 문자열·위치
// 이 값은 사용자 **자기 계정의 행에만** 저장되고 RLS로 자기만 읽는다. 추적 용도가 아니라
// "내 기기 중 어느 것이 뒤처졌나"를 사용자 자신에게 보여주기 위한 것이다.
//
// ─────────────────────────────────────────────────────────────────────────────
// 2026-07-26 · 사용자 실기기: **태블릿인데 「PC · Linux · Chrome」으로 찍혔다**
// ─────────────────────────────────────────────────────────────────────────────
// 서버 행에 그대로 남아 있던 값이다. 코드가 UA를 잘못 읽은 게 아니다 — 브라우저가 준 UA가
// 진짜로 `X11; Linux x86_64`였다. Chrome의 「데스크톱 사이트」를 켜면 **UA가 데스크톱으로
// 바뀌고**, UA-CH(`navigator.userAgentData`)까지 같이 바뀐다. 즉 UA만 보는 한 이 기기가
// 태블릿이라는 사실은 **원리적으로 알 수 없다.**
//
// 그래서 두 층으로 답한다:
//
//  ① **모순은 잡아낸다(추측은 안 한다).** `maxTouchPoints`와 `pointer: coarse`는 데스크톱
//     모드에서도 위조되지 않는다. UA는 데스크톱이라는데 손가락으로 만지는 기기라면, 우리가
//     아는 사실은 "PC가 아니다"까지다. **「터치 기기」라고 쓰고 거기서 멈춘다** — 태블릿인지
//     큰 휴대폰인지는 이 신호로 갈리지 않는다(데스크톱 모드에선 화면 크기도 부풀려진다).
//     정상으로도 문제로도 반올림하지 않는 것과 같은 규율이다(§8 · 비타협 원칙 #4).
//
//  ② **사용자가 이름을 짓는다.** 어떤 감지도 사용자보다 정확할 수 없다. 이름을 지으면
//     그 이름이 서버 행에 찍히고, 감지는 **기본값**으로만 남는다. 이게 근본 해결이다.
//
// 덤으로 진짜 결함도 하나 나왔다: 안드로이드 **태블릿**은 UA에서 `Mobi`를 빼고 보내는데
// 옛 코드는 `Android`만 보고 전부 「휴대폰」이라 했다. 그건 추측이 아니라 규약이라 고칠 수 있다.

const KEY = 'bj.deviceId';
const NAME_KEY = 'bj.deviceName';

/** 사용자가 지은 이름의 길이 상한 — 진단 표 한 줄을 넘기지 않을 만큼. */
export const DEVICE_NAME_MAX = 24;

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

// ────────────────────────────────────────────────────────────────────────────
// 감지 — 브라우저가 말해 준 것만 쓴다
// ────────────────────────────────────────────────────────────────────────────

/**
 * 판별에 쓰는 **실측 신호 묶음**. 순수 함수가 브라우저를 직접 만지지 않게 하려고 분리했다 —
 * 그래야 유닛이 「데스크톱 모드 태블릿」 같은 상황을 실제로 돌려볼 수 있다(§10 ③).
 */
export interface DeviceHints {
  ua: string;
  /** 동시에 인식하는 터치 접점 수. 데스크톱 모드에서도 **위조되지 않는다.** */
  maxTouchPoints: number;
  /** 주 입력이 손가락인가(`pointer: coarse`). 마우스 PC는 false. */
  coarsePointer: boolean;
}

/** 브라우저에서 신호를 읽는다. 없는 값은 보수적으로(터치 없음) 둔다. */
export function readDeviceHints(): DeviceHints {
  if (typeof navigator === 'undefined') return { ua: '', maxTouchPoints: 0, coarsePointer: false };
  let coarse = false;
  try {
    coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  } catch {
    coarse = false;
  }
  return { ua: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints ?? 0, coarsePointer: coarse };
}

/** UA가 스스로 밝힌 기기 종류. 못 밝히면 `null`(= 데스크톱 계열 UA). */
function kindFromUa(ua: string): string | null {
  if (/iPad|Tablet/i.test(ua)) return '태블릿';
  if (/iPhone/i.test(ua)) return '휴대폰';
  // 안드로이드 규약: **휴대폰만** `Mobi`를 넣는다. 태블릿은 뺀다.
  // 옛 코드는 이걸 안 보고 Android면 전부 휴대폰이라 했다(실제 결함, 추측이 아니라 규약이라 고칠 수 있다).
  if (/Android/i.test(ua)) return /Mobi/i.test(ua) ? '휴대폰' : '태블릿';
  if (/Mobi/i.test(ua)) return '휴대폰';
  return null;
}

function osFromUa(ua: string): string {
  if (/Android/i.test(ua)) return 'Android';
  if (/iPhone|iPad|iOS/i.test(ua)) return 'iOS';
  if (/Mac OS X/i.test(ua)) return 'macOS';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Linux/i.test(ua)) return 'Linux';
  return '알 수 없음';
}

function browserFromUa(ua: string): string {
  // 순서가 중요하다 — Edge/Samsung/Opera는 UA에 'Chrome'을 포함한다.
  if (/Edg\//i.test(ua)) return 'Edge';
  if (/SamsungBrowser/i.test(ua)) return 'Samsung';
  if (/OPR\//i.test(ua)) return 'Opera';
  if (/Firefox/i.test(ua)) return 'Firefox';
  if (/Chrome/i.test(ua)) return 'Chrome';
  if (/Safari/i.test(ua)) return 'Safari';
  return '알 수 없음';
}

/**
 * 감지된 기본 이름 — `"태블릿 · Android · Chrome"`. **순수 함수.**
 *
 * UA 문자열 전체가 아니라 **분류만** 뽑는다(개인정보 최소화). 판별이 안 되면 '알 수 없음'으로
 * 남긴다 — 추측해서 틀린 이름을 붙이면 사용자가 자기 기기를 못 알아본다.
 *
 * UA가 데스크톱이라는데 터치 신호가 모순되면 **「터치 기기」에서 멈춘다.** 그 이상은 이
 * 신호들로 알 수 없고, 알 수 없는 것을 지어내면 위 문장을 스스로 어기는 것이다.
 */
export function detectDeviceLabel(h: DeviceHints): string {
  const declared = kindFromUa(h.ua);
  // 데스크톱 모드에서도 위조되지 않는 두 신호가 **동시에** 터치를 가리킬 때만 모순으로 본다.
  // (터치 모니터를 단 PC는 coarsePointer가 false다 — 주 입력이 마우스이므로.)
  const touchy = h.maxTouchPoints >= 1 && h.coarsePointer;
  if (declared === null && touchy) {
    // OS도 못 믿는다 — 데스크톱 모드는 OS까지 바꿔 보낸다. 브라우저 종류만 남긴다.
    return `터치 기기 · ${browserFromUa(h.ua)}`;
  }
  return `${declared ?? 'PC'} · ${osFromUa(h.ua)} · ${browserFromUa(h.ua)}`;
}

// ────────────────────────────────────────────────────────────────────────────
// 사용자가 지은 이름 — 어떤 감지도 이것보다 정확할 수 없다
// ────────────────────────────────────────────────────────────────────────────

/**
 * 저장 가능한 형태로 다듬는다. `#`는 **반드시** 없앤다 — 스탬프의 구분자라 이름에 들어가면
 * `parseDeviceStamp`가 이름 뒷부분을 id로 읽는다(경계 문자를 데이터가 밟는 고전적 결함).
 */
export function normalizeDeviceName(raw: string): string {
  return raw.replace(/#/g, ' ').replace(/\s+/g, ' ').trim().slice(0, DEVICE_NAME_MAX);
}

/** 사용자가 지은 이름. 없으면 `null`(= 감지값을 쓴다). */
export function customDeviceName(): string | null {
  try {
    const v = localStorage.getItem(NAME_KEY);
    return v ? normalizeDeviceName(v) || null : null;
  } catch {
    return null;
  }
}

/**
 * 이름을 정한다. 빈 문자열이면 **지우고 자동 감지로 되돌린다**(되돌릴 길 없는 설정을 만들지 않는다).
 * 저장이 막힌 브라우저에서는 조용히 실패하지 않고 알린다 — 사용자는 이름이 바뀐 줄 알 테니까.
 */
export function setCustomDeviceName(raw: string): string | null {
  const name = normalizeDeviceName(raw);
  try {
    if (name) localStorage.setItem(NAME_KEY, name);
    else localStorage.removeItem(NAME_KEY);
  } catch {
    throw new Error('이 브라우저가 설정 저장을 막고 있어 이름을 기억할 수 없어요.');
  }
  return name || null;
}

/**
 * 사람이 알아보는 이 기기 이름. **사용자가 지은 이름이 있으면 그것이 이긴다.**
 *
 * 인자를 주면 그 신호로 감지만 한다(유닛·진단 미리보기용).
 */
export function deviceLabel(hints: DeviceHints = readDeviceHints()): string {
  return customDeviceName() ?? detectDeviceLabel(hints);
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
