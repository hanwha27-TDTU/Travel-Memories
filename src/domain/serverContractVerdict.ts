// domain/serverContractVerdict.ts — 「서버 계약」의 판정과 문장(순수 함수).
//
// 이 도구가 묻는 질문(§7-E):
//
//   **「서버가 앱이 가정한 대로 행동하는가?」**
//
// 왜 필요한가(실측 2026-08-05): 오늘 고친 결함 셋(M-0100·M-0101·M-0102)이 전부
// *"서버가 내 가정과 다르게 행동한다"* 부류였고, 그걸 좁히려고 **운영 DB에 직접 SQL을
// 질의해야 했다.** 개발 컨테이너의 프록시가 운영 서버 접근을 막기 때문이다.
// 그런데 사용자의 앱은 **진짜 서버에 붙어 있다** — 그 자리에서 재면 다음 고장이 훨씬 싸다.
//
// 재는 것 셋 — 전부 **읽기 전용**이다(쓰기 계약은 「왕복 시험」이 따로 잰다):
//   ① 한 번에 주는 행수 상한이 앱의 가정과 같은가 (페이지 크기)
//   ② 페이지를 나눠 받을 때 사이가 빠지지 않는가 (경계 겹침 대조)
//   ③ 로그인하지 않은 요청이 실제로 막히는가 (RLS·초대제 실측)
//
// 🔴 ③이 가장 무겁다. RLS는 **서버가 지키는 마지막 경계**이고, 클라이언트 코드가 아무리
//    옳아도 정책이 잘못 배포되면 남의 자료가 보인다. 지금까지 이 앱은 그걸 **한 번도
//    실측하지 않았다** — 마이그레이션 SQL 검사(`supabase/tests/`)는 CI에서 돌지만
//    그건 *로컬 스택*이고, 운영 서버가 그대로인지는 다른 질문이다(§2-J ②).

export type ContractLevel = 'ok' | 'todo' | 'problem' | 'unknown';

export interface ContractMetricView {
  actual: string;
  expected: string;
  level: ContractLevel;
  meaning?: string;
}

/**
 * 관측값 — 서비스가 실제 서버에 물어서 채운다.
 *
 * 🔴 각 필드의 `null`은 **0이 아니라 「못 쟀음」**이다(§8). 조회 실패와 「0건」을 같은 값으로
 * 접으면 서버가 이상한데 화면이 조용해진다.
 */
export interface ServerContractObservation {
  /** 클라우드가 설정된 배포인가. 아니면 이 도구 전체가 해당 없음이다. */
  cloudConfigured: boolean;
  /** 로그인 상태인가. 아니면 ①②를 잴 수 없다(RLS가 0행을 준다). */
  signedIn: boolean;

  /** ① 한 번 요청에 서버가 실제로 준 최대 행수. 못 쟀으면 null. */
  observedPageSize: number | null;
  /** 앱이 페이지네이션에 쓰는 크기 — 코드의 상수. 서버 상한이 이보다 작으면 결손이 난다. */
  assumedPageSize: number;

  /** ② 경계에서 겹쳐 받은 두 조각이 같은 행을 가리켰는가. 못 쟀으면 null. */
  paginationSound: boolean | null;
  /** ②를 못 쟀거나 실패한 이유. */
  paginationNote: string | null;

  /**
   * ③ 로그인 없는 요청이 실제로 막혔는가.
   *  · true  = 막혔다(0행 또는 권한 오류) — 정상
   *  · false = **뚫렸다**(행이 왔다) — 이건 즉시 문제다
   *  · null  = 못 쟀다
   */
  anonBlocked: boolean | null;
  /** ③에서 익명 요청이 실제로 받은 행 수(뚫렸을 때 얼마나 새는지). */
  anonRowsSeen: number | null;
  /** ③을 못 쟨 이유. */
  anonNote: string | null;
}

/** ① 서버가 한 번에 주는 행수가 앱의 가정 이상인가. */
export function pageSizeMetric(o: ServerContractObservation): ContractMetricView {
  if (!o.cloudConfigured) {
    return { actual: '해당 없음(클라우드를 쓰지 않는 배포)', expected: '해당 없음', level: 'ok' };
  }
  if (o.observedPageSize === null) {
    return {
      actual: '못 쟀음',
      expected: `${o.assumedPageSize}행 이상`,
      level: 'unknown',
      meaning: o.signedIn
        ? '서버에 물어보지 못했어요. 연결이 돌아오면 다시 재집니다.'
        : '로그인해야 잴 수 있어요 — 로그인 전에는 서버가 아무 행도 주지 않는 것이 정상입니다.',
    };
  }
  // 🔴 관측값이 가정보다 **작으면** 페이지 경계에서 행이 조용히 빠질 수 있다.
  //    같거나 크면 정상 — 더 주는 것은 문제가 아니다.
  if (o.observedPageSize < o.assumedPageSize) {
    return {
      actual: `${o.observedPageSize}행`,
      expected: `${o.assumedPageSize}행 이상`,
      level: 'problem',
      meaning:
        '서버가 앱의 가정보다 적게 줍니다. 이러면 자료가 많을 때 페이지 사이에서 조용히 빠질 수 있어요. ' +
        '[진단 요약 복사]로 이 화면을 전달해 주세요.',
    };
  }
  return { actual: `${o.observedPageSize}행`, expected: `${o.assumedPageSize}행 이상`, level: 'ok' };
}

/** ② 페이지를 나눠 받을 때 사이가 빠지지 않는가. */
export function paginationMetric(o: ServerContractObservation): ContractMetricView {
  if (!o.cloudConfigured) {
    return { actual: '해당 없음(클라우드를 쓰지 않는 배포)', expected: '해당 없음', level: 'ok' };
  }
  if (o.paginationSound === null) {
    return {
      actual: '못 쟀음',
      expected: '빠짐 없음',
      level: 'unknown',
      ...(o.paginationNote ? { meaning: o.paginationNote } : {}),
    };
  }
  if (!o.paginationSound) {
    return {
      actual: '경계에서 어긋남',
      expected: '빠짐 없음',
      level: 'problem',
      meaning:
        '페이지를 나눠 받을 때 경계의 행이 서로 맞지 않아요. 자료가 많으면 일부가 안 내려올 수 있습니다.' +
        (o.paginationNote ? ` (${o.paginationNote})` : ''),
    };
  }
  return { actual: '빠짐 없음', expected: '빠짐 없음', level: 'ok' };
}

/**
 * ③ 로그인 없는 요청이 실제로 막히는가 — **이 앱에서 가장 무거운 지표**.
 *
 * 뚫렸다면 다른 사람이 내 여행·사진·위치를 볼 수 있다는 뜻이다(§0 개인자료 기본 비공개).
 * 그래서 「모름」과 「막힘」을 절대 같게 칠하지 않는다.
 */
export function anonBlockMetric(o: ServerContractObservation): ContractMetricView {
  if (!o.cloudConfigured) {
    return { actual: '해당 없음(클라우드를 쓰지 않는 배포)', expected: '해당 없음', level: 'ok' };
  }
  if (o.anonBlocked === null) {
    return {
      actual: '못 쟀음',
      expected: '막힘',
      level: 'unknown',
      meaning: o.anonNote ?? '서버에 물어보지 못했어요. 연결이 돌아오면 다시 재집니다.',
    };
  }
  if (!o.anonBlocked) {
    return {
      actual: `뚫림 — 로그인 없이 ${o.anonRowsSeen ?? '?'}행이 보임`,
      expected: '막힘',
      level: 'problem',
      meaning:
        '로그인하지 않은 요청에 서버가 자료를 내주고 있어요. 다른 사람이 기록을 볼 수 있는 상태입니다. ' +
        '[진단 요약 복사]로 이 화면을 지금 전달해 주세요.',
    };
  }
  return { actual: '막힘', expected: '막힘', level: 'ok' };
}

/** 세 지표를 계약된 순서로. 화면 자리도 계약이다(§7 사용자 대면 대칭). */
export function serverContractMetrics(o: ServerContractObservation): ContractMetricView[] {
  return [anonBlockMetric(o), pageSizeMetric(o), paginationMetric(o)];
}

/**
 * 판정 한 문장 — 무리별 개수에서 만든다(§7-C 「엉뚱한 곳을 가리킴」 방지).
 * 지표를 늘렸는데 문장만 옛 지표를 가리키던 사고가 이 저장소에서 두 번 났다.
 */
export function serverContractHeadline(o: ServerContractObservation): string {
  if (!o.cloudConfigured) return '이 배포는 클라우드를 쓰지 않아요';
  const ms = serverContractMetrics(o);
  const bad = ms.filter((m) => m.level === 'problem');
  if (bad.length) {
    // 접근이 뚫린 것은 나머지와 급이 다르다 — 그 문장을 먼저 세운다.
    if (anonBlockMetric(o).level === 'problem') return '🔴 로그인 없이도 자료가 보입니다';
    return `서버가 가정과 다르게 행동해요 — 확인할 것 ${bad.length}가지`;
  }
  const unknown = ms.filter((m) => m.level === 'unknown').length;
  if (unknown === ms.length) {
    return o.signedIn ? '서버에 물어보지 못했어요' : '로그인하면 서버 계약을 확인할 수 있어요';
  }
  if (unknown) return `${ms.length - unknown}가지는 확인했고 ${unknown}가지는 못 쟀어요`;
  return '서버가 앱의 가정대로 행동합니다';
}
