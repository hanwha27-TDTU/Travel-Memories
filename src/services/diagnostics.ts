// services/diagnostics.ts — 로컬 동기화 상태를 **관측 가능하게** 만든다.
//
// 왜 필요한가(실제 사고, 2026-07-25): "지운 것이 되살아난다"는 신고를 여러 번 받았는데,
// 서버(로그·테이블)는 볼 수 있어도 **사용자 기기 안**(대기 작업·tombstone·표식)은 볼 수단이
// 없어 매번 가설을 세우고 틀렸다. 좀비가 반복된 진짜 이유는 결함 자체보다 **관측 불가**였다.
// CLAUDE.md §3 "의도가 아니라 현실로 검증" — 현실을 볼 창이 없으면 그 규율을 지킬 수 없다.
//
// 이 모듈은 **읽기 전용 집계**다(수리는 sync.ts의 재큐잉이 담당). 어떤 데이터도 바꾸지 않는다.

import { db, type SyncMeta } from '../offline/db';
import type { IntegritySnapshot } from '../domain/integrity';
import { isoInstant, isoInstantOrNull } from '../domain/time';
import {
  classifyTombstoneSync,
  type TombstoneSyncFinding,
  type TombstoneSyncRef,
} from '../domain/syncTombstoneVerdict';
import { DOMAIN_PURGE, PURGE_DOMAINS, type PurgeDomain } from './purge';
import type { JourneyClient } from './supabase/client';

export interface DiagnosedSyncItem {
  type: PurgeDomain;
  id: string;
  deleted: boolean;
  queued: boolean;
}

export interface SyncDiagnosis {
  /** 대기열 — 상태별/종류별. `local_only`만 세면 **실패가 조용히 숨는다**(옛 pendingSyncCount의 함정). */
  queue: { total: number; byState: Record<string, number>; byType: Record<string, number> };
  /** 로컬 tombstone 개수(종류별). */
  tombstones: Record<string, number>;
  /**
   * op 없는 tombstone.
   *
   * ⚠️ 정직한 한계(2026-07-25 정정): 이 숫자는 **"아직 서버에 못 간 것"과 "이미 다 간 것"을
   * 구분하지 못한다** — push가 성공하면 op를 지우기 때문에 정상 항목도 여기 잡힌다.
   * 처음에 "서버로 못 간 삭제"라고 이름 붙인 것은 **거짓 경보**였다. 서버와 대조해야만 알 수
   * 있고, 그 대조는 동기화(pull)가 한다. 여기서는 사실만 적는다: "op가 없는 지운 항목".
   */
  opLessTombstones: Record<string, number>;
  /**
   * **설명이 필요한 항목**의 실제 id·상태 — 개수만으로는 어느 것인지 알 수 없어 추측하게 된다.
   * 정상적으로 살아 있고 큐도 비어 있는 항목은 담지 않는다(정상은 나열하지 않는다).
   */
  items: DiagnosedSyncItem[];
  /** 상한(ITEM_CAP)을 넘어 생략된 항목 수 — **조용히 자르지 않는다**(잘랐으면 잘랐다고 말한다). */
  itemsOmitted: number;
  /** 서버 판정 뒤 정상 항목을 먼저 걷고 나서 상한을 적용하기 위한 전체 후보. */
  itemCandidates: DiagnosedSyncItem[];
  /** 서버 대조 대상 전부. 화면 목록 상한과 무관해야 뒤의 실제 이상이 정상 항목에 밀리지 않는다. */
  opLessItems: TombstoneSyncRef[];
  /** 영구삭제 표식 수(pull이 건너뛰는 id). */
  purgedMarks: number;
  /** 사진 바이트가 어디로 가는가. */
  mediaStore: 'r2' | 'supabase';
}

/** 목록 상한 — 이보다 많으면 개수로만 알린다. 화면이 목록으로 뒤덮이면 수리 버튼에 못 닿는다. */
export const ITEM_CAP = 20;

export async function diagnoseSync(): Promise<SyncDiagnosis> {
  const d = db();
  const [queue, purged, groups] = await Promise.all([
    d.syncQueue.toArray(),
    d.purgedIds.count(),
    Promise.all(
      PURGE_DOMAINS.map(async (domain) => [
        domain,
        (await DOMAIN_PURGE[domain].table().toArray()) as SyncMeta[],
      ] as [PurgeDomain, SyncMeta[]]),
    ),
  ]);

  const byState: Record<string, number> = {};
  const byType: Record<string, number> = {};
  for (const q of queue) {
    byState[q.state] = (byState[q.state] ?? 0) + 1;
    byType[q.entityType] = (byType[q.entityType] ?? 0) + 1;
  }

  const queued = new Set(queue.map((q) => `${q.entityType}:${q.entityId}`));
  const tombstones: Record<string, number> = {};
  const opLessTombstones: Record<string, number> = {};
  const itemCandidates: DiagnosedSyncItem[] = [];
  const opLessItems: TombstoneSyncRef[] = [];
  // 🔴 `PURGE_DOMAINS` 등록부에서 직접 뽑는다. 수동 6칸이면 다음 형제가 생길 때 조용히 0건을
  // 보고한다(M-0095). 등록부에 추가되는 순간 이 진단도 같은 테이블을 읽어야 한다.
  for (const [type, rows] of groups) {
    const dead = rows.filter((r) => r.deletedAt !== null);
    tombstones[type] = dead.length;
    const opLess = dead.filter((r) => !queued.has(`${type}:${r.id}`));
    opLessTombstones[type] = opLess.length;
    for (const r of opLess) opLessItems.push({ ...r, domain: type });
    // **설명이 필요한 항목만** 낸다.
    //
    // 옛 코드는 사진·비용의 *전 행*을 넣었다. 주석엔 "개수가 적고"라고 적혀 있었지만 이 앱은
    // 여행 사진 앱이다 — 한 번 여행하면 수백 장이 정상이다. 실제로 사진 10장 계정에서 진단
    // 화면이 정상 항목 나열로 뒤덮였고(2026-07-26 사용자 지적), 수백 장이면 수리 버튼이
    // 목록 뒤로 밀려 도달 불가가 된다. 진단 도구가 스스로 수리 경로를 막는 셈이다.
    //
    // 판정 기준: 정상적으로 살아 있고 큐도 비어 있으면 설명할 것이 없다 → 뺀다.
    // 지웠는데 큐에 없거나(정말 갔나?), 큐에 남아 있으면(왜 안 갔나?) 설명이 필요하다 → 넣는다.
    for (const r of rows) {
      const isQueued = queued.has(`${type}:${r.id}`);
      const isDeleted = r.deletedAt !== null;
      if (!isDeleted && !isQueued) continue; // 정상 활성 — 침묵이 정상 신호
      itemCandidates.push({ type, id: r.id, deleted: isDeleted, queued: isQueued });
    }
  }

  const items = itemCandidates.slice(0, ITEM_CAP);
  const overflow = Math.max(0, itemCandidates.length - items.length);

  return {
    queue: { total: queue.length, byState, byType },
    tombstones,
    opLessTombstones,
    items,
    itemsOmitted: overflow,
    itemCandidates,
    opLessItems,
    purgedMarks: purged,
    mediaStore: 'r2' as const,
  };
}

interface TombstoneMarkerRow {
  id: string;
  version: number;
  updated_at: string;
  deleted_at: string | null;
  client_operation_id: string | null;
}

export interface TombstoneAuditPort {
  generation(): Promise<string>;
  markers(domain: PurgeDomain, ids: string[]): Promise<TombstoneSyncRef[]>;
  purgedIds(ids: string[]): Promise<string[]>;
}

/** PostgREST URL 상한과 기본 행 상한을 동시에 피한다. */
const AUDIT_CHUNK = 100;

function chunks<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** 읽기 전용 서버 대조 포트. 한 테이블이라도 실패하면 호출부가 전체를 확인 불가로 둔다. */
export function tombstoneAuditRemote(client: JourneyClient): TombstoneAuditPort {
  return {
    async generation() {
      const r = await client.from('sync_meta').select('canonical_version').maybeSingle();
      if (r.error) throw new Error(`최종본 세대 조회 실패: ${r.error.message}`);
      const version = (r.data as { canonical_version?: unknown } | null)?.canonical_version;
      if (typeof version !== 'string') throw new Error('최종본 세대를 확인할 수 없습니다.');
      return version;
    },
    async markers(domain, ids) {
      const out: TombstoneSyncRef[] = [];
      for (const part of chunks([...new Set(ids)], AUDIT_CHUNK)) {
        const r = await client
          .from(DOMAIN_PURGE[domain].remoteTable)
          .select('id,version,updated_at,deleted_at,client_operation_id')
          .in('id', part);
        if (r.error) throw new Error(`${DOMAIN_PURGE[domain].remoteTable} 삭제 상태 조회 실패: ${r.error.message}`);
        for (const row of (r.data ?? []) as TombstoneMarkerRow[]) {
          const updatedAt = isoInstant(row.updated_at);
          out.push({
            domain,
            id: row.id,
            version: row.version,
            createdAt: updatedAt,
            updatedAt,
            deletedAt: isoInstantOrNull(row.deleted_at),
            ...(row.client_operation_id ? { clientOperationId: row.client_operation_id } : {}),
          });
        }
      }
      return out;
    },
    async purgedIds(ids) {
      const out: string[] = [];
      for (const part of chunks([...new Set(ids)], AUDIT_CHUNK)) {
        const r = await client.from('purged_ids').select('id').in('id', part);
        if (r.error) throw new Error(`영구삭제 원장 조회 실패: ${r.error.message}`);
        for (const row of (r.data ?? []) as { id: string }[]) out.push(row.id);
      }
      return out;
    },
  };
}

/**
 * 큐 없는 tombstone을 서버 증거와 대조한다. **읽기 전용**이며 일부 성공을 정상으로 반올림하지 않는다.
 */
export async function auditOpLessTombstones(
  port: TombstoneAuditPort,
  locals: TombstoneSyncRef[],
): Promise<TombstoneSyncFinding[]> {
  if (!locals.length) return [];
  const generationBefore = await port.generation();
  const byDomain = new Map<PurgeDomain, TombstoneSyncRef[]>();
  for (const domain of PURGE_DOMAINS) byDomain.set(domain, []);
  for (const local of locals) byDomain.get(local.domain as PurgeDomain)?.push(local);

  const markerGroups = await Promise.all(
    PURGE_DOMAINS.map(async (domain) => {
      const rows = byDomain.get(domain) ?? [];
      return rows.length ? port.markers(domain, rows.map((x) => x.id)) : [];
    }),
  );
  const purged = new Set(await port.purgedIds(locals.map((x) => x.id)));
  const generationAfter = await port.generation();
  if (generationAfter !== generationBefore) {
    throw new Error('대조 중 최종본 세대가 바뀌었습니다. 다시 확인해 주세요.');
  }
  const servers = new Map(markerGroups.flat().map((x) => [`${x.domain}:${x.id}`, x]));
  return locals.map((local) => {
    const server = servers.get(`${local.domain}:${local.id}`) ?? null;
    return {
      local,
      server,
      state: classifyTombstoneSync(local, server, purged.has(local.id)),
    };
  });
}

/**
 * 무결성 점검이 볼 **로컬 스냅샷을 한 곳에서** 만든다.
 *
 * 왜 여기로 뽑았나(§7 2층, 2026-07-27): 이 `Promise.all([...])`는 `diagnostics.ts` 안에
 * **두 번 손으로 적혀 있었다**(진단 카드용·요약 텍스트용). 도메인을 하나 더할 때 둘 다
 * 고쳐야 하는 구조는 반드시 한쪽을 빠뜨린다 — 이 저장소의 삭제 결함이 전부 그 형태였다.
 * 한 곳만 남기면 다음 형제는 **여기만 고치면 모든 소비처가 따라온다.**
 */
export async function loadIntegritySnapshot(): Promise<IntegritySnapshot> {
  const d = db();
  const [trips, moments, media, expenses, audio, places] = await Promise.all([
    d.localTrips.toArray(),
    d.localMoments.toArray(),
    d.localMedia.toArray(),
    d.localExpenses.toArray(),
    d.localAudio.toArray(),
    d.localPlaces.toArray(), // 🔴 M-2 — 장소를 스냅샷에 넣는다(소리가 겪은 「안 봐서 0건」 반복 방지)
  ]);
  return { trips, moments, media, expenses, audio, places };
}
