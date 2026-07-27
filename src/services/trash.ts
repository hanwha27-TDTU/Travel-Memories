// services/trash.ts — 휴지통의 **여행 아닌 것들**(순간·사진·비용·소리).
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 생겼나 (F5 — 2026-07-25 감사에서 발견하고 오래 미뤄둔 구멍)
// ─────────────────────────────────────────────────────────────────────────────
// 휴지통은 **여행 단위만** 다뤘다. 순간·사진·비용·소리를 개별로 지우면 실행취소 토스트가 사라지는
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
import { localDate, compareInstants } from '../domain/time';
import {
  TRASH_DOMAINS,
  isLocalOnlyDomain,
  localTableOf,
  purgeOpType,
  type TrashDomain,
} from './purge';
import { formatDuration } from '../domain/audio/note';
import { restoreMomentLocalFirst } from './moments';
import { restoreMediaLocalFirst } from './media';
import { restoreExpenseLocalFirst } from './expenses';
import { restoreAudio } from './audio';

/** 여행이 아닌 도메인. 여행은 `listDeletedTrips`가 따로 다룬다. */
export type ChildDomain = Exclude<TrashDomain, 'trip'>;
export const CHILD_DOMAINS: ChildDomain[] = TRASH_DOMAINS.filter((d): d is ChildDomain => d !== 'trip');

export interface TrashedChild {
  domain: ChildDomain;
  id: string;
  /** 사람이 알아볼 한 줄(순간 제목 · 사진은 촬영시각 · 비용은 금액 · 소리는 녹음시각+길이). */
  label: string;
  deletedAt: string;
}

/** 사람이 읽는 도메인 이름 — 화면이 손으로 다시 적지 않게 여기 한 곳(§7). */
export const CHILD_LABEL: Record<ChildDomain, string> = {
  moment: '순간',
  media: '사진',
  expense: '비용',
  audio: '소리',
};

/** 한 도메인의 tombstone 행을 휴지통 줄로 바꾸는 규칙. */
interface ChildSource {
  /** 이 도메인의 삭제된 행들. `tripId`는 부모 생사 판정에 쓴다. */
  rows: () => Promise<{ id: string; tripId: string; deletedAt: string | null; label: string }[]>;
}

/**
 * 도메인별 휴지통 규칙 **등록부**.
 *
 * 왜 Record인가(§7 2층): 예전엔 `listTrashedChildren` 안에 도메인마다 `for` 루프를 손으로
 * 썼다. 그 구조에서는 **새 도메인을 만들면서 여기를 안 고쳐도 컴파일이 통과한다** — 실제로
 * 오디오가 그렇게 태어나 순간·여행을 지워도 소리만 활성으로 남았고, 개별 삭제한 소리는
 * 휴지통 어디에도 안 보였다(복구 경로 소멸 = F5와 **같은 결함의 재발**). Record로 바꿔
 * 도메인 누락을 컴파일 오류로 만든다.
 */
const CHILD_SOURCE: Record<ChildDomain, ChildSource> = {
  moment: {
    rows: async () =>
      (await db().localMoments.toArray()).map((m) => ({
        id: m.id,
        tripId: m.tripId,
        deletedAt: m.deletedAt,
        label: m.title || '(제목 없음)',
      })),
  },
  media: {
    rows: async () =>
      (await db().localMedia.toArray()).map((m) => {
        // 사진은 제목이 없다 — 촬영시각이 사용자가 알아볼 유일한 단서다(id 앞자리는 hex라 §6 위반).
        // **잘라 쓰지 않는다**: ISO를 slice하면 UTC 날짜가 나와 사용자의 날짜와 어긋난다(게이트가 잡아줬다).
        const iso = m.takenAt || m.createdAt || '';
        const when = iso ? localDate(iso) : '';
        return { id: m.id, tripId: m.tripId, deletedAt: m.deletedAt, label: when ? `${when} 촬영` : '사진' };
      }),
  },
  expense: {
    rows: async () =>
      (await db().localExpenses.toArray()).map((e) => ({
        id: e.id,
        tripId: e.tripId,
        deletedAt: e.deletedAt,
        label: `${e.originalAmount.toLocaleString()} ${e.originalCurrency}${e.note ? ` · ${e.note}` : ''}`,
      })),
  },
  audio: {
    rows: async () =>
      (await db().localAudio.toArray()).map((a) => {
        // 사진과 **같은 자리에 같은 어휘**(§7 사용자 대면 대칭): 「날짜 + 무엇」 뒤에 길이를 붙인다.
        // 길이는 화면 칩과 **같은 함수**를 쓴다 — 같은 값이 두 곳에서 다르게 보이지 않게.
        const when = a.recordedAt ? localDate(a.recordedAt) : '';
        const head = when ? `${when} 녹음` : '녹음';
        return { id: a.id, tripId: a.tripId, deletedAt: a.deletedAt, label: `${head} · ${formatDuration(a.durationSec)}` };
      }),
  },
};

/**
 * **부모가 살아 있는데 혼자 지워진** 순간·사진·비용·소리. 최근 삭제 먼저.
 *
 * 부모 여행이 함께 tombstone이면 제외한다 — 여행 휴지통이 이미 보여주므로 중복이고,
 * 자식만 복원하면 부모 없는 자식이 생긴다.
 */
export async function listTrashedChildren(): Promise<TrashedChild[]> {
  const d = db();
  const trips = await d.localTrips.toArray();
  const deadTrips = new Set(trips.filter((t) => t.deletedAt !== null).map((t) => t.id));
  const out: TrashedChild[] = [];

  // 등록부를 **돈다** — 도메인마다 루프를 손으로 쓰지 않는다. 다음 형제가 자동으로 따라온다.
  for (const domain of CHILD_DOMAINS) {
    for (const r of await CHILD_SOURCE[domain].rows()) {
      if (r.deletedAt === null || deadTrips.has(r.tripId)) continue;
      out.push({ domain, id: r.id, label: r.label, deletedAt: r.deletedAt });
    }
  }

  // 휴지통은 **최근에 지운 것이 위**다. 시각은 순간으로 비교한다 — 문자열 대소는 표기에
  // 흔들린다(M-0034). 이 자리는 **게이트가 잡아 줬다**: 내 손 목록에는 없었다.
  return out.sort((a, b) => compareInstants(b.deletedAt, a.deletedAt) ?? 0);
}

/** 영구삭제를 막는 사전 조건 — 여행 쪽(`PendingSyncError`)과 **같은 규율**이다. */
export class PendingChildSyncError extends Error {
  constructor(public readonly count: number) {
    super(`아직 서버에 반영되지 않은 변경이 ${count}건 있습니다. 먼저 동기화해 주세요.`);
    this.name = 'PendingChildSyncError';
  }
}

/**
 * 순간·사진·비용·소리 하나를 **영구삭제**한다. `purgeTripPermanently`와 같은 순서·같은 규율:
 *
 *  ① **사전 조건** — 이 id에 대기 중인 큐 작업이 있으면 거부한다. 작업이 없다 = tombstone이
 *     서버에 반영됐다는 뜻이므로 "서버에 활성 행이 남는" 갈래가 사라진다.
 *  ② **표식을 먼저** 넣는다 — 중간에 실패해도 "지웠는데 표식이 없어 되살아나는" 창이 없다.
 *  ③ 전파 작업을 큐에 넣는다 — 없으면 이 기기에서만 지워지고 서버엔 영영 남는다(M-0023).
 *  ④ 로컬 행을 하드 삭제하고 **되읽어** 확인한다.
 *
 * **로컬 전용 도메인(소리)은 ②③이 없다** — 그리고 그것이 차별이 아닌 이유:
 * ②는 *pull이 서버 tombstone을 다시 받아와 되살아나는 것*을 막는 표식이고, ③은 *서버 행을
 * 지우라는 전파*다. 소리는 pull되지도, 서버에 있지도 않으므로 **두 단계가 막을 대상 자체가
 * 없다.** 표식을 굳이 남기면 아무것도 지키지 않으면서 원장만 부풀린다. 반면 ①④는 그대로
 * 적용된다 — 사용자에게 보이는 결과(바이트가 실제로 사라지고, 되읽어 확인한다)는 같다.
 *
 * 되돌릴 수 없다. tombstone된 것에만 적용한다.
 */
export async function purgeChildPermanently(domain: ChildDomain, id: string): Promise<void> {
  const d = db();
  const localTable = localTableOf(domain);
  const table = localTable as unknown as {
    get(id: string): Promise<{ id: string; deletedAt: string | null } | undefined>;
    delete(id: string): Promise<void>;
  };
  const cur = await table.get(id);
  if (!cur) return; // 이미 없다 — 멱등
  if (cur.deletedAt === null) throw new Error('삭제되지 않은 항목은 영구 삭제할 수 없습니다.');

  // ① 사전 조건은 **모든 도메인에 같다.** 소리엔 op가 없으니 늘 통과하지만, 그건 결과이지
  //    면제가 아니다 — 예외를 조건문으로 만들면 나중에 op가 생겨도 아무도 모른다.
  const pending = (await d.syncQueue.toArray()).filter((q) => q.entityId === id);
  if (pending.length) throw new PendingChildSyncError(pending.length);

  const now = new Date().toISOString();
  const localOnly = isLocalOnlyDomain(domain);
  await d.transaction('rw', [localTable, d.purgedIds, d.syncQueue], async () => {
    if (!localOnly) {
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
    }
    await localTable.delete(id);
  });

  // read-back — 성공 반환이 아니라 되읽어 확인한다(데이터 안전 불변식).
  // **행이 사라졌는지는 도메인과 무관하게 확인한다.** 소리에서 확인을 건너뛰면 "지웠다고
  // 말했는데 바이트가 남는" 갈래가 소리에만 생긴다 — 저장공간을 비우는 것이 이 기능의 목적이다.
  if (await table.get(id)) throw new Error('영구 삭제 확인 실패: 행이 남아 있음');
  if (localOnly) return; // 아래 둘은 서버가 있는 도메인에만 존재하는 산출물이다.
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
  if (domain === 'audio') {
    await restoreAudio(id);
    return;
  }
  // 순간을 되살리면 **그 순간에 딸린 tombstone 사진·비용·소리도 함께** 되살아나야 한다.
  // 목록은 여기서 만든다 — 화면이 넘기게 두면 언젠가 하나를 빠뜨린다.
  const media = (await d.localMedia.where('momentId').equals(id).toArray())
    .filter((m) => m.deletedAt !== null)
    .map((m) => m.id);
  const expenses = (await d.localExpenses.where('momentId').equals(id).toArray())
    .filter((e) => e.deletedAt !== null)
    .map((e) => e.id);
  const audio = (await d.localAudio.where('momentId').equals(id).toArray())
    .filter((a) => a.deletedAt !== null)
    .map((a) => a.id);
  await restoreMomentLocalFirst(id, media, expenses, audio);
}
