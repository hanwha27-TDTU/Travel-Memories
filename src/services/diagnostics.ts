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
   * **고아 tombstone** — 로컬은 지워졌는데 대기열 op가 없어 서버로 영영 못 가는 항목.
   * 이 숫자가 0이 아니면 서버·바이트 저장소에 지워지지 않은 것이 남아 있다는 뜻이다.
   */
  orphanTombstones: Record<string, number>;
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
  const orphanTombstones: Record<string, number> = {};
  const groups: [string, { id: string; deletedAt: string | null }[]][] = [
    ['trip', trips],
    ['moment', moments],
    ['media', media],
    ['expense', expenses],
  ];
  for (const [type, rows] of groups) {
    const dead = rows.filter((r) => r.deletedAt !== null);
    tombstones[type] = dead.length;
    orphanTombstones[type] = dead.filter((r) => !queued.has(`${type}:${r.id}`)).length;
  }

  return { queue: { total: queue.length, byState, byType }, tombstones, orphanTombstones, purgedMarks: purged, mediaStore: mediaStoreKind() };
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
