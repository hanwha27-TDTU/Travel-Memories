// tests/unit/here.test.ts — 「지금 내 위치」의 **판정과 문장**(순수).
//
// 사용자(2026-07-31): *"장소가 바로 입력되게 하고 싶은거야. 어떤 방식이든 결과가 중요함."*
//
// 여기서 나오는 것은 값만이 아니라 **사용자에게 가는 문장**이다. M-0022·M-0053·M-0055가
// 전부 그 자리였다 — 숫자는 맞았고 화면에 나가는 말이 틀렸거나, 없었거나, 잘렸다(§10 ③).

import { describe, it, expect } from 'vitest';
import { hereVerdict, hereLabel, hereFailMessage, type HereFail } from '../../src/domain/place/here';

describe('hereVerdict — 정확도를 **이미 있는 정밀도 체계**로 말한다', () => {
  it('🔴 정확도는 반지름이고 우리 span은 지름이다 — 2배로 넘긴다', () => {
    // 50m 반지름 → 100m 지름 → 'point'(경계 120m 이내)
    expect(hereVerdict(50)).toEqual({ precision: 'point', spanMeters: 100, pinpoint: true });
  });

  it('실외 GPS(10m)는 **지점**이다', () => {
    expect(hereVerdict(10).pinpoint).toBe(true);
  });

  it('🔴 실내 wifi 측위(2km)를 「위치 지정됨」으로 반올림하지 않는다', () => {
    const v = hereVerdict(2000);
    expect(v.pinpoint).toBe(false);
    expect(v.precision).toBe('area'); // 4km 지름 → 동네 범위
  });

  it('정확도를 모르면 **확인 불가**다(정밀한 쪽으로 반올림하지 않는다 · §8)', () => {
    expect(hereVerdict(null)).toEqual({ precision: 'unknown', spanMeters: null, pinpoint: false });
  });

  it('말이 안 되는 값은 값이 아니다', () => {
    expect(hereVerdict(Number.NaN).precision).toBe('unknown');
    expect(hereVerdict(-5).precision).toBe('unknown');
  });

  it('0m도 값이다 — falsy로 뭉개지 않는다', () => {
    expect(hereVerdict(0)).toEqual({ precision: 'point', spanMeters: 0, pinpoint: true });
  });
});

describe('hereLabel — 배지에 적는 근거(좌표를 **가져갈 수 있게**)', () => {
  const SEOUL = { lat: 37.5665, lng: 126.978 };

  // 🔴 사용자(2026-07-31): *"사진 업로드와 동시에 내게 좌표를 제공해주면 내가 직접 입력하면
  // 되지 않아? 지금 목적이 무료지도 자체가 위치가 정확하지 않아서..GPS 도움 받으려는거거든"*
  it('🔴 **숫자 좌표를 보여준다** — 「위치 지정됨」만으로는 옮겨 적을 수도 대조할 수도 없다', () => {
    expect(hereLabel(SEOUL, 23)).toContain('37.56650');
    expect(hereLabel(SEOUL, 23)).toContain('126.97800');
  });

  it('소수점 5자리다(약 1m) — GPS 정밀도를 버리지도, 읽을 수 없게 만들지도 않는다', () => {
    expect(hereLabel({ lat: 37.123456789, lng: 127.987654321 }, 10)).toContain('37.12346, 127.98765');
  });

  it('정확도를 알면 함께 말한다', () => {
    expect(hereLabel(SEOUL, 23)).toContain('±23m');
  });

  it('킬로미터 단위로 커지면 단위를 바꾼다(±2400m는 읽히지 않는다)', () => {
    expect(hereLabel(SEOUL, 2400)).toContain('±2.4km');
  });

  it('🔴 정확도를 모르면 **지어내지 않는다** — 좌표는 주되 정확도는 침묵', () => {
    expect(hereLabel(SEOUL, null)).toBe('지금 내 위치 · 37.56650, 126.97800');
    expect(hereLabel(SEOUL, Number.POSITIVE_INFINITY)).not.toContain('±');
  });

  it('0,0(기니만)도 좌표다 — falsy로 뭉개지 않는다', () => {
    expect(hereLabel({ lat: 0, lng: 0 }, 5)).toContain('0.00000, 0.00000');
  });
});

describe('hereFailMessage — 실패해도 **다음에 할 일**을 준다(§12)', () => {
  const FAILS: HereFail[] = ['denied', 'unavailable', 'timeout', 'unsupported'];

  it('🔴 넷이 **서로 다른 말**을 한다(할 일이 다르므로 뭉개면 안 된다)', () => {
    const said = FAILS.map(hereFailMessage);
    expect(new Set(said).size).toBe(FAILS.length);
  });

  it('🔴 넷 다 **탈출구**로 데려간다 — 「안 됩니다」로 끝내지 않는다', () => {
    for (const f of FAILS) expect(hereFailMessage(f)).toMatch(/지도|좌표/);
  });

  it('권한 거부는 **권한을 켜는 길**을 말한다(버튼을 다시 누르라고 하면 안 된다)', () => {
    const s = hereFailMessage('denied');
    expect(s).toContain('권한');
    expect(s).toMatch(/자물쇠|설정/);
    expect(s).not.toContain('다시 누르'); // 다시 눌러도 안 된다 — 그게 이 사유의 본질이다
  });

  it('실내·시간초과는 **다시 눌러 보라**고 말한다(설정을 뒤지게 하지 않는다)', () => {
    expect(hereFailMessage('unavailable')).toContain('다시 누르');
    expect(hereFailMessage('timeout')).toContain('다시 누르');
  });

  it('미지원은 다시 누르라고 하지 않는다(영원히 안 되는 것을 기다리게 하지 않는다)', () => {
    expect(hereFailMessage('unsupported')).not.toContain('다시 누르');
  });

  it('모든 사유에 문장이 있다(빈 문자열로 조용해지지 않는다)', () => {
    for (const f of FAILS) expect(hereFailMessage(f).length).toBeGreaterThan(10);
  });
});
