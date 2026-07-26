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

export const PURGE_DOMAINS = ['trip', 'moment', 'media', 'expense'] as const;
export type PurgeDomain = (typeof PURGE_DOMAINS)[number];

interface DomainPurge {
  /** 이 도메인의 로컬 테이블. 영구삭제는 여기서 행을 **하드 삭제**한다(로컬 저장공간을 실제로 비운다). */
  table: () => Table<{ id: string }, string>;
  /** 서버 테이블 이름(snake_case 경계는 여기서만 만난다). */
  remoteTable: string;
  /** 원격 바이트(R2·Supabase 객체)를 가진 도메인인가 — 사진만 해당. */
  hasRemoteBytes: boolean;
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
  },
  moment: {
    table: () => db().localMoments as unknown as Table<{ id: string }, string>,
    remoteTable: 'moments',
    hasRemoteBytes: false,
  },
  media: {
    // 사진 바이트(표시본·썸네일 blob)는 **로컬 행에 붙어 있으므로** 행을 지우면 함께 사라진다.
    // 원격 바이트는 `pushPurges`가 지운다 — 삭제(휴지통행) 때가 아니라 **영구삭제 때만**이다
    // (정책 2026-07-26: 휴지통에 있는 동안은 남겨 둬야 어느 기기에서 복원해도 사진이 돌아온다).
    table: () => db().localMedia as unknown as Table<{ id: string }, string>,
    remoteTable: 'media',
    hasRemoteBytes: true,
  },
  expense: {
    table: () => db().localExpenses as unknown as Table<{ id: string }, string>,
    remoteTable: 'expenses',
    hasRemoteBytes: false,
  },
};

/** 큐에 담기는 영구삭제 작업의 entityType. 기존 push 루프(`!== 'trip'` …)가 자연히 건너뛴다. */
export function purgeOpType(domain: PurgeDomain): string {
  return `purge:${domain}`;
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
  const fresh = ids.filter((id) => !known.has(id));
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
