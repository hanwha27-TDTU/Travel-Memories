// services/diagnostics.ts — 로컬 동기화 상태를 **관측 가능하게** 만든다.
//
// 왜 필요한가(실제 사고, 2026-07-25): "지운 것이 되살아난다"는 신고를 여러 번 받았는데,
// 서버(로그·테이블)는 볼 수 있어도 **사용자 기기 안**(대기 작업·tombstone·표식)은 볼 수단이
// 없어 매번 가설을 세우고 틀렸다. 좀비가 반복된 진짜 이유는 결함 자체보다 **관측 불가**였다.
// CLAUDE.md §3 "의도가 아니라 현실로 검증" — 현실을 볼 창이 없으면 그 규율을 지킬 수 없다.
//
// 이 모듈은 **읽기 전용 집계**다(수리는 sync.ts의 재큐잉이 담당). 어떤 데이터도 바꾸지 않는다.

import { db } from '../offline/db';
import { mediaStoreKind } from './r2';

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
  /** 각 항목의 실제 id·상태 — 개수만으로는 어느 것인지 알 수 없어 추측하게 된다. */
  items: { type: string; id: string; deleted: boolean; queued: boolean }[];
  /** 영구삭제 표식 수(pull이 건너뛰는 id). */
  purgedMarks: number;
  /** 사진 바이트가 어디로 가는가. */
  mediaStore: 'r2' | 'supabase';
}

export async function diagnoseSync(): Promise<SyncDiagnosis> {
  const d = db();
  const [queue, trips, moments, media, expenses, purged] = await Promise.all([
    d.syncQueue.toArray(),
    d.localTrips.toArray(),
    d.localMoments.toArray(),
    d.localMedia.toArray(),
    d.localExpenses.toArray(),
    d.purgedIds.count(),
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
  const items: { type: string; id: string; deleted: boolean; queued: boolean }[] = [];
  const groups: [string, { id: string; deletedAt: string | null }[]][] = [
    ['trip', trips],
    ['moment', moments],
    ['media', media],
    ['expense', expenses],
  ];
  for (const [type, rows] of groups) {
    const dead = rows.filter((r) => r.deletedAt !== null);
    tombstones[type] = dead.length;
    opLessTombstones[type] = dead.filter((r) => !queued.has(`${type}:${r.id}`)).length;
    // 사진·비용은 개수가 적고 진단 가치가 크므로 목록을 그대로 낸다(여행·순간은 개수로 충분).
    if (type === 'media' || type === 'expense') {
      for (const r of rows) items.push({ type, id: r.id, deleted: r.deletedAt !== null, queued: queued.has(`${type}:${r.id}`) });
    }
  }

  return { queue: { total: queue.length, byState, byType }, tombstones, opLessTombstones, items, purgedMarks: purged, mediaStore: mediaStoreKind() };
}

/**
 * 대기 중인 작업 수 — **모든 미완료 상태**를 센다.
 *
 * ⚠️ 결함 이력: 옛 `pendingSyncCount`는 `local_only`만 세어 **실패한 작업이 숨었다**.
 * 화면은 "동기화됨"인데 실제로는 서버에 못 간 변경이 쌓여 있을 수 있었다.
 */
export async function pendingOpCount(): Promise<number> {
  return db().syncQueue.count();
}
