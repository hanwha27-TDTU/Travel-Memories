// services/roundTrip.ts — 「왕복 시험」의 **실제 실행**(쓰기 시험).
//
// 사용자 결정(2026-08-05): 진단 범위를 *"쓰기 시험까지"*로 확장한다. 읽기 전용 관측은
// **지금 상태**만 말한다 — 「저장이 실제로 도착하는가」는 한 번 보내 봐야 안다.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 안전 경계 (§0 — 원본 자료를 임의로 삭제/덮어쓰지 않는다)
// ─────────────────────────────────────────────────────────────────────────────
//  ① **자기가 만든 id 하나만** 건드린다. 사용자의 실제 기록은 읽지도 쓰지도 않는다.
//  ② 시험용 여행에는 알아볼 수 있는 제목 접두사가 붙는다(`ROUND_TRIP_TITLE_PREFIX`) —
//     **숨기지 않는다.** 감추면 정리 실패를 사용자가 영영 모른다.
//  ③ 어느 단계에서 실패하든 **정리를 시도**하고, 못 치웠으면 `leftover`에 id를 남겨
//     화면이 그 사실을 말한다. 조용한 잔재가 곧 M-0019형 오염이다.
//  ④ 사진·소리·영상은 이번 판에서 만들지 않는다 — R2 바이트가 얽히면 실패 시 정리가
//     여러 층이 되고, 그 층을 다 갖추기 전에는 잔재 위험이 이득보다 크다.
//     (「파일 실재 전수」 도구에서 별도로 다룬다.)

import { db } from '../offline/db';
import { supabase } from './supabase/client';
import { currentUser } from './auth';
import { requestSync } from './autoSync';
import { createTripLocalFirst, updateTripLocalFirst, softDeleteTripLocalFirst, purgeTripPermanently } from './trips';
// 시각 비교는 **표기가 아니라 의미 단위**로 — 서버와 로컬이 같은 순간을 다르게 적는다(M-0034).
import { compareInstants } from '../domain/time';
import {
  ROUND_TRIP_STEPS,
  ROUND_TRIP_TITLE_PREFIX,
  type RoundTripRun,
  type RoundTripStep,
  type StepResult,
} from '../domain/roundTripVerdict';

const LAST_RUN_KEY = 'bugeon:lastRoundTrip';

/**
 * 마지막 시험 결과 — `localStorage`에 둔다. 캐시 성격(기억 자체가 아님)이라 사이트 데이터를
 * 지워 사라져도 무해하고, Dexie에 쓰면 백업 대상 판단이 흐려진다(`backupMeta.ts`와 같은 규율).
 */
export function lastRoundTrip(): RoundTripRun | null {
  try {
    const raw = localStorage.getItem(LAST_RUN_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as RoundTripRun;
    // 형식이 낡았으면 「없음」으로 본다 — 반쯤 읽힌 결과를 판정에 쓰면 거짓이 된다.
    return Array.isArray(v.steps) && typeof v.at === 'string' ? v : null;
  } catch {
    return null;
  }
}

function saveRun(run: RoundTripRun): void {
  try {
    localStorage.setItem(LAST_RUN_KEY, JSON.stringify(run));
  } catch {
    /* localStorage 불가(프라이빗 모드 등) — 시험 자체엔 영향 없다. */
  }
}

/**
 * 한 단계를 재고 결과를 기록한다. 던지지 않는다 — 실패도 **값**으로 흐른다.
 *
 * 문자열을 돌려주면 그건 「통과했지만 이런 걸 봤다」는 관측이다(`note`).
 */
async function runStep(step: RoundTripStep, fn: () => Promise<string | void>): Promise<StepResult> {
  const t0 = Date.now();
  try {
    const note = await fn();
    return { step, state: 'pass', ms: Date.now() - t0, error: null, note: note ?? null };
  } catch (e) {
    return { step, state: 'fail', ms: Date.now() - t0, error: (e as Error).message || '알 수 없는 오류', note: null };
  }
}

/** 서버에서 여행 한 건을 되읽는다. 없으면 null. */
async function readServerTrip(id: string): Promise<{ deleted_at: string | null; updated_at: string } | null> {
  const c = supabase();
  if (!c) throw new Error('서버 연결이 설정되지 않았습니다');
  const { data, error } = await c.from('trips').select('id, deleted_at, updated_at').eq('id', id).maybeSingle();
  if (error) throw new Error(`서버 조회 실패: ${error.message}`);
  return (data as { deleted_at: string | null; updated_at: string } | null) ?? null;
}

/** 영구삭제 원장에 id가 있는가 — 좀비 차단의 근거가 실제로 남았는지. */
async function purgedOnServer(id: string): Promise<boolean> {
  const c = supabase();
  if (!c) throw new Error('서버 연결이 설정되지 않았습니다');
  const { data, error } = await c.from('purged_ids').select('id').eq('id', id).maybeSingle();
  if (error) throw new Error(`원장 조회 실패: ${error.message}`);
  return Boolean(data);
}

/**
 * 시험용 여행이 이 기기에 남아 있으면 치운다. **접두사가 붙은 것만** 대상으로 한다.
 * 정리는 멱등이어야 한다 — 여러 번 눌러도 안전하고, 실패해도 다음 시도가 이어받는다.
 */
export async function cleanupRoundTripLeftovers(): Promise<string[]> {
  const d = db();
  const all = await d.localTrips.toArray();
  const mine = all.filter((t) => t.title.startsWith(ROUND_TRIP_TITLE_PREFIX));
  const stillThere: string[] = [];
  for (const t of mine) {
    try {
      if (t.deletedAt === null) await softDeleteTripLocalFirst(t.id);
      await purgeTripPermanently(t.id);
      if (await d.localTrips.get(t.id)) stillThere.push(t.id);
    } catch {
      stillThere.push(t.id);
    }
  }
  return stillThere;
}

/**
 * 왕복 한 판을 돈다. **던지지 않는다** — 어디서 끊겼는지가 결과이므로, 예외로 나가면
 * 그 정보가 사라진다(§13 4항 ③ — 실패 사유를 조용히 삼키지 않는다).
 *
 * 앞 단계가 실패하면 뒤는 `skipped`다. 「안 쟀다」와 「실패했다」는 다른 말이고, 둘을
 * 같은 빨강으로 칠하면 사용자가 원인을 엉뚱한 데서 찾는다(§8).
 */
export async function runRoundTrip(): Promise<RoundTripRun> {
  const at = new Date().toISOString();
  const steps: StepResult[] = [];
  let tripId: string | null = null;

  const bail = (from: number): RoundTripRun => {
    for (const s of ROUND_TRIP_STEPS.slice(from)) steps.push(skip(s));
    return { at, steps, leftover: null };
  };

  // 사전 조건 — 못 도는 상황은 **실패가 아니라 못 돈 것**이다. 그대로 사유를 적는다.
  const c = supabase();
  if (!c) {
    steps.push({ step: 'create', state: 'fail', ms: null, note: null, error: '서버 연결이 설정되지 않았습니다(로컬 전용 배포)' });
    const run = bail(1);
    saveRun(run);
    return run;
  }
  if (!(await currentUser())) {
    steps.push({ step: 'create', state: 'fail', ms: null, note: null, error: '로그인 상태가 아닙니다' });
    const run = bail(1);
    saveRun(run);
    return run;
  }

  // ① 이 기기에 저장 — 시각을 제목에 넣어 여러 판이 겹쳐도 구분된다.
  const stamp = at.slice(0, 19).replace('T', ' ');
  steps.push(
    await runStep('create', async () => {
      const t = await createTripLocalFirst({ title: `${ROUND_TRIP_TITLE_PREFIX} ${stamp}` });
      tripId = t.id;
    }),
  );
  if (!tripId) {
    const run = { at, steps: [...steps, ...ROUND_TRIP_STEPS.slice(1).map((s) => skip(s))], leftover: null };
    saveRun(run);
    return run;
  }
  const id: string = tripId;

  // ② 서버로 올림 → ③ 되읽어 확인. **성공 응답이 아니라 행이 있는가**(§2-B read-back).
  steps.push(await runStep('push', async () => void (await requestSync('왕복 시험'))));
  steps.push(
    await runStep('serverRead', async () => {
      const row = await readServerTrip(id);
      if (!row) throw new Error('올렸는데 서버에서 그 행을 찾지 못했습니다');
      if (row.deleted_at !== null) throw new Error('올린 직후인데 서버에서 이미 삭제 상태입니다');
    }),
  );

  steps.push(...(await updateAndStamp(id, stamp))); // ④⑤ T-013 — 아래 함수의 머리말이 이유를 적는다

  // ⑥ 휴지통으로 → ⑦ 그 삭제가 서버에도 갔는가(다른 기기가 이걸 보고 지운다).
  steps.push(await runStep('delete', async () => void (await softDeleteTripLocalFirst(id))));
  steps.push(
    await runStep('tombstoneRead', async () => {
      await requestSync('왕복 시험 — 삭제 반영');
      const row = await readServerTrip(id);
      if (!row) throw new Error('서버에서 행이 통째로 사라졌습니다(tombstone이어야 합니다)');
      if (row.deleted_at === null) throw new Error('지웠는데 서버는 아직 살아 있다고 합니다');
    }),
  );

  // ⑧ 영구삭제 → ⑨ 행 사라짐 + 원장에 남음(좀비 차단의 근거).
  steps.push(await runStep('purge', async () => void (await purgeTripPermanently(id))));
  steps.push(
    await runStep('purgeRead', async () => {
      await requestSync('왕복 시험 — 영구삭제 반영');
      const row = await readServerTrip(id);
      if (row) throw new Error('영구삭제했는데 서버에 행이 남아 있습니다');
      if (!(await purgedOnServer(id))) {
        throw new Error('원장에 표식이 없습니다 — 다른 기기에서 되살아날 수 있습니다');
      }
    }),
  );

  // ⑩ 이 기기 뒷정리 — 시험이 자기 흔적을 남기지 않았는가(§3-C).
  let leftover: string | null = null;
  steps.push(
    await runStep('cleanup', async () => {
      const stuck = await cleanupRoundTripLeftovers();
      if (stuck.length) {
        leftover = stuck[0];
        throw new Error(`시험용 기록 ${stuck.length}건을 치우지 못했습니다`);
      }
      if (await db().localTrips.get(id)) {
        leftover = id;
        throw new Error('시험용 여행이 이 기기에 남아 있습니다');
      }
    }),
  );

  const run: RoundTripRun = { at, steps, leftover };
  saveRun(run);
  return run;
}

/**
 * ④ **이미 있는 행을 고친다** → ⑤ 그 수정 시각을 이 기기와 서버가 같은 값으로 들고 있는가.
 *
 * ── 이 두 단계가 왜 있나 (T-013 · 2026-08-06) ────────────────────────────────
 * 운영 DB 실측: `journey.set_updated_at()`은 `new.updated_at := now()`로 **무조건 덮어쓴다.**
 * 다만 트리거는 이름 순으로 돌아 `a_sync_write_guard`가 **먼저** 보므로 LWW·OCC 판정 자체는
 * **이 기기가 보낸 값**으로 내려지고, push의 read-back이 서버 값을 받아 적어 양쪽이 같아진다.
 *
 * 🔴 **그 「같아짐」은 코드를 읽어서가 아니라 실제 서버에서 확인돼야 한다.** 두 기기가 같은
 * 기록을 고쳤을 때 어느 쪽이 최신인지 가리는 근거가 바로 그 값이기 때문이다.
 *
 * 🔴 **왜 「고치기」인가**: 그 트리거는 **UPDATE에만** 붙어 있다. 만들기(INSERT)만 재면 이
 * 질문은 **문제가 날 수 없는 자리**에서 초록이 나고, 그 초록의 뜻은 「없다」가 아니라
 * **「안 봤다」**이다(§17 — 검사가 모순이 날 수 있는 표면에서 도는가).
 */
async function updateAndStamp(id: string, stamp: string): Promise<StepResult[]> {
  const sent = { at: null as string | null };
  const update = await runStep('update', async () => {
    await updateTripLocalFirst(id, { title: `${ROUND_TRIP_TITLE_PREFIX} ${stamp} (수정)` });
    const local = await db().localTrips.get(id);
    if (!local) throw new Error('고친 직후인데 이 기기에서 그 기록을 찾지 못했습니다');
    sent.at = local.updatedAt; // 서버가 이 값을 그대로 둘지 바꿀지가 다음 단계의 관측이다
  });
  const stampRead = await runStep('stampRead', async () => {
    if (!sent.at) throw new Error('고치기가 되지 않아 보낸 시각을 모릅니다');
    await requestSync('왕복 시험 — 수정 반영');
    const row = await readServerTrip(id);
    if (!row) throw new Error('고쳤는데 서버에서 그 행을 찾지 못했습니다');
    const local = await db().localTrips.get(id);
    if (!local) throw new Error('이 기기에서 그 기록을 찾지 못했습니다');
    // 🔴 문자열 대소가 아니라 **의미 단위**로 비교한다 — 서버는 `…+00:00`, 로컬은 `…Z`로
    // 같은 순간을 다르게 적는다. 문자열로 비교하면 멀쩡한 것을 결함이라 부른다(M-0034).
    const same = compareInstants(local.updatedAt, row.updated_at);
    if (same === null) {
      throw new Error(`시각 표기를 비교할 수 없습니다 — 이 기기 ${local.updatedAt} · 서버 ${row.updated_at}`);
    }
    if (same !== 0) {
      throw new Error(
        `이 기기와 서버가 서로 다른 수정 시각을 들고 있어요 — 이 기기 ${local.updatedAt} · 서버 ${row.updated_at}. ` +
          '다음 동기화에서 어느 쪽이 최신인지 판정이 흔들릴 수 있습니다',
      );
    }
    // 통과했어도 **무엇을 봤는지**는 말한다(§12). 서버가 바꾸는 것 자체는 결함이 아니다 —
    // 이 기기가 그 값을 받아 적어 양쪽이 같아지는 것이 계약이고, 위에서 그걸 확인했다.
    return compareInstants(sent.at, row.updated_at) === 0
      ? `서버가 보낸 시각을 그대로 뒀고, 이 기기도 같은 값입니다(${row.updated_at})`
      : `서버가 자기 시각으로 바꿨고(보낸 값 ${sent.at} → 서버 ${row.updated_at}), 이 기기도 그 값을 받아 적었습니다`;
  });
  return [update, stampRead];
}

function skip(step: RoundTripStep): StepResult {
  return { step, state: 'skipped', ms: null, error: null, note: null };
}
