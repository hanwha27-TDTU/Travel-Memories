// domain/integrity.ts — 저장된 기억의 **ID·참조 무결성 점검**(순수 함수, 읽기 전용).
//
// 왜: 오늘(2026-07-25) "지운 것이 되살아난다"를 네 번 진단하며 배운 것 — **로컬 상태를 볼 창이
// 없으면 추측하게 된다**(M-0008). 동기화 진단이 "얼마나 밀렸나"를 본다면, 이 점검은 **"데이터가
// 서로 앞뒤가 맞나"**를 본다. 고아 참조·부모 없는 자식·형식 위반은 조용히 쌓이다가 화면에서
// 사라진 기억으로 드러난다.
//
// 설계 원칙:
//  1) **읽기 전용.** 어떤 것도 고치지 않는다 — 자동 수리는 잘못 판단하면 기억을 지운다.
//  2) **심각도 3단**: `now`(지금 확인) / `prevent`(예방 주의) / `info`(참고).
//     대부분의 발견은 "지금 당장 문제"가 아니다. 겁주는 것은 거짓 경보만큼 나쁘다(M-0008).
//  3) **순수 함수.** DB 접근 없이 배열만 받는다 → 유닛으로 모든 분기를 실제로 돌린다.

export interface IdCheckRow {
  id: string;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}
export interface TripRowLike extends IdCheckRow {
  coverMediaId?: string | null;
}
export interface MomentRowLike extends IdCheckRow {
  tripId: string;
  lat?: number | null;
  lng?: number | null;
}
export interface MediaRowLike extends IdCheckRow {
  tripId: string;
  momentId: string;
}
export interface ExpenseRowLike extends IdCheckRow {
  tripId: string;
  momentId: string;
  originalAmount?: number;
  originalCurrency?: string;
}

export interface IntegritySnapshot {
  trips: TripRowLike[];
  moments: MomentRowLike[];
  media: MediaRowLike[];
  expenses: ExpenseRowLike[];
}

export type Severity = 'now' | 'prevent' | 'info';

export interface IntegrityFinding {
  /** 기술 코드 — 검색·문의용. 사람 문구가 바뀌어도 이건 안정적이다. */
  code: string;
  severity: Severity;
  /** 사람이 읽는 제목. */
  title: string;
  /** 무엇을 뜻하고 무엇을 해야 하는지 — 전문용어 없이. */
  detail: string;
  count: number;
  /** 대표 사례(최대 3개, id 앞 8자리) — 개수만으로는 추적이 안 된다. */
  samples: string[];
}

export interface IntegrityReport {
  checked: number;
  findings: IntegrityFinding[];
  bySeverity: Record<Severity, number>;
  ok: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const short = (id: string): string => id.slice(0, 8);

/** 점검 분류 수 — 화면이 "점검 N개 분류"를 손으로 세지 않도록 여기서 파생한다. */
export const CHECK_COUNT = 10;

/**
 * 무결성 점검. 활성 행만 대상으로 한다 — tombstone은 이미 "없는 것"이라 참조가 끊겨도 정상이다.
 */
export function checkIntegrity(s: IntegritySnapshot): IntegrityReport {
  const findings: IntegrityFinding[] = [];
  const add = (
    code: string,
    severity: Severity,
    title: string,
    detail: string,
    hits: string[],
  ): void => {
    if (!hits.length) return;
    findings.push({ code, severity, title, detail, count: hits.length, samples: hits.slice(0, 3).map(short) });
  };

  const aliveTrips = s.trips.filter((t) => t.deletedAt === null);
  const aliveMoments = s.moments.filter((m) => m.deletedAt === null);
  const aliveMedia = s.media.filter((m) => m.deletedAt === null);
  const aliveExpenses = s.expenses.filter((e) => e.deletedAt === null);

  const tripById = new Map(s.trips.map((t) => [t.id, t]));
  const momentById = new Map(s.moments.map((m) => [m.id, m]));
  const mediaIds = new Set(s.media.map((m) => m.id));
  const all = [...s.trips, ...s.moments, ...s.media, ...s.expenses];

  // 1. 부모 없는 자식 — 화면에서 영영 못 찾는 기억이 된다.
  add(
    'ORPHAN_PARENT',
    'now',
    '속한 여행·순간이 없는 기록',
    '이 기록이 가리키는 여행이나 순간을 찾을 수 없어요. 화면 어디에도 나타나지 않아 사실상 잃어버린 상태입니다. 백업 파일이 있으면 복원으로 되살릴 수 있어요.',
    [
      ...aliveMoments.filter((m) => !tripById.has(m.tripId)).map((m) => m.id),
      ...aliveMedia.filter((m) => !tripById.has(m.tripId) || !momentById.has(m.momentId)).map((m) => m.id),
      ...aliveExpenses.filter((e) => !tripById.has(e.tripId) || !momentById.has(e.momentId)).map((e) => e.id),
    ],
  );

  // 2. 부모는 지워졌는데 자식이 살아 있음 — cascade가 새는 자리(오늘 실제로 겪은 형태).
  add(
    'ALIVE_UNDER_DELETED',
    'now',
    '지운 여행·순간에 살아 있는 기록',
    '부모가 지워졌는데 딸린 기록이 활성으로 남아 있어요. 화면엔 안 보이지만 서버·저장소에는 남습니다. 동기화를 눌러도 사라지지 않으면 알려주세요.',
    [
      ...aliveMoments.filter((m) => tripById.get(m.tripId)?.deletedAt).map((m) => m.id),
      ...aliveMedia.filter((m) => tripById.get(m.tripId)?.deletedAt || momentById.get(m.momentId)?.deletedAt).map((m) => m.id),
      ...aliveExpenses.filter((e) => tripById.get(e.tripId)?.deletedAt || momentById.get(e.momentId)?.deletedAt).map((e) => e.id),
    ],
  );

  // 3. 대표사진이 사라짐 — 표지가 빈 카드로 보인다.
  add(
    'DANGLING_COVER',
    'prevent',
    '없는 사진을 대표로 지정',
    '여행 표지로 지정된 사진이 지금은 없어요. 표지만 비어 보일 뿐 다른 기록은 안전합니다. 표지를 다시 고르면 정리됩니다.',
    aliveTrips.filter((t) => t.coverMediaId && !mediaIds.has(t.coverMediaId)).map((t) => t.id),
  );

  // 4. id 형식 위반 — 동기화·저장 경로가 id 형식을 전제한다.
  add(
    'BAD_ID_FORMAT',
    'now',
    '식별번호 형식이 어긋남',
    '내부 식별번호가 정해진 형식이 아니에요. 이 기록은 동기화나 사진 저장에서 거부될 수 있습니다.',
    all.filter((r) => !UUID_RE.test(r.id)).map((r) => r.id),
  );

  // 5. 같은 id 중복 — 하나가 다른 하나를 덮어쓴다.
  const seen = new Set<string>();
  const dup: string[] = [];
  for (const r of all) {
    if (seen.has(r.id)) dup.push(r.id);
    else seen.add(r.id);
  }
  add(
    'DUPLICATE_ID',
    'now',
    '같은 식별번호가 두 번',
    '서로 다른 기록이 같은 식별번호를 쓰고 있어요. 동기화에서 하나가 다른 하나를 덮어쓸 수 있습니다.',
    dup,
  );

  // 6. 시간 역전 — 만든 시각이 고친 시각보다 나중.
  add(
    'TIME_INVERSION',
    'prevent',
    '만든 시각이 고친 시각보다 늦음',
    '기록의 시간 정보가 앞뒤가 안 맞아요. 기기 시계가 어긋났을 때 생깁니다. 지금 사용에는 지장이 없지만, 어느 쪽이 최신인지 판단할 때 헷갈릴 수 있어요.',
    all.filter((r) => r.createdAt && r.updatedAt && r.createdAt > r.updatedAt).map((r) => r.id),
  );

  // 7. 세대(version) 이상 — 병합 판정의 기준값.
  add(
    'BAD_VERSION',
    'prevent',
    '세대 번호가 이상함',
    '기록의 세대 번호가 1보다 작아요. 여러 기기에서 같은 기록을 고쳤을 때 어느 것이 최신인지 판단하는 값입니다.',
    all.filter((r) => !Number.isFinite(r.version) || r.version < 1).map((r) => r.id),
  );

  // 8. 좌표 범위 — 지도가 엉뚱한 곳을 가리킨다.
  add(
    'COORD_RANGE',
    'prevent',
    '좌표가 지구 밖',
    '위도·경도 값이 가능한 범위를 벗어났어요. 지도에서 엉뚱한 위치로 보일 수 있습니다.',
    aliveMoments
      .filter((m) => (m.lat != null && Math.abs(m.lat) > 90) || (m.lng != null && Math.abs(m.lng) > 180))
      .map((m) => m.id),
  );

  // 9. 금액 이상 — 합계가 조용히 틀어진다.
  add(
    'BAD_AMOUNT',
    'prevent',
    '비용 금액이 이상함',
    '금액이 0 이하이거나 숫자가 아니에요. 합계가 실제와 다르게 보일 수 있습니다.',
    aliveExpenses.filter((e) => e.originalAmount != null && !(e.originalAmount > 0)).map((e) => e.id),
  );

  // 10. 사진 없는 순간 — 결함이 아니라 정보(글만 적은 순간은 정상).
  add(
    'MOMENT_NO_MEDIA',
    'info',
    '사진 없는 순간',
    '사진 없이 글만 있는 순간이에요. 정상입니다 — 참고로만 알려드립니다.',
    aliveMoments.filter((m) => !aliveMedia.some((x) => x.momentId === m.id)).map((m) => m.id),
  );

  const bySeverity: Record<Severity, number> = { now: 0, prevent: 0, info: 0 };
  for (const f of findings) bySeverity[f.severity] += 1;

  return {
    checked: all.length,
    findings: findings.sort((a, b) => sevRank(a.severity) - sevRank(b.severity)),
    bySeverity,
    ok: bySeverity.now === 0,
  };
}

function sevRank(s: Severity): number {
  return s === 'now' ? 0 : s === 'prevent' ? 1 : 2;
}
