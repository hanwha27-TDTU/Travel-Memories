// services/trash.ts — 휴지통의 **여행 아닌 것들**(순간·사진·비용).
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 생겼나 (F5 — 2026-07-25 감사에서 발견하고 오래 미뤄둔 구멍)
// ─────────────────────────────────────────────────────────────────────────────
// 휴지통은 **여행 단위만** 다뤘다. 순간·사진·비용을 개별로 지우면 실행취소 토스트가 사라지는
// 순간 **복구 경로가 완전히 사라졌다** — 화면 어디에도 안 보이고, 되살릴 방법도 영구히 지울
// 방법도 없었다.
//
// 그게 추상적인 문제가 아니었다는 것이 2026-07-26에 드러났다: 진단의 「파일이 없는 사진 기록」이
// **2건**을 가리키는데, 그 둘은 살아 있는 여행에서 개별로 지운 사진이었다. 사용자는 그 숫자를
// 보면서 **손댈 방법이 없었다.** 진단이 문제를 말할 수 있게 됐는데 정작 고칠 곳이 없었던 것이다.
//
// ─────────────────────────────────────────────────────────────────────────────
// "고아 tombstone"만 다룬다
// ─────────────────────────────────────────────────────────────────────────────
// 부모 여행이 함께 휴지통에 있으면 그건 **여행 휴지통이 이미 보여주고 있다** — 여기서 또 보이면
// 같은 것이 두 줄로 나오고, 자식만 따로 복원하면 부모 없는 자식이 생긴다.
// 그래서 **부모가 살아 있는(활성) 것만** 골라낸다. 그게 지금 어디에도 안 보이는 바로 그것이다.

import { db } from '../offline/db';
import { localDate } from '../domain/time';
import { PURGE_DOMAINS, DOMAIN_PURGE, purgeOpType, type PurgeDomain } from './purge';
import { restoreMomentLocalFirst } from './moments';
import { restoreMediaLocalFirst } from './media';
import { restoreExpenseLocalFirst } from './expenses';

/** 여행이 아닌 도메인. 여행은 `listDeletedTrips`가 따로 다룬다. */
export type ChildDomain = Exclude<PurgeDomain, 'trip'>;
export const CHILD_DOMAINS: ChildDomain[] = PURGE_DOMAINS.filter((d): d is ChildDomain => d !== 'trip');

export interface TrashedChild {
  domain: ChildDomain;
  id: string;
  /** 사람이 알아볼 한 줄(순간 제목 · 사진은 촬영시각 · 비용은 금액). */
  label: string;
  deletedAt: string;
}

/** 사람이 읽는 도메인 이름 — 화면이 손으로 다시 적지 않게 여기 한 곳(§7). */
export const CHILD_LABEL: Record<ChildDomain, string> = {
  moment: '순간',
  media: '사진',
  expense: '비용',
};

/**
 * **부모가 살아 있는데 혼자 지워진** 순간·사진·비용. 최근 삭제 먼저.
 *
 * 부모 여행이 함께 tombstone이면 제외한다 — 여행 휴지통이 이미 보여주므로 중복이고,
 * 자식만 복원하면 부모 없는 자식이 생긴다.
 */
export async function listTrashedChildren(): Promise<TrashedChild[]> {
  const d = db();
  const trips = await d.localTrips.toArray();
  const deadTrips = new Set(trips.filter((t) => t.deletedAt !== null).map((t) => t.id));
  const out: TrashedChild[] = [];

  const moments = await d.localMoments.toArray();
  for (const m of moments) {
    if (m.deletedAt === null || deadTrips.has(m.tripId)) continue;
    out.push({ domain: 'moment', id: m.id, label: m.title || '(제목 없음)', deletedAt: m.deletedAt });
  }

  const media = await d.localMedia.toArray();
  for (const m of media) {
    if (m.deletedAt === null || deadTrips.has(m.tripId)) continue;
    // 사진은 제목이 없다 — 촬영시각이 사용자가 알아볼 유일한 단서다(id 앞자리는 hex라 §6 위반).
    // **잘라 쓰지 않는다**: ISO를 slice하면 UTC 날짜가 나와 사용자의 날짜와 어긋난다(게이트가 잡아줬다).
    const iso = m.takenAt || m.createdAt || '';
    const when = iso ? localDate(iso) : '';
    out.push({ domain: 'media', id: m.id, label: when ? `${when} 촬영` : '사진', deletedAt: m.deletedAt });
  }

  const expenses = await d.localExpenses.toArray();
  for (const e of expenses) {
    if (e.deletedAt === null || deadTrips.has(e.tripId)) continue;
    out.push({
      domain: 'expense',
      id: e.id,
      label: `${e.originalAmount.toLocaleString()} ${e.originalCurrency}${e.note ? ` · ${e.note}` : ''}`,
      deletedAt: e.deletedAt,
    });
  }

  return out.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

/** 영구삭제를 막는 사전 조건 — 여행 쪽(`PendingSyncError`)과 **같은 규율**이다. */
export class PendingChildSyncError extends Error {
  constructor(public readonly count: number) {
    super(`아직 서버에 반영되지 않은 변경이 ${count}건 있습니다. 먼저 동기화해 주세요.`);
    this.name = 'PendingChildSyncError';
  }
}

/**
 * 순간·사진·비용 하나를 **영구삭제**한다. `purgeTripPermanently`와 같은 순서·같은 규율:
 *
 *  ① **사전 조건** — 이 id에 대기 중인 큐 작업이 있으면 거부한다. 작업이 없다 = tombstone이
 *     서버에 반영됐다는 뜻이므로 "서버에 활성 행이 남는" 갈래가 사라진다.
 *  ② **표식을 먼저** 넣는다 — 중간에 실패해도 "지웠는데 표식이 없어 되살아나는" 창이 없다.
 *  ③ 전파 작업을 큐에 넣는다 — 없으면 이 기기에서만 지워지고 서버엔 영영 남는다(M-0023).
 *  ④ 로컬 행을 하드 삭제하고 **되읽어** 확인한다.
 *
 * 되돌릴 수 없다. tombstone된 것에만 적용한다.
 */
export async function purgeChildPermanently(domain: ChildDomain, id: string): Promise<void> {
  const d = db();
  const table = DOMAIN_PURGE[domain].table() as unknown as {
    get(id: string): Promise<{ id: string; deletedAt: string | null } | undefined>;
    delete(id: string): Promise<void>;
  };
  const cur = await table.get(id);
  if (!cur) return; // 이미 없다 — 멱등
  if (cur.deletedAt === null) throw new Error('삭제되지 않은 항목은 영구 삭제할 수 없습니다.');

  const pending = (await d.syncQueue.toArray()).filter((q) => q.entityId === id);
  if (pending.length) throw new PendingChildSyncError(pending.length);

  const now = new Date().toISOString();
  const localTable = DOMAIN_PURGE[domain].table();
  await d.transaction('rw', [localTable, d.purgedIds, d.syncQueue], async () => {
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
    await localTable.delete(id);
  });

  // read-back — 성공 반환이 아니라 되읽어 확인한다(데이터 안전 불변식).
  if (await table.get(id)) throw new Error('영구 삭제 확인 실패: 행이 남아 있음');
  if (!(await d.purgedIds.get(id))) throw new Error('영구 삭제 확인 실패: 표식이 남지 않음');
  const queued = (await d.syncQueue.toArray()).some((q) => q.entityId === id && q.operationType === 'purge');
  if (!queued) throw new Error('영구 삭제 확인 실패: 다른 기기에 알릴 작업이 큐에 남지 않음');
}

/**
 * 자식 하나를 **복원**한다. 도메인 분기와 **딸린 것 모으기를 여기서 한다** — 화면이 하면 안 된다.
 *
 * 왜(M-0007): `restoreMomentLocalFirst(id, mediaIds, expenseIds)`는 딸린 사진·비용 목록을
 * 인자로 받는데, **선택적 매개변수의 기본값이 누락을 삼킨다.** 실제로 여행 복원에서 비용을
 * 안 넘겨 비용만 복원되지 않았고, 여행이 활성으로 돌아와 휴지통에도 안 보여 **복구 경로가
 * 소멸**했다. 그때 `TripChildren` 묶음 타입으로 누락을 컴파일 오류화한 것과 같은 이유로,
 * 여기서는 **호출부가 목록을 만질 기회 자체를 없앤다.**
 */
export async function restoreTrashedChild(domain: ChildDomain, id: string): Promise<void> {
  const d = db();
  if (domain === 'media') {
    await restoreMediaLocalFirst(id);
    return;
  }
  if (domain === 'expense') {
    await restoreExpenseLocalFirst(id);
    return;
  }
  // 순간을 되살리면 **그 순간에 딸린 tombstone 사진·비용도 함께** 되살아나야 한다.
  // 목록은 여기서 만든다 — 화면이 넘기게 두면 언젠가 하나를 빠뜨린다.
  const media = (await d.localMedia.where('momentId').equals(id).toArray())
    .filter((m) => m.deletedAt !== null)
    .map((m) => m.id);
  const expenses = (await d.localExpenses.where('momentId').equals(id).toArray())
    .filter((e) => e.deletedAt !== null)
    .map((e) => e.id);
  await restoreMomentLocalFirst(id, media, expenses);
}
