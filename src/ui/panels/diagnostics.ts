// ui/panels/diagnostics.ts — 진단 도구 **여섯 개의 판정(Verdict)**.
//
// 이 파일에는 **그리는 코드가 없다.** 각 도구는 `Verdict`(데이터)만 만들고, 그리는 일은
// `panels/verdict.ts`의 `renderTool()` 한 곳이 한다. 왜 그렇게까지 하는지는 그 파일의 머리주석에
// 적었다 — 요약하면 "선언만으로는 대칭이 안 지켜진다"(M-0006에서 실제로 겪었다).
//
// 2026-07-26 재설계의 계기(사용자 지적):
//   "뭐가 문제인지도 잘 모르겠고 **너무 나열되어** 있기도 하구요.
//    우리가 이런 도구를 만드는 건 **정상은 어떤 상태이고 문제가 발생한 게 뭔지 차이를 아는 것**
//    아닐까요?"
// 이전 화면은 정상 항목 11개를 이상 항목과 똑같은 알약으로 나열했다. 지금은 정상이 한 줄로
// 접히고, **남아 있는 것이 곧 문제**다.
//
// 지표 감사(무엇을 최상위에 둘지 임의로 고르지 않았다 — 기대값을 쓸 수 있는가로 걸렀다):
//   ○ 최상위 지표  = "정상이면 이 값" 을 쓸 수 있는 것만. (막힌 작업 없음, 미지원 기능 없음 …)
//   ○ 접힌 출처    = 판정 불가하거나 목록인 것. (지운 항목 개수, 영구삭제 표식, 항목 id …)
//   ○ 맥락(context) = 상태가 아닌 환경 사실. (앱 버전·시간대·사진 저장소 …)
// 옛 동기화 진단 5줄 중 최상위 자격이 있는 것은 사실상 하나뿐이었다.

import { el } from '../dom';
import { db } from '../../offline/db';
import { diagnoseSync } from '../../services/diagnostics';
import { forceRepairCascadeOps, retryFailedOps } from '../../services/sync';
import { checkIntegrity, CHECK_COUNT } from '../../domain/integrity';
import { collectEnv, evictionRisk, requestPersist } from '../../services/envReport';
import { recentErrors, clearErrors } from '../../app/errorLog';
import { CHANGELOG } from '../../app/changelog';
import { syncStatus, requestSync } from '../../services/autoSync';
import {
  compareStore,
  storeStateRemote,
  unionListings,
  DOMAIN_LABEL,
  type StoreComparison,
} from '../../services/storeState';
import { r2ListObjects, r2DeleteMany, r2AbortMultipart } from '../../services/r2';
import {
  PURGE_DOMAINS,
  requeueUnpropagatedPurges,
  purgeServerOnly,
  requestUnpurge,
  pendingUnpurgeIds,
} from '../../services/purge';
import { supabase } from '../../services/supabase/client';
import {
  deviceLabel,
  shortDeviceId,
  customDeviceName,
  setCustomDeviceName,
  detectDeviceLabel,
  readDeviceHints,
  DEVICE_NAME_MAX,
} from '../../app/deviceId';
import { renderTool, levelFromMetrics, worst, type Verdict, type Metric, type Level, type Action } from './verdict';

/** 접힌 출처에 보일 사진 id 상한. 넘으면 "외 N건 생략"이라고 **적는다**(조용히 자르지 않는다). */
export const FILE_ID_CAP = 20;

/**
 * 이 앱이 **기대하는** 사진 저장소 함수 판. 서버가 이보다 낮으면 새 지표를 믿을 수 없다.
 * 함수에 연산을 추가할 때 `FN_VERSION`과 **함께** 올린다 — 안 올리면 화면이 낡음을 못 알아본다.
 */
export const EXPECTED_FN_VERSION = 5;

/** 화면에 표시할 앱 버전 — changelog가 SSOT(손으로 적지 않는다). */
const APP_VERSION = `v${CHANGELOG[0]?.version ?? '0.00'}`;

/** 사람이 읽는 바이트. */
function bytes(n: number | null): string {
  if (n === null) return '알 수 없음';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** 접힌 출처용 표 — 목록·원자료는 전부 이 형태로 내려간다. */
function table(rows: [string, string][]): HTMLElement {
  const t = el('div', 'vd-src-table');
  for (const [k, v] of rows) {
    const r = el('div', 'vd-src-row');
    r.append(el('span', 'vd-src-k', k), el('span', 'vd-src-v', v));
    t.appendChild(r);
  }
  if (!rows.length) t.appendChild(el('p', 'vd-src-empty', '없음'));
  return t;
}

const countMap = (o: Record<string, number>): string =>
  Object.entries(o)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`)
    .join(' · ') || '없음';

// ────────────────────────────────────────────────────────────────────────────
// ① 저장소 안전 — 앱 밖 원인의 유일한 기억 손실 경로
// ────────────────────────────────────────────────────────────────────────────

export async function storageProbe(): Promise<Verdict> {
  const env = await collectEnv(APP_VERSION);
  const risk = evictionRisk(env);
  const { usage, quota, persisted, canPersist } = env.storage;
  const pct = usage !== null && quota ? Math.round((usage / quota) * 100) : null;

  const metrics: Metric[] = [
    {
      label: '저장소 보호(persist)',
      actual: persisted === null ? '알 수 없음' : persisted ? '적용됨' : '미적용',
      expected: '적용됨',
      level: persisted === null ? 'unknown' : persisted ? 'ok' : 'todo',
      ...(persisted === false
        ? { meaning: '보호가 없으면 브라우저가 공간이 부족할 때 이 앱의 기록을 지울 수 있어요. 아래 버튼으로 요청할 수 있습니다(브라우저가 거절할 수도 있어요).' }
        : {}),
    },
    {
      label: '저장 공간 사용률',
      actual: pct === null ? '알 수 없음' : `${pct}% (${bytes(usage)} / ${bytes(quota)})`,
      expected: '80% 미만',
      level: pct === null ? 'unknown' : pct >= 80 ? 'problem' : 'ok',
      ...(pct !== null && pct >= 80
        ? { meaning: '여유가 적어요. 브라우저가 공간을 회수하며 앱 데이터를 지울 수 있습니다. 지금 [데이터 관리 › 백업]으로 파일을 받아 두세요.' }
        : {}),
    },
  ];

  const level = levelFromMetrics(metrics);
  const v: Verdict = {
    level,
    headline:
      level === 'problem'
        ? '저장 공간이 부족해요 — 지금 백업을 받으세요'
        : level === 'todo'
          ? '저장소 보호를 켜면 더 안전해요'
          : level === 'unknown'
            ? '이 브라우저는 저장 용량을 알려주지 않아요'
            : '브라우저가 이 기기의 기록을 임의로 지우지 않습니다',
    because: risk.text,
    metrics,
    actions: [],
    evidence: [],
    // 같은 기기를 화면마다 다르게 부르지 않는다(§7 사용자 대면 대칭). `navigator.platform`은
    // 「Linux」처럼 사용자가 자기 태블릿을 못 알아보는 값을 준다 — 「저장 상태」가 쓰는 이름표와
    // **같은 것**을 쓴다(사용자가 지은 이름이 있으면 그게 이긴다).
    context: [{ label: '기기', value: `${deviceLabel()} · ${shortDeviceId()}` }],
  };
  if (persisted !== true && canPersist) {
    v.actions.push({
      label: '저장소 보호 요청',
      primary: true,
      hook: 'data-ask-persist',
      run: async () => {
        const ok = await requestPersist();
        if (ok) return '보호가 적용됐어요. 브라우저가 임의로 지우지 않습니다.';
        // ⚠️ 2026-07-26 사용자 실기기: 여기서 멈추면 **판정만 하고 행동을 못 준 것**이다
        // (근본형 D). 브라우저가 거절한 것은 우리 잘못이 아니지만, *어떻게 하면 허락하는지*는
        // 알려줄 수 있다 — 그게 화면이 할 일이다.
        //
        // Chrome은 이 권한을 요청만으로 주지 않고 **"이 사이트를 중요하게 쓰고 있는가"**로
        // 판단한다. 가장 확실한 신호가 **홈 화면에 추가(앱으로 설치)**다. 추측이 아니라
        // 브라우저가 공개한 기준이고, 우리가 사용자에게 시킬 수 있는 유일한 행동이다.
        return (
          '브라우저가 아직 허락하지 않았어요. 크롬은 "이 사이트를 중요하게 쓴다"고 판단해야 허락합니다 — ' +
          '메뉴(⋮) → **홈 화면에 추가**로 앱처럼 설치한 뒤 다시 눌러 보세요. ' +
          '그래도 안 되면 괜찮습니다: 가장 확실한 보호는 [데이터 관리 › 백업]으로 파일을 받아두는 것입니다.'
        );
      },
    });
  }
  return v;
}

// ────────────────────────────────────────────────────────────────────────────
// ② 동기화 상태 — 서버와 얼마나 어긋나 있나
// ────────────────────────────────────────────────────────────────────────────

/**
 * 대기열을 **두 가지로 쪼갠다** — 이게 옛 화면의 핵심 결함이었다.
 * "대기 중인 작업 3건"은 *아직 안 보낸 것*과 *보내다 막힌 것*을 한 숫자에 섞었다. 앞은 동기화를
 * 누르면 풀리는 '할 일'이고, 뒤는 눌러도 안 풀리는 '문제'다. 사용자가 해야 할 행동이 정반대다.
 */
export const STUCK_STATES = new Set(['permanent_failed', 'conflict', 'failed']);

export async function syncProbe(): Promise<Verdict> {
  const d = await diagnoseSync();
  const stuck = Object.entries(d.queue.byState)
    .filter(([s]) => STUCK_STATES.has(s))
    .reduce((a, [, n]) => a + n, 0);
  const waiting = d.queue.total - stuck;
  const opless = Object.values(d.opLessTombstones).reduce((a, b) => a + b, 0);

  const metrics: Metric[] = [
    {
      label: '막힌 작업',
      actual: stuck === 0 ? '없음' : `${stuck}건`,
      expected: '없음',
      level: stuck > 0 ? 'problem' : 'ok',
      ...(stuck > 0
        ? { meaning: '보내다 실패해 멈춘 작업이에요. 동기화를 눌러도 저절로 풀리지 않습니다 — 아래 [실패 재시도]를 눌러 주세요.' }
        : {}),
    },
    {
      label: '보낼 대기',
      actual: waiting === 0 ? '없음' : `${waiting}건`,
      expected: '없음',
      level: waiting > 0 ? 'todo' : 'ok',
      ...(waiting > 0 ? { meaning: '아직 서버로 보내지 않은 변경이에요. 동기화를 누르면 올라갑니다 — 정상적인 대기 상태입니다.' } : {}),
    },
    {
      label: '지웠지만 보낼 목록엔 없는 항목',
      actual: opless === 0 ? '없음' : `${opless}건`,
      expected: '로컬만으로는 판정 불가',
      // 정직(비타협 원칙 #4): 이 숫자는 "이미 서버에 갔다"와 "못 갔다"를 구분하지 못한다.
      // M-0008에서 이걸 "서버로 못 간 삭제"라 단정해 거짓 경보를 냈다. 모르는 건 모른다고 쓴다.
      level: opless > 0 ? 'unknown' : 'ok',
      ...(opless > 0
        ? { meaning: '이미 서버에 반영됐을 수도(정상), 못 갔을 수도 있어요 — 이 기기 정보만으로는 구분되지 않습니다. 동기화를 누르면 서버와 대조해 자동으로 처리합니다.' }
        : {}),
    },
  ];

  // 자동 동기화가 **조용히 실패하고 있지 않은지** — 자동화의 가장 큰 위험이 여기다(M-0008 부류).
  const st = syncStatus();
  metrics.push({
    label: '자동 동기화',
    actual:
      st.phase === 'failed'
        ? `실패 — ${st.lastError ?? '사유 불명'}`
        : st.phase === 'offline'
          ? '오프라인이라 대기 중'
          : st.phase === 'signed-out'
            ? '로그인하지 않아 대기 중'
            : st.lastOkAt
              ? `마지막 성공 ${st.lastOkAt.slice(11, 19)}`
              : '이 세션에서 아직 실행 안 됨',
    expected: '최근에 성공',
    level: st.phase === 'failed' ? 'problem' : st.phase === 'ok' ? 'ok' : 'unknown',
    ...(st.phase === 'failed'
      ? { meaning: '자동으로 보내려다 실패했어요. 저장한 기록은 이 기기에 안전합니다 — 연결을 확인하고 [지금 동기화]를 눌러 주세요.' }
      : st.phase === 'signed-out'
        ? { meaning: '로그인하면 저장·삭제할 때마다 자동으로 서버에 올라갑니다.' }
        : {}),
  });

  const level = levelFromMetrics(metrics);
  const v: Verdict = {
    level,
    headline:
      level === 'problem'
        ? `보내지 못하고 멈춘 작업이 ${stuck}건 있어요`
        : level === 'todo'
          ? `서버로 보낼 변경이 ${waiting}건 남아 있어요`
          : level === 'unknown'
            ? '서버와 한 번 대조해 봐야 알 수 있어요'
            : '이 기기에서 서버로 보낼 것이 남아 있지 않습니다',
    metrics,
    actions: [],
    evidence: [
      {
        label: '자세히 — 지운 항목·표식',
        build: () =>
          table([
            ['지운 항목(이 기기)', countMap(d.tombstones)],
            ['영구삭제 표식', String(d.purgedMarks)],
            ['대기열 종류별', countMap(d.queue.byType)],
            ['대기열 상태별', countMap(d.queue.byState)],
          ]),
      },
      {
        // 잘랐으면 잘랐다고 라벨에 적는다 — 조용한 절단은 "전부 봤다"로 읽힌다.
        label: `설명이 필요한 항목 ${d.items.length}개${d.itemsOmitted ? ` (외 ${d.itemsOmitted}건 생략)` : ''}`,
        build: () =>
          table([
            ...d.items.map(
              (it): [string, string] => [
                `${it.type} ${it.id.slice(0, 8)}`,
                `${it.deleted ? '지움' : '활성'}${it.queued ? ' · 보낼 목록에 있음' : ' · 보낼 목록에 없음'}`,
              ],
            ),
            ...(d.itemsOmitted ? ([['…', `외 ${d.itemsOmitted}건은 화면에서 생략했어요(전체는 [진단 요약 복사]에 담깁니다)`]] as [string, string][]) : []),
          ]),
      },
    ],
    context: [{ label: '사진 저장소', value: d.mediaStore === 'r2' ? 'Cloudflare R2' : 'Supabase Storage' }],
  };

  // 주행동은 판정에 따라 **하나만** primary. 여러 버튼을 늘어놓으면 무엇을 눌러야 할지 다시 사용자 몫이 된다.
  if (stuck > 0) {
    v.actions.push({
      label: '실패 재시도',
      primary: true,
      hook: 'data-retry-failed',
      run: async () => {
        const n = await retryFailedOps();
        return n ? `막혀 있던 작업 ${n}건을 다시 시도하도록 되돌렸어요. 이어서 [지금 동기화]를 눌러 주세요.` : '막힌 작업이 없어요.';
      },
    });
  }
  v.actions.push({
    label: '지금 동기화',
    primary: stuck === 0 && (waiting > 0 || opless > 0),
    hook: 'data-sync-now',
    run: async () => {
      // 수동 버튼도 **같은 경로**를 쓴다 — 단일 실행·상태 보고가 거기 있다(§7).
      await requestSync('수동');
      const after = syncStatus();
      if (after.phase === 'failed') return `동기화 실패: ${after.lastError ?? '사유 불명'}`;
      if (after.phase === 'signed-out') return '로그인 상태가 아니에요. 홈 화면에서 로그인한 뒤 다시 시도해 주세요.';
      if (after.phase === 'offline') return '오프라인이에요. 연결되면 자동으로 다시 시도합니다.';
      const r = after.lastResult;
      return r ? `동기화했어요 — 올림 ${r.pushed}건 · 내림 ${r.pulled}건.` : '동기화했어요.';
    },
  });
  if (opless > 0) {
    // 강등: [정리 실행]은 옛 화면에서 최상위 버튼이었는데, 대부분의 경우 [지금 동기화]가 같은 일을
    // 자동으로 한다. 사용자가 먼저 손댈 버튼이 아니다.
    v.actions.push({
      label: '정리 실행',
      hook: 'data-repair-sync',
      run: async () => {
        const r = await forceRepairCascadeOps();
        return `사진 ${r.media}건 · 비용 ${r.expenses}건을 다시 보낼 목록에 넣었어요. 이어서 [지금 동기화]를 눌러 주세요. (데이터는 지워지지 않습니다.)`;
      },
    });
  }
  return v;
}

// ────────────────────────────────────────────────────────────────────────────
// ③ ID 무결성 — 기록이 서로 앞뒤가 맞나
// ────────────────────────────────────────────────────────────────────────────

export async function integrityProbe(): Promise<Verdict> {
  const d = db();
  const [trips, moments, media, expenses] = await Promise.all([
    d.localTrips.toArray(),
    d.localMoments.toArray(),
    d.localMedia.toArray(),
    d.localExpenses.toArray(),
  ]);
  const r = checkIntegrity({ trips, moments, media, expenses });
  const nowFinds = r.findings.filter((f) => f.severity === 'now');
  const prevFinds = r.findings.filter((f) => f.severity === 'prevent');

  const metrics: Metric[] = [
    {
      label: '지금 확인이 필요한 기록',
      actual: r.bySeverity.now === 0 ? '없음' : `${r.bySeverity.now}종 ${nowFinds.reduce((a, f) => a + f.count, 0)}건`,
      expected: '없음',
      level: r.bySeverity.now > 0 ? 'problem' : 'ok',
      ...(nowFinds.length ? { meaning: nowFinds.map((f) => `${f.title}: ${f.detail}`).join(' / ') } : {}),
    },
    {
      label: '예방 차원에서 볼 기록',
      actual: r.bySeverity.prevent === 0 ? '없음' : `${r.bySeverity.prevent}종 ${prevFinds.reduce((a, f) => a + f.count, 0)}건`,
      expected: '없음',
      level: r.bySeverity.prevent > 0 ? 'todo' : 'ok',
      ...(prevFinds.length ? { meaning: prevFinds.map((f) => `${f.title}: ${f.detail}`).join(' / ') } : {}),
    },
  ];

  const level = levelFromMetrics(metrics);
  return {
    level,
    headline:
      level === 'problem'
        ? '앞뒤가 맞지 않는 기록이 있어요'
        : level === 'todo'
          ? '지금 쓰는 데는 지장 없지만, 봐 둘 항목이 있어요'
          : '저장된 기록이 서로 앞뒤가 맞습니다',
    because: `기록 ${r.checked}건을 ${CHECK_COUNT}가지 기준으로 확인했어요. 읽기 전용이라 아무것도 바꾸지 않습니다.`,
    metrics,
    actions: [],
    evidence: [
      {
        label: `발견 전체 ${r.findings.length}종 (기술 코드 포함)`,
        build: () => table(r.findings.map((f) => [`${f.code} ×${f.count}`, `${f.title} — 예: ${f.samples.join(', ')}`])),
      },
    ],
    context: [{ label: '참고 항목', value: `${r.bySeverity.info}종(정상 범위)` }],
  };
}

// ────────────────────────────────────────────────────────────────────────────
// ④ 환경·기능 지원 — "왜 안 되지/왜 느리지"의 답
// ────────────────────────────────────────────────────────────────────────────

/** 없으면 앱이 제 기능을 못 하는 것 vs 없어도 대체 경로가 있는 것 — 같은 무게로 다루면 안 된다. */
const ESSENTIAL = new Set(['IndexedDB', 'Crypto.subtle']);

export async function environmentProbe(): Promise<Verdict> {
  const env = await collectEnv(APP_VERSION);
  const missing = Object.entries(env.features)
    .filter(([, ok]) => !ok)
    .map(([k]) => k);
  const missingEssential = missing.filter((k) => ESSENTIAL.has(k));

  const metrics: Metric[] = [
    {
      label: '앱에 필요한 기능',
      actual:
        missing.length === 0 ? `${Object.keys(env.features).length}개 모두 지원` : `${missing.length}개 미지원 — ${missing.join(', ')}`,
      expected: '모두 지원',
      level: missingEssential.length ? 'problem' : missing.length ? 'todo' : 'ok',
      ...(missing.length
        ? {
            meaning: missingEssential.length
              ? '앱의 기본 동작에 꼭 필요한 기능이 없어요. 다른 브라우저(크롬·사파리 최신)에서 열어 주세요.'
              : '없어도 앱은 돌지만 대체 경로를 쓰게 돼요 — 사진 처리가 느리거나 화질이 달라질 수 있습니다.',
          }
        : {}),
    },
    {
      label: '네트워크',
      actual: env.device.online ? '온라인' : '오프라인',
      expected: '온라인',
      level: env.device.online ? 'ok' : 'todo',
      ...(env.device.online
        ? {}
        : { meaning: '지금은 오프라인이에요. 기록은 이 기기에 안전히 저장되고, 연결되면 자동으로 올라갑니다 — 정상 동작입니다.' }),
    },
  ];

  const level = levelFromMetrics(metrics);
  return {
    level,
    headline:
      level === 'problem'
        ? '이 브라우저에는 꼭 필요한 기능이 없어요'
        : level === 'todo'
          ? '일부 기능이 대체 경로로 동작해요'
          : '이 기기는 앱에 필요한 기능을 모두 갖췄습니다',
    metrics,
    actions: [],
    evidence: [
      { label: '기능 지원 전체', build: () => table(Object.entries(env.features).map(([k, ok]) => [k, ok ? '지원' : '미지원'])) },
      {
        label: '화면·서비스워커·브라우저',
        build: () =>
          table([
            ['화면', `${env.screen.w}×${env.screen.h} · ${env.screen.orientation} · 배율 ${env.screen.dpr}`],
            ['서비스워커', env.sw.supported ? (env.sw.controlled ? '동작 중(캐시 사용)' : '지원하나 미제어') : '미지원'],
            ['브라우저', env.device.ua],
          ]),
      },
    ],
    context: [
      { label: '앱', value: env.app.version },
      { label: '사진 저장소', value: env.app.mediaStore },
      { label: '시간대', value: `${env.clock.tz} (UTC${env.clock.tzOffsetMin >= 0 ? '+' : ''}${env.clock.tzOffsetMin / 60})` },
    ],
  };
}

// ────────────────────────────────────────────────────────────────────────────
// ⑤ 오류 기록 — 사용자가 콘솔을 열 줄 몰라도
// ────────────────────────────────────────────────────────────────────────────

export function errorProbe(): Promise<Verdict> {
  const errs = recentErrors();
  const metrics: Metric[] = [
    {
      label: '이 세션에서 생긴 오류',
      actual: errs.length === 0 ? '없음' : `${errs.length}건`,
      expected: '없음',
      level: errs.length > 0 ? 'problem' : 'ok',
      ...(errs.length ? { meaning: '앱이 도는 중 오류가 났어요. [진단 요약 복사]로 전달해 주시면 원인을 찾을 수 있습니다.' } : {}),
    },
  ];
  const v: Verdict = {
    level: levelFromMetrics(metrics),
    headline: errs.length ? `오류가 ${errs.length}건 기록됐어요` : '이 세션에서 생긴 오류가 없습니다',
    because: '새로고침하면 사라집니다(이 세션만 기억해요).',
    metrics,
    actions: [],
    evidence: errs.length
      ? [
          {
            label: '오류 전체',
            build: () => table(errs.map((e) => [`${e.kind} · ${e.at.slice(11, 19)}`, `${e.message}${e.where ? ` ← ${e.where}` : ''}`])),
          },
        ]
      : [],
    context: [],
  };
  if (errs.length) {
    v.actions.push({
      label: '기록 지우기',
      hook: 'data-clear-errors',
      run: async () => {
        clearErrors();
        return '오류 기록을 지웠어요.';
      },
    });
  }
  return Promise.resolve(v);
}

// ────────────────────────────────────────────────────────────────────────────
// ⑥ 저장 상태 · 기기별 현황 — 클라우드와 이 기기를 나란히 놓는다
// ────────────────────────────────────────────────────────────────────────────

/**
 * 사용자 제안(2026-07-26): "진단도구 안에 '저장상태 확인 및 기기별 현황'을 추가하면 좋을 거 같아요."
 *
 * 2기기 문제를 지금까지 **추측으로** 좇았다. 서버와 이 기기의 개수를 나란히 놓고, 각 기기가
 * 마지막으로 올린 시각을 보이면 **어느 쪽이 뒤처졌는지가 즉시 보인다.**
 *
 * 정직함: 개수가 다르다고 결함이 아니다 — 대개 "아직 안 올렸다/안 받았다"이고 동기화로 풀린다.
 * 그래서 판정은 '문제'가 아니라 **'할 일'**이다. 진짜 실패는 [동기화 상태] 도구가 따로 말한다.
 */
/**
 * 「저장 상태」의 판정 한 문장. **순수 함수**라 유닛이 모든 갈래를 직접 돌린다.
 *
 * 왜 뽑아냈나(실제 사고 2026-07-26, 사용자 실기기): 사진 파일 지표를 추가한 뒤에도 문장이
 * `클라우드와 다른 항목이 1가지 있어요`로 나왔다. 개수 대조는 **전부 정상**이었고 진짜 문제는
 * 사진 파일이었는데 — **문장이 엉뚱한 곳을 가리켰다.** 문구는 지표가 개수 대조뿐이던 시절에
 * 쓰였고, 지표를 늘리면서 문장을 안 고쳤다(낡은 전제의 화석 — M-0006의 형태).
 *
 * 진단 도구의 제1 규율(§8)은 "판정한다"인데, **엉뚱한 것을 판정하면 관측보다 나쁘다** —
 * 사용자를 틀린 곳으로 보낸다. 그래서 문장을 손으로 쓰지 않고 **무리별 개수에서 만든다.**
 */
/**
 * **기록 없는 사진 파일**을 세 갈래로 가른다. 순수 함수 — 유닛이 모든 갈래를 직접 돌린다(§10 ③).
 *
 * 2026-07-26 사용자 실기기: 서버 행이 전부 0인데 R2에 파일 3개가 남았다. 영구삭제 시 바이트
 * 삭제는 **최선노력**이라(실패해도 op을 지운다) 재시도 기회가 없고, 그래서 잔재가 생긴다.
 *
 * 한 숫자에 두면 **사용자가 할 일이 정반대인 것들**이 섞인다:
 *  · `leftover`   — 영구삭제 원장에 있고 **되살리는 중도 아닌** id. 자료는 이미 없다. 치우면 된다.
 *  · `restoring`  — 원장에 있지만 사용자가 **지금 복원 중**인 id. 원장에 있다는 사실은 같지만
 *    자료는 없어진 게 아니라 **돌아오는 중**이다. 이 바이트가 그 사진의 마지막 사본일 수 있다.
 *  · `unexplained` — 원장에 없는 id. 올리다 기록이 안 만들어졌다면 이 파일이 그 사진의
 *    **마지막 사본**이다. **앱이 지우면 안 된다.**
 *
 * 왜 `restoring`을 여기서 가르나(2026-07-26 그날의 두 번째 사고): 같은 날 R2에 남아 있던 파일
 * 10개는 잔재가 아니라 **사용자가 방금 복원한 사진들**이었는데, 화면은 그걸 「치워도 되는 것」으로
 * 분류하고 [남은 사진 파일 정리] 버튼까지 내어 주고 있었다. 그 판단이 화면 코드 한복판의
 * `filter` 한 줄로 흩어져 있으면 다음 사람이 모르고 지운다 — **분류는 분류하는 곳에서 끝낸다.**
 */
export function classifyOrphanFiles(
  orphans: string[],
  purgedLedger: string[],
  /** 지금 되살리는 중인 id — 원장에 있어도 **치울 대상이 아니다.** 없으면 빈 집합을 넘긴다. */
  restorePending: ReadonlySet<string>,
): { leftover: string[]; restoring: string[]; unexplained: string[] } {
  const led = new Set(purgedLedger);
  return {
    leftover: orphans.filter((id) => led.has(id) && !restorePending.has(id)),
    restoring: orphans.filter((id) => led.has(id) && restorePending.has(id)),
    unexplained: orphans.filter((id) => !led.has(id)),
  };
}

/**
 * **복원했는데 서버가 막은 항목** 지표. 순수 함수 — 사용자에게 나가는 문장을 유닛이 직접 돌린다(§10 ③).
 *
 * 2026-07-26 사용자 실기기: 백업을 복원했더니 *"복원 내용은 앱에는 하나도 없고 서버에만 좀비처럼
 * 살아났어요."* 복원은 **로컬** 영구삭제 표식만 걷어내고 서버 원장은 그대로 뒀다 → push는 트리거에
 * 거부되고 다음 pull이 로컬 행까지 지웠다. **아무 오류도 안 보였다.**
 *
 * 왜 지표인가(§10 ②): 이건 코드가 아니라 **지금 데이터의 모양**에 달린 결함이다. 고친 뒤에도
 * 옛 판으로 이미 복원해 둔 사람은 여전히 이 상태이고, 그걸 데려올 층은 런타임 진단뿐이다.
 */
export function blockedByLedgerMetric(blocked: number, restoringFiles: number): Metric {
  if (blocked === 0) return { label: '복원했는데 서버가 막은 항목', actual: '없음', expected: '없음', level: 'ok' };
  return {
    label: '복원했는데 서버가 막은 항목',
    actual: `${blocked}건`,
    expected: '없음',
    // 그대로 두면 **다음 동기화에서 이 기기에서도 사라진다** — 기억 손실이므로 '문제'다.
    level: 'problem',
    meaning:
      '백업에서 되살린 기록인데 서버가 「영구삭제된 것」으로 알고 받지 않고 있어요. 그대로 두면 다음 동기화 때 이 기기에서도 사라집니다 — 아래 [복원한 항목 되살리기]를 눌러 주세요.' +
      // 왜 굳이 덧붙이나: 위쪽 「영구삭제 후 남은 사진 파일」이 그만큼 줄어 보이기 때문이다.
      // 숫자가 줄어든 이유를 화면이 말하지 않으면 사용자는 파일이 사라진 줄 안다.
      (restoringFiles ? ` 사진 파일 ${restoringFiles}개는 되살아날 사진이라 정리 대상에서 빼 뒀어요.` : ''),
  };
}

export interface StoreHeadlineInput {
  level: Level;
  /** 개수 대조에서 어긋난 도메인 수. */
  countBad: number;
  /** 사진 파일 대조에서 어긋난 지표 수. */
  fileBad: number;
  /** 전파되지 않은 영구삭제 건수. */
  stranded: number;
  /**
   * **복원했는데 서버 원장이 막고 있는** 건수. 가장 무겁다 — 그대로 두면 다음 동기화에서
   * 이 기기에서도 사라진다(2026-07-26 사용자: *"서버에만 좀비처럼 살아났어요"*).
   */
  blocked: number;
  /** **살아 있는(활성) 기록** 총합. 0이면 "같다"만 말해선 안 된다. */
  alive: number;
  /** 휴지통에 있는 항목 수(클라우드 기준). 자료는 그대로 있고 복원하면 돌아온다. */
  trashed: number;
}

export function storeHeadline(i: StoreHeadlineInput): string {
  if (i.level === 'ok') {
    // ⚠️ 2026-07-26 사용자 지적: *"클라우드와 동일한 게 아니잖아요? 이미 휴지통으로 자료가
    // 이동했는데."* 옛 문장은 「이 기기는 클라우드와 같습니다」였다. 대조 자체는 맞았지만
    // **무엇을 비교했는지 말하지 않았다** — 비교한 것은 *살아 있는 항목의 개수*뿐이고,
    // 휴지통·영구삭제 표식·사진 파일은 그 문장이 다루는 대상이 아니었다.
    //
    // 특히 활성이 **양쪽 다 0**일 때가 최악이었다. 0 == 0은 대조라기보다 "비교할 것이 없다"에
    // 가까운데, 화면은 초록 「정상 · 클라우드와 같습니다」를 띄웠다. 자료가 전부 휴지통으로
    // 옮겨간 사용자는 그 문장을 "아무 문제 없다"로 읽고 **자기 자료가 어디 갔는지 모른 채**
    // 화면을 떠난다. M-0021과 같은 부류다 — 판정 문장이 실제로 검사한 것과 다른 것을 가리킨다.
    //
    // 그래서 **비교한 대상을 문장에 넣고**, 살아 있는 것이 없으면 자료가 어디 있는지 말한다.
    if (i.alive > 0) return `살아 있는 기록 ${i.alive}건이 클라우드와 같아요`;
    if (i.trashed > 0) return `살아 있는 기록이 없어요 — ${i.trashed}건이 휴지통에 있습니다`;
    return '아직 기록이 없어요';
  }
  // 가장 무거운 것부터 말한다.
  // 1위는 **기억을 잃는 쪽**이다 — 되살린 기록이 서버에 막혀 있으면 다음 동기화 때 이 기기에서도
  // 사라진다. 「지웠는데 남은 것」은 용량과 정합의 문제지만 이건 자료가 없어지는 문제다.
  if (i.blocked) return `되살린 기록 ${i.blocked}건을 서버가 받지 않고 있어요`;
  if (i.stranded) return `지웠는데 서버에 남은 항목이 ${i.stranded}건 있어요`;
  if (i.countBad && i.fileBad) return `클라우드와 다른 항목 ${i.countBad}가지, 사진 파일 문제 ${i.fileBad}가지가 있어요`;
  if (i.countBad) return `클라우드와 다른 항목이 ${i.countBad}가지 있어요`;
  if (i.fileBad) return `사진 파일에 확인할 것이 ${i.fileBad}가지 있어요`;
  // 어느 무리에도 안 잡혔는데 정상도 아니다 = 대조 자체를 못 했다(확인 불가).
  return '지금은 클라우드와 대조하지 못했어요';
}

/**
 * **이 기기 이름 바꾸기.**
 *
 * 왜(2026-07-26 사용자 실기기): 태블릿이 「PC · Linux · Chrome」으로 서버에 찍혔다. UA만
 * 보는 한 이건 고칠 수 없다 — Chrome의 「데스크톱 사이트」가 UA를 통째로 바꿔 보내기 때문이다
 * (`deviceId.ts` 머리말). 감지를 아무리 다듬어도 **사용자보다 정확할 수 없으므로**, 판단을
 * 사용자에게 넘긴다. 감지는 기본값으로만 남는다.
 *
 * 한 곳에서 만들어 로그인 전/후 두 갈래가 **같은 것을 쓴다** — 손으로 두 번 적으면 드리프트가
 * 시간 문제다(§7).
 */
function renameDeviceAction(): Action {
  return {
    label: '이 기기 이름 바꾸기',
    hook: 'data-rename-device',
    input: {
      label: '이 기기 이름',
      placeholder: '예: 갤럭시 탭 · 거실 PC',
      // 재판정 때마다 다시 읽는다 — 방금 바꾼 이름이 칸에 남아 있어야 한다.
      initial: () => customDeviceName() ?? '',
      maxLength: DEVICE_NAME_MAX,
    },
    run: async (raw: string): Promise<string> => {
      const before = customDeviceName();
      const after = setCustomDeviceName(raw);
      // read-back — 저장했다고 말하지 말고 되읽는다(데이터 안전과 같은 규율).
      if (customDeviceName() !== after) throw new Error('이름을 저장하지 못했어요.');
      if (after === null) {
        return before === null
          ? `자동 감지를 씁니다: ${detectDeviceLabel(readDeviceHints())}`
          : `이름을 지웠어요. 자동 감지로 돌아갑니다: ${detectDeviceLabel(readDeviceHints())}`;
      }
      // 서버 행의 이름은 **다음에 저장·수정할 때** 바뀐다. 그 사실을 감추면 사용자가
      // "안 바뀌었네"라고 읽는다 — 화면은 지금 바로 새 이름으로 보인다(foldDevices가 덮어쓴다).
      return `이 기기를 "${after}"(으)로 부릅니다. 다음에 저장·수정할 때 서버 기록에도 이 이름이 찍혀요.`;
    },
  };
}

/**
 * 「저장 상태」의 **행동 버튼들**.
 *
 * 왜 따로 두나: `storeStateProbe`가 지표를 만들고 판정 문장을 고르고 버튼까지 짓느라 계속
 * 커졌고, 길이 래칫이 이를 막았다(큰 함수는 결함이 숨을 면적이다). 판정(무엇이 문제인가)과
 * 행동(무엇을 눌러 고치나)은 원래 다른 일이므로 여기서 갈라 둔다.
 *
 * **primary는 하나뿐이어야 한다.** 위에서부터 무거운 순 — 되살리기 › 서버 삭제 전파 ›
 * 조각 정리 › 파일 정리 › 기록 정리 › 동기화. 순서가 곧 "지금 눌러야 할 것"의 순서다.
 */
interface StoreActionsInput {
  /** `supabase()`가 준 그 클라이언트 — 스키마(journey)까지 붙은 타입을 그대로 받는다. */
  c: NonNullable<ReturnType<typeof supabase>>;
  cmp: StoreComparison;
  level: Level;
  /** 전파되지 않은 영구삭제 건수. */
  stranded: number;
  /** 복원했는데 서버 원장이 막고 있는 건수. */
  blocked: number;
  /** 치워도 되는 고아 파일 id(복원 대기분은 이미 빠져 있다). */
  leftoverFileIds: string[];
  /** 자료 없이 기록 줄만 남은 사진 id. */
  clearableIds: string[];
}

/**
 * 「저장 상태」의 **치우기 버튼들** — 이미 자료가 없는 잔재만 다룬다.
 *
 * 되살리기·전파와 갈라 둔 이유는 성격이 정반대이기 때문이다. 위쪽 둘은 **자료를 지키는** 일이고
 * 여기 셋은 **찌꺼기를 버리는** 일이다. 한 함수에 섞여 있으면 "지우는 버튼"과 "살리는 버튼"이
 * 같은 코드 덩어리 안에서 서로의 조건을 보게 된다 — 실제로 복원 대기 중인 사진을
 * 「치워도 되는 파일」로 분류하는 사고가 그렇게 났다(2026-07-26).
 */
function storeCleanupActions(i: StoreActionsInput): Action[] {
  const { c, cmp, stranded, blocked, leftoverFileIds, clearableIds } = i;
  return [
    ...(cmp.multipart.known && cmp.multipart.mine
      ? [
          {
            // 지표를 만들었으면 **고칠 곳도 만든다**(진단 §7-B — 그날 이걸 두 번 어겼다).
            label: '올리다 만 조각 정리',
            hook: 'data-abort-multipart',
            run: async (): Promise<string> => {
              const r = await r2AbortMultipart(c);
              if (r.error) return `조각을 치우지 못했어요: ${r.error}`;
              // 되읽기 — 목록을 다시 물어 실제로 사라졌는지 확인한다.
              const after = await r2ListObjects(c);
              if (after.error || !after.multipart.known) {
                return `${r.aborted}건을 치웠지만 다시 확인하지 못했어요.`;
              }
              return after.multipart.mine
                ? `${r.aborted}건을 치웠는데 ${after.multipart.mine}건이 남아 있어요.`
                : `조각 ${r.aborted}건을 치웠어요. 다시 대조합니다.`;
            },
          },
        ]
      : []),
    ...(leftoverFileIds.length
      ? [
          {
            // 지표를 만들었으면 **고칠 곳도 만든다**(진단 §7-B). 2026-07-26에 사용자는
            // 「기록 없는 사진 파일 3개」를 보면서 앱 안에서 손댈 방법이 없어 Cloudflare
            // 대시보드를 직접 열어야 했다. 판정만 하고 행동을 못 주면 관측으로 되돌아간 것이다.
            label: '남은 사진 파일 정리',
            primary: !blocked && !stranded && !clearableIds.length,
            hook: 'data-clear-leftover-files',
            run: async (): Promise<string> => {
              // 건당 왕복 대신 **한 번에** 보내고, 함수가 지운 뒤 목록을 다시 읽어 확인한 결과를
              // 받는다(v0.98). 100장이면 100왕복이던 것이 1왕복이 되고, "성공 응답"이 아니라
              // **되읽기**가 완료의 근거다.
              const r = await r2DeleteMany(c, leftoverFileIds);
              if (r.error) return `치우지 못했어요: ${r.error}`;
              if (!r.verified) return `${r.sent}건 삭제를 요청했지만 다시 읽어 확인하지 못했어요.`;
              if (r.stillThere.length) return `${r.requested}건 중 ${r.stillThere.length}건이 아직 남아 있어요.`;
              return `사진 파일 ${r.sent}건을 치웠어요. 다시 대조합니다.`;
            },
          },
        ]
      : []),
    ...(clearableIds.length
      ? [
          {
            label: '지운 사진 기록 정리',
            primary: !blocked && !stranded && !leftoverFileIds.length,
            hook: 'data-clear-dead-media',
            run: async (): Promise<string> => {
              // 사진 자체는 이미 없다 — 서버에 남은 **기록 줄**만 치운다.
              // 로컬에 그 행이 없을 수 있으므로(비파괴 pull 규율) 서버 기준으로 의도를 만든다.
              const n = await purgeServerOnly('media', clearableIds);
              if (!n) return '큐에 이미 들어 있어요. [지금 동기화]를 눌러 주세요.';
              await requestSync('지운 사진 기록 정리');
              const st = syncStatus();
              return st.phase === 'failed'
                ? `${n}건을 큐에 넣었지만 동기화가 실패했어요: ${st.lastError ?? '사유 불명'}`
                : `${n}건을 정리했어요. 다시 대조합니다.`;
            },
          },
        ]
      : []),
  ];
}

function storeActions(i: StoreActionsInput): Action[] {
  const { cmp, level, stranded, blocked, leftoverFileIds, clearableIds } = i;
  return [
    // 지표를 만들었으면 **고칠 곳도 만든다**(진단 §7-B). 판정만 하고 행동을 못 주면 사용자는
    // "그래서 어쩌라고"에 남겨진다 — 2026-07-26에 반복해서 나온 지적이 그것이다.
    ...(blocked
      ? [
          {
            label: '복원한 항목 되살리기',
            primary: true,
            hook: 'data-unpurge-restored',
            run: async (): Promise<string> => {
              // 로컬 행은 이미 복원돼 있다 — 여기서는 **서버 원장에서 빼 달라는 의사**를 실어 보낸다.
              // 그 의사는 큐에 남으므로 오프라인이거나 실패해도 다음 동기화에서 다시 시도된다.
              await requestUnpurge(cmp.blockedByLedger);
              await requestSync('복원한 항목 되살리기');
              const st = syncStatus();
              const n = cmp.blockedByLedger.length;
              return st.phase === 'failed'
                ? `${n}건을 큐에 넣었지만 동기화가 실패했어요: ${st.lastError ?? '사유 불명'}`
                // "보냈다"가 아니라 **다시 대조해서** 확인한다(§8 — 고쳤다고 말하지 말고 다시 읽어라).
                : `${n}건을 서버에 되살렸다고 알렸어요. 다시 대조합니다.`;
            },
          },
        ]
      : []),
    ...(stranded
      ? [
          {
            label: '서버에서도 지우기',
            primary: !blocked,
            hook: 'data-requeue-purges',
            run: async (): Promise<string> => {
              // 로컬은 이미 사용자 뜻대로 지워져 있다 — 여기서는 **의도를 다시 실어 보낼 뿐**이다.
              const n = await requeueUnpropagatedPurges(cmp.unpropagatedPurges);
              if (!n) return '큐에 이미 들어 있어요. [지금 동기화]를 눌러 주세요.';
              await requestSync('전파 안 된 영구삭제');
              const st = syncStatus();
              return st.phase === 'failed'
                ? `${n}건을 큐에 넣었지만 동기화가 실패했어요: ${st.lastError ?? '사유 불명'}`
                : `${n}건을 서버로 보냈어요. 다시 대조합니다.`;
            },
          },
        ]
      : []),
    ...storeCleanupActions(i),
    {
      label: '지금 동기화',
      primary: level !== 'ok' && !blocked && !stranded && !clearableIds.length && !leftoverFileIds.length,
      hook: 'data-store-sync',
      run: async () => {
        await requestSync('저장 상태 확인');
        const s = syncStatus();
        return s.phase === 'failed' ? `동기화 실패: ${s.lastError ?? '사유 불명'}` : '동기화했어요. 다시 대조합니다.';
      },
    },
    renameDeviceAction(),
  ];
}

export async function storeStateProbe(): Promise<Verdict> {
  const c = supabase();
  const u = c ? await currentUserSafe() : null;
  const me = `${deviceLabel()} · ${shortDeviceId()}`;

  if (!c || !u) {
    // 로그인 전은 **실패가 아니다.** 대조할 상대가 없을 뿐이다(원칙 #4).
    return {
      level: 'unknown',
      headline: '로그인하면 클라우드와 대조할 수 있어요',
      because: '지금은 이 기기의 기록만 볼 수 있습니다. 기록은 이 기기에 안전하게 저장돼 있어요.',
      metrics: [],
      // 이름 짓기는 서버가 필요 없다 — 로그인 전이라고 막을 이유가 없다.
      actions: [renameDeviceAction()],
      evidence: [],
      context: [{ label: '이 기기', value: me }],
    };
  }

  // ── 사진 파일은 **두 저장소를 다 봐야 한다** ─────────────────────────────
  // 저장소는 지금 혼재 상태다: R2 전환(2026-07-25) 이전 사진의 바이트는 **여전히
  // Supabase Storage에 있다**(HANDOFF Phase 9c에 적혀 있다). R2만 훑고 "파일이 없다"고
  // 판정하면 멀쩡한 사진 여러 장을 문제로 단정하는 **거짓 경보**가 된다 — M-0008에서
  // 이미 한 번 저지른 실수라, 두 곳의 id를 합집합으로 본다.
  //
  // 종류 판단은 여기(합성 지점)서 하고 storeState에는 **모양만** 넘긴다 — storeState가
  // 저장소 종류를 알게 되면 되돌리기가 환경변수 하나라는 계약이 깨진다.
  // 사진 파일은 **R2 한 곳**에만 있다(v0.86). 옛 Supabase Storage 경로는 이관을 마치고 제거했다.
  // `unionListings`는 저장소가 하나여도 그대로 쓴다 — "못 읽으면 개수를 세지 않는다"는 규칙이
  // 거기 있고, 저장소가 하나든 둘이든 그 규칙은 같기 때문이다.
  const filesPort = {
    list: async () => unionListings([await r2ListObjects(c)]),
  };
  const cmp = await compareStore(storeStateRemote(c), filesPort);

  // **복원 대기 중인 id는 손대면 안 된다.** 원장에 있다는 이유로 「치워도 되는 파일」로 분류하면,
  // 되살아나려는 사진의 **마지막 바이트**를 앱이 스스로 지운다. 실제로 2026-07-26에 R2에 남은
  // 파일 10개가 바로 그 사진들이었고, 화면은 그걸 [남은 사진 파일 정리]로 치우라고 권하고 있었다.
  // 원장(`blockedByLedger`)과 큐(`pendingUnpurgeIds`) 둘 다 본다 — 로컬 행이 이미 지워졌어도
  // 되돌리기 의사가 남아 있으면 여전히 복원 중이다.
  const restorePending = new Set<string>([...cmp.blockedByLedger, ...(await pendingUnpurgeIds())]);

  const countMetrics: Metric[] = PURGE_DOMAINS.map((d) => {
    const { cloud, local } = cmp.counts[d];
    const same = cloud === local;
    return {
      label: DOMAIN_LABEL[d],
      actual: `클라우드 ${cloud} · 이 기기 ${local}`,
      expected: '같음',
      level: same ? ('ok' as const) : ('todo' as const),
      ...(same
        ? {}
        : {
            meaning:
              local > cloud
                ? `이 기기에 아직 안 올린 것이 ${local - cloud}건 있어요. 동기화하면 올라갑니다.`
                : `클라우드에 있는데 이 기기가 아직 안 받은 것이 ${cloud - local}건 있어요. 동기화하면 받아옵니다.`,
          }),
    };
  });

  // 휴지통도 **자료다.** 활성만 대조하면 자료가 전부 휴지통으로 옮겨간 순간 양쪽이 0이 되어
  // 화면이 「같습니다」라고 말한다 — 정작 13건이 어디 있는지는 아무 지표도 말하지 않았다
  // (2026-07-26 사용자 지적: *"클라우드와 동일한 게 아니잖아요? 이미 휴지통으로 자료가 이동했는데."*).
  //
  // 기대값을 `같음`으로 쓰지 않는 이유: **이 기기가 더 적은 것은 정상이다.** 다른 기기에서 지운
  // 항목은 이 기기에 사본이 없으면 tombstone을 만들지 않는다(비파괴 pull, 불변식 #8).
  // 그래서 어긋남은 한 방향뿐이다 — 이 기기가 **더 많으면** 아직 안 올린 것이 있다는 뜻이다.
  countMetrics.push({
    label: '휴지통 항목',
    actual: `클라우드 ${cmp.trashed.cloud} · 이 기기 ${cmp.trashed.local}`,
    expected: '이 기기가 클라우드보다 많지 않음',
    level: cmp.trashed.local > cmp.trashed.cloud ? ('todo' as const) : ('ok' as const),
    ...(cmp.trashed.local > cmp.trashed.cloud
      ? {
          meaning: `이 기기에서 지운 것 중 ${cmp.trashed.local - cmp.trashed.cloud}건이 아직 클라우드에 안 올라갔어요. 동기화하면 올라갑니다.`,
        }
      : {}),
  });

  // 개수 대조와 파일 대조를 **한 배열에 담되 경계를 기억한다** — 판정 문장이 둘을 구분해야 한다.
  const metrics: Metric[] = [...countMetrics];

  // ── 사진 파일 대조 ──────────────────────────────────────────────
  // 두 방향을 **한 숫자로 합치지 않는다.** 사용자가 할 일이 정반대이기 때문이다
  // (진단 §4의 "대기 중인 작업 3건"이 정확히 그 실수였다).
  const fa = cmp.fileAudit;
  let clearableIds: string[] = [];
  /** 원장에 있는(= 자료가 이미 없는) 고아 파일 id — 치워도 되는 것만 여기 담긴다. */
  let leftoverFileIds: string[] = [];
  /** 되살리는 중이라 **지키는** 사진 파일 수. 화면이 "왜 안 치우는지"를 말할 수 있어야 한다. */
  let restoringFiles = 0;
  if (!fa) {
    // 못 본 것을 정상으로 반올림하지 않는다(비타협 원칙 #4).
    metrics.push({
      label: '사진 파일 대조',
      actual: '확인 못 함',
      expected: '기록과 파일이 1:1',
      level: 'unknown',
      meaning: cmp.fileAuditNote ?? '서버 사진 목록을 물어보지 못했어요',
    });
  } else {
    // 「기록 없는 사진 파일」도 **두 갈래로 쪼갠다**(2026-07-26 사용자 실기기 — 서버 행이
    // 전부 0인데 R2에 파일 3개가 남았다). 영구삭제 시 바이트 삭제는 **최선노력**이라
    // 실패해도 op을 지운다 → 재시도 기회가 없다. 그래서 잔재가 생긴다.
    //
    // 성격이 정반대인 둘이 한 숫자에 섞여 있었다 — 「사진 파일이 사라진 기록」을 쪼갠 것과
    // **같은 근본형**이다(§7 대칭):
    //  · 원장에 있는 id → 영구삭제한 사진의 잔재. **자료는 이미 없다.** 치우면 된다(todo).
    //  · 원장에 없는 id → **설명할 수 없는 파일.** 업로드는 됐는데 기록이 안 만들어졌을 수
    //    있고, 그러면 이 파일이 그 사진의 **마지막 사본**이다. 지우면 기억을 잃는다(problem).
    const { leftover, restoring, unexplained } = classifyOrphanFiles(fa.orphans, cmp.serverPurged, restorePending);
    leftoverFileIds = leftover;
    restoringFiles = restoring.length;

    metrics.push({
      label: '영구삭제 후 남은 사진 파일',
      actual: `${leftoverFileIds.length}개`,
      expected: '0개',
      // '문제'가 아니라 '할 일'이다 — 자료는 이미 없고 바이트만 남았다. 겁줄 일이 아니다(§5.10).
      level: leftoverFileIds.length ? 'todo' : 'ok',
      ...(leftoverFileIds.length
        ? { meaning: '영구삭제할 때 파일 지우기가 실패해 바이트만 남았어요. 기억은 이미 지워졌고 용량만 차지합니다 — 아래 [남은 사진 파일 정리]로 치울 수 있어요.' }
        : {}),
    });

    metrics.push({
      label: '설명할 수 없는 사진 파일',
      actual: `${unexplained.length}개`,
      expected: '0개',
      level: unexplained.length ? 'problem' : 'ok',
      ...(unexplained.length
        ? { meaning: '기록도 없고 영구삭제한 적도 없는 파일이에요. 올리다 기록이 안 만들어졌다면 **이 파일이 그 사진의 마지막 사본**일 수 있습니다 — 앱이 자동으로 지우지 않습니다.' }
        : {}),
    });
    // 「파일이 없는 사진 기록」을 **두 갈래로 쪼갠다**(2026-07-26 사용자 실기기에서 배웠다).
    // 한 숫자에 섞으면 성격이 정반대인 둘이 같은 줄에 온다:
    //  · 휴지통에 있으면서 파일 없음 → **자료가 이미 없다.** 기록만 남았으니 정리하면 된다.
    //  · 활성인데 파일 없음 → **기억 손실 위험.** 지우면 안 되고, 사본을 가진 기기가 올려야 한다.
    // 사용자가 해야 할 일이 정반대인데 예전엔 "파일이 없는 사진 기록 2개"로 뭉뚱그렸다.
    const deadIds = new Set(cmp.serverTombstoned);
    const clearable = fa.truncated ? [] : fa.missing.filter((id) => deadIds.has(id));
    clearableIds = clearable;
    const atRisk = fa.truncated ? [] : fa.missing.filter((id) => !deadIds.has(id));

    metrics.push({
      label: '사진 파일이 사라진 기록',
      actual: fa.truncated ? '확인 못 함' : `${atRisk.length}개`,
      expected: '0개',
      // 목록이 잘렸으면 "없다"고 말할 수 없다 — 뒤쪽 페이지에 있을 수 있다.
      level: fa.truncated ? 'unknown' : atRisk.length ? 'problem' : 'ok',
      ...(fa.truncated
        ? { meaning: `사진이 너무 많아 목록을 다 보지 못했어요(${fa.files}개까지 확인). 이 판정은 보류합니다.` }
        : atRisk.length
          ? { meaning: '살아 있는 사진인데 서버에 파일이 없어요. **지우지 마세요** — 사본을 가진 기기에서 동기화하면 다시 올라갑니다.' }
          : {}),
    });

    metrics.push({
      label: '지운 사진의 남은 기록',
      actual: fa.truncated ? '확인 못 함' : `${clearable.length}개`,
      expected: '0개',
      // '문제'가 아니라 '할 일'이다 — 자료는 이미 없고 기록 줄만 남았다. 겁줄 일이 아니다.
      level: fa.truncated ? 'unknown' : clearable.length ? 'todo' : 'ok',
      ...(clearable.length
        ? { meaning: '이미 지운 사진의 기록 줄만 서버에 남아 있어요. 사진 자체는 없습니다 — 아래 [지운 사진 기록 정리]로 치울 수 있어요.' }
        : {}),
    });
  }

  // ── 앱이 관리하지 않는 항목 ────────────────────────────────────────
  // 왜(2026-07-26 사용자 *"니가 객체목록을 보게 하려면 내가 어케 해야해?"* — 스크린샷을 수백 장
  // 찍고 있었다): 위의 사진 파일 대조는 보안상 **내 폴더만** 본다. 그래서 「사진 파일 0개」는
  // *내 폴더 기준*이지 "저장소가 비었다"가 아니다. 그 한정을 화면이 말하지 않아, 사용자가
  // Cloudflare 콘솔을 직접 열어 확인하고 그 결과를 사진으로 찍어 보내야 했다.
  //
  // 이제 서버가 **개수 하나**를 함께 준다(키는 안 준다). 앱이 자기 시야의 경계를 스스로 말한다.
  metrics.push({
    label: '앱이 관리하지 않는 항목',
    actual: cmp.outside.known ? `${cmp.outside.count}개` : '확인 못 함',
    expected: '0개',
    // 못 봤으면 정상이 아니라 '확인 불가'다(비타협 원칙 #4).
    level: !cmp.outside.known ? 'unknown' : cmp.outside.count ? 'todo' : 'ok',
    ...(!cmp.outside.known
      ? { meaning: '사진 저장소 최상위를 확인하지 못했어요. 앱은 자기 폴더만 보므로, 그 밖은 지금 판단할 수 없습니다.' }
      : cmp.outside.count
        ? {
            meaning:
              '사진 저장소에 이 앱이 만들지 않은 폴더·파일이 있어요. **앱은 손대지 않습니다** — 다른 앱이나 옛 테스트 자료일 수 있으니 Cloudflare에서 직접 확인하세요.',
          }
        : {}),
  });

  // ── 보이지 않는데 용량을 먹는 조각 ─────────────────────────────────
  // 2026-07-26 사용자: 버킷 최상위가 **완전히 비었는데** 대시보드는 2.87MB를 계속 보여줬다.
  // *"설마 휴지통 이런 데 간 거 아님? 완전히 날려버리지 않고?"*
  //
  // R2에 휴지통은 없다. 그러나 **미완료 멀티파트 업로드**는 정확히 그렇게 행동한다 —
  // 업로드가 중간에 끊기면 조각이 남는데 **객체 목록에도 대시보드 파일 목록에도 안 보이면서
  // 저장 공간은 차지한다.** 앱이 못 보면 그 질문에 영영 답할 수 없다(§8 — 보이게 만든다).
  metrics.push({
    label: '올리다 만 사진 조각',
    actual: cmp.multipart.known ? `${cmp.multipart.mine}개` : '확인 못 함',
    expected: '0개',
    level: !cmp.multipart.known ? 'unknown' : cmp.multipart.mine ? 'todo' : 'ok',
    ...(!cmp.multipart.known
      ? { meaning: '사진 저장소에 물어보지 못했어요. 서버 함수가 낡았거나 조회에 실패했습니다.' }
      : cmp.multipart.mine
        ? {
            meaning:
              '사진을 올리다 중간에 끊긴 조각이에요. **목록에도 대시보드에도 안 보이는데 용량만 차지합니다** — 아래 [올리다 만 조각 정리]로 치울 수 있어요.',
          }
        : {}),
  });

  // 서버 함수 판 — 앱이 기대하는 것보다 낮으면 **위 지표들을 못 믿는다.** 그걸 말한다.
  metrics.push({
    label: '사진 저장소 함수 판',
    actual: cmp.fnVersion ? `v${cmp.fnVersion}` : '알 수 없음(낡음)',
    expected: `v${EXPECTED_FN_VERSION} 이상`,
    level: cmp.fnVersion >= EXPECTED_FN_VERSION ? 'ok' : 'todo',
    ...(cmp.fnVersion >= EXPECTED_FN_VERSION
      ? {}
      : {
          meaning:
            '서버에 배포된 사진 저장소 함수가 이 앱보다 낡았어요. 새 지표(조각·폴더 밖 항목)는 지금 믿을 수 없습니다 — 함수를 다시 배포해 주세요.',
        }),
  });

  // ── 전파되지 않은 영구삭제 ─────────────────────────────────────────
  // 내가 지웠다고 믿는데(로컬 표식) 서버엔 tombstone으로 남은 것. 로컬 표식 때문에 휴지통에도
  // 안 보이므로 **어디서도 손댈 수 없는 상태**다 — 앱이 말해주지 않으면 영원히 남는다.
  const stranded = cmp.unpropagatedPurges.length;
  metrics.push({
    label: '지웠는데 서버에 남은 항목',
    actual: stranded === 0 ? '없음' : `${stranded}건`,
    expected: '없음',
    level: stranded > 0 ? 'problem' : 'ok',
    ...(stranded > 0
      ? { meaning: '이 기기에서 영구삭제했지만 서버에 전하지 못한 항목이에요. 휴지통에도 안 보여서 손댈 수가 없습니다 — 아래 [서버에서도 지우기]를 눌러 주세요.' }
      : {}),
  });

  const blocked = cmp.blockedByLedger.length;
  metrics.push(blockedByLedgerMetric(blocked, restoringFiles));

  const level = levelFromMetrics(metrics);
  const behind = cmp.devices.filter((d) => !d.isThis && cmp.lastCloudWriteAt && d.lastPushAt < cmp.lastCloudWriteAt);

  const countBad = countMetrics.filter((m) => m.level !== 'ok').length;
  const fileBad = metrics.slice(countMetrics.length).filter((m) => m.level !== 'ok').length;
  // 살아 있는 기록이 하나도 없을 때 「클라우드와 같습니다」만 말하면 사용자는 **자기 자료가
  // 어디 갔는지 모른 채** 화면을 떠난다. 그래서 판정 문장에 대조한 대상(활성)과 자료의
  // 현재 위치(휴지통)를 함께 넘긴다.
  const alive = PURGE_DOMAINS.reduce((n, d) => n + cmp.counts[d].local, 0);
  const headline = storeHeadline({ level, countBad, fileBad, stranded, blocked, alive, trashed: cmp.trashed.cloud });

  return {
    level,
    headline,
    because:
      // 판정 문장이 사진 파일을 가리키면 **그 밑도 사진 얘기여야 한다.** 기기 얘기를 붙여 놓으면
      // 사용자가 "기기 때문에 문제라는 건가?"로 읽는다(실제로 그렇게 보였다 — 2026-07-26).
      // 판정 문장이 가리키는 곳과 **같은 것**을 설명해야 한다. 2026-07-26에 두 번 어긋났다:
      // 처음엔 사진 문제인데 기기 얘기를, 다음엔 전파 안 된 삭제인데 사진 얘기를 했다(M-0021).
      blocked
        ? '백업에서 되살린 기록을 서버가 「이미 영구삭제된 것」으로 알고 거부하고 있어요. 아래 버튼으로 서버에 되살렸다고 알릴 수 있습니다.'
        : stranded
        ? '이 기기에서 지운 것이 서버까지 가지 못했어요. 아래 버튼으로 다시 보낼 수 있습니다.'
        : fileBad && !countBad
        ? '사진 기록과 서버 파일이 짝이 맞지 않아요. 아래 지표에서 어느 쪽인지 볼 수 있습니다.'
        : cmp.devices.length > 1
        ? `기기 ${cmp.devices.length}대가 이 계정에 기록을 올렸어요.${behind.length ? ` 그중 ${behind.length}대는 최신본보다 오래됐습니다.` : ''}`
        : cmp.devices.length === 1
          ? '아직 이 기기에서만 올렸어요.'
          // 0대는 "기기가 없다"가 아니라 **"이름표를 붙이기 시작한 뒤로 올린 적이 없다"**이다.
          // 기기 이름은 push할 때만 서버에 찍히므로, 최근에 저장·수정한 적이 없으면 비어 있다.
          // 이걸 그냥 "0대"로 두면 사용자가 연동이 끊겼다고 오해한다(§5.9 — 말할 수 있는 것만).
          : '기기 이름은 무언가를 저장·수정해 서버로 올릴 때 찍혀요. 아직 그 뒤로 올린 것이 없습니다.',
    metrics,
    actions: storeActions({ c, cmp, level, stranded, blocked, leftoverFileIds, clearableIds }),
    evidence: [
      {
        // 사용자가 Supabase·R2를 직접 열어 "안 지워졌다"고 판단하던 자리(2026-07-26).
        // 서버에 **무엇이 왜 남는지**를 앱이 스스로 설명한다.
        label: `서버에 남는 표식 ${cmp.remnants.tombstoned + cmp.remnants.purged}건 — 왜 남나요?`,
        build: () =>
          table([
            ['지운 항목(휴지통)', `${cmp.remnants.tombstoned}건 · 자료가 그대로 있습니다(복원하면 돌아옵니다)`],
            ['영구삭제한 항목', `${cmp.remnants.purged}건 · **자료는 없습니다.** 번호(id)만 한 줄 남습니다`],
            [
              '왜 번호는 남기나요',
              '이 번호가 없으면, 아직 사정을 모르는 다른 기기가 자기 사본을 다시 올려 되살아납니다. 서버는 이 번호를 보고 재등록을 **거부**합니다. 제목·메모·위치·금액은 서버에서 사라졌습니다.',
            ],
            ['사진 파일은?', '영구삭제 시점에 서버 사진 파일도 함께 지웁니다(위 개수에 안 잡힙니다).'],
          ]),
      },
      ...(fa
        ? [
            {
              // 목록에 상한을 둔다 — 여행 사진 앱이라 수백 장이 정상이고, 상한이 없으면
              // 수리 버튼이 목록 뒤로 밀려 진단 도구가 스스로 수리 경로를 막는다(진단 §5.2).
              // 총 바이트를 **여기서 말한다.** 2026-07-26에 사용자가 대시보드의 「버킷 크기
              // 2.87MB」와 앱의 「사진 파일 0개」를 대조하지 못해 콘솔을 반복해서 열었다.
              // 앱이 자기 합계를 말하면 그 대조를 화면 안에서 끝낼 수 있다.
              label: `사진 파일 ${fa.files}개(${bytes(cmp.bytes)}) · 기록 ${fa.rows}개${fa.truncated ? ' (다 못 봄)' : ''}`,
              build: () => {
                const rows: [string, string][] = [];
                const show = (ids: string[], what: string): void => {
                  for (const id of ids.slice(0, FILE_ID_CAP)) rows.push([id.slice(0, 8), what]);
                  // 조용히 자르지 않는다 — 자른 것은 자랐다고 적는다(진단 §5.3).
                  if (ids.length > FILE_ID_CAP) rows.push(['…', `${what} 외 ${ids.length - FILE_ID_CAP}건 생략`]);
                };
                show(fa.orphans, '기록 없는 파일');
                show(fa.missing, '파일 없는 기록');
                if (fa.foreign) rows.push(['(형식 밖)', `${fa.foreign}개 — 이 앱이 만들지 않은 이름의 파일이에요`]);
                if (fa.truncated) rows.push(['⚠', `사진이 많아 목록을 다 보지 못했어요 — 위 개수는 확인한 범위까지입니다`]);
                return table(rows);
              },
            },
          ]
        : []),
      {
        label: `내 기기들 ${cmp.devices.length}대`,
        build: () =>
          table([
            ...(cmp.devices.length
              ? cmp.devices.map((d): [string, string] => [
                  `${d.label}${d.isThis ? ' (이 기기)' : ''}`,
                  `마지막으로 올림 ${d.lastPushAt.replace('T', ' ').slice(0, 19)}`,
                ])
              : ([['(없음)', '기기 이름은 서버로 올릴 때 찍혀요. 저장·수정을 한 번 하면 여기에 나타납니다.']] as [string, string][])),
            // 이름이 왜 틀릴 수 있는지 **여기서** 말한다. 사용자가 "내 태블릿이 왜 PC야?"를
            // 물을 자리가 바로 이 목록이고, 고치는 버튼은 위에 있다(위 renameDeviceAction).
            [
              '이름이 안 맞나요',
              '브라우저의 「데스크톱 사이트」를 켜면 기기 종류가 PC로 바뀌어 전달돼요 — 앱이 알 수 있는 방법이 없습니다. 위 [이 기기 이름 바꾸기]로 직접 지어 주세요.',
            ],
            ...(customDeviceName()
              ? ([['자동 감지값', `${detectDeviceLabel(readDeviceHints())} (지금은 지어 주신 이름을 씁니다)`]] as [string, string][])
              : []),
          ]),
      },
    ],
    context: [
      { label: '이 기기', value: me },
      // 이 화면이 말할 수 없는 것을 적는다 — 라벨 한 글자가 거짓말과 사실을 가른다.
      { label: '읽는 법', value: '받아가기(pull)는 서버에 흔적을 남기지 않아 여기 안 보입니다' },
    ],
  };
}

/** 로그인 조회 실패를 오류로 만들지 않는다(로그아웃과 구분이 안 되는 상황은 '없음'으로). */
async function currentUserSafe(): Promise<{ id: string } | null> {
  try {
    const { currentUser } = await import('../../services/auth');
    return await currentUser();
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// ⑦ 전체 요약 — 도구 롤업 + 텍스트 복사
// ────────────────────────────────────────────────────────────────────────────

/**
 * 다섯 도구를 한 번에 돌려 **총괄 판정**을 만든다.
 *
 * 이 함수 하나가 두 곳에 쓰인다 — 허브 홈의 배지·총괄 줄, 그리고 요약 복사 도구. 롤업 규칙을
 * 두 번 쓰면 허브는 '정상'인데 요약은 '문제'인 화면이 언젠가 나온다(SSOT — 규칙을 두 번 쓰지 않는다).
 */
export async function rollup(): Promise<{
  level: Level;
  per: { id: string; label: string; level: Level; headline: string; metrics: Metric[] }[];
}> {
  const per = await Promise.all(
    CORE_TOOLS.map(async (t) => {
      try {
        const v = await t.probe();
        // 지표까지 들고 온다 — 요약 복사가 이걸 그대로 쓴다. 도구를 새로 만들면 **자동으로**
        // 요약에 들어간다(§7 2층: 다음 형제가 손대지 않아도 따라오게).
        return { id: t.id, label: t.label, level: v.level, headline: v.headline, metrics: v.metrics };
      } catch {
        // 판정을 못 했으면 '정상'이 아니라 '확인 불가'다 — 미검사를 통과로 적지 않는다(원칙 #4).
        return { id: t.id, label: t.label, level: 'unknown' as Level, headline: '확인하지 못했어요', metrics: [] };
      }
    }),
  );
  return { level: worst(per.map((p) => p.level)), per };
}

async function summaryText(): Promise<string> {
  const d = db();
  const [trips, moments, media, expenses] = await Promise.all([
    d.localTrips.toArray(),
    d.localMoments.toArray(),
    d.localMedia.toArray(),
    d.localExpenses.toArray(),
  ]);
  const [env, sync, roll] = await Promise.all([collectEnv(APP_VERSION), diagnoseSync(), rollup()]);
  const integ = checkIntegrity({ trips, moments, media, expenses });
  const errs = recentErrors();
  const fmt = (o: Record<string, number>): string =>
    Object.entries(o)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}=${n}`)
      .join(' ') || '없음';

  return [
    `[Bugeon Journey 진단 요약] ${env.clock.nowIso}`,
    `총괄 판정: ${roll.level}`,
    // 판정 한 줄 **아래에 지표까지** 붙인다(2026-07-26 사용자: 확인할 때마다 화면을 사진으로
    // 찍어 보내야 했다 — "수백 장은 찍은 거 같아"). 요약에 숫자가 없으면 복사해 봐야 소용이
    // 없고, 결국 다시 사진을 찍게 된다. 개인정보는 그대로 안 담는다(진단 §6 — 개수와 판정만).
    ...roll.per.flatMap((p) => [
      `  ${p.level.padEnd(7)} ${p.label} — ${p.headline}`,
      ...p.metrics.map((m) => `      ${m.level.padEnd(7)} ${m.label}: 지금 ${m.actual} / 정상 ${m.expected}`),
    ]),
    `--- 환경 ---`,
    `앱 ${env.app.version} · base ${env.app.base} · 사진저장소 ${env.app.mediaStore}`,
    `화면 ${env.screen.w}x${env.screen.h}@${env.screen.dpr} ${env.screen.orientation} · ${env.clock.tz}(UTC${env.clock.tzOffsetMin >= 0 ? '+' : ''}${env.clock.tzOffsetMin / 60}) · ${env.device.online ? '온라인' : '오프라인'}`,
    `UA ${env.device.ua}`,
    `platform ${env.device.platform} · 언어 ${env.device.languages}`,
    `저장 ${bytes(env.storage.usage)}/${bytes(env.storage.quota)} · persist=${String(env.storage.persisted)}`,
    `미지원 기능: ${
      Object.entries(env.features)
        .filter(([, v]) => !v)
        .map(([k]) => k)
        .join(', ') || '없음'
    }`,
    `SW ${env.sw.supported ? (env.sw.controlled ? '제어중' : '미제어') : '미지원'} · 범위 ${env.sw.scope ?? '(없음)'}`,
    `--- 동기화 ---`,
    `대기 ${sync.queue.total} (${fmt(sync.queue.byState)} / ${fmt(sync.queue.byType)})`,
    `tombstone ${fmt(sync.tombstones)} · op없는tombstone ${fmt(sync.opLessTombstones)} · 영구삭제표식 ${sync.purgedMarks}`,
    ...sync.items.map((i) => `  ${i.type} ${i.id.slice(0, 8)} ${i.deleted ? 'del' : 'alive'}${i.queued ? ' queued' : ''}`),
    `--- 무결성 (${integ.checked}건 검사) ---`,
    `지금확인 ${integ.bySeverity.now} · 예방 ${integ.bySeverity.prevent} · 참고 ${integ.bySeverity.info}`,
    ...integ.findings.map((f) => `  ${f.severity} ${f.code} x${f.count} [${f.samples.join(' ')}]`),
    `--- 오류 ${errs.length}건 ---`,
    ...errs.slice(0, 5).map((e) => `  ${e.kind}: ${e.message}`),
  ].join('\n');
}

export async function summaryProbe(): Promise<Verdict> {
  const roll = await rollup();
  const metrics: Metric[] = roll.per.map((p) => ({
    label: p.label,
    actual: p.headline,
    expected: '정상',
    level: p.level,
  }));
  const bad = roll.per.filter((p) => p.level === 'problem').length;
  return {
    level: roll.level,
    headline:
      roll.level === 'problem'
        ? `지금 확인할 것이 ${bad}가지 있어요`
        : roll.level === 'todo'
          ? '지금 해두면 좋은 일이 있어요'
          : roll.level === 'unknown'
            ? '확인하지 못한 항목이 있어요'
            : `${CORE_TOOLS.length}가지 모두 정상입니다`,
    because: '[복사하기]를 누르면 이 결과를 텍스트로 전달할 수 있어요. 여행 제목·사진·메모 같은 기록 내용은 담기지 않습니다.',
    metrics,
    actions: [
      {
        label: '복사하기',
        primary: true,
        hook: 'data-copy-diag',
        run: async () => {
          const text = await summaryText();
          if (!navigator.clipboard?.writeText) return '이 브라우저는 자동 복사가 막혀 있어요. 아래 [원문 보기]를 열어 길게 눌러 복사해 주세요.';
          try {
            await navigator.clipboard.writeText(text);
            return '복사했어요. 대화창에 붙여넣으시면 됩니다.';
          } catch {
            return '복사가 막혔어요. 아래 [원문 보기]를 열어 길게 눌러 복사해 주세요.';
          }
        },
      },
    ],
    evidence: [
      {
        label: '원문 보기',
        build: () => {
          const pre = el('pre', 'vd-pre', '만드는 중…');
          void summaryText().then((t) => {
            pre.textContent = t;
          });
          return pre;
        },
      },
    ],
    context: [{ label: '담기지 않는 것', value: '여행 제목·메모·사진·위치·이메일' }],
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 도구 등록부 — 허브와 패널이 **같은 목록**을 본다
// ────────────────────────────────────────────────────────────────────────────

export interface DiagTool {
  id: string;
  icon: string;
  label: string;
  hint: string;
  lead: string;
  probe: () => Promise<Verdict>;
}

/** 판정 롤업에 참여하는 도구 — 요약 자신은 롤업 대상이 아니다(자기참조가 된다). */
export const CORE_TOOLS: DiagTool[] = [
  {
    id: 'storage',
    icon: '💾',
    label: '저장소 안전',
    hint: '브라우저가 데이터를 지울 위험',
    lead: '브라우저가 공간이 부족하면 앱 데이터를 지울 수 있어요. 그 위험을 봅니다.',
    probe: storageProbe,
  },
  {
    id: 'sync',
    icon: '🔄',
    label: '동기화 상태',
    hint: '서버와 얼마나 어긋나 있나',
    lead: '이 기기의 변경이 서버까지 갔는지 봅니다.',
    probe: syncProbe,
  },
  {
    id: 'integrity',
    icon: '🧷',
    label: 'ID 무결성',
    hint: '기록이 서로 앞뒤가 맞나',
    lead: '저장된 기록끼리 참조가 끊기지 않았는지 봅니다. 읽기 전용이라 아무것도 바꾸지 않아요.',
    probe: integrityProbe,
  },
  {
    id: 'environment',
    icon: '🧩',
    label: '환경·기능',
    hint: '이 기기가 갖춘 기능',
    lead: '이 기기·브라우저가 앱에 필요한 기능을 갖췄는지 봅니다.',
    probe: environmentProbe,
  },
  {
    id: 'store',
    icon: '☁️',
    label: '저장 상태 · 기기별 현황',
    hint: '클라우드와 같은가 · 어느 기기가 뒤처졌나',
    lead: '클라우드와 이 기기의 기록 수를 나란히 놓고, 각 기기가 마지막으로 올린 시각을 봅니다.',
    probe: storeStateProbe,
  },
  {
    id: 'errors',
    icon: '📄',
    label: '오류 기록',
    hint: '이 세션에서 생긴 오류',
    lead: '앱이 도는 동안 생긴 오류를 모아 둡니다. 새로고침하면 사라져요.',
    probe: errorProbe,
  },
];

export const SUMMARY_TOOL: DiagTool = {
  id: 'summary',
  icon: '📋',
  label: '진단 요약 복사',
  hint: '앞의 결과를 한 번에 전달',
  lead: '위 도구들의 결과를 한 덩어리 텍스트로 만듭니다.',
  probe: summaryProbe,
};

export const DIAG_TOOLS: DiagTool[] = [...CORE_TOOLS, SUMMARY_TOOL];

/** 도구 하나를 그린다 — **모든 도구가 같은 렌더러를 통과한다**. */
export function renderDiagTool(t: DiagTool): HTMLElement {
  return renderTool({ title: t.label, lead: t.lead, probe: t.probe });
}

function toolById(id: string): DiagTool {
  const t = DIAG_TOOLS.find((x) => x.id === id);
  if (!t) throw new Error(`진단 도구 없음: ${id}`);
  return t;
}

// ── 다른 화면에서 직접 여는 진입점(데이터 관리·가이드) — 같은 렌더러를 쓴다 ──
export function syncDiagnosticsPanel(): HTMLElement {
  return renderDiagTool(toolById('sync'));
}
export function integrityPanel(): HTMLElement {
  return renderDiagTool(toolById('integrity'));
}
