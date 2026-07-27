// tests/unit/instantFormat.test.ts — **같은 순간을 같은 방식으로 적는가.**
//
// ── 실제로 밟은 것(2026-07-27 사용자 실기기) ──────────────────────────
// 진단이 사진 9건을 「만든 시각이 고친 시각보다 늦음」으로 띄웠다. 사용자가 물었다: *"이 문제
// 해결하자."* 그런데 서버를 열어 보니 `created_at = updated_at`으로 **완전히 같았다.**
// 틀린 것은 데이터가 아니라 **비교**였다:
//
//   로컬 createdAt (JS)        2026-07-26T17:29:48.340Z
//   서버발 updatedAt (PostgREST) 2026-07-26T17:29:48.34+00:00
//   문자열 대소 → '0'(0x30) > '+'(0x2B) → createdAt이 "더 크다"
//
// 왜 유닛이 없어서 놓쳤나: rowmap 왕복 유닛은 **우리가 만든 문자열**을 넣고 되읽었다.
// 서버가 실제로 뭘 주는지는 아무도 안 넣어봤다 — 이 파일은 그 자리를 메운다.
// (M-0033과 같은 형태다: 조각마다 유닛이 있었고 **이음매**에는 없었다.)

import { describe, it, expect } from 'vitest';
import { isoInstant, isoInstantOrNull, isCanonicalInstant, withCanonicalStamps, compareInstants } from '../../src/domain/time';
import { fromRow } from '../../src/domain/trip/rowmap';
import { fromMomentRow } from '../../src/domain/moment/rowmap';
import { fromMediaRow } from '../../src/domain/media/rowmap';
import { fromExpenseRow } from '../../src/domain/expense/rowmap';
import { mergeDecision } from '../../src/sync/merge';
import { checkIntegrity } from '../../src/domain/integrity';
import { groupMomentsByDay } from '../../src/domain/moment/timeline';
import { latestOccurredAt } from '../../src/domain/moment/whenDefault';

/** 서버가 실제로 준 값(2026-07-26 journey.media, `to_jsonb`로 확인). 지어낸 예가 아니다. */
const PG = '2026-07-26T17:29:48.34+00:00';
/** 같은 순간을 JS가 적는 법. */
const JS = '2026-07-26T17:29:48.340Z';

const U = (n: number): string => `0000000${n}-0000-4000-8000-000000000000`.slice(-36);

describe('① 서버 표기와 로컬 표기는 **같은 순간**이다 — 그런데 문자열로는 다르다', () => {
  it('두 표기가 같은 순간을 가리킨다(전제 확인)', () => {
    expect(Date.parse(PG)).toBe(Date.parse(JS));
  });

  it('그런데 문자열 대소로는 로컬이 더 크다 — 이 한 줄이 사고의 전부였다', () => {
    expect(JS > PG).toBe(true);
  });

  it('isoInstant가 둘을 하나로 만든다', () => {
    expect(isoInstant(PG)).toBe(JS);
    expect(isoInstant(JS)).toBe(JS);
  });

  it('ms가 아예 없는 표기도(Postgres는 .000을 통째로 생략한다)', () => {
    expect(isoInstant('2026-07-26T17:29:48+00:00')).toBe('2026-07-26T17:29:48.000Z');
  });

  it('UTC가 아닌 오프셋도 같은 순간으로 옮긴다(표기만 바뀐다)', () => {
    expect(isoInstant('2026-07-27T02:29:48.34+09:00')).toBe(JS);
  });

  it('못 읽는 값은 **그대로 둔다** — 지어내지 않는다(비타협 원칙 #4)', () => {
    expect(isoInstant('not-a-date')).toBe('not-a-date');
    expect(isoInstant('')).toBe('');
  });

  it('null은 null(tombstone 없음을 시각으로 만들지 않는다)', () => {
    expect(isoInstantOrNull(null)).toBeNull();
    expect(isoInstantOrNull(PG)).toBe(JS);
  });

  it('isCanonicalInstant는 정규형만 참', () => {
    expect(isCanonicalInstant(JS)).toBe(true);
    expect(isCanonicalInstant(PG)).toBe(false);
    expect(isCanonicalInstant('not-a-date')).toBe(true); // 못 읽는 값은 바꿀 수 없다 → 표기 문제로 세지 않는다
  });
});

describe('② 서버 경계 4곳 전부가 정규화한다 (§7 — 형제를 손으로 세지 않는다)', () => {
  const stamps = { created_at: PG, updated_at: PG, deleted_at: PG };

  it('trip', () => {
    const r = fromRow({ id: U(1), user_id: U(9), title: 't', start_date: null, end_date: null, status: 'active', version: 1, client_operation_id: null, ...stamps });
    expect([r.createdAt, r.updatedAt, r.deletedAt]).toEqual([JS, JS, JS]);
  });

  it('moment', () => {
    const r = fromMomentRow({ id: U(2), user_id: U(9), trip_id: U(1), occurred_at: PG, title: '', note: '', emotion: '', place_name: '', place_lat: null, place_lng: null, version: 1, client_operation_id: null, ...stamps });
    expect([r.createdAt, r.updatedAt, r.deletedAt]).toEqual([JS, JS, JS]);
  });

  it('media', () => {
    const r = fromMediaRow({ id: U(3), user_id: U(9), moment_id: U(2), trip_id: U(1), storage_path: null, width: 1, height: 1, taken_at: null, bytes_display: 1, source: 'user', version: 1, client_operation_id: null, ...stamps });
    expect([r.createdAt, r.updatedAt, r.deletedAt]).toEqual([JS, JS, JS]);
  });

  it('expense', () => {
    const r = fromExpenseRow({ id: U(4), user_id: U(9), moment_id: U(2), trip_id: U(1), original_amount: 1, original_currency: 'KRW', category: '', note: '', version: 1, client_operation_id: null, ...stamps });
    expect([r.createdAt, r.updatedAt, r.deletedAt]).toEqual([JS, JS, JS]);
  });

  it('deleted_at이 null이면 null 그대로(활성 행을 tombstone으로 만들지 않는다)', () => {
    const r = fromRow({ id: U(1), user_id: U(9), title: 't', start_date: null, end_date: null, status: 'active', version: 1, client_operation_id: null, created_at: PG, updated_at: PG, deleted_at: null });
    expect(r.deletedAt).toBeNull();
  });
});

describe('③ LWW가 표기에 흔들리지 않는다 — 여기가 기억이 사라질 수 있던 자리', () => {
  const meta = (updatedAt: string, version: number) => ({ id: U(1), createdAt: JS, updatedAt, version, deletedAt: null });

  it('표기만 다른 같은 순간이면 **version이 판정한다**(예전엔 이 갈래를 통째로 건너뛰었다)', () => {
    // 문자열 대소로는 server(`+00:00`) < local(`Z`)라 곧장 keep-local로 빠졌고,
    // **더 높은 세대의 서버 행이 조용히 무시됐다.**
    expect(mergeDecision(meta(JS, 1), meta(PG, 2))).toBe('take-server');
  });

  it('같은 순간·같은 세대면 로컬 유지(안정)', () => {
    expect(mergeDecision(meta(JS, 3), meta(PG, 3))).toBe('keep-local');
  });

  it('서버가 실제로 더 최신이면 표기가 달라도 서버가 이긴다', () => {
    expect(mergeDecision(meta(JS, 5), meta('2026-07-26T17:29:49+00:00', 1))).toBe('take-server');
  });

  it('로컬이 더 최신이면 로컬이 이긴다', () => {
    expect(mergeDecision(meta('2026-07-26T17:29:50.000Z', 1), meta(PG, 9))).toBe('keep-local');
  });

  it('tombstone 우위는 그대로다 — 시각으로 부활하지 않는다(불변식 3)', () => {
    const localAlive = { id: U(1), createdAt: JS, updatedAt: '2026-07-26T23:00:00.000Z', version: 2, deletedAt: null };
    const serverDead = { id: U(1), createdAt: JS, updatedAt: PG, version: 2, deletedAt: PG };
    expect(mergeDecision(localAlive, serverDead)).toBe('take-server'); // 동률 → 삭제가 이긴다
  });

  it('compareInstants: 못 읽는 값이면 null(모르는 값으로 승부를 내지 않는다)', () => {
    expect(compareInstants('nope', JS)).toBeNull();
    expect(compareInstants(JS, PG)).toBe(0);
  });
});

describe('④ 진단이 **멀쩡한 것을 문제라 하지 않는다** (오탐은 틀린 게이트다 — §11 ③)', () => {
  const row = (createdAt: string, updatedAt: string) => ({ id: U(1), deletedAt: null, createdAt, updatedAt, version: 1 });
  const codes = (createdAt: string, updatedAt: string): string[] =>
    checkIntegrity({ trips: [row(createdAt, updatedAt)], moments: [], media: [], expenses: [] }).findings.map((f) => f.code);

  it('표기만 다른 같은 순간은 **시간 역전이 아니다**(사용자가 본 그 9건)', () => {
    expect(codes(JS, PG)).not.toContain('TIME_INVERSION');
  });

  it('대신 **표기 문제로** 말한다 — 침묵하지도, 겁주지도 않는다', () => {
    expect(codes(JS, PG)).toContain('BAD_TIME_FORMAT');
  });

  it('진짜 시간 역전은 여전히 잡는다(게이트를 느슨하게 만든 게 아니다)', () => {
    expect(codes('2026-07-05T00:00:00.000Z', '2026-07-01T00:00:00.000Z')).toContain('TIME_INVERSION');
  });

  it('표기가 달라도 진짜 역전이면 둘 다 말한다', () => {
    const c = codes('2026-07-05T00:00:00.000Z', '2026-07-01T00:00:00+00:00');
    expect(c).toContain('TIME_INVERSION');
    expect(c).toContain('BAD_TIME_FORMAT');
  });

  it('정규 표기로 앞뒤가 맞으면 **아무 말도 안 한다**(침묵이 정상 — §8)', () => {
    const c = codes(JS, '2026-07-26T18:00:00.000Z');
    expect(c).not.toContain('TIME_INVERSION');
    expect(c).not.toContain('BAD_TIME_FORMAT');
  });

  it('tombstone 시각의 표기도 본다(형제를 빠뜨리지 않는다)', () => {
    const r = { id: U(1), deletedAt: PG, createdAt: JS, updatedAt: JS, version: 1 };
    const c = checkIntegrity({ trips: [r], moments: [], media: [], expenses: [] }).findings.map((f) => f.code);
    expect(c).toContain('BAD_TIME_FORMAT');
  });
});

describe('⑤ withCanonicalStamps — 이미 저장된 행을 데려오는 변환(§10 ②)', () => {
  it('시각 3칸만 바꾸고 나머지는 건드리지 않는다', () => {
    const before = { id: U(1), title: '제주', version: 7, createdAt: PG, updatedAt: PG, deletedAt: PG };
    const after = withCanonicalStamps(before);
    expect(after).toEqual({ ...before, createdAt: JS, updatedAt: JS, deletedAt: JS });
  });

  it('**같은 순간**이다 — version·LWW 의미가 바뀌지 않으므로 사용자 편집이 아니다', () => {
    const after = withCanonicalStamps({ id: U(1), createdAt: PG, updatedAt: PG, deletedAt: null });
    expect(Date.parse(after.updatedAt)).toBe(Date.parse(PG));
    expect(after.deletedAt).toBeNull();
  });

  it('멱등 — 두 번 돌려도 같다(1회 표식이 실패해도 안전)', () => {
    const once = withCanonicalStamps({ id: U(1), createdAt: PG, updatedAt: PG, deletedAt: null });
    expect(withCanonicalStamps(once)).toEqual(once);
  });
});

// ── 자기점검에서 나온 구멍(2026-07-27) ────────────────────────────────
// M-0034를 고치며 `created_at`·`updated_at`·`deleted_at` **셋만** 정규화했다. 그런데 서버에서
// 오는 시각은 그 셋이 아니다 — `occurred_at`(순간의 발생 시각)과 `taken_at`(사진 촬영 시각)이
// 더 있고, **둘 다 문자열로 정렬된다**(`timeline.ts`의 `localeCompare`, `tripDetail`의 `>`).
// 형제 목록을 **파일 단위**로만 뽑고 **필드 단위**로는 안 뽑은 §7 미완이었다.
describe('⑥ 시각 컬럼을 **빠짐없이** 정규화한다 (§7 — 형제는 파일이 아니라 필드다)', () => {
  it('순간의 발생 시각(occurred_at)도 정규 표기로 온다', () => {
    const r = fromMomentRow({ id: U(2), user_id: U(9), trip_id: U(1), occurred_at: PG, title: '', note: '', emotion: '', place_name: '', place_lat: null, place_lng: null, version: 1, client_operation_id: null, created_at: PG, updated_at: PG, deleted_at: null });
    expect(r.occurredAt).toBe(JS);
  });

  it('사진의 촬영 시각(taken_at)도 — R2 파일 이름의 앞부분이 여기서 나온다', () => {
    const r = fromMediaRow({ id: U(3), user_id: U(9), moment_id: U(2), trip_id: U(1), storage_path: null, width: 1, height: 1, taken_at: PG, bytes_display: 1, source: 'user', version: 1, client_operation_id: null, created_at: PG, updated_at: PG, deleted_at: null });
    expect(r.takenAt).toBe(JS);
  });

  it('서버가 null이면 빈 문자열 그대로(없는 시각을 지어내지 않는다)', () => {
    const r = fromMomentRow({ id: U(2), user_id: U(9), trip_id: U(1), occurred_at: null, title: '', note: '', emotion: '', place_name: '', place_lat: null, place_lng: null, version: 1, client_operation_id: null, created_at: PG, updated_at: PG, deleted_at: null });
    expect(r.occurredAt).toBe('');
  });

  it('타임라인 정렬이 표기에 흔들리지 않는다 — 정규화 뒤에는 같은 순간이 같은 문자열이다', () => {
    const fromServer = isoInstant(PG);
    const madeLocally = JS;
    expect(fromServer.localeCompare(madeLocally)).toBe(0);
  });
});

// ── 논리적 충돌 점검(2026-07-27) ─────────────────────────────────────
// 입구(rowmap)만 막고 나머지 층을 안 맞추면 규율이 절반만 산다. 셋을 맞췄다:
// ①비교도 순간으로(정렬) ②이미 저장된 행의 그 필드도 정리 ③진단도 그 필드를 본다.
describe('⑦ 정규화·정리·판정·정렬이 **같은 필드 집합**을 본다 (§7 대칭)', () => {
  const P = { createdAt: PG, updatedAt: PG, deletedAt: null, occurredAt: PG, takenAt: PG };

  it('withCanonicalStamps가 occurredAt·takenAt까지 다시 쓴다(정리의 절반이 빠져 있었다)', () => {
    const after = withCanonicalStamps(P);
    expect([after.createdAt, after.updatedAt, after.occurredAt, after.takenAt]).toEqual([JS, JS, JS, JS]);
  });

  it('빈 값·null은 건드리지 않는다(없는 시각을 지어내지 않는다)', () => {
    const after = withCanonicalStamps({ ...P, occurredAt: '', deletedAt: null });
    expect(after.occurredAt).toBe('');
    expect(after.deletedAt).toBeNull();
  });

  it('시각이 아닌 필드는 그대로(이름이 At으로 안 끝나면 대상이 아니다)', () => {
    const after = withCanonicalStamps({ ...P, startDate: '2026-07-16', title: '제주' });
    expect(after.startDate).toBe('2026-07-16');
    expect(after.title).toBe('제주');
  });

  it('진단이 occurredAt의 옛 표기도 본다 — 예전엔 「0건」이라 말했다', () => {
    const m = { id: U(2), deletedAt: null, createdAt: JS, updatedAt: JS, version: 1, tripId: U(1), occurredAt: PG };
    const c = checkIntegrity({ trips: [], moments: [m], media: [], expenses: [] }).findings.map((f) => f.code);
    expect(c).toContain('BAD_TIME_FORMAT');
  });

  it('진단이 takenAt의 옛 표기도 본다', () => {
    const md = { id: U(3), deletedAt: null, createdAt: JS, updatedAt: JS, version: 1, tripId: U(1), momentId: U(2), takenAt: PG };
    const c = checkIntegrity({ trips: [], moments: [], media: [md], expenses: [] }).findings.map((f) => f.code);
    expect(c).toContain('BAD_TIME_FORMAT');
  });

  it('전부 정규 표기면 침묵한다(§8)', () => {
    const m = { id: U(2), deletedAt: null, createdAt: JS, updatedAt: JS, version: 1, tripId: U(1), occurredAt: JS };
    const c = checkIntegrity({ trips: [], moments: [m], media: [], expenses: [] }).findings.map((f) => f.code);
    expect(c).not.toContain('BAD_TIME_FORMAT');
  });
});

describe('⑧ 정렬이 **가짜 차이**를 보지 않는다 (정직하게: 여기가 진짜 위험이다)', () => {
  // ⚠️ 처음에 쓴 검사는 **공허했다.** 「옛 표기가 섞이면 순서가 뒤집힌다」는 케이스를 만들려
  // 했는데, 실측해 보니 PostgREST는 timestamptz를 **항상 `+00:00`**으로 준다 — 초 단위까지
  // 자릿수가 맞아 **사전순과 시간순이 대체로 일치한다.** 주입(localeCompare 복귀)에도 유닛이
  // 통과했고 게이트만 잡았다. 그래서 주장도 검사도 고쳤다: 실제 위험은 순서 뒤집힘이 아니라
  // **같은 순간을 다르다고 보는 것**(가짜 차이)이고, 그게 동률 처리를 건너뛰게 만든다.
  const mk = (id: number, occurredAt: string) => ({
    id: U(id), tripId: U(1), occurredAt, title: '', note: '', emotion: '', placeName: '',
    version: 1, createdAt: JS, updatedAt: JS, deletedAt: null,
  });

  it('같은 순간의 두 표기를 문자열은 다르다고 한다 — 이게 가짜 차이다', () => {
    expect('2026-07-16T09:30:00+00:00'.localeCompare('2026-07-16T09:30:00.000Z')).not.toBe(0);
  });

  it('정렬은 그것을 **동률로** 본다(정규화 + 순간 비교, 두 층 모두)', () => {
    expect(compareInstants('2026-07-16T09:30:00+00:00', '2026-07-16T09:30:00.000Z')).toBe(0);
  });

  it('시간순 자체는 유지된다(느슨해진 게 아니다)', () => {
    const early = '2026-07-16T09:30:00.400Z';
    const late = '2026-07-16T09:30:00.900Z';
    const groups = groupMomentsByDay([mk(2, late), mk(3, early)] as never, '2026-07-16');
    expect(groups[0]!.items.map((m) => m.occurredAt)).toEqual([early, late]);
  });

  it('가장 늦은 순간을 고를 때도 순간으로 비교한다', () => {
    expect(latestOccurredAt([{ occurredAt: '2026-07-16T09:30:00.900Z' }, { occurredAt: '2026-07-16T09:30:00.400Z' }]))
      .toBe('2026-07-16T09:30:00.900Z');
  });

  it('같은 순간이면 앞의 것을 유지한다(안정 — 화면이 새로고침마다 흔들리지 않게)', () => {
    expect(latestOccurredAt([{ occurredAt: '2026-07-16T09:30:00+00:00' }, { occurredAt: '2026-07-16T09:30:00.000Z' }]))
      .toBe('2026-07-16T09:30:00+00:00');
  });

  it('못 읽는 값은 기준이 되지 못한다(지어낸 값이 이기지 않게)', () => {
    expect(latestOccurredAt([{ occurredAt: 'nope' }, { occurredAt: JS }])).toBe(JS);
    expect(latestOccurredAt([])).toBeNull();
  });
});
