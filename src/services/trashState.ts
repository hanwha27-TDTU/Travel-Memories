// services/trashState.ts — 「저장·삭제·휴지통」 도구의 **읽기 전용 관측 수집**.
//
// 판정은 여기서 하지 않는다 — `domain/trashVerdict.ts`가 한다(§10 ③ 전달 결함 방지).
// 이 파일은 사실만 모은다: 서버 휴지통을 읽을 수 있었나, 이 기기 휴지통은 몇 건인가,
// 되살려도 자료가 비는 항목은 무엇인가, 되살릴 부모가 사라진 항목은 무엇인가.
//
// 🔴 **아무것도 바꾸지 않는다.** 진단은 관측이 기본이고, 상태를 바꾸는 것은 사용자가 누른
//    행동뿐이다. 특히 「모르는 상태에서 쓰기·삭제·재큐잉으로 확인」은 금지다(§8 · M-0095).

import { db, type LocalMedia, type LocalAudio } from '../offline/db';
import { supabase, isConfigured } from './supabase/client';
import { currentUser } from './auth';
import { listDeletedTrips, listDeletedTripsFromServer } from './trips';
import { listTrashedChildren, listTrashedChildrenFromServer, CHILD_LABEL } from './trash';
import type { TrashObservation, EmptyOnRestore, OrphanTrashed } from '../domain/trashVerdict';

/**
 * 서버 휴지통 건수를 읽는다. **못 읽으면 개수가 아니라 이유를 돌려준다** — 조회 실패와
 * 「비었다」를 같은 0으로 접으면 서버에 쌓인 것을 화면이 조용히 숨긴다(§8).
 *
 * 여행·자식 **둘 다** 성공해야 개수를 낸다. 하나만 성공한 값을 쓰면 「서버 기준」이라는 말
 * 자체가 거짓이 된다 — ADR-0049가 화면에서 전부-아니면-폴백을 택한 것과 같은 이유다.
 */
async function readServerTrash(): Promise<{ count: number | null; reason: string | null }> {
  const c = supabase();
  // 클라우드 미설정은 여기서 null로만 답하고, **판정은 `cloudConfigured`가 가른다** — 이 자리에서
  // 「연결 실패」로 뭉개면 읽을 서버가 없는 배포에까지 「연결이 돌아오면」이라고 말하게 된다(§7-E).
  if (!c) return { count: null, reason: null };
  let user: unknown = null;
  try {
    user = await currentUser();
  } catch {
    return { count: null, reason: '로그인 상태를 확인하지 못했습니다' };
  }
  if (!user) return { count: null, reason: '로그인 상태가 아닙니다' };
  try {
    const [trips, kids] = await Promise.all([listDeletedTripsFromServer(c), listTrashedChildrenFromServer(c)]);
    if (trips === null || kids === null) return { count: null, reason: '서버 휴지통 조회에 실패했습니다' };
    return { count: trips.length + kids.length, reason: null };
  } catch (e) {
    return { count: null, reason: (e as Error).message || '서버 휴지통 조회에 실패했습니다' };
  }
}

/**
 * 되살려도 사진·소리가 빈 채로 오는 항목.
 *
 * `bytesMissing`은 **추측이 아니라 확인한 사실**을 적는 표시다(M-0060의 규율) — 「바이트가
 * 이 기기에 없음을 확인했다」는 뜻이다. 그 표시가 붙은 tombstone 행만 센다.
 */
async function readEmptyOnRestore(): Promise<EmptyOnRestore[]> {
  const d = db();
  const [media, audio] = await Promise.all([d.localMedia.toArray(), d.localAudio.toArray()]);
  const out: EmptyOnRestore[] = [];
  const pick = (rows: (LocalMedia | LocalAudio)[], domain: 'media' | 'audio'): void => {
    for (const r of rows) {
      if (r.deletedAt === null || r.bytesMissing !== true) continue;
      out.push({ domain, label: `${CHILD_LABEL[domain]} ${r.id.slice(0, 8)}` });
    }
  };
  pick(media, 'media');
  pick(audio, 'audio');
  return out;
}

/**
 * 되살릴 **부모가 사라진** 휴지통 자식.
 *
 * 순간을 영구삭제하면 그 순간 행만 없어지고(자식은 `trip_id`로만 묶여 있다) 휴지통에 있던
 * 그 순간의 사진·소리·비용은 돌아갈 곳을 잃는다. `checkIntegrity`는 **살아 있는 행만** 보므로
 * 이 상태를 원리적으로 못 본다 — 그래서 여기서 잰다.
 *
 * 🔴 부모를 「없음」으로 판정하는 근거는 **로컬 행의 부재 + 영구삭제 원장에 있음** 둘 다다.
 * 로컬에 없다는 것만으로는 「이 기기가 아직 못 받았다」와 구별되지 않는다(M-0048의 근본형 —
 * 「이 기기에 없다」는 「없다」가 아니다). 원장에 id가 있으면 그건 **누군가 영구삭제했다**는
 * 확인된 사실이므로 그때만 고아로 센다.
 */
async function readOrphans(): Promise<OrphanTrashed[]> {
  const d = db();
  const [moments, media, audio, expenses, purged] = await Promise.all([
    d.localMoments.toArray(),
    d.localMedia.toArray(),
    d.localAudio.toArray(),
    d.localExpenses.toArray(),
    d.purgedIds.toArray(),
  ]);
  const momentIds = new Set(moments.map((m) => m.id));
  const purgedIds = new Set(purged.map((p) => p.id));
  const out: OrphanTrashed[] = [];
  const scan = (
    rows: { id: string; momentId?: string | null; deletedAt: string | null }[],
    domain: 'media' | 'audio' | 'expense',
  ): void => {
    for (const r of rows) {
      if (r.deletedAt === null) continue; // 살아 있는 것은 이 도구의 대상이 아니다
      const parent = r.momentId;
      if (!parent) continue; // 순간에 매달리지 않은 항목(여행 직속)은 이 검사 밖이다
      if (momentIds.has(parent)) continue; // 부모가 이 기기에 있다 — 되살릴 곳이 있다
      if (!purgedIds.has(parent)) continue; // 🔴 원장에 없으면 「아직 못 받음」일 수 있다 — 세지 않는다
      out.push({ label: `${CHILD_LABEL[domain]} ${r.id.slice(0, 8)}` });
    }
  };
  scan(media, 'media');
  scan(audio, 'audio');
  scan(expenses, 'expense');
  return out;
}

/** 세 관측을 한 번에 모은다. 서버 조회 실패는 예외가 아니라 **값**으로 흐른다. */
export async function collectTrashState(): Promise<TrashObservation> {
  const [server, emptyOnRestore, orphans, localTrips, localKids] = await Promise.all([
    readServerTrash(),
    readEmptyOnRestore(),
    readOrphans(),
    listDeletedTrips(),
    listTrashedChildren(),
  ]);
  return {
    cloudConfigured: isConfigured(),
    serverTrashCount: server.count,
    unavailableReason: server.reason,
    localTrashCount: localTrips.length + localKids.length,
    emptyOnRestore,
    orphans,
  };
}
