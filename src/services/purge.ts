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
import { db, type PurgedId, type SyncQueueItem } from '../offline/db';
import { fromRow, type TripRow } from '../domain/trip/rowmap';
import { fromMomentRow, type MomentRow } from '../domain/moment/rowmap';
import { fromExpenseRow, type ExpenseRow } from '../domain/expense/rowmap';
import { fromMediaRow, type MediaRow } from '../domain/media/rowmap';
import { fromAudioRow, type AudioRow } from '../domain/audio/rowmap';
import { fromPlaceRow, type PlaceRow } from '../domain/place/rowmap';
import { fetchAllRows, fetchAllIds } from './canonicalSync';
import type { JourneyClient } from './supabase/client';

export const PURGE_DOMAINS = ['trip', 'moment', 'media', 'expense', 'audio', 'place'] as const;
export type PurgeDomain = (typeof PURGE_DOMAINS)[number];

/**
 * **부모 노릇을 하는 도메인** — 이 행을 지우면 서버 FK가 자식을 함께 지운다.
 *
 * 🔴 왜 이 개념이 생겼나 (2026-08-05 · M-0107, 사용자 실기기 Windows PC):
 * 서버 스키마는 `media/expenses/audio → moments → trips`로 **두 단계** `ON DELETE CASCADE`인데,
 * 앱은 **여행에만** 가족 개념이 있었다. 그래서 **순간을 영구삭제하면** 서버는 자식 사진까지
 * 지우는데 앱은 몰랐다 — 자식은 ①원장에 안 들어가고 ②R2 바이트가 안 지워지고 ③모든 기기의
 * 로컬 행이 남고 ④그 행의 delete op이 FK 위반(4xx)으로 **영구 실패**해 큐에 영원히 박혔다.
 * 실측: 막힌 작업 13건 · 설명할 수 없는 사진 파일 13개 · 되살릴 곳이 없는 항목 13건.
 */
export const PURGE_PARENTS = ['trip', 'moment'] as const;
export type PurgeParent = (typeof PURGE_PARENTS)[number];

/**
 * 부모를 가리키는 키 — **서버 컬럼과 로컬 인덱스를 한 곳에서 짝지운다.**
 * 두 곳에 손으로 적으면 갈라진다(M-0060 — "같은 판정을 두 번 쓰지 마라").
 */
export const PARENT_KEY: Record<PurgeParent, { column: string; index: string }> = {
  trip: { column: 'trip_id', index: 'tripId' },
  moment: { column: 'moment_id', index: 'momentId' },
};

interface DomainPurge {
  /** 이 도메인의 로컬 테이블. 영구삭제는 여기서 행을 **하드 삭제**한다(로컬 저장공간을 실제로 비운다). */
  table: () => Table<{ id: string }, string>;
  /** 서버 테이블 이름(snake_case 경계는 여기서만 만난다). */
  remoteTable: string;
  /** 원격 바이트(R2·Supabase 객체)를 가진 도메인인가 — 사진만 해당. */
  hasRemoteBytes: boolean;
  /**
   * 이 도메인을 **함께 데려가는 부모들** — 그 부모를 영구삭제하면 서버 FK가 이 행을 지운다.
   * 목록에 있는 부모마다 `PARENT_KEY[부모].column`이 이 테이블에 있어야 한다(그 컬럼으로 찾는다).
   *
   * 🔴 왜 **자식 쪽이** 선언하는가: 부모 쪽에 자식 목록을 두면 새 자식이 생겼을 때 부모 파일을
   * 고쳐야 하고, 그게 빠지면 조용히 남는다. 자식이 선언하면 Record가 **빠뜨림을 컴파일 오류로**
   * 만든다(§7 2층). 부모 → 자식 목록은 `cascadeChildDomains()`가 **역으로 계산**한다.
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
   * 빈 배열을 안 적으면 이 Record가 컴파일되지 않는다. 그리고 `check-purge-scope`가 이 선언을
   * **실제 rowmap의 컬럼 + migration의 `ON DELETE CASCADE`**와 대조한다(3층).
   */
  cascadeParents: readonly PurgeParent[];
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
    cascadeParents: [], // 여행 자신이 최상위 부모다 — 아무도 여행을 데려가지 않는다
  },
  moment: {
    table: () => db().localMoments as unknown as Table<{ id: string }, string>,
    remoteTable: 'moments',
    hasRemoteBytes: false,
    cascadeParents: ['trip'],
  },
  media: {
    // 사진 바이트(표시본·썸네일 blob)는 **로컬 행에 붙어 있으므로** 행을 지우면 함께 사라진다.
    // 원격 바이트는 `pushPurges`가 지운다 — 삭제(휴지통행) 때가 아니라 **영구삭제 때만**이다
    // (정책 2026-07-26: 휴지통에 있는 동안은 남겨 둬야 어느 기기에서 복원해도 사진이 돌아온다).
    table: () => db().localMedia as unknown as Table<{ id: string }, string>,
    remoteTable: 'media',
    hasRemoteBytes: true,
    // 🔴 서버 FK는 순간에만 걸려 있고(`media_moment_fk`), 여행은 순간을 거쳐 **전이적으로**
    // 데려간다. 둘 다 적는다 — 둘 다 이 표를 지우고, 둘 다 이 표의 컬럼으로 찾을 수 있다.
    cascadeParents: ['trip', 'moment'],
  },
  expense: {
    table: () => db().localExpenses as unknown as Table<{ id: string }, string>,
    remoteTable: 'expenses',
    hasRemoteBytes: false,
    cascadeParents: ['trip', 'moment'],
  },
  audio: {
    // 소리 바이트도 사진과 같다: 로컬 blob은 행에 붙어 있어 행을 지우면 함께 사라지고,
    // R2 객체는 `pushPurges`가 **영구삭제 때만** 지운다(휴지통에 있는 동안은 남겨 둬야
    // 어느 기기에서 복원해도 소리가 돌아온다 — 사진과 같은 정책, ADR-0029).
    table: () => db().localAudio as unknown as Table<{ id: string }, string>,
    remoteTable: 'audio',
    hasRemoteBytes: true,
    cascadeParents: ['trip', 'moment'],
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
    cascadeParents: [], // 🔴 여행의 자식이 아니다 — trip_id도 moment_id도 없다(C-1). 아무도 데려가지 않는다.
  },
};

/**
 * **이 부모를 영구삭제할 때 함께 지워야 하는 자식 도메인들** — 등록부에서 **역으로** 뽑는다.
 *
 * 🔴 장소는 어느 부모의 자식도 아니다(C-1). 예전엔 `PURGE_DOMAINS.filter(d => d !== 'trip')`로
 * 뽑아 장소까지 넣었고, `trip_id` 없는 장소 테이블에 `trip_id`로 질의해 여행 영구삭제가 서버에
 * 영영 전파되지 않았다. 이제 **각 도메인이 선언한 `cascadeParents`**에서 뽑는다 — 새 형제가
 * 자기 사정을 데이터로 밝히지 않으면 컴파일이 안 되고, `check-purge-scope`가 그 선언을 실제
 * 스키마(rowmap 컬럼 + migration의 `ON DELETE CASCADE`)와 대조한다.
 */
export function cascadeChildDomains(parent: PurgeParent): PurgeDomain[] {
  return PURGE_DOMAINS.filter((d) => DOMAIN_PURGE[d].cascadeParents.includes(parent));
}

/**
 * 이 도메인이 **부모인가** — 지우면 서버 FK가 자식을 데려가는가. 아니면 `null`(잎).
 *
 * 🔴 이 한 줄이 M-0107의 자리다. 예전 코드는 `if (domain === 'trip')`이라고 **손으로** 적어
 * 순간을 잎처럼 다뤘다. 이제 부모 여부는 **등록부가 답한다** — 새 부모가 생겨도 따라온다.
 */
export function asPurgeParent(domain: PurgeDomain): PurgeParent | null {
  const p = (PURGE_PARENTS as readonly string[]).includes(domain) ? (domain as PurgeParent) : null;
  return p && cascadeChildDomains(p).length ? p : null;
}

/** 영구삭제 대상 한 칸 — id와 도메인이 **함께** 다닌다(표식·전파 op·하드 삭제가 같은 목록을 쓴다). */
export interface PurgeTarget {
  id: string;
  domain: PurgeDomain;
  /**
   * **행이 사라지기 전에 적어 둔** 원격 바이트 경로. 바이트 없는 도메인이면 `undefined`.
   *
   * 🔴 왜 여기서 적나(M-0107): `pushPurges`는 지우기 **전에 서버에 경로를 묻는다**. 그런데
   * 서버 행이 **이미 없는** 경우(부모 cascade가 먼저 데려간 자식)에는 물어볼 곳이 없다 —
   * 그러면 R2 바이트가 영원히 고아로 남는다. 로컬 행이 기억하는 경로가 그때 유일한 근거이고,
   * 로컬 행도 영구삭제가 지우므로 **지우는 그 순간에 적어 두는 수밖에 없다.**
   */
  bytePath?: string;
  /** 이 대상은 **뿌리 op이 가족까지 쓸어 간다** — 자기 가족을 또 쓸지 않는다(요청 낭비). */
  underRoot?: true;
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

/** 바이트를 가진 도메인이면 로컬 행이 기억하는 경로를 target에 실어 준다(행이 사라지기 전에). */
function targetOf(domain: PurgeDomain, row: { id: string; storagePath?: string }): PurgeTarget {
  const path = DOMAIN_PURGE[domain].hasRemoteBytes ? row.storagePath : undefined;
  return { id: row.id, domain, ...(path ? { bytePath: path } : {}) };
}

/**
 * **영구삭제 가족을 이 기기에서 모은다** — 부모 자신 + 부모를 가리키는 모든 로컬 자식.
 *
 * 🔴 여행과 순간이 **같은 함수를 지난다**(§7 2층). 예전엔 여행만 가족을 모았고 순간은
 * `purgeChildPermanently`에서 자기 한 행만 지웠다 — 그런데 서버 FK는 순간의 자식도 지운다.
 * 그 비대칭이 M-0107이다. 이제 부모 여부는 등록부가 답하고, 모으는 코드는 여기 하나뿐이다.
 *
 * tombstone인지 활성인지 **묻지 않는다**: 부모를 영구삭제하면 서버는 상태와 무관하게 자식 행을
 * 전부 데려간다. 여기서 활성 자식을 남기면 그 행은 어디에도 없는 부모를 가리키게 된다.
 */
export async function collectPurgeTargets(parent: PurgeParent, id: string): Promise<PurgeTarget[]> {
  const key = PARENT_KEY[parent].index;
  const targets: PurgeTarget[] = [{ id, domain: parent }];
  for (const child of cascadeChildDomains(parent)) {
    const rows = (await DOMAIN_PURGE[child]
      .table()
      .where(key)
      .equals(id)
      .toArray()) as { id: string; storagePath?: string }[];
    // 자식에는 `underRoot`를 붙인다 — 뿌리 op의 `hardDeleteFamily`가 이미 자손을 데려가므로,
    // 자식이 (자기도 부모라도) 가족을 다시 쓸 이유가 없다.
    for (const r of rows) targets.push({ ...targetOf(child, r), underRoot: true });
  }
  // 여행의 자식 목록은 `trip_id`로 뽑으므로 순간의 자식(사진·비용·소리)도 이미 들어 있다.
  // 중복이 생길 여지는 없지만(도메인마다 한 번씩 훑는다) id 기준으로 한 번 더 접는다 —
  // 새 부모가 생겨 두 경로로 잡히게 되면 표식·op이 두 벌 만들어지기 때문이다.
  const seen = new Set<string>();
  return targets.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
}

/** 전파 작업 하나. `bytePath`는 **서버 행이 이미 없을 때의 유일한 근거**다(M-0107). */
export function purgeOpOf(t: PurgeTarget, at: string): SyncQueueItem {
  return {
    operationId: crypto.randomUUID(),
    entityType: purgeOpType(t.domain),
    entityId: t.id,
    operationType: 'purge',
    state: 'local_only',
    attempts: 0,
    createdAt: at,
    ...(t.bytePath ? { bytePath: t.bytePath } : {}),
    ...(t.underRoot ? { purgeUnderRoot: true as const } : {}),
  };
}

/**
 * **가족 전체를 한 트랜잭션에 영구삭제한다** — 표식 → 전파 op → 로컬 하드 삭제.
 *
 * 순서가 곧 안전이다(§2-Z): 표식을 **먼저** 넣어야 중간에 실패해도 "지웠는데 표식이 없어
 * 되살아나는" 창이 생기지 않는다. 셋이 한 트랜잭션인 이유는 불변식 #1과 같다 —
 * "곧 이어서 쓸 것"은 없는 것과 같다(M-0033).
 *
 * `dropEntityOps`는 **대상 id의 일반 op(create/update/delete)를 함께 지운다.** 기본은 `false`다:
 * 사용자가 누른 영구삭제는 사전 조건에서 대기 작업을 **거부**하지, 조용히 버리지 않는다.
 * `true`는 복구 경로 전용이다 — 그 op들이 **원리적으로 성공할 수 없음이 확인된** 경우
 * (부모가 이미 영구삭제돼 서버 행도 부모도 없는 자식)에만 쓴다.
 */
export async function commitPurge(
  targets: PurgeTarget[],
  at: string,
  opts: { dropEntityOps?: boolean } = {},
): Promise<void> {
  if (!targets.length) return;
  const d = db();
  const tables = [...new Set(targets.map((t) => t.domain))].map((dm) => DOMAIN_PURGE[dm].table());
  const ids = new Set(targets.map((t) => t.id));
  const doomed = opts.dropEntityOps
    ? (await d.syncQueue.toArray()).filter((q) => ids.has(q.entityId) && purgeDomainOf(q.entityType) === null)
    : [];

  await d.transaction('rw', [d.purgedIds, d.syncQueue, ...tables], async () => {
    await d.purgedIds.bulkPut(purgeMarks(targets, at));
    for (const t of targets) await d.syncQueue.add(purgeOpOf(t, at));
    for (const q of doomed) await d.syncQueue.delete(q.operationId);
    // 자식 먼저 지우고 부모를 마지막에 — 중간에 끊겨도 부모가 남아 있으면 다시 모을 수 있다.
    for (const t of [...targets].reverse()) await DOMAIN_PURGE[t.domain].table().delete(t.id);
  });

  // read-back — 성공 반환이 아니라 되읽어 확인한다(데이터 안전 불변식).
  for (const t of targets) {
    if (!(await d.purgedIds.get(t.id))) throw new Error(`영구삭제 표식 확인 실패: ${t.domain} ${t.id}`);
    if (await DOMAIN_PURGE[t.domain].table().get(t.id)) {
      throw new Error(`영구삭제 확인 실패: ${t.domain} 행이 남아 있음 ${t.id}`);
    }
  }
  const queued = new Set(
    (await d.syncQueue.toArray()).filter((q) => purgeDomainOf(q.entityType) !== null).map((q) => q.entityId),
  );
  for (const t of targets) {
    if (!queued.has(t.id)) throw new Error(`영구 삭제 확인 실패: 다른 기기에 알릴 작업이 큐에 남지 않음 ${t.id}`);
  }
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
 * **부모가 영구삭제됐는데 이 기기에 남아 있는 자식들을 데려간다**(2026-08-05 · M-0107).
 *
 * ── 왜 이게 필요한가 (사용자 실기기 Windows PC) ─────────────────────────────
 * 서버 FK는 `media/expenses/audio → moments → trips`로 `ON DELETE CASCADE`다. 즉 **부모를
 * 영구삭제하면 서버는 자식 행을 지운다.** 그런데 앱은 여행에만 가족 개념이 있어, 순간을
 * 영구삭제한 자리에 자식이 통째로 남았다. 그 자식들은:
 *
 *  · 서버에 행이 없고 원장에도 없다 → R2 바이트가 「설명할 수 없는 파일」로 영원히 남는다
 *  · 부모가 없으니 **되살릴 곳이 없다**
 *  · 그 행의 delete op은 서버에서 FK 위반(4xx)이라 `permanent_failed`로 굳고, push는 그
 *    상태를 **영원히 건너뛴다** — 「막힌 작업 13건」이 그것이었다
 *
 * ── 왜 자동인가 ───────────────────────────────────────────────────────────
 * 이건 새 삭제 결정이 아니라 **이미 내려진 삭제 결정의 나머지 절반**이다. 부모의 영구삭제는
 * 2단계 확인을 거친 사용자의 명시적 의도였고(ADR-0030), 서버는 이미 자식을 지웠다. 남은 행은
 * 어느 기기에서도 되살릴 수 없고 큐를 막는다 — 남겨 두는 것이 곧 결함이다. `applyPurgedLedger`가
 * 원장의 id를 이미 자동으로 하드 삭제하는 것과 같은 층이다.
 *
 * ── 안전 경계 ─────────────────────────────────────────────────────────────
 *  · **복원 대기 중인 부모는 건드리지 않는다**(`pendingUnpurgeIds`) — 백업 복원이 되살린 것을
 *    원장이 다시 지우면 복원이 조용히 무효화된다(2026-07-26에 실제로 그렇게 됐다).
 *  · **부모 행이 이 기기에 살아 있으면 건너뛴다** — 표식이 있어도 되살아나 있으면 고아가 아니다.
 *  · 자식의 원격 바이트 경로를 **지우기 전에 op에 적어 둔다**(`bytePath`). 서버 행이 없어
 *    `pushPurges`가 경로를 물어볼 곳이 없기 때문이다.
 *  · 자식에 박혀 있던 일반 op은 함께 지운다 — 서버 행도 부모도 없으므로 **원리적으로 성공할 수
 *    없음이 확인된** 작업이다(M-0095의 반대 방향: 모르는 것을 지우는 게 아니라 아는 것을 지운다).
 *
 * @returns 이번에 데려간 자식 수.
 */
export async function sweepPurgedOrphans(): Promise<number> {
  const d = db();
  const marks = await d.purgedIds.toArray();
  if (!marks.length) return 0;
  const restoring = await pendingUnpurgeIds();
  const purged = new Set(marks.map((m) => m.id).filter((id) => !restoring.has(id)));

  const targets: PurgeTarget[] = [];
  const seen = new Set<string>();
  const parentAlive = new Map<string, boolean>();
  for (const parent of PURGE_PARENTS) {
    for (const child of cascadeChildDomains(parent)) {
      const table = DOMAIN_PURGE[child].table();
      // 🔴 표식이 아니라 **인덱스 쪽에서** 훑는다. 표식마다 질의하면 원장이 커질수록 동기화마다
      // 질의 수가 선형으로 늘어난다 — `uniqueKeys()`는 인덱스에 실제로 있는 부모 id만 준다.
      const present = (await table.orderBy(PARENT_KEY[parent].index).uniqueKeys()) as string[];
      for (const pid of present.filter((k) => purged.has(k))) {
        const key = `${parent}:${pid}`;
        if (!parentAlive.has(key)) parentAlive.set(key, Boolean(await DOMAIN_PURGE[parent].table().get(pid)));
        if (parentAlive.get(key)) continue; // 부모가 이 기기에 살아 있다 — 고아가 아니다(복원됐을 수 있다)
        // 🔴 `primaryKeys()`로 먼저 좁힌다 — `toArray()`는 사진 blob을 통째로 메모리에 올린다.
        const hits = (await table.where(PARENT_KEY[parent].index).equals(pid).primaryKeys()) as string[];
        for (const id of hits) {
          if (seen.has(id) || restoring.has(id)) continue;
          const row = (await table.get(id)) as { id: string; storagePath?: string } | undefined;
          if (!row) continue;
          seen.add(id);
          targets.push(targetOf(child, row));
        }
      }
    }
  }
  if (!targets.length) return 0;
  await commitPurge(targets, new Date().toISOString(), { dropEntityOps: true });
  console.info(`영구삭제 정리: 부모가 영구삭제된 자식 ${targets.length}건을 함께 치웠어요(서버는 이미 지운 상태).`);
  return targets.length;
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

// ─────────────────────────────────────────────────────────────────────────────
// 휴지통 화면을 **서버 기준**으로 (2026-08-05 · 사용자 결정)
// ─────────────────────────────────────────────────────────────────────────────
// "휴지통 개념을 아예 서버로 확정짓자 — 절대절대절대 기기끼리 내용이 다르면 안 됩니다."
//
// 불변식 #8("로컬에 없는 tombstone을 만들지 않는다")은 **일반 동기화**에는 옳다 — 이 기기가
// 한 번도 본 적 없는 자료를 함부로 로컬에 채우면 안 된다. 그런데 그 규율을 **휴지통 화면**에
// 그대로 물려썼더니(§7 M-0057의 시간축 버전) "이 기기가 언제 마지막으로 그 항목을 봤는가"가
// 곧 "휴지통에 뭐가 보이는가"가 됐다 — 정확히 `purgeServerOnly`가 이미 한 번 겪은 근본형이다
// (위 함수 주석 참조). 여기서는 그 처방을 **읽기(목록)**로 확장한다.
//
// 쓰기(삭제·복원 자체)는 여전히 로컬 우선이다 — 오프라인에서도 즉시·안전하게 되는 것이
// 비타협 원칙 #1이다. 서버 기준은 오직 **"지금 화면에 뭘 보여줄까"**에만 쓴다.
function purgeRowsCol(domain: PurgeDomain, r: Record<string, unknown>): { id: string; entity: unknown } {
  switch (domain) {
    case 'trip': return { id: r.id as string, entity: fromRow(r as unknown as TripRow) };
    case 'moment': return { id: r.id as string, entity: fromMomentRow(r as unknown as MomentRow) };
    case 'expense': return { id: r.id as string, entity: fromExpenseRow(r as unknown as ExpenseRow) };
    case 'place': return { id: r.id as string, entity: fromPlaceRow(r as unknown as PlaceRow) };
    case 'media': {
      const meta = fromMediaRow(r as unknown as MediaRow);
      const blob = new Blob([], { type: 'image/webp' });
      return { id: r.id as string, entity: { ...meta, mime: 'image/webp', displayBlob: blob, thumbBlob: blob, bytesMissing: true as const } };
    }
    case 'audio': {
      const meta = fromAudioRow(r as unknown as AudioRow);
      return { id: r.id as string, entity: { ...meta, blob: new Blob([], { type: 'audio/webm' }), bytesMissing: true as const } };
    }
  }
}

/**
 * **서버가 지금 아는 도메인 한 종류의 행 전부**를 로컬과 같은 모양(`LocalX`)으로 가져온다.
 * 화면 표시·라벨링에만 쓴다 — 어떤 값도 로컬 Dexie에 쓰지 않는다(그건 정상 pull의 일이다).
 * 영구삭제 원장에 있는 id는 제외한다(다른 기기가 이미 영구삭제한 것을 휴지통에 다시 보여주지 않는다).
 *
 * @returns 실패(오프라인·네트워크 오류)하면 `null` — 호출부가 로컬 목록으로 내려간다.
 */
export async function fetchServerDomainEntities<T extends { id: string; deletedAt: string | null }>(
  domain: PurgeDomain,
  client: JourneyClient,
): Promise<T[] | null> {
  const [rowsRes, purgedRes] = await Promise.all([
    fetchAllRows<Record<string, unknown>>(client, DOMAIN_PURGE[domain].remoteTable),
    fetchAllIds(client, 'purged_ids'),
  ]);
  if (rowsRes.error) return null;
  const purged = new Set(purgedRes.data ?? []);
  return rowsRes.data
    .filter((r) => !purged.has(r.id as string))
    .map((r) => purgeRowsCol(domain, r).entity as T);
}

/**
 * **이 기기에 없는 tombstone 행을 서버에서 메타데이터만** 채운다(바이트 없이 — 복원·영구삭제는
 * 바이트가 필요 없고, 필요해지면 정상 pull이 채운다). 이미 로컬에 있으면 그대로 둔다(멱등).
 *
 * 활성(살아 있는) 행은 이 경로로 만들지 않는다 — 그건 비파괴 pull의 일이고, 여기서 만들면
 * 이 기기가 본 적 없는 행이 조용히 "활성"으로 나타나는 결함이 된다(§0).
 *
 * @returns 이제 로컬에 있으면 true(원래 있었거나, 방금 채웠거나). 서버에도 없거나 활성이면 false.
 */
export async function ensureLocalTombstone(domain: PurgeDomain, id: string, client: JourneyClient): Promise<boolean> {
  const table = DOMAIN_PURGE[domain].table();
  if (await table.get(id)) return true;
  const { data, error } = await client.from(DOMAIN_PURGE[domain].remoteTable).select('*').eq('id', id).maybeSingle();
  if (error || !data) return false;
  const row = data as Record<string, unknown>;
  if (row.deleted_at == null) return false; // 활성 행 — 이 경로가 만들 대상이 아니다
  const { entity } = purgeRowsCol(domain, row);
  await table.put(entity as never);
  return Boolean(await table.get(id));
}
