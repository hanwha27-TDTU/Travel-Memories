// services/serverContract.ts — 「서버 계약」의 **읽기 전용 실측**.
//
// 개발 컨테이너는 프록시가 운영 서버 접근을 막아 이걸 잴 수 없다. 사용자의 앱은 **진짜
// 서버에 붙어 있으므로** 그 자리에서 재면 된다(BLIND_SPOTS의 contract 그룹 4건).
//
// 🔴 **아무것도 쓰지 않는다.** 세 검사 전부 SELECT다. 쓰기 계약은 「왕복 시험」이 따로 잰다.

import { createClient } from '@supabase/supabase-js';
import { supabase, isConfigured, type JourneyClient } from './supabase/client';
import { currentUser } from './auth';
import type { ServerContractObservation } from '../domain/serverContractVerdict';

/**
 * 앱이 페이지네이션에 쓰는 크기. `canonicalSync.ts`의 `PAGE_SIZE`와 **같아야 한다** —
 * 다르면 이 도구가 엉뚱한 가정을 재게 된다.
 *
 * 🔴 손으로 맞춘 값이다. 저쪽이 바뀌면 여기도 바뀌어야 하고, 그 짝은
 * `check-page-size-parity`가 정적으로 대조한다(§7 2층 — 산문 약속은 반드시 드리프트한다).
 */
export const ASSUMED_PAGE_SIZE = 1000;

/** 실측용 테이블 — 여행은 어느 계정에나 있고 행이 가장 적어 egress가 싸다. */
const PROBE_TABLE = 'trips';

/**
 * ① 서버가 한 번에 주는 최대 행수.
 *
 * 앱의 가정(`ASSUMED_PAGE_SIZE`)만큼 요청해 **실제로 몇 행이 왔는지** 본다.
 * 자료가 그보다 적으면 상한을 알 수 없으므로(요청보다 적게 온 것이 정상) `null`을 준다 —
 * 「자료가 적어서 못 쟀다」와 「서버가 잘라서 줬다」는 다른 말이다(§8).
 */
async function measurePageSize(c: JourneyClient): Promise<number | null> {
  const { data, error } = await c
    .from(PROBE_TABLE)
    .select('id')
    .order('id', { ascending: true })
    .range(0, ASSUMED_PAGE_SIZE - 1);
  if (error || !data) return null;
  const n = (data as unknown[]).length;
  // 요청한 만큼 다 왔으면 상한은 그 이상이다. 덜 왔으면 **자료가 그만큼인 것**이라
  // 상한을 알 수 없다 — 이때 「서버가 잘랐다」로 읽으면 정상을 문제라 부르게 된다.
  return n >= ASSUMED_PAGE_SIZE ? n : null;
}

/**
 * ② 페이지 경계에서 행이 빠지지 않는가.
 *
 * 재는 법: `[0..1]`과 `[1..2]`를 따로 받아 **겹치는 자리(index 1)가 같은 행인지** 본다.
 * 같으면 서버의 정렬·오프셋이 두 요청 사이에 일관된 것이고, 다르면 그 사이로 행이
 * 빠지거나 겹칠 수 있다. 행이 3개 미만이면 경계가 생기지 않으므로 `null`(못 쟀음).
 */
async function checkPaginationSeam(
  c: JourneyClient,
): Promise<{ sound: boolean | null; note: string | null }> {
  const q = (from: number, to: number) =>
    c.from(PROBE_TABLE).select('id').order('id', { ascending: true }).range(from, to);
  const [a, b] = await Promise.all([q(0, 1), q(1, 2)]);
  if (a.error || b.error) return { sound: null, note: '서버 조회에 실패했어요' };
  const rowsA = (a.data ?? []) as { id: string }[];
  const rowsB = (b.data ?? []) as { id: string }[];
  if (rowsA.length < 2 || rowsB.length < 1) {
    return { sound: null, note: '여행이 3건 이상이어야 경계를 잴 수 있어요' };
  }
  const sound = rowsA[1].id === rowsB[0].id;
  return {
    sound,
    note: sound ? null : `경계 행이 다릅니다(${rowsA[1].id.slice(0, 8)} ≠ ${rowsB[0].id.slice(0, 8)})`,
  };
}

/**
 * ③ 🔴 로그인 없는 요청이 실제로 막히는가 — **이 앱에서 가장 무거운 실측**.
 *
 * 세션이 붙지 않은 **새 클라이언트**를 만들어 같은 테이블을 조회한다. 정상이면 RLS가
 * 0행을 주거나 권한 오류를 낸다. 행이 오면 그건 **남의 자료가 보인다**는 뜻이다(§0).
 *
 * 왜 새 클라이언트인가: 기존 `supabase()`는 세션을 물고 있어 그대로 쓰면 **내가 로그인한
 * 상태로** 묻게 된다 — 그러면 이 검사는 아무것도 재지 않는다(공허한 검사, §4).
 * `persistSession: false`로 만들어 저장된 토큰도 집지 않는다.
 */
async function probeAnonAccess(): Promise<{ blocked: boolean | null; rows: number | null; note: string | null }> {
  const u = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const k = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
  if (!u || !k) return { blocked: null, rows: null, note: '환경변수를 읽지 못했어요' };
  try {
    const anon = createClient(u, k, {
      db: { schema: 'journey' },
      // 🔴 이 셋이 이 검사의 전부다 — 하나라도 빠지면 내 세션을 물고 가서 공허해진다.
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await anon.from(PROBE_TABLE).select('id').limit(5);
    if (error) {
      // 권한 오류 = 막힌 것이다. 네트워크 오류와 구분하려면 코드를 봐야 하지만, PostgREST는
      // RLS 거부를 401/403 또는 빈 결과로 준다 — 오류가 났다는 사실 자체가 「안 내줬다」이다.
      return { blocked: true, rows: 0, note: null };
    }
    const n = ((data ?? []) as unknown[]).length;
    return { blocked: n === 0, rows: n, note: null };
  } catch (e) {
    // 🔴 예외를 「막혔다」로 반올림하지 않는다 — 네트워크가 끊겨도 예외가 난다(§8).
    return { blocked: null, rows: null, note: (e as Error).message || '익명 요청을 보내지 못했어요' };
  }
}

/** 세 실측을 모은다. 실패는 예외가 아니라 **값**으로 흐른다. */
export async function collectServerContract(): Promise<ServerContractObservation> {
  const base: ServerContractObservation = {
    cloudConfigured: isConfigured(),
    signedIn: false,
    observedPageSize: null,
    assumedPageSize: ASSUMED_PAGE_SIZE,
    paginationSound: null,
    paginationNote: null,
    anonBlocked: null,
    anonRowsSeen: null,
    anonNote: null,
  };
  if (!base.cloudConfigured) return base;

  const c = supabase();
  const signedIn = Boolean(c && (await currentUser()));
  // ③은 **로그인과 무관하게** 잰다 — 오히려 로그인 전에도 서버가 막는지가 이 지표의 질문이다.
  const anon = await probeAnonAccess();
  if (!c || !signedIn) {
    return {
      ...base,
      signedIn,
      anonBlocked: anon.blocked,
      anonRowsSeen: anon.rows,
      anonNote: anon.note,
    };
  }
  const [pageSize, seam] = await Promise.all([measurePageSize(c), checkPaginationSeam(c)]);
  return {
    ...base,
    signedIn: true,
    observedPageSize: pageSize,
    paginationSound: seam.sound,
    paginationNote: seam.note,
    anonBlocked: anon.blocked,
    anonRowsSeen: anon.rows,
    anonNote: anon.note,
  };
}
