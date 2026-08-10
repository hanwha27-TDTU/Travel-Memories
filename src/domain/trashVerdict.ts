// domain/trashVerdict.ts — 「저장·삭제·휴지통」 도구의 판정을 **순수 함수로** 잠근다.
//
// 이 도구가 묻는 질문 한 문장(§7-E — 질문을 쓰고 판정을 그 질문에 맞춘다):
//
//   **「지운 것을 되살릴 수 있는가, 그리고 모든 기기가 같은 휴지통을 보는가?」**
//
// 왜 기존 도구로는 안 되는가(빈칸을 실측해 골랐다 — 겹치면 만들지 않는다):
//   · 「저장소 안전」  = 브라우저가 지울 위험. 휴지통 얘기가 아니다.
//   · 「동기화 상태」  = 큐가 막혔나 · 삭제가 서버에 갔나. **간 뒤의 되살림**은 안 본다.
//   · 「저장 상태」    = 클라우드↔이 기기 개수. 휴지통은 「이 기기가 더 많지 않은가」 한 줄뿐.
//   · 「ID 무결성」    = 🔴 **살아 있는 행만 본다**(`deletedAt === null` 필터). 휴지통 항목은
//                       어느 도구의 시야에도 없었다 — 이 도구가 그 자리다.
//
// 화면에 나가는 문장이 곧 결함일 수 있으므로(§10 ③) 판정과 문구를 여기 순수 함수에 두고
// 유닛이 모든 갈래를 직접 돌린다. `diagnostics.ts`는 이 결과를 Metric으로 옮기기만 한다.

export type TrashLevel = 'ok' | 'todo' | 'problem' | 'unknown';

/** 지표 하나의 표시값 — `Metric`과 같은 모양이되 ui를 import하지 않는다(도메인→화면 의존 금지). */
export interface TrashMetricView {
  actual: string;
  expected: string;
  level: TrashLevel;
  meaning?: string;
}

/** 되살려도 자료가 비는 항목 하나. */
export interface EmptyOnRestore {
  domain: 'media' | 'audio' | 'video';
  label: string;
}

/** 되살릴 부모가 사라진 항목 하나. */
export interface OrphanTrashed {
  label: string;
}

/**
 * 관측값 — 서비스가 읽기 전용으로 모아 온다. **판정은 여기서만 한다.**
 *
 * 🔴 `serverTrashCount`가 `null`인 것은 **0이 아니라 「모름」**이다(§8). 조회 실패와 「서버
 * 휴지통이 비었다」를 같은 값으로 접으면, 서버에 지운 것이 쌓여 있는데 화면이 조용해진다.
 */
export interface TrashObservation {
  /**
   * 🔴 이 배포에 클라우드가 **있는가**(`isConfigured()`).
   *
   * 없으면 서버를 못 읽은 게 아니라 **읽을 서버가 없는 것**이고, 그때 이 기기는 유일한 기기라
   * 「모든 기기가 같은 목록을 보는가」의 답이 자명하게 예다 — `unknown`이 아니라 `ok`다.
   * (§7-E: **과도한 `unknown`도 결함이다.** 총괄 판정을 끌어내려 정상 화면을 이상하게 보이게
   * 만들고, 「연결이 돌아오면」처럼 **돌아올 연결이 없는데 하는 말**까지 화면에 내보낸다.)
   */
  cloudConfigured: boolean;
  /** 서버 휴지통 건수(여행+자식 합). 조회를 못 했으면 null. */
  serverTrashCount: number | null;
  /** serverTrashCount가 null인 이유(오프라인·로그인 전·조회 실패). 있으면 그대로 화면에 나간다. */
  unavailableReason: string | null;
  /** 이 기기 로컬 휴지통 건수(여행+자식 합). */
  localTrashCount: number;
  /** 되살려도 사진·소리·영상이 빈 채로 오는 항목(`bytesMissing` 표시가 붙은 행). */
  emptyOnRestore: EmptyOnRestore[];
  /** 부모(여행·순간)가 영구삭제돼 되살릴 곳이 없는 자식. */
  orphans: OrphanTrashed[];
}

/** 접힌 출처·요약이 함께 쓰는 상한 — 조용히 자르지 않고 「외 N건」을 적는다(§5 3항). */
export const TRASH_ITEM_CAP = 20;

/**
 * ① 휴지통 목록의 **기준**이 서버인가.
 *
 * ADR-0049 이후 온라인이면 서버가 정본이라 **모든 기기가 같은 휴지통을 본다.** 이 지표는
 * 그 계약이 실제로 서 있는지를 잰다 — 서버를 못 읽어 이 기기 기록으로 폴백 중이면 그때가
 * 바로 **기기끼리 달라지는** 상태이고, 사용자가 알아야 할 유일한 순간이다.
 *
 * 🔴 개수를 대조하지 **않는다.** 로컬이 서버보다 적은 것은 정상이기 때문이다 — 다른 기기가
 * 지운 항목은 이 기기에 사본이 없으면 tombstone을 만들지 않는다(불변식 #8). 개수로 판정하면
 * 정상 상태를 영원히 경고한다(§7-D 오탐 — 오탐은 빡빡한 진단이 아니라 **틀린 진단**이다).
 */
export function trashSourceMetric(o: TrashObservation): TrashMetricView {
  // 클라우드가 없는 배포 — 기기가 하나뿐이라 어긋날 상대가 없다. 기대값도 「서버」가 아니다.
  if (!o.cloudConfigured) {
    return {
      actual: '이 기기 (클라우드를 쓰지 않는 배포입니다)',
      expected: '이 기기',
      level: 'ok',
    };
  }
  if (o.serverTrashCount !== null) {
    return {
      actual: '서버 (모든 기기가 같은 목록을 봅니다)',
      expected: '서버',
      level: 'ok',
    };
  }
  return {
    actual: '이 기기 (다른 기기와 다를 수 있어요)',
    expected: '서버',
    level: 'unknown',
    meaning: `서버 휴지통을 읽지 못해 이 기기의 기록으로 보여주고 있어요${
      o.unavailableReason ? ` — ${o.unavailableReason}` : ''
    }. 연결이 돌아오면 자동으로 서버 기준으로 바뀝니다.`,
  };
}

/**
 * ② 되살려도 **자료가 비는** 항목.
 *
 * 왜 이 지표가 생겼나: M-0101을 고치며 「휴지통 사진의 바이트를 못 받아도 최종본 전체를 막지
 * 않는다」로 바꾸고 빈 자리에 `bytesMissing` 표시를 남겼다. 자료구조는 정직해졌는데 **그
 * 표시를 사용자가 볼 곳을 안 만들었다** — 되살리기 버튼은 멀쩡히 보이고, 눌러야 사진이
 * 비어 있는 걸 안다. §7-B: *"이미 그 상태에 빠진 사람은 누가 데려오나?"* 그 답이 이 지표다.
 */
export function emptyOnRestoreMetric(o: TrashObservation): TrashMetricView {
  const n = o.emptyOnRestore.length;
  if (n === 0) return { actual: '없음', expected: '없음', level: 'ok' };
  const media = o.emptyOnRestore.filter((x) => x.domain === 'media').length;
  const audio = o.emptyOnRestore.filter((x) => x.domain === 'audio').length;
  const video = o.emptyOnRestore.filter((x) => x.domain === 'video').length;
  const parts = [media ? `사진 ${media}` : '', audio ? `소리 ${audio}` : '', video ? `영상 ${video}` : ''].filter(Boolean);
  return {
    actual: `${n}건 (${parts.join(' · ')})`,
    expected: '없음',
    level: 'todo',
    // 🔴 원인을 못박지 않는다(§7-I). 관측은 「바이트가 이 기기에 없다」까지이고, 왜 없는지는
    // 여럿일 수 있다(옛 결함의 잔재 · 다른 기기에서 만들어 아직 못 받음 · 서버에서 사라짐).
    meaning:
      '되살리기는 되지만 사진·소리·영상은 빈 채로 돌아와요. 그 자료를 가진 다른 기기가 있으면 ' +
      '거기서 동기화한 뒤 되살리면 함께 돌아옵니다.',
  };
}

/**
 * ③ 되살릴 **곳이 없는** 항목.
 *
 * 순간을 영구삭제하면 그 순간 행만 사라진다(`purgeChildPermanently`는 자식을 데려가지 않는다 —
 * 자식은 `trip_id`로만 묶여 있다). 그때 휴지통에 있던 그 순간의 사진·소리·영상·비용은 **되살려도
 * 갈 부모가 없다.** 어느 기존 도구도 이걸 못 본다 — `checkIntegrity`는 살아 있는 행만 보고,
 * 이 항목들은 전부 tombstone이기 때문이다.
 */
export function orphanTrashedMetric(o: TrashObservation): TrashMetricView {
  const n = o.orphans.length;
  if (n === 0) return { actual: '없음', expected: '없음', level: 'ok' };
  return {
    actual: `${n}건`,
    expected: '없음',
    level: 'problem',
    meaning:
      '이 항목들이 속한 순간·여행이 영구삭제돼서 되살려도 돌아갈 곳이 없어요. ' +
      '휴지통에서 영구삭제해 정리할 수 있습니다.',
  };
}

/** 세 지표를 한 번에 — 도구는 이 순서대로 화면에 올린다(순서도 계약이다 · §7 화면 대칭). */
export function trashMetrics(o: TrashObservation): TrashMetricView[] {
  return [trashSourceMetric(o), emptyOnRestoreMetric(o), orphanTrashedMetric(o)];
}

/**
 * 판정 한 문장.
 *
 * 🔴 문장을 손으로 쓰지 않고 **무리별 개수에서 만든다**(§7-C — 「엉뚱한 곳을 가리킴」 방지).
 * 지표를 하나 더 늘렸는데 문장만 옛 지표를 가리키던 사고가 이 저장소에서 두 번 났다.
 * 그리고 **빈 상태를 초록으로 칠하지 않는다**(§7-C) — 휴지통이 비어 있으면 그렇다고 말한다.
 */
export function trashHeadline(o: TrashObservation): string {
  const bad = orphanTrashedMetric(o).level === 'problem' ? o.orphans.length : 0;
  const todo = o.emptyOnRestore.length;
  if (bad > 0) return `되살릴 곳이 없는 항목이 ${bad}건 있어요`;
  if (todo > 0) return `되살려도 자료가 비는 항목이 ${todo}건 있어요`;
  // 클라우드가 없는 배포에서는 이 기기가 곧 전부다 — 「못 읽었다」가 아니라 「이게 전부다」.
  if (!o.cloudConfigured) {
    return o.localTrashCount === 0 ? '휴지통이 비어 있습니다' : `휴지통에 ${o.localTrashCount}건이 있습니다`;
  }
  if (o.serverTrashCount === null) return '휴지통을 이 기기 기록으로 보여주고 있어요';
  if (o.serverTrashCount === 0) return '휴지통이 비어 있습니다';
  return `휴지통의 ${o.serverTrashCount}건을 모든 기기가 같이 봅니다`;
}
