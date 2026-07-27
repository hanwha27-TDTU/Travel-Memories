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

import { compareInstants, isCanonicalInstant, instantFieldsOf } from './time';

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

export interface AudioRowLike extends IdCheckRow {
  tripId: string;
  momentId: string;
}

/**
 * 점검 대상 스냅샷.
 *
 * ⚠️ 2026-07-27: 소리가 여기 **없던 동안, 무결성 점검은 소리를 못 봤다** — 부모 없는 소리도,
 * 지운 순간에 살아남은 소리도, 옛 표기로 박힌 `recordedAt`도 전부 「0건」으로 보고했다.
 * 그건 정상이라는 뜻이 아니라 **안 봤다는 뜻**이었고, 지표가 자기 시야의 경계를 밝히지 않으면
 * 그건 §8이 말하는 거짓말이다. 소리는 서버에 안 갈 뿐 **로컬 참조 무결성은 형제와 똑같이**
 * 지켜야 한다 — 오히려 서버 사본이 없으니 이 점검이 **유일한 감시자**다.
 */
export interface IntegritySnapshot {
  trips: TripRowLike[];
  moments: MomentRowLike[];
  media: MediaRowLike[];
  expenses: ExpenseRowLike[];
  audio: AudioRowLike[];
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
export const CHECK_COUNT = 11;

/** `checkIntegrity` 안의 발견 등록 함수 — 점검을 곁 함수로 뽑을 때 그대로 넘긴다. */
type AddFinding = (code: string, severity: Severity, title: string, detail: string, hits: string[]) => void;

/**
 * 부모-자식 참조 점검 두 가지. **자식 종류가 늘면 여기 한 곳만 늘어난다.**
 *
 * 왜 뽑았나(2026-07-27): 소리를 자식으로 더하자 `checkIntegrity`가 래칫(`check-fn-size`)을
 * 넘었다. 주석을 지워 줄이는 대신 응집된 덩어리를 뽑았고 결과가 더 낫다 —
 * 자식 목록이 한 배열로 모여, 다음 형제를 더할 자리가 눈에 보인다(§11 「게이트가 설계를 밀어준다」).
 */
function parentChecks(s: IntegritySnapshot, add: AddFinding): void {
  const tripById = new Map(s.trips.map((t) => [t.id, t]));
  const momentById = new Map(s.moments.map((m) => [m.id, m]));

  /** 여행·순간을 가리키는 **활성** 자식 전부. 새 자식 종류는 이 배열에 한 줄 더한다. */
  const children: { tripId: string; momentId?: string; id: string }[] = [
    ...s.moments.filter((m) => m.deletedAt === null).map((m) => ({ tripId: m.tripId, id: m.id })),
    ...s.media.filter((m) => m.deletedAt === null).map((m) => ({ tripId: m.tripId, momentId: m.momentId, id: m.id })),
    ...s.expenses.filter((e) => e.deletedAt === null).map((e) => ({ tripId: e.tripId, momentId: e.momentId, id: e.id })),
    ...s.audio.filter((a) => a.deletedAt === null).map((a) => ({ tripId: a.tripId, momentId: a.momentId, id: a.id })),
  ];
  const missing = (c: { tripId: string; momentId?: string }): boolean =>
    !tripById.has(c.tripId) || (c.momentId !== undefined && !momentById.has(c.momentId));
  const underDeleted = (c: { tripId: string; momentId?: string }): boolean =>
    !!tripById.get(c.tripId)?.deletedAt || (c.momentId !== undefined && !!momentById.get(c.momentId)?.deletedAt);

  add(
    'ORPHAN_PARENT',
    'now',
    '속한 여행·순간이 없는 기록',
    '이 기록이 가리키는 여행이나 순간을 찾을 수 없어요. 화면 어디에도 나타나지 않아 사실상 잃어버린 상태입니다. 백업 파일이 있으면 복원으로 되살릴 수 있어요.',
    children.filter(missing).map((c) => c.id),
  );

  // 소리는 서버로 안 가므로 아래 안내문("서버·저장소에는 남습니다")이 소리엔 정확하진 않다.
  // 그래도 **같은 발견으로 묶는다**: 사용자가 고쳐야 할 상태는 동일하고(지운 부모에 딸린 것이
  // 살아 있다), 소리만 따로 코드를 만들면 화면에 같은 성격의 줄이 둘로 늘어난다(§7 화면 대칭).
  add(
    'ALIVE_UNDER_DELETED',
    'now',
    '지운 여행·순간에 살아 있는 기록',
    '부모가 지워졌는데 딸린 기록이 활성으로 남아 있어요. 화면엔 안 보이지만 서버·저장소에는 남습니다. 동기화를 눌러도 사라지지 않으면 알려주세요.',
    children.filter(underDeleted).map((c) => c.id),
  );
}

/**
 * 시각 점검 두 가지. **내용(순간)과 형식(표기)을 나눈다** — 하나로 묶었다가 사고가 났다.
 *
 * ── M-0034 (2026-07-27 사용자 실기기) ─────────────────────────────────
 * 예전 판정은 `r.createdAt > r.updatedAt`, 즉 **문자열 대소**였다. 그래서 서버에서 온
 * `2026-07-26T17:29:48.34+00:00`(updatedAt)과 로컬의 `2026-07-26T17:29:48.340Z`(createdAt)를
 * 비교해 — **같은 순간인데** `'0'`(0x30) > `'+'`(0x2B)이므로 — 사진 9건 전부를
 * 「만든 시각이 고친 시각보다 늦음」으로 띄웠다. 데이터는 처음부터 멀쩡했다.
 *
 * 오탐은 "빡빡한 게이트"가 아니라 **틀린 게이트**다(§11 ③). 사용자가 무시하기 시작하면
 * 그 지표는 죽고, 진짜 시간 역전이 왔을 때 아무도 안 본다. 그래서 둘로 나눴다:
 *  · `TIME_INVERSION` — **순간**으로 잰다. 진짜로 앞뒤가 안 맞는 것만.
 *  · `BAD_TIME_FORMAT` — **표기**만 본다. 순간은 맞지만 적는 법이 다른 것.
 */
function timeChecks(all: IdCheckRow[], add: AddFinding): void {
  add(
    'TIME_INVERSION',
    'prevent',
    '만든 시각이 고친 시각보다 늦음',
    '기록의 시간 정보가 앞뒤가 안 맞아요. 기기 시계가 어긋났을 때 생깁니다. 지금 사용에는 지장이 없지만, 어느 쪽이 최신인지 판단할 때 헷갈릴 수 있어요.',
    // 못 읽는 값은 `?? 0`으로 **역전이 아니라고** 본다 — 그건 아래 표기 점검의 몫이다.
    all.filter((r) => (compareInstants(r.createdAt, r.updatedAt) ?? 0) > 0).map((r) => r.id),
  );

  // **이미 저장된 것**을 보는 런타임 지표(§10 ②). 정적 게이트는 이 부류를 원리적으로 못 잡는다 —
  // 코드를 고쳐도 옛 표기로 박힌 행은 그대로다. `normalizeStampsOnce()`가 동기화 때 정리하므로
  // **정상은 0건**이고, 0이 아니면 그 정리가 아직 안 돌았거나 실패한 것이다.
  // 필드 목록을 손으로 적지 않는다 — `instantFieldsOf`가 행에서 뽑는다(자기점검 2026-07-27).
  // 예전엔 `createdAt`·`updatedAt`·`deletedAt` 셋만 봐서, 순간의 `occurredAt`과 사진의
  // `takenAt`이 옛 표기로 남아 있어도 **앱이 「0건」이라고 말했다** — 지표가 자기 시야의
  // 경계를 밝히지 않은 셈이다(§7-C의 세 번째 거짓말).
  const badFormat = (r: IdCheckRow): boolean =>
    instantFieldsOf(r).some((k) => !isCanonicalInstant((r as unknown as Record<string, string>)[k] as string));
  add(
    'BAD_TIME_FORMAT',
    'prevent',
    '시각 표기가 표준형이 아님',
    '시각이 이 앱의 표준 표기로 저장되지 않았어요. 같은 순간을 서로 다르게 적으면 어느 쪽이 최신인지 판단할 때 어긋날 수 있습니다. 동기화를 한 번 실행하면 자동으로 정리됩니다.',
    all.filter(badFormat).map((r) => r.id),
  );
}

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

  const mediaIds = new Set(s.media.map((m) => m.id));
  // 소리도 `all`에 든다 — id 형식·중복·시각 표기·세대 점검은 **도메인을 가리지 않는다.**
  const all = [...s.trips, ...s.moments, ...s.media, ...s.expenses, ...s.audio];

  // 1·2. 부모-자식 참조 점검 — 자식 종류가 늘 때 **한 곳만** 늘어나게 곁 함수로 뺐다.
  parentChecks(s, add);

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

  // 6·6-B. 시각 점검 — 순간(내용)과 표기(형식)를 **나눠서** 본다. 아래 참조.
  timeChecks(all, add);

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
