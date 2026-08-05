// domain/deviceFleetVerdict.ts — 「기기별 현황」의 판정과 문장(순수 함수).
//
// 이 도구가 묻는 질문(§7-E):
//
//   **「내 기기들이 서로 뒤처지지 않고 같은 것을 보고 있는가?」**
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 접힌 출처에서 **도구로 승격**했나
// ─────────────────────────────────────────────────────────────────────────────
// 「내 기기들 N대」는 지금까지 「저장 상태」의 **접힌 출처**에 있었다. 그런데 이 정보는
// M-0048에서 **판정을 뒤집은 결정적 근거**였다 — 다른 기기가 하나라도 있으면 「이 기기에
// 사본이 없다」를 「없다」로 읽으면 안 되고, 파괴적 정리를 권해서도 안 된다. 판정을 뒤집는
// 정보가 펼쳐야 보이는 자리에 있는 것은 §8 위반이다(도구는 관측이 아니라 판정을 한다).
//
// 그리고 사용자가 여러 날 겪은 문제가 정확히 이 축이었다 — *"같은 태블릿인데 왜 안드로이드
// 앱과 크롬이 다르지?"* 그때 그 답을 줄 화면이 없었다.
//
// 🔴 **라벨이 말할 수 있는 것만 말한다**(§5 9항): 이 목록은 서버 행의 `updated_by_device`에서
//    나오므로 **올린 기록만** 있다. 받아만 간 기기는 흔적이 없다 — 그래서 「마지막 동기화」가
//    아니라 **「마지막으로 올림」**이다. 한 글자 차이가 거짓말과 사실을 가른다.

export type FleetLevel = 'ok' | 'todo' | 'problem' | 'unknown';

export interface FleetMetricView {
  actual: string;
  expected: string;
  level: FleetLevel;
  meaning?: string;
}

export interface FleetDevice {
  label: string;
  id: string;
  /** 이 기기가 **마지막으로 올린** 시각(ISO). */
  lastPushAt: string;
  isThis: boolean;
}

/**
 * 얼마나 오래 안 올렸으면 「뒤처졌다」고 볼 것인가.
 *
 * 🔴 이건 **결함 판정이 아니다.** 안 쓰는 기기는 안 올리는 것이 정상이다 — 그래서 `todo`이지
 * `problem`이 아니다(§5 10항 — 차이 ≠ 결함, 겁주지 않는다). 이 값의 유일한 쓸모는
 * *"저 기기에서 아직 안 올라온 게 있을 수 있다"*를 사용자가 떠올리게 하는 것이다.
 */
export const STALE_DEVICE_DAYS = 14;

export interface FleetObservation {
  cloudConfigured: boolean;
  signedIn: boolean;
  /** 서버가 아는 내 기기들. 조회 못 했으면 null(0대가 아니다 — §8). */
  devices: FleetDevice[] | null;
  /** 조회를 못 한 이유. */
  unavailableReason: string | null;
  /** 판정 기준 시각(ISO) — 유닛이 시간을 고정할 수 있게 주입받는다. */
  now: string;
}

/** 며칠 전인지. 파싱 불가면 null. */
export function daysSince(iso: string, now: string): number | null {
  const t = Date.parse(iso);
  const n = Date.parse(now);
  if (Number.isNaN(t) || Number.isNaN(n)) return null;
  return Math.max(0, Math.floor((n - t) / 86_400_000));
}

/** ① 이 계정에 기기가 몇 대인가 — 파괴적 행동의 전제를 가르는 값이다(M-0048). */
export function fleetSizeMetric(o: FleetObservation): FleetMetricView {
  if (!o.cloudConfigured) {
    return { actual: '이 기기 하나(클라우드를 쓰지 않는 배포)', expected: '해당 없음', level: 'ok' };
  }
  if (o.devices === null) {
    return {
      actual: '확인하지 못함',
      expected: '1대 이상',
      level: 'unknown',
      meaning: o.unavailableReason ?? (o.signedIn ? '서버에 물어보지 못했어요.' : '로그인하면 기기 목록을 볼 수 있어요.'),
    };
  }
  const n = o.devices.length;
  // 🔴 0대는 「기기가 없다」가 아니라 **「아직 아무것도 올린 적이 없다」**이다. 이 목록은
  //    올린 흔적에서 만들어지므로, 받기만 한 새 계정은 정상적으로 0대다.
  if (n === 0) {
    return {
      actual: '아직 올린 기기가 없음',
      expected: '1대 이상',
      level: 'todo',
      meaning: '이 계정에서 아직 아무것도 서버로 올리지 않았어요. 여행을 하나 만들면 이 기기가 여기 나타납니다.',
    };
  }
  return { actual: `${n}대`, expected: '1대 이상', level: 'ok' };
}

/** ② 오래 안 올린 기기가 있는가 — 그 기기에 아직 안 올라온 기록이 있을 수 있다. */
export function staleDeviceMetric(o: FleetObservation): FleetMetricView {
  if (!o.cloudConfigured || o.devices === null || o.devices.length === 0) {
    // 위 지표가 이미 그 사정을 말했다 — 같은 말을 두 번 하지 않는다(§8 침묵이 정상).
    return { actual: '해당 없음', expected: '해당 없음', level: 'ok' };
  }
  const stale = o.devices.filter((d) => {
    if (d.isThis) return false; // 이 기기는 지금 쓰고 있으므로 대상이 아니다
    const days = daysSince(d.lastPushAt, o.now);
    return days !== null && days >= STALE_DEVICE_DAYS;
  });
  if (stale.length === 0) {
    return { actual: '없음', expected: '없음', level: 'ok' };
  }
  return {
    actual: `${stale.length}대 (${stale.map((d) => d.label).join(' · ')})`,
    expected: '없음',
    level: 'todo',
    // 🔴 결함이라 말하지 않는다. 안 쓰는 기기는 안 올리는 것이 정상이다(§5 10항).
    meaning:
      `${STALE_DEVICE_DAYS}일 넘게 아무것도 올리지 않은 기기예요. 안 쓰는 기기라면 정상이고, ` +
      '쓰는 기기라면 거기서 앱을 한 번 열어 주세요 — 그 기기에만 있는 기록이 그때 올라옵니다.',
  };
}

export function fleetMetrics(o: FleetObservation): FleetMetricView[] {
  return [fleetSizeMetric(o), staleDeviceMetric(o)];
}

/**
 * 판정 한 문장.
 *
 * 🔴 **여러 대일 때 그 사실을 먼저 말한다.** 사용자가 이 도구를 여는 이유가 대개
 * *"왜 기기마다 다르지?"*이고, 그 답의 출발점이 「몇 대인가」이기 때문이다.
 */
export function fleetHeadline(o: FleetObservation): string {
  if (!o.cloudConfigured) return '이 배포는 클라우드를 쓰지 않아요';
  if (o.devices === null) return o.signedIn ? '기기 목록을 확인하지 못했어요' : '로그인하면 기기 목록을 볼 수 있어요';
  const n = o.devices.length;
  if (n === 0) return '아직 서버로 올린 기기가 없어요';
  const stale = staleDeviceMetric(o);
  if (stale.level === 'todo') return `기기 ${n}대 중 일부가 오래 안 올렸어요`;
  if (n === 1) return '이 계정은 기기 1대를 쓰고 있어요';
  return `기기 ${n}대가 모두 최근에 올렸어요`;
}
