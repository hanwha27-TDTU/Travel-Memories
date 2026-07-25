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

import { describe, it, expect } from 'vitest';
import { foldDevices } from '../../src/services/storeState';
import { deviceLabel, parseDeviceStamp, shortDeviceId } from '../../src/app/deviceId';

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
    safariIpad: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',
  };

  it('Edge가 Chrome으로 뭉개지지 않는다(UA에 Chrome을 포함한다)', () => {
    expect(deviceLabel(UA.edge)).toBe('PC · Windows · Edge');
  });

  it('삼성 브라우저도 마찬가지', () => {
    expect(deviceLabel(UA.samsung)).toBe('휴대폰 · Android · Samsung');
  });

  it('안드로이드 크롬 휴대폰', () => {
    expect(deviceLabel(UA.chromeAndroid)).toBe('휴대폰 · Android · Chrome');
  });

  it('아이패드는 태블릿으로', () => {
    expect(deviceLabel(UA.safariIpad)).toBe('태블릿 · iOS · Safari');
  });

  it('리눅스 파이어폭스', () => {
    expect(deviceLabel(UA.firefoxLinux)).toBe('PC · Linux · Firefox');
  });

  it('모르면 추측하지 않고 "알 수 없음"으로 둔다', () => {
    expect(deviceLabel('완전히 낯선 문자열')).toBe('PC · 알 수 없음 · 알 수 없음');
  });
});

describe('짧은 id', () => {
  it('8자리로 줄인다(전체를 보여줄 이유가 없다)', () => {
    expect(shortDeviceId('0123456789abcdef-0000')).toBe('01234567');
  });
});
