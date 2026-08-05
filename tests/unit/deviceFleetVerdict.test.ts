// tests/unit/deviceFleetVerdict.test.ts — 「기기별 현황」 판정과 문장을 잠근다.
//
// 이 지표는 M-0048에서 **판정을 뒤집은** 정보다(다른 기기가 있으면 파괴적 정리를 권하면
// 안 된다). 그래서 「몇 대인가」를 틀리게 말하면 그 결정이 다시 틀어진다.
//
// 그리고 §5 10항 — **차이 ≠ 결함.** 안 쓰는 기기가 안 올리는 것은 정상이므로 `problem`이
// 아니라 `todo`다. 정상을 문제라 부르면 사용자가 그 지표를 안 보게 된다(§7-D 오탐).

import { describe, it, expect } from 'vitest';
import {
  fleetSizeMetric,
  staleDeviceMetric,
  fleetMetrics,
  fleetHeadline,
  daysSince,
  STALE_DEVICE_DAYS,
  type FleetObservation,
  type FleetDevice,
} from '../../src/domain/deviceFleetVerdict';

const NOW = '2026-08-05T12:00:00.000Z';
const daysAgo = (n: number): string => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();

const dev = (label: string, days: number, isThis = false): FleetDevice => ({
  label,
  id: label.slice(0, 8),
  lastPushAt: daysAgo(days),
  isThis,
});

const clean = (over: Partial<FleetObservation> = {}): FleetObservation => ({
  cloudConfigured: true,
  signedIn: true,
  devices: [dev('태블릿', 0, true), dev('폴드5', 1)],
  unavailableReason: null,
  now: NOW,
  ...over,
});

describe('며칠 전인가', () => {
  it('정상 계산', () => {
    expect(daysSince(daysAgo(3), NOW)).toBe(3);
    expect(daysSince(NOW, NOW)).toBe(0);
  });

  it('파싱 불가면 null — 0으로 반올림하지 않는다(§8)', () => {
    expect(daysSince('언젠가', NOW)).toBeNull();
  });
});

describe('① 이 계정의 기기', () => {
  it('여러 대면 개수를 말한다', () => {
    const m = fleetSizeMetric(clean());
    expect(m.level).toBe('ok');
    expect(m.actual).toBe('2대');
  });

  it('🔴 조회 실패는 「0대」가 아니라 「확인하지 못함」이다(§8)', () => {
    const m = fleetSizeMetric(clean({ devices: null, unavailableReason: '네트워크 끊김' }));
    expect(m.level).toBe('unknown');
    expect(m.actual).not.toContain('0');
    expect(m.meaning).toContain('네트워크 끊김');
  });

  it('🔴 0대는 「기기가 없다」가 아니라 「아직 아무것도 안 올렸다」다', () => {
    // 이 목록은 **올린 흔적**에서 만들어진다. 받기만 한 새 계정은 정상적으로 0대다.
    const m = fleetSizeMetric(clean({ devices: [] }));
    expect(m.level).toBe('todo');
    expect(m.actual).toContain('올린 기기가 없음');
    expect(m.meaning).toContain('여행을 하나 만들면');
  });

  it('클라우드를 안 쓰면 해당 없음(정상)', () => {
    expect(fleetSizeMetric(clean({ cloudConfigured: false })).level).toBe('ok');
  });
});

describe('② 오래 안 올린 기기', () => {
  it('전부 최근이면 정상이고 침묵한다', () => {
    const m = staleDeviceMetric(clean());
    expect(m.level).toBe('ok');
    expect(m.meaning).toBeUndefined();
  });

  it('🔴 오래된 기기는 problem이 아니라 todo다 — 안 쓰는 기기는 안 올리는 게 정상(§5 10항)', () => {
    const m = staleDeviceMetric(clean({ devices: [dev('태블릿', 0, true), dev('폴드5', STALE_DEVICE_DAYS + 1)] }));
    expect(m.level).toBe('todo');
    expect(m.level).not.toBe('problem');
    expect(m.meaning).toContain('안 쓰는 기기라면 정상');
  });

  it('어느 기기인지 **이름을 부른다**(숫자로 합치면 이름이 사라진다 — §7-G)', () => {
    const m = staleDeviceMetric(clean({ devices: [dev('태블릿', 0, true), dev('폴드5', 30), dev('노트북', 40)] }));
    expect(m.actual).toContain('폴드5');
    expect(m.actual).toContain('노트북');
  });

  it('🔴 지금 쓰는 이 기기는 대상이 아니다 — 지금 쓰고 있는데 「오래됐다」면 오탐이다', () => {
    const m = staleDeviceMetric(clean({ devices: [dev('태블릿', 99, true)] }));
    expect(m.level).toBe('ok');
  });

  it('기기 목록을 못 읽었으면 같은 말을 두 번 하지 않는다(위 지표가 이미 말했다)', () => {
    expect(staleDeviceMetric(clean({ devices: null })).level).toBe('ok');
  });
});

describe('판정 한 문장', () => {
  it('여러 대면 그 사실을 말한다 — 사용자가 이 도구를 여는 이유가 그것이다', () => {
    expect(fleetHeadline(clean())).toContain('2대');
  });

  it('한 대뿐이면 그것도 말한다(침묵하면 「못 읽었나?」로 읽힌다)', () => {
    expect(fleetHeadline(clean({ devices: [dev('태블릿', 0, true)] }))).toContain('1대');
  });

  it('오래된 기기가 있으면 그것을 먼저 가리킨다', () => {
    const h = fleetHeadline(clean({ devices: [dev('태블릿', 0, true), dev('폴드5', 30)] }));
    expect(h).toContain('오래 안 올렸');
  });

  it('로그인 전이면 그 사실을 말한다 — 실패처럼 보이지 않게', () => {
    expect(fleetHeadline(clean({ signedIn: false, devices: null }))).toContain('로그인하면');
  });
});

describe('묶음 규율', () => {
  it('🔴 모든 갈래에 기대값이 있고 마크다운이 없다(§4 · §5 7항)', () => {
    const cases = [
      clean(),
      clean({ cloudConfigured: false }),
      clean({ devices: null, unavailableReason: 'x' }),
      clean({ devices: [] }),
      clean({ devices: [dev('a', 0, true), dev('b', 40)] }),
      clean({ signedIn: false, devices: null }),
    ];
    for (const o of cases) {
      for (const m of fleetMetrics(o)) {
        expect(m.expected.length).toBeGreaterThan(0);
        expect(m.actual.length).toBeGreaterThan(0);
        expect(m.actual).not.toContain('**');
        expect(m.meaning ?? '').not.toContain('**');
      }
      expect(fleetHeadline(o)).not.toContain('**');
    }
  });
});
