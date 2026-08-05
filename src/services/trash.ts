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

import { db, type LocalMoment, type LocalMedia, type LocalExpense, type LocalAudio, type LocalPlace } from '../offline/db';
import { momentWhen, compareInstants, type TripClock } from '../domain/time';
import { homeZone } from './homeZone';
import {
  TRASH_DOMAINS, localTableOf, ensureLocalTombstone, fetchServerDomainEntities,
  asPurgeParent, collectPurgeTargets, commitPurge, DOMAIN_PURGE,
  type TrashDomain, type PurgeTarget,
} from './purge';
import { formatDuration } from '../domain/audio/note';
import { restoreMomentLocalFirst } from './moments';
import { restoreMediaLocalFirst } from './media';
import { restoreExpenseLocalFirst } from './expenses';
import { restoreAudio } from './audio';
import { restorePlace } from './places';
import type { JourneyClient } from './supabase/client';

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
  place: '장소',
};

/** 도메인 공통 결과 줄. */
type ChildRow = { id: string; tripId: string; deletedAt: string | null; label: string };

/**
 * 한 도메인의 tombstone 행을 휴지통 줄로 바꾸는 규칙.
 *
 * `fromEntity`가 **라벨을 만드는 유일한 곳**이다(§7 SSOT) — 로컬 Dexie 읽기(`rows`)도,
 * 서버 직접 조회(`listTrashedChildrenFromServer`, 2026-08-05)도 **같은 함수**를 지난다.
 * 두 경로가 라벨을 각자 만들면 "로컬에서 본 문구"와 "서버에서 본 문구"가 갈라질 수 있고,
 * 그건 이 조항이 막으려는 바로 그 종류의 드리프트다.
 */
interface ChildSource<T> {
  /** 이 도메인의 삭제된 행들(로컬 Dexie). */
  rows: () => Promise<T[]>;
  /** 엔티티 → 화면 줄. 로컬 엔티티와 서버에서 만든 엔티티(`fromXRow`)가 **같은 모양**이라 그대로 쓴다. */
  fromEntity: (e: T, clockOf: ClockOf) => ChildRow;
}

/**
 * 여행 id → 그 여행의 시계. 라벨의 날짜를 **그 자리 기준**으로 적기 위해 필요하다.
 *
 * 🔴 인자로 받는 이유(§7 2층): 도메인마다 각자 `localTrips`를 다시 읽으면 ①같은 표를 다섯 번
 * 읽고 ②한 도메인이 옛 방식(기기 시계)을 쓰는 것이 조용해진다. 등록부가 **주는** 도구로 두면
 * 새 도메인이 태어날 때 같은 도구를 손에 들고 태어난다.
 */
export type ClockOf = (tripId: string) => TripClock;

/**
 * 도메인별 휴지통 규칙 **등록부**.
 *
 * 왜 Record인가(§7 2층): 예전엔 `listTrashedChildren` 안에 도메인마다 `for` 루프를 손으로
 * 썼다. 그 구조에서는 **새 도메인을 만들면서 여기를 안 고쳐도 컴파일이 통과한다** — 실제로
 * 오디오가 그렇게 태어나 순간·여행을 지워도 소리만 활성으로 남았고, 개별 삭제한 소리는
 * 휴지통 어디에도 안 보였다(복구 경로 소멸 = F5와 **같은 결함의 재발**). Record로 바꿔
 * 도메인 누락을 컴파일 오류로 만든다.
 */
interface ChildSourceMap {
  moment: ChildSource<LocalMoment>;
  media: ChildSource<LocalMedia>;
  expense: ChildSource<LocalExpense>;
  audio: ChildSource<LocalAudio>;
  place: ChildSource<LocalPlace>;
}

const CHILD_SOURCE: ChildSourceMap = {
  moment: {
    rows: async () => (await db().localMoments.toArray()),
    // 순간은 라벨이 **제목**이라 시각이 필요 없다 — `clockOf`를 받지 않는 것이 맞다.
    fromEntity: (m) => ({ id: m.id, tripId: m.tripId, deletedAt: m.deletedAt, label: m.title || '(제목 없음)' }),
  },
  media: {
    rows: async () => (await db().localMedia.toArray()),
    fromEntity: (m, clockOf) => {
      // 사진은 제목이 없다 — 촬영시각이 사용자가 알아볼 유일한 단서다(id 앞자리는 hex라 §6 위반).
      // **잘라 쓰지 않는다**: ISO를 slice하면 UTC 날짜가 나와 사용자의 날짜와 어긋난다(게이트가 잡아줬다).
      // 그리고 **기기 시계로도 적지 않는다**(M-0049 후반): 「7월 16일 촬영」이 보는 기기에
      // 따라 15일로 보이면, 사용자는 자기가 찾는 사진이 아니라고 판단해 지나친다.
      // 사진에는 순간별 오프셋 필드가 없어 여행 시간대로 잰다 — 라벨은 「어느 것인가」를
      // 말하는 자리라 그 정밀도로 충분하다(정밀한 자리는 뷰어·타임라인이 담당한다).
      const iso = m.takenAt || m.createdAt || '';
      const when = iso ? momentWhen(iso, null, clockOf(m.tripId)).date : '';
      return { id: m.id, tripId: m.tripId, deletedAt: m.deletedAt, label: when ? `${when} 촬영` : '사진' };
    },
  },
  expense: {
    rows: async () => (await db().localExpenses.toArray()),
    fromEntity: (e) => ({
      id: e.id,
      tripId: e.tripId,
      deletedAt: e.deletedAt,
      label: `${e.originalAmount.toLocaleString()} ${e.originalCurrency}${e.note ? ` · ${e.note}` : ''}`,
    }),
  },
  audio: {
    rows: async () => (await db().localAudio.toArray()),
    fromEntity: (a, clockOf) => {
      // 사진과 **같은 자리에 같은 어휘**(§7 사용자 대면 대칭): 「날짜 + 무엇」 뒤에 길이를 붙인다.
      // 길이는 화면 칩과 **같은 함수**를 쓴다 — 같은 값이 두 곳에서 다르게 보이지 않게.
      const when = a.recordedAt ? momentWhen(a.recordedAt, null, clockOf(a.tripId)).date : '';
      const head = when ? `${when} 녹음` : '녹음';
      return { id: a.id, tripId: a.tripId, deletedAt: a.deletedAt, label: `${head} · ${formatDuration(a.durationSec)}` };
    },
  },
  place: {
    rows: async () => (await db().localPlaces.toArray()),
    // 🔴 장소에는 **부모 여행이 없다**(0022 — 한 장소는 여러 여행에 걸친다). 그래서 `tripId`가
    // 빈 문자열이고, 아래 「부모가 죽었으면 숨긴다」 필터에 **절대 걸리지 않는다** — 그게 맞다.
    // 여행을 지웠다고 장소가 휴지통에서 사라지면 되살릴 길이 없어진다.
    fromEntity: (p) => ({
      id: p.id,
      tripId: '',
      deletedAt: p.deletedAt,
      // 형제와 **같은 어휘**: 사람이 알아볼 한 줄. 이름 + (있으면) 어느 동네인지.
      label: p.city || p.region ? `${p.name} · ${[p.region, p.city].filter(Boolean).join(' ')}` : p.name,
    }),
  },
};

/**
 * 도메인 하나의 로컬 행을 화면 줄로 바꾼다. `switch`로 명시하는 이유(§7 2층): `CHILD_SOURCE[domain]`를
 * `ChildDomain` 변수로 동적 색인하면 `rows()`의 반환 타입과 `fromEntity()`의 인자 타입이 유니온으로
 * 섞여, 실제로는 안전한 짝(같은 도메인끼리)인데도 타입이 그 사실을 표현하지 못한다. 형제가 하나
 * 늘면 컴파일러가 이 `switch`에서 「빠짐」을 잡는다(`CHILD_DOMAINS`의 exhaustive 보장과 같은 층).
 */
async function childRowsLocal(domain: ChildDomain, clockOf: ClockOf): Promise<ChildRow[]> {
  switch (domain) {
    case 'moment': return (await CHILD_SOURCE.moment.rows()).map((e) => CHILD_SOURCE.moment.fromEntity(e, clockOf));
    case 'media': return (await CHILD_SOURCE.media.rows()).map((e) => CHILD_SOURCE.media.fromEntity(e, clockOf));
    case 'expense': return (await CHILD_SOURCE.expense.rows()).map((e) => CHILD_SOURCE.expense.fromEntity(e, clockOf));
    case 'audio': return (await CHILD_SOURCE.audio.rows()).map((e) => CHILD_SOURCE.audio.fromEntity(e, clockOf));
    case 'place': return (await CHILD_SOURCE.place.rows()).map((e) => CHILD_SOURCE.place.fromEntity(e, clockOf));
  }
}

/** 서버판 — 같은 `fromEntity`를 지나므로 라벨 문구가 로컬판과 절대 갈라지지 않는다. `null` = 조회 실패. */
async function childRowsServer(domain: ChildDomain, client: JourneyClient, clockOf: ClockOf): Promise<ChildRow[] | null> {
  switch (domain) {
    case 'moment': {
      const rows = await fetchServerDomainEntities<LocalMoment>('moment', client);
      return rows && rows.map((e) => CHILD_SOURCE.moment.fromEntity(e, clockOf));
    }
    case 'media': {
      const rows = await fetchServerDomainEntities<LocalMedia>('media', client);
      return rows && rows.map((e) => CHILD_SOURCE.media.fromEntity(e, clockOf));
    }
    case 'expense': {
      const rows = await fetchServerDomainEntities<LocalExpense>('expense', client);
      return rows && rows.map((e) => CHILD_SOURCE.expense.fromEntity(e, clockOf));
    }
    case 'audio': {
      const rows = await fetchServerDomainEntities<LocalAudio>('audio', client);
      return rows && rows.map((e) => CHILD_SOURCE.audio.fromEntity(e, clockOf));
    }
    case 'place': {
      const rows = await fetchServerDomainEntities<LocalPlace>('place', client);
      return rows && rows.map((e) => CHILD_SOURCE.place.fromEntity(e, clockOf));
    }
  }
}

function sortNewestFirst(rows: TrashedChild[]): TrashedChild[] {
  // 휴지통은 **최근에 지운 것이 위**다. 시각은 순간으로 비교한다 — 문자열 대소는 표기에
  // 흔들린다(M-0034). 이 자리는 **게이트가 잡아 줬다**: 내 손 목록에는 없었다.
  return rows.sort((a, b) => compareInstants(b.deletedAt, a.deletedAt) ?? 0);
}

/**
 * **부모가 살아 있는데 혼자 지워진** 순간·사진·비용·소리 — 이 기기의 로컬 기록 기준. 최근 삭제 먼저.
 *
 * 부모 여행이 함께 tombstone이면 제외한다 — 여행 휴지통이 이미 보여주므로 중복이고,
 * 자식만 복원하면 부모 없는 자식이 생긴다.
 *
 * 🔴 온라인이면 `listTrashedChildrenFromServer`를 우선한다(2026-08-05 사용자 결정 — "기기끼리
 * 절대 다르면 안 된다"). 이 함수는 오프라인 폴백과 그 서버판의 구현 바탕으로 남는다.
 */
export async function listTrashedChildren(): Promise<TrashedChild[]> {
  const d = db();
  const trips = await d.localTrips.toArray();
  const deadTrips = new Set(trips.filter((t) => t.deletedAt !== null).map((t) => t.id));

  // 시계는 **여기서 한 번** 만들어 등록부에 내린다(표를 다섯 번 읽지 않는다).
  // 부모가 없는 도메인(장소)은 `zone: ''`이 되고, 그 도메인은 어차피 날짜를 안 쓴다.
  const home = homeZone();
  const zoneById = new Map(trips.map((t) => [t.id, t.timeZone ?? '']));
  const clockOf: ClockOf = (tripId) => ({ zone: zoneById.get(tripId) ?? '', homeZone: home });

  const out: TrashedChild[] = [];
  // 등록부를 **돈다** — 도메인마다 루프를 손으로 쓰지 않는다. 다음 형제가 자동으로 따라온다.
  for (const domain of CHILD_DOMAINS) {
    for (const r of await childRowsLocal(domain, clockOf)) {
      if (r.deletedAt === null || deadTrips.has(r.tripId)) continue;
      out.push({ domain, id: r.id, label: r.label, deletedAt: r.deletedAt });
    }
  }
  return sortNewestFirst(out);
}

/**
 * 🔴 **서버가 지금 아는 것을 그대로 보여준다**(2026-08-05 · 사용자 결정).
 *
 * *"휴지통 개념을 아예 서버로 확정짓자 — 절대절대절대 기기끼리 내용이 다르면 안 됩니다."*
 *
 * `listTrashedChildren`(로컬)은 이 기기가 그 항목을 **본 적 있어야만** 보여준다(불변식 #8이
 * 일반 동기화에는 옳지만, 화면 표시에 그대로 물려쓰면 "마지막으로 언제 봤는가"가 "무엇이
 * 보이는가"가 된다 — 실제로 같은 계정 두 기기가 다른 휴지통을 보였다). 여기서는 서버 테이블을
 * 직접 읽어 **모든 기기가 항상 같은 것**을 보게 한다. 어떤 값도 로컬 Dexie에 쓰지 않는다 —
 * 이건 표시 전용이고, 실제로 로컬에 채우는 일은 정상 pull과 `ensureLocalTombstone`(행동 시)의
 * 몫이다.
 *
 * @returns 조회 실패(오프라인·네트워크 오류)면 `null` — 호출부가 `listTrashedChildren()`으로
 *   내려가되, 그 사실을 사용자에게 **밝혀야 한다**(§8 — 모르는 걸 아는 척하지 않는다).
 */
export async function listTrashedChildrenFromServer(client: JourneyClient): Promise<TrashedChild[] | null> {
  const trips = await fetchServerDomainEntities<{ id: string; deletedAt: string | null; timeZone?: string | null }>('trip', client);
  if (!trips) return null;
  const deadTrips = new Set(trips.filter((t) => t.deletedAt !== null).map((t) => t.id));
  const home = homeZone();
  const zoneById = new Map(trips.map((t) => [t.id, t.timeZone ?? '']));
  const clockOf: ClockOf = (tripId) => ({ zone: zoneById.get(tripId) ?? '', homeZone: home });

  const out: TrashedChild[] = [];
  for (const domain of CHILD_DOMAINS) {
    const rows = await childRowsServer(domain, client, clockOf);
    if (rows === null) return null; // 부분 실패로 "일부만 서버 기준"인 목록을 절대 기준으로 말하지 않는다
    for (const r of rows) {
      if (r.deletedAt === null || deadTrips.has(r.tripId)) continue;
      out.push({ domain, id: r.id, label: r.label, deletedAt: r.deletedAt });
    }
  }
  return sortNewestFirst(out);
}

/**
 * 서버판 목록에 있는 항목을 **행동(복원·영구삭제)**하려면 먼저 이 기기에 채워야 한다.
 * 이미 로컬에 있으면 아무 일도 하지 않는다(멱등) — `restoreTrashedChild`/`purgeChildPermanently`가
 * 그 다음을 그대로 잇는다.
 */
export async function prepareChildForAction(domain: ChildDomain, id: string, client: JourneyClient): Promise<boolean> {
  return ensureLocalTombstone(domain, id, client);
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
 *  ① **사전 조건** — 이 **가족**에 대기 중인 큐 작업이 있으면 거부한다. 작업이 없다 =
 *     tombstone이 서버에 반영됐다는 뜻이므로 "서버에 활성 행이 남는" 갈래가 사라진다.
 *  ② **표식을 먼저** 넣는다 — 중간에 실패해도 "지웠는데 표식이 없어 되살아나는" 창이 없다.
 *  ③ 전파 작업을 큐에 넣는다 — 없으면 이 기기에서만 지워지고 서버엔 영영 남는다(M-0023).
 *  ④ 로컬 행을 하드 삭제하고 **되읽어** 확인한다.
 *
 * 🔴 **순간은 잎이 아니다**(2026-08-05 · M-0107, 사용자 실기기 Windows PC). 예전 이 함수는
 * 도메인과 무관하게 **자기 한 행만** 지웠다. 그런데 서버 FK는 `media/expenses/audio → moments`가
 * `ON DELETE CASCADE`라 **서버는 자식까지 지운다.** 앱만 몰랐고, 그 결과 자식은 원장에도 못
 * 들어가고 R2 바이트도 안 지워지고 로컬에 남아 delete op이 FK 위반으로 **영원히 막혔다**.
 * 바로 옆 `restoreTrashedChild`는 순간을 되살릴 때 자식을 **이미 데려가고 있었다** — 되살리기는
 * 가족을 알고 지우기는 몰랐던 것이 §7이 말하는 형제 비대칭이다.
 * 이제 부모 여부는 등록부가 답하고(`asPurgeParent`), 가족은 여행과 **같은 함수**가 모은다.
 *
 * 🔴 예전엔 소리만 ②③을 건너뛰었다(서버에 표가 없었으므로). 그 예외는 사라졌다 —
 * 마이그레이션 0019 이후 소리도 `PURGE_DOMAINS`의 형제라 **네 단계를 전부 지난다.**
 * 도메인 분기가 이 함수에서 통째로 없어진 것이 그 증거다(§7 2층 — 예외가 없으면 분기도 없다).
 *
 * 되돌릴 수 없다. tombstone된 것에만 적용한다.
 */
export async function purgeChildPermanently(domain: ChildDomain, id: string): Promise<void> {
  const d = db();
  const localTable = localTableOf(domain);
  const table = localTable as unknown as {
    get(id: string): Promise<{ id: string; deletedAt: string | null } | undefined>;
  };
  const cur = await table.get(id);
  if (!cur) return; // 이미 없다 — 멱등
  if (cur.deletedAt === null) throw new Error('삭제되지 않은 항목은 영구 삭제할 수 없습니다.');

  // 부모면 가족을 데려간다(서버가 그렇게 하기 때문이다). 잎이면 자기 한 칸이다.
  const parent = asPurgeParent(domain);
  const targets = parent ? await collectPurgeTargets(parent, id) : await collectPurgeTargets2(domain, id);

  // ① 사전 조건은 **모든 도메인에 같다** — 그리고 이제 **가족 전체**를 센다.
  //    자식의 대기 작업을 안 세면 그 op이 부모가 사라진 뒤 영원히 막힌다(M-0107이 그 형태였다).
  const ids = new Set(targets.map((t) => t.id));
  const pending = (await d.syncQueue.toArray()).filter((q) => ids.has(q.entityId));
  if (pending.length) throw new PendingChildSyncError(pending.length);

  await commitPurge(targets, new Date().toISOString());
}

/** 잎 도메인 한 칸 — `collectPurgeTargets`와 같은 모양으로 만든다(바이트 경로 포함). */
async function collectPurgeTargets2(domain: ChildDomain, id: string): Promise<PurgeTarget[]> {
  const row = (await localTableOf(domain).get(id)) as { id: string; storagePath?: string } | undefined;
  if (!row) return [];
  const path = DOMAIN_PURGE[domain].hasRemoteBytes ? row.storagePath : undefined;
  return [{ id, domain, ...(path ? { bytePath: path } : {}) }];
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
  if (domain === 'place') {
    await restorePlace(id);
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
  await restoreMomentLocalFirst(id, { mediaIds: media, expenseIds: expenses, audioIds: audio });
}
