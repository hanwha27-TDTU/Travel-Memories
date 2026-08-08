// services/syncPlan.ts — 동기화 도메인의 병렬 그룹과 직렬 의존성 SSOT.
//
// 새 도메인은 이 파일에 들어오는 순간 push/pull 실행 방식까지 선택해야 한다. 직렬 단계는
// `waitsFor.reason` 없이는 타입상 만들 수 없다. 실행기는 한 형제가 실패해도 같은 단계의 모든
// 부수효과가 끝날 때까지 기다린 뒤 실패한다. Promise.all의 조기 reject 뒤에 서버 쓰기가 남아
// 다음 동기화와 겹치는 일을 막기 위한 경계다(헌법 §18-C).

export const SYNC_DOMAINS = ['trip', 'place', 'moment', 'media', 'expense', 'audio'] as const;
export type SyncDomain = (typeof SYNC_DOMAINS)[number];

export interface SyncPlanObserver {
  /** 한 도메인이 성공·실패 어느 쪽으로든 정산된 직후 알린다. 관찰 실패는 동기화를 멈추지 않는다. */
  onDomainSettled?: (domain: SyncDomain) => void;
}

interface RootSyncLevel {
  id: string;
  domains: readonly SyncDomain[];
  waitsFor: null;
}

interface DependentSyncLevel {
  id: string;
  domains: readonly SyncDomain[];
  waitsFor: {
    stage: string;
    /** 직렬이어야만 하는 구체적 데이터·증거 의존성. 빈 관행 설명은 허용하지 않는다. */
    reason: string;
  };
}

export type SyncLevel = RootSyncLevel | DependentSyncLevel;

/**
 * push는 서버 복합 FK가 요구하는 세 단계만 직렬이고, 같은 단계의 형제는 병렬이다.
 * 여행과 장소는 독립 부모, 순간은 둘을 참조, 사진·비용·소리는 순간을 참조한다.
 */
export const PUSH_SYNC_PLAN = [
  { id: 'roots', domains: ['trip', 'place'], waitsFor: null },
  {
    id: 'moments',
    domains: ['moment'],
    waitsFor: {
      stage: 'roots',
      reason:
        'moments의 (trip_id,user_id)와 선택적 (place_id,user_id) 복합 FK가 서버에 먼저 존재해야 H-02 거부 없이 착지한다.',
    },
  },
  {
    id: 'moment-children',
    domains: ['media', 'expense', 'audio'],
    waitsFor: {
      stage: 'moments',
      reason:
        'media·expenses·audio의 (moment_id,user_id) 복합 FK와 자식 read-back은 서버 순간이 착지한 뒤에만 유효하다.',
    },
  },
] as const satisfies readonly SyncLevel[];

/** pull 결과끼리는 입력·FK 의존성이 없으므로 여섯 도메인을 한 단계에서 모두 시작한다. */
export const PULL_SYNC_PLAN = [
  { id: 'all-domains', domains: SYNC_DOMAINS, waitsFor: null },
] as const satisfies readonly SyncLevel[];

/**
 * 단계 안에서는 전부 병렬 시작하고 전부 정산한다. 하나가 실패해도 나머지 형제의 서버/로컬
 * 부수효과가 끝날 때까지 기다려, 호출자가 다음 단계나 다음 동기화를 시작하지 못하게 한다.
 */
export async function runSyncPlan<T>(
  plan: readonly SyncLevel[],
  tasks: Record<SyncDomain, () => Promise<T>>,
  observer: SyncPlanObserver = {},
): Promise<Record<SyncDomain, T>> {
  const results: Partial<Record<SyncDomain, T>> = {};

  for (const level of plan) {
    // Promise.resolve().then은 동기 throw도 rejected 결과로 바꾸고 모든 형제를 먼저 예약한다.
    const settled = await Promise.allSettled(
      level.domains.map((domain) => Promise.resolve().then(tasks[domain])),
    );
    const failures: string[] = [];

    settled.forEach((result, index) => {
      const domain = level.domains[index];
      try {
        observer.onDomainSettled?.(domain);
      } catch {
        // 진행 표시 관찰자가 실패해도 실제 동기화의 정산·안전 경계를 깨지 않는다.
      }
      if (result.status === 'fulfilled') results[domain] = result.value;
      else {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        failures.push(`${domain}: ${message}`);
      }
    });

    if (failures.length) {
      throw new Error(`동기화 단계 '${level.id}' 실패 — ${failures.join(' | ')}`);
    }
  }

  const missing = SYNC_DOMAINS.filter((domain) => results[domain] === undefined);
  if (missing.length) throw new Error(`동기화 실행 계획에서 빠진 도메인: ${missing.join(', ')}`);
  return results as Record<SyncDomain, T>;
}
