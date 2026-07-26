// tests/unit/storeState.test.ts — 저장 상태 대조가 **정직한가**.
//
// 사용자 제안(2026-07-26): 진단에 "저장상태 확인 및 기기별 현황"을 추가.
// 2기기 문제를 추측으로 좇던 것을 대조로 바꾸는 도구다. 그래서 이 도구가 **틀리면 최악**이다 —
// 거짓 경보는 결함만큼 해롭고(M-0008), "맞다"고 잘못 말하면 사용자가 진짜 유실을 놓친다.
//
// 이 검사가 잠그는 것:
//  ① 기기 접기 — 같은 기기의 여러 행에서 **가장 최근 것**만 남는가, 이 기기가 맨 위인가
//  ② 라벨 파싱 — 형식이 달라도 깨지지 않는가(옛 행은 스탬프 형식이 없다)
//  ③ 기기 이름 판별 — Edge/Samsung이 Chrome으로 뭉개지지 않는가(UA에 'Chrome'을 포함한다)

import { describe, it, expect, beforeEach } from 'vitest';
import { foldDevices } from '../../src/services/storeState';
import {
  deviceLabel,
  detectDeviceLabel,
  parseDeviceStamp,
  shortDeviceId,
  deviceStamp,
  customDeviceName,
  setCustomDeviceName,
  normalizeDeviceName,
  DEVICE_NAME_MAX,
  type DeviceHints,
} from '../../src/app/deviceId';

describe('기기 접기 — 같은 기기는 한 줄, 최신 시각만', () => {
  const rows = [
    { stamp: '휴대폰 · Android · Chrome#aaaa1111', at: '2026-07-19T09:31:15.000Z' },
    { stamp: '휴대폰 · Android · Chrome#aaaa1111', at: '2026-07-20T10:00:00.000Z' },
    { stamp: 'PC · Windows · Chrome#bbbb2222', at: '2026-07-13T14:36:57.000Z' },
  ];

  it('같은 기기의 여러 행이 한 줄로 접히고 **가장 최근** 시각이 남는다', () => {
    const d = foldDevices(rows, 'zzzz9999');
    expect(d.length).toBe(2);
    expect(d.find((x) => x.id === 'aaaa1111')?.lastPushAt).toBe('2026-07-20T10:00:00.000Z');
  });

  it('이 기기가 항상 맨 위 — 사용자가 자기 자리를 먼저 찾게', () => {
    const d = foldDevices(rows, 'bbbb2222');
    expect(d[0]?.id).toBe('bbbb2222');
    expect(d[0]?.isThis).toBe(true);
  });

  it('이 기기가 없으면 최근에 올린 순서', () => {
    const d = foldDevices(rows, 'zzzz9999');
    expect(d.map((x) => x.id)).toEqual(['aaaa1111', 'bbbb2222']);
    expect(d.every((x) => !x.isThis)).toBe(true);
  });

  it('빈 목록은 빈 목록이다(없는 기기를 지어내지 않는다)', () => {
    expect(foldDevices([], 'x')).toEqual([]);
  });
});

describe('스탬프 파싱 — 옛 형식이어도 깨지지 않는다', () => {
  it('라벨#id 를 갈라 읽는다', () => {
    expect(parseDeviceStamp('PC · Linux · Chrome#6d535bbc')).toEqual({ label: 'PC · Linux · Chrome', id: '6d535bbc' });
  });

  it('# 가 없으면 전체를 라벨로 본다(id는 빈 문자열)', () => {
    expect(parseDeviceStamp('알 수 없는 기기')).toEqual({ label: '알 수 없는 기기', id: '' });
  });

  it('라벨에 # 가 있어도 **마지막** # 를 경계로 본다', () => {
    expect(parseDeviceStamp('PC#1 · Linux#abcd1234')).toEqual({ label: 'PC#1 · Linux', id: 'abcd1234' });
  });
});

describe('기기 이름 판별 — 뭉개지지 않는다', () => {
  const UA = {
    edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36 Edg/120',
    samsung: 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23 Chrome/115 Mobile Safari/537.36',
    chromeAndroid: 'Mozilla/5.0 (Linux; Android 13; SM-S911N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
    // 안드로이드 **태블릿**은 `Mobi`를 뺀다. 옛 코드는 이걸 안 보고 전부 휴대폰이라 했다.
    chromeAndroidTablet:
      'Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
    safariIpad: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',
    // 실제로 사용자 서버 행에 「PC · Linux · Chrome」을 찍은 그 UA — 태블릿 + 「데스크톱 사이트」.
    desktopMode: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
  };
  /** 마우스 PC. */
  const mouse = (ua: string): DeviceHints => ({ ua, maxTouchPoints: 0, coarsePointer: false });
  /** 손가락으로 만지는 기기. */
  const finger = (ua: string): DeviceHints => ({ ua, maxTouchPoints: 5, coarsePointer: true });

  it('Edge가 Chrome으로 뭉개지지 않는다(UA에 Chrome을 포함한다)', () => {
    expect(detectDeviceLabel(mouse(UA.edge))).toBe('PC · Windows · Edge');
  });

  it('삼성 브라우저도 마찬가지', () => {
    expect(detectDeviceLabel(finger(UA.samsung))).toBe('휴대폰 · Android · Samsung');
  });

  it('안드로이드 크롬 휴대폰', () => {
    expect(detectDeviceLabel(finger(UA.chromeAndroid))).toBe('휴대폰 · Android · Chrome');
  });

  it('안드로이드 **태블릿**은 태블릿이다 — Mobi가 없으면 휴대폰이 아니다(옛 결함)', () => {
    expect(detectDeviceLabel(finger(UA.chromeAndroidTablet))).toBe('태블릿 · Android · Chrome');
  });

  it('아이패드는 태블릿으로', () => {
    expect(detectDeviceLabel(finger(UA.safariIpad))).toBe('태블릿 · iOS · Safari');
  });

  it('리눅스 파이어폭스', () => {
    expect(detectDeviceLabel(mouse(UA.firefoxLinux))).toBe('PC · Linux · Firefox');
  });

  it('모르면 추측하지 않고 "알 수 없음"으로 둔다', () => {
    expect(detectDeviceLabel(mouse('완전히 낯선 문자열'))).toBe('PC · 알 수 없음 · 알 수 없음');
  });
});

describe('「데스크톱 사이트」 모순 — 아는 데까지만 말하고 멈춘다 (2026-07-26 사용자 실기기)', () => {
  // 태블릿에서 데스크톱 사이트를 켜면 UA가 `X11; Linux x86_64`가 되고 UA-CH까지 같이 바뀐다.
  // 그래서 서버 행에 「PC · Linux · Chrome」이 찍혔다. UA만으로는 **원리적으로** 알 수 없다.
  const DESKTOP_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

  it('데스크톱 UA인데 손가락으로 만진다 = PC라고 단정하지 않는다', () => {
    const label = detectDeviceLabel({ ua: DESKTOP_UA, maxTouchPoints: 5, coarsePointer: true });
    expect(label).toBe('터치 기기 · Chrome');
    expect(label).not.toContain('PC');
  });

  it('태블릿인지 큰 휴대폰인지까지는 **지어내지 않는다**(§8 모르는 것은 확인 불가)', () => {
    const label = detectDeviceLabel({ ua: DESKTOP_UA, maxTouchPoints: 10, coarsePointer: true });
    expect(label).not.toContain('태블릿');
    expect(label).not.toContain('휴대폰');
  });

  it('OS도 못 믿는다 — 데스크톱 모드는 OS까지 바꿔 보낸다', () => {
    expect(detectDeviceLabel({ ua: DESKTOP_UA, maxTouchPoints: 5, coarsePointer: true })).not.toContain('Linux');
  });

  it('터치 모니터를 단 PC는 여전히 PC다 — 주 입력이 마우스면(coarse 아님) 모순이 아니다', () => {
    expect(detectDeviceLabel({ ua: DESKTOP_UA, maxTouchPoints: 10, coarsePointer: false })).toBe('PC · Linux · Chrome');
  });

  it('터치 신호가 없으면 평범한 PC다', () => {
    expect(detectDeviceLabel({ ua: DESKTOP_UA, maxTouchPoints: 0, coarsePointer: false })).toBe('PC · Linux · Chrome');
  });
});

/**
 * 유닛은 node 환경이라 `localStorage`가 없다. jsdom을 통째로 끌어오는 대신 **필요한 네 메서드만**
 * 있는 최소 저장소를 놓는다 — 검사 대상은 브라우저가 아니라 우리 규칙(정규화·구분자·되돌리기)이다.
 */
function installLocalStorage(): void {
  const m = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}

describe('사용자가 지은 이름 — 어떤 감지도 이것보다 정확할 수 없다', () => {
  beforeEach(() => installLocalStorage());

  it('이름을 지으면 감지값 대신 그 이름이 스탬프에 찍힌다', () => {
    expect(setCustomDeviceName('갤럭시 탭')).toBe('갤럭시 탭');
    expect(deviceLabel()).toBe('갤럭시 탭');
    expect(parseDeviceStamp(deviceStamp()).label).toBe('갤럭시 탭');
  });

  it('빈 문자열이면 지우고 자동 감지로 돌아간다 — 되돌릴 길 없는 설정을 만들지 않는다', () => {
    setCustomDeviceName('갤럭시 탭');
    expect(setCustomDeviceName('   ')).toBeNull();
    expect(customDeviceName()).toBeNull();
  });

  it('`#`는 이름에서 없앤다 — 스탬프 구분자라 들어가면 id 파싱이 깨진다', () => {
    setCustomDeviceName('탭#1');
    expect(customDeviceName()).toBe('탭 1');
    const { label, id } = parseDeviceStamp(deviceStamp());
    expect(label).toBe('탭 1');
    expect(id).toBe(shortDeviceId());
  });

  it(`길이는 ${DEVICE_NAME_MAX}자로 자른다(진단 표 한 줄을 넘기지 않게)`, () => {
    const long = '가'.repeat(80);
    expect(setCustomDeviceName(long)?.length).toBe(DEVICE_NAME_MAX);
  });

  it('앞뒤 공백과 중복 공백을 정리한다', () => {
    expect(normalizeDeviceName('  거실   PC  ')).toBe('거실 PC');
  });
});

describe('바꾼 이름은 **지금 화면에서** 보인다 (옛 서버 행을 누가 데려오나 — §9 4단계)', () => {
  // 이름은 push할 때 서버 행에 찍힌 채로 남는다. 다음 저장 전까지 서버엔 옛 이름이 있다.
  // 화면이 서버 값을 그대로 그리면 방금 바꾼 이름이 안 보이고 사용자는 "안 됐네"라고 읽는다.
  const rows = [
    { stamp: 'PC · Linux · Chrome#aaaa1111', at: '2026-07-26T05:02:59.000Z' },
    { stamp: '휴대폰 · Android · Chrome#bbbb2222', at: '2026-07-20T10:00:00.000Z' },
  ];

  it('이 기기 줄만 지금 이름으로 덮어쓴다', () => {
    const d = foldDevices(rows, 'aaaa1111', '갤럭시 탭');
    expect(d.find((x) => x.id === 'aaaa1111')?.label).toBe('갤럭시 탭');
  });

  it('**다른 기기 줄은 건드리지 않는다** — 그 기기가 스스로 밝힌 이름이 진실이다', () => {
    const d = foldDevices(rows, 'aaaa1111', '갤럭시 탭');
    expect(d.find((x) => x.id === 'bbbb2222')?.label).toBe('휴대폰 · Android · Chrome');
  });

  it('이름을 안 주면 서버 값 그대로(옛 호출부가 그대로 동작한다)', () => {
    expect(foldDevices(rows, 'aaaa1111')[0]?.label).toBe('PC · Linux · Chrome');
  });
});

describe('짧은 id', () => {
  it('8자리로 줄인다(전체를 보여줄 이유가 없다)', () => {
    expect(shortDeviceId('0123456789abcdef-0000')).toBe('01234567');
  });
});
