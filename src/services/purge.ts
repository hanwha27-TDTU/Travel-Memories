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
// 그때 서버 행 하드 삭제(B안)를 기각한 근거 — *"그 사실을 모르는 다른 기기가 자기 사본을 다시
// 올려 좀비를 만든다"* — 는 지금도 유효하다. 하지만 거기서 멈춘 게 틀렸다: **"서버 행을 지우지
// 않는다"와 "다른 기기에 알리지 않는다"는 별개인데** 한 묶음으로 처리했다. 행은 tombstone으로
// 남기고 **의도(`purged_at`)만 실어 보내면** 두 가지를 동시에 얻는다(ADR-0027).
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
    // 원격 바이트는 삭제(tombstone) 단계에서 이미 지워진다 — 영구삭제 사전조건이 그걸 보장한다.
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
