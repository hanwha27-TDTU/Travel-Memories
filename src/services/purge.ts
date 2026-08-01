// services/purge.ts — 영구삭제(휴지통 비우기)의 **단일 구현**.
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 이 파일이 생겼는가 (사용자 지적 2026-07-26)
// ─────────────────────────────────────────────────────────────────────────────
// "다른 기기에서 휴지통을 비웠으면 연동기기에서도 사라져 있어야 되는 거 아닌가요?"
//
// 맞다. ADR-0025는 영구삭제를 **기기별**로 뒀다 — 한 기기에서 비워도 다른 기기 휴지통엔 그대로
// 남았다. 1인 사용 앱에서 '영구'가 이 기기만을 뜻하면 그건 영구삭제가 아니라 숨김이다.
//
// 이어서(같은 날): *"의도를 가지고 삭제하는건데 서버에 왜 살려두나요? 자료를.. 2번 이상 클릭으로
// 삭제한거라면 영원히 복구가 안되도록 기록줄까지도 삭제시켜야 되는게 맞는거 아닌가요?"*
//
// 이것도 맞다. 서버 행 하드 삭제를 두 번(ADR-0025·0027) 기각한 근거는 **오직 하나**였다 —
// *"그 사실을 모르는 다른 기기가 자기 사본을 다시 올려 좀비를 만든다."* 그런데 그 목적은
// "행을 남긴다"가 아니라 **"서버가 재삽입을 거부한다"**로 푸는 게 옳다. `journey.purged_ids`
// 원장 + BEFORE INSERT 트리거(마이그레이션 0012)가 그 일을 한다. 그러면 자료를 살려둘 이유가
// 사라진다 — 서버엔 **id·소유자·시각만** 남고 제목·메모·좌표·금액은 실제로 없어진다(ADR-0030).
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 "도메인별 함수"가 아니라 등록부 하나인가 (CLAUDE.md §7)
// ─────────────────────────────────────────────────────────────────────────────
// 이 저장소의 삭제 결함은 **전부 같은 형태**였다 — 도메인 4종 × 연산 3종(삭제·복원·영구삭제)
// × 표면 4종(로컬 행·동기화 큐·서버 행·사진 바이트)이라는 행렬을 **손으로 한 칸씩 채워왔고**,
// 사고가 날 때마다 빈 칸이 하나씩 드러났다:
//   · M-0006 cascade가 순간엔 op를 만들고 사진·비용엔 안 만듦
//   · M-0007 실행취소가 비용만 복원 안 함
//   · ADR-0025 영구삭제가 mergeDecision과 안 맞물려 부활
//   · M-0012 같은 결함을 고치면서 형제 화면 절반을 빠뜨림
//
// 그래서 영구삭제 쪽 칸은 **`Record<PurgeDomain, …>` 하나**로 못박는다. 도메인을 하나라도
// 빠뜨리면 **컴파일 오류**가 난다 — 다음 사람이 이 규율을 몰라도 지켜진다(§7 2층 구조적 강제).

import type { Table } from 'dexie';
import { db, type PurgedId } from '../offline/db';

export const PURGE_DOMAINS = ['trip', 'moment', 'media', 'expense', 'audio', 'place'] as const;
export type PurgeDomain = (typeof PURGE_DOMAINS)[number];

interface DomainPurge {
  /** 이 도메인의 로컬 테이블. 영구삭제는 여기서 행을 **하드 삭제**한다(로컬 저장공간을 실제로 비운다). */
  table: () => Table<{ id: string }, string>;
  /** 서버 테이블 이름(snake_case 경계는 여기서만 만난다). */
  remoteTable: string;
  /** 원격 바이트(R2·Supabase 객체)를 가진 도메인인가 — 사진만 해당. */
  hasRemoteBytes: boolean;
  /**
   * 이 도메인이 **여행의 자식인가**(서버 테이블에 `trip_id` 컬럼이 있어 `trip_id`로 묶어 지울 수 있는가).
   *
   * 🔴 왜 데이터인가(C-1 · 2026-08-01 감사·실서버 확정): 여행 영구삭제는 자식들을 `trip_id`로
   * 찾는데 **`journey.places`에는 `trip_id`가 없다**(장소는 여행의 자식이 아니라 사용자 소유 —
   * 0022의 의도적 비대칭). 그런데 자식 목록을 「`trip` 빼고 전부」로 뽑던 코드가 장소까지 넣어
   * `trip_id`로 질의했고, PostgREST가 `42703 column does not exist`를 냈다 → **여행 단위
   * 영구삭제 전체가 서버에 한 번도 전파되지 못하고 무한 재시도**에 빠졌다(다른 기기엔 그 여행이
   * 영원히 살아 있었다). 게이트 40종·유닛이 전부 초록이었다.
   *
   * 근본형은 §7 M-0057이다 — *"형제의 규율을 물려받되, 그 자리에서 참인지 다시 묻는다."*
   * 「trip 빼고 전부」라는 산문 대신 **각 형제가 자기 사정을 데이터로 선언**하게 한다: place가
   * `false`를 안 적으면 이 Record가 컴파일되지 않는다. 그리고 `check-purge-scope`가 이 플래그를
   * 실제 rowmap의 `trip_id` 유무와 대조해, 산문이 스키마와 갈라지는 것을 막는다(3층).
   */
  tripScoped: boolean;
}

/**
 * 도메인 등록부. **Record이므로 빠뜨리면 컴파일이 안 된다.**
 * 새 동기화 도메인이 생기면 컴파일러가 여기로 데려온다 — 그게 이 타입의 목적이다.
 */
export const DOMAIN_PURGE: Record<PurgeDomain, DomainPurge> = {
  trip: {
    table: () => db().localTrips as unknown as Table<{ id: string }, string>,
    remoteTable: 'trips',
    hasRemoteBytes: false,
    tripScoped: false, // 여행 자신은 부모다 — 자식으로서 trip_id로 묶이지 않는다
  },
  moment: {
    table: () => db().localMoments as unknown as Table<{ id: string }, string>,
    remoteTable: 'moments',
    hasRemoteBytes: false,
    tripScoped: true,
  },
  media: {
    // 사진 바이트(표시본·썸네일 blob)는 **로컬 행에 붙어 있으므로** 행을 지우면 함께 사라진다.
    // 원격 바이트는 `pushPurges`가 지운다 — 삭제(휴지통행) 때가 아니라 **영구삭제 때만**이다
    // (정책 2026-07-26: 휴지통에 있는 동안은 남겨 둬야 어느 기기에서 복원해도 사진이 돌아온다).
    table: () => db().localMedia as unknown as Table<{ id: string }, string>,
    remoteTable: 'media',
    hasRemoteBytes: true,
    tripScoped: true,
  },
  expense: {
    table: () => db().localExpenses as unknown as Table<{ id: string }, string>,
    remoteTable: 'expenses',
    hasRemoteBytes: false,
    tripScoped: true,
  },
  audio: {
    // 소리 바이트도 사진과 같다: 로컬 blob은 행에 붙어 있어 행을 지우면 함께 사라지고,
    // R2 객체는 `pushPurges`가 **영구삭제 때만** 지운다(휴지통에 있는 동안은 남겨 둬야
    // 어느 기기에서 복원해도 소리가 돌아온다 — 사진과 같은 정책, ADR-0029).
    table: () => db().localAudio as unknown as Table<{ id: string }, string>,
    remoteTable: 'audio',
    hasRemoteBytes: true,
    tripScoped: true,
  },
  place: {
    // 장소는 바이트가 없다(좌표와 글자뿐) — 지울 원격 객체가 없다.
    //
    // 🔴 장소를 영구삭제하면 그 장소를 가리키던 순간의 링크는 서버에서 **끊긴다**
    // (`moments.place_id`의 `on delete set null` — 0023). 그래도 **순간의 기억은 남는다**:
    // 이름·좌표는 순간 자신이 갖고 있기 때문이다. 링크만 잃고 기록은 잃지 않는다 —
    // 그것이 장소를 부가정보로 설계한 이유다.
    table: () => db().localPlaces as unknown as Table<{ id: string }, string>,
    remoteTable: 'places',
    hasRemoteBytes: false,
    tripScoped: false, // 🔴 여행의 자식이 아니다 — trip_id 컬럼이 없다(C-1). 여행 영구삭제가 건드리지 않는다.
  },
};

/**
 * **여행의 자식 도메인들** — 여행을 영구삭제할 때 `trip_id`로 묶어 함께 지우는 대상.
 *
 * 🔴 장소는 여기 없다(C-1). 예전엔 `PURGE_DOMAINS.filter(d => d !== 'trip')`로 뽑아 장소까지
 * 넣었고, `trip_id` 없는 장소 테이블에 `trip_id`로 질의해 여행 영구삭제가 서버에 영영 전파되지
 * 않았다. 이제 **각 도메인이 선언한 `tripScoped`**로 뽑는다 — 새 형제가 자기 사정을 데이터로
 * 밝히지 않으면 컴파일이 안 되고, `check-purge-scope`가 이 플래그를 실제 스키마와 대조한다.
 */
export function tripScopedChildDomains(): PurgeDomain[] {
  return PURGE_DOMAINS.filter((d) => d !== 'trip' && DOMAIN_PURGE[d].tripScoped);
}

/**
 * **휴지통이 다루는 도메인 전부.** 사용자에게 보이는 층의 진실원이다.
 *
 * 🔴 2026-07-27까지 이 자리에는 `LOCAL_ONLY_DOMAINS = ['audio']`라는 **별도 목록**이 있었다.
 * 소리에는 서버 표가 없어 `remoteTable` 이름을 지어낼 수 없었기 때문이다. 사용자가 그 전제를
 * 없앴다(*"서버에 올라가는 순간 클라우드가 정본이 되야 합니다"*) — 마이그레이션 0019가
 * `journey.audio`를 만들었고, 소리는 `PURGE_DOMAINS`의 다섯 번째 형제가 됐다.
 *
 * 그래서 두 목록은 **같은 것이 됐다.** 빈 `LOCAL_ONLY_DOMAINS`를 남겨 두지 않는 이유:
 * 비어 있는 예외 목록은 *언젠가 또 채워도 된다*는 뜻으로 읽힌다. 이 앱의 결론은 그 반대다 —
 * **로컬에만 있는 자료는 기능이 아니라 결함이다.** 새 종류를 만들면 서버 왕복을 함께 만들거나,
 * 못 만들 사정을 그때 `PURGE_DOMAINS` 옆에 심사해 적는다(§7 — 비대칭은 설계 단계에서).
 *
 * 별칭은 남긴다: `TrashDomain`은 **사용자에게 보이는 층**의 어휘이고 `PurgeDomain`은
 * **서버 전파 층**의 어휘라, 지금 값이 같아도 두 관심사는 다르다.
 */
export const TRASH_DOMAINS = PURGE_DOMAINS;
export type TrashDomain = PurgeDomain;

/** 도메인의 로컬 테이블 — 화면·휴지통이 테이블 이름을 손으로 적지 않게 한 곳에서 준다. */
export function localTableOf(d: TrashDomain): Table<{ id: string }, string> {
  return DOMAIN_PURGE[d].table();
}

/** 큐에 담기는 영구삭제 작업의 entityType. 기존 push 루프(`!== 'trip'` …)가 자연히 건너뛴다. */
export function purgeOpType(domain: PurgeDomain): string {
  return `purge:${domain}`;
}

/** 원장 되돌리기(복원) 작업의 entityType. 도메인이 없다 — 원장은 종류를 모른다. */
export const UNPURGE_OP = 'unpurge:ledger';

/**
 * **백업 복원이 되살린 id들을 서버 원장에서 빼달라고 큐에 올린다.**
 *
 * 왜 큐인가(2026-07-26 사용자 실기기): 복원은 오프라인에서도 되고, 서버 호출은 실패할 수 있다.
 * 그때 그냥 넘어가면 다음 동기화가 원장을 pull해 **복원한 것을 다시 지운다** — 실제로 그렇게
 * 됐고 사용자에겐 아무 오류도 안 보였다. 의사를 **남겨야** 재시도된다.
 *
 * 멱등: 이미 같은 id가 큐에 있으면 다시 넣지 않는다.
 */
export async function requestUnpurge(ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const d = db();
  const queued = new Set(
    (await d.syncQueue.toArray()).filter((q) => q.operationType === 'unpurge').map((q) => q.entityId),
  );
  const fresh = [...new Set(ids)].filter((id) => !queued.has(id));
  if (!fresh.length) return 0;
  const now = new Date().toISOString();
  await d.syncQueue.bulkAdd(
    fresh.map((id) => ({
      operationId: crypto.randomUUID(),
      entityType: UNPURGE_OP,
      entityId: id,
      operationType: 'unpurge' as const,
      state: 'local_only' as const,
      attempts: 0,
      createdAt: now,
    })),
  );
  return fresh.length;
}

/** 아직 서버 원장에서 못 뺀 복원 대상 id들 — `applyPurgedLedger`가 이걸 건너뛴다. */
export async function pendingUnpurgeIds(): Promise<Set<string>> {
  const rows = (await db().syncQueue.toArray()).filter((q) => q.operationType === 'unpurge');
  return new Set(rows.map((q) => q.entityId));
}

/** entityType에서 도메인을 되읽는다. 영구삭제 작업이 아니면 null. */
export function purgeDomainOf(entityType: string): PurgeDomain | null {
  if (!entityType.startsWith('purge:')) return null;
  const d = entityType.slice('purge:'.length);
  return (PURGE_DOMAINS as readonly string[]).includes(d) ? (d as PurgeDomain) : null;
}

/**
 * 영구삭제 표식 조회 — pull이 이 id를 건너뛴다.
 *
 * 없으면 표식이 장식이 되고 서버 tombstone을 다시 받아와 **휴지통에 되살아난다**.
 * 네 pull 함수가 **모두** 써야 한다.
 */
export async function purgedIdSet(): Promise<Set<string>> {
  return new Set((await db().purgedIds.toArray()).map((p) => p.id));
}

export function purgeMarks(entries: { id: string; domain: PurgeDomain }[], at: string): PurgedId[] {
  return entries.map((e) => ({ id: e.id, entityType: e.domain, purgedAt: at }));
}

/**
 * **서버가 알려준 영구삭제를 이 기기에 적용한다.** 멱등 — 이미 적용됐으면 아무 일도 하지 않는다.
 *
 * 사용자 결정(2026-07-26): 이 기기에 아직 서버로 못 보낸 변경이 있어도 **그냥 지운다.**
 * 사용자가 "지워라"라고 한 의도를 그대로 따르고, 동작을 단순·예측 가능하게 유지한다.
 * (영구삭제를 누른 기기는 이미 "보낼 것 없음" 사전조건을 통과해야 하므로 이 상황 자체가 드물다.)
 *
 * @returns 이번 호출에서 실제로 치웠으면 true(이미 처리됐으면 false).
 */
export async function applyRemotePurge(domain: PurgeDomain, id: string): Promise<boolean> {
  const d = db();
  if (await d.purgedIds.get(id)) return false; // 이미 이 기기에서 치움

  const table = DOMAIN_PURGE[domain].table();
  await d.transaction('rw', d.purgedIds, table, async () => {
    // 표식을 **먼저** 넣는다 — 중간에 실패해도 "지웠는데 표식이 없어 되살아나는" 창이 생기지 않는다.
    await d.purgedIds.put({ id, entityType: domain, purgedAt: new Date().toISOString() });
    await table.delete(id);
  });

  // read-back으로 확인한다(성공 반환이 아니라 되읽어 본다 — 데이터 안전 불변식).
  if (!(await d.purgedIds.get(id))) throw new Error(`영구삭제 표식 확인 실패: ${domain} ${id}`);
  if (await table.get(id)) throw new Error(`영구삭제 확인 실패: ${domain} 행이 남아 있음 ${id}`);
  return true;
}

/**
 * 서버 **원장**에서 받은 id들을 이 기기에 적용한다(ADR-0030).
 *
 * 원장은 **id만** 담는다 — 자료를 서버에 남기지 않는 것이 목적이므로 종류도 안 담는다.
 * 그래서 어느 도메인인지 모른 채 받아, **네 테이블을 모두 훑어** 지운다. 등록부를 도는 구조라
 * 새 도메인이 생기면 자동으로 따라온다(§7 — 다음 형제가 자동으로 따라오는가).
 *
 * 멱등: 이미 표식이 있는 id는 건너뛴다.
 * @returns 이번에 새로 치운 id 수.
 */
export async function applyPurgedLedger(ids: string[]): Promise<number> {
  const d = db();
  const known = await purgedIdSet();
  // **복원 대기 중인 id는 건드리지 않는다**(2026-07-26). 사용자가 백업에서 되살린 것을
  // 원장이 다시 지우면 복원이 조용히 무효화된다 — 실제로 그렇게 됐다. 서버 원장에서 빼는
  // 작업이 아직 큐에 남아 있으면 그건 "지울 것"이 아니라 "되살릴 것"이다.
  const restoring = await pendingUnpurgeIds();
  const fresh = ids.filter((id) => !known.has(id) && !restoring.has(id));
  if (!fresh.length) return 0;

  const now = new Date().toISOString();
  const tables = PURGE_DOMAINS.map((dm) => DOMAIN_PURGE[dm].table());
  await d.transaction('rw', [d.purgedIds, ...tables], async () => {
    for (const id of fresh) {
      // 종류를 모르므로 전부 훑는다. 없는 테이블에서의 delete는 무해하다.
      // entityType은 표식용 라벨일 뿐이라 'unknown'으로 둔다 — 거짓 종류를 적지 않는다(원칙 #4).
      await d.purgedIds.put({ id, entityType: 'unknown', purgedAt: now });
      for (const t of tables) await t.delete(id);
    }
  });

  for (const id of fresh) {
    if (!(await d.purgedIds.get(id))) throw new Error(`영구삭제 표식 확인 실패: ${id}`);
  }
  return fresh.length;
}

/**
 * **전파되지 않은 영구삭제를 다시 큐에 넣는다**(2026-07-26 실기기에서 드러난 상태).
 *
 * 왜 이런 상태가 생기나: ADR-0027 **이전**의 `purgeTripPermanently`는 로컬 표식만 남기고
 * 서버엔 아무것도 알리지 않았다(ADR-0025 — "서버 행은 tombstone으로 남겨 둔다"). 그래서
 * 그 시절에 지운 항목은 **전파 op가 애초에 만들어진 적이 없다** — 아무리 동기화해도 안 간다.
 *
 * 그리고 로컬 표식 때문에 pull이 그 id를 건너뛰므로 **휴지통에도 안 보인다.** 사용자는
 * "지웠다"고 믿고, 서버는 "안 지웠다"고 알고, 앱은 아무 말도 안 한다. 어디서도 손댈 수 없다.
 *
 * 여기서 하는 일은 **의도를 다시 실어 보내는 것**뿐이다 — 로컬은 이미 사용자 뜻대로 지워져
 * 있으므로 건드리지 않는다. 종류를 모르는 id(다른 기기가 알려준 것)는 `'trip'`으로 보낸다:
 * `pushPurges`의 여행 갈래가 **가족까지 쓸어 담으므로** 가장 넓게 잡는 쪽이 안전하다.
 *
 * 멱등: 이미 큐에 있는 id는 다시 넣지 않는다.
 * @returns 이번에 새로 큐에 넣은 수.
 */
export async function requeueUnpropagatedPurges(ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const d = db();
  const queued = new Set(
    (await d.syncQueue.toArray()).filter((q) => purgeDomainOf(q.entityType) !== null).map((q) => q.entityId),
  );
  const marks = await d.purgedIds.bulkGet(ids);
  const now = new Date().toISOString();
  let added = 0;

  for (const [i, id] of ids.entries()) {
    if (queued.has(id)) continue;
    // 표식이 없는 id는 **이 기기가 지운 것이 아니다.** 남의 tombstone을 영구삭제로 바꾸지 않는다.
    const mark = marks[i];
    if (!mark) continue;
    const domain = purgeDomainOf(`purge:${mark.entityType}`) ?? 'trip';
    await d.syncQueue.add({
      operationId: crypto.randomUUID(),
      entityType: purgeOpType(domain),
      entityId: id,
      operationType: 'purge',
      state: 'local_only',
      attempts: 0,
      createdAt: now,
    });
    added++;
  }
  return added;
}

/**
 * **서버에만 있는 tombstone을 영구삭제한다**(로컬엔 행이 없는 경우).
 *
 * 왜 필요한가(2026-07-26, 휴지통 확장 직후 사용자 실기기): 서버에 tombstone 사진이 남아
 * 있는데 **휴지통엔 안 보였다.** `listTrashedChildren`은 로컬 Dexie를 보는데, `pullMedia`가
 * "로컬에 없는 tombstone은 만들지 않는다"(비파괴 규율·불변식 #8)로 건너뛰어 **그 행이 이
 * 기기에 아예 없기** 때문이다. 진단은 서버를 봐서 "1개 있다"고 말하고 휴지통은 로컬을 봐서
 * "비었다"고 말했다 — 두 화면이 다른 이야기를 했다.
 *
 * M-0016과 같은 근본형이다: **로컬이 못 보는 것은 없는 것으로 친다.** 그래서 여기서는
 * 로컬 행의 존재를 요구하지 않는다 — 서버가 아는 id로 바로 의도를 만든다.
 *
 * ⚠️ 이것은 **사용자가 명시적으로 누른 경우에만** 부른다. 표식 없는 서버 tombstone을 자동으로
 * 영구삭제로 바꾸면 *다른 기기가 휴지통에 넣은 것*을 내가 뒤집는 셈이다(M-0023에서 막았다).
 * 사용자의 새 의도는 그것과 다르다 — 그래서 호출부는 2단계 확인을 거친다.
 *
 * @returns 이번에 새로 큐에 넣은 수.
 */
export async function purgeServerOnly(domain: PurgeDomain, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const d = db();
  const queued = new Set(
    (await d.syncQueue.toArray()).filter((q) => purgeDomainOf(q.entityType) !== null).map((q) => q.entityId),
  );
  const now = new Date().toISOString();
  const table = DOMAIN_PURGE[domain].table();
  let added = 0;

  for (const id of ids) {
    if (queued.has(id)) continue;
    await d.transaction('rw', [table, d.purgedIds, d.syncQueue], async () => {
      // 표식을 **먼저** — 중간에 실패해도 "지웠는데 표식이 없어 되살아나는" 창이 없다.
      await d.purgedIds.put({ id, entityType: domain, purgedAt: now });
      await d.syncQueue.add({
        operationId: crypto.randomUUID(),
        entityType: purgeOpType(domain),
        entityId: id,
        operationType: 'purge',
        state: 'local_only',
        attempts: 0,
        createdAt: now,
      });
      // 로컬에 행이 **있을 수도** 있다(기기마다 다르다). 있으면 함께 치운다.
      await table.delete(id);
    });
    if (!(await d.purgedIds.get(id))) throw new Error(`영구삭제 표식 확인 실패: ${id}`);
    added++;
  }
  return added;
}
