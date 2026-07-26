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
import { forceRepairCascadeOps, retryFailedOps, supabaseMediaIds } from '../../services/sync';
import { checkIntegrity, CHECK_COUNT } from '../../domain/integrity';
import { collectEnv, evictionRisk, requestPersist } from '../../services/envReport';
import { recentErrors, clearErrors } from '../../app/errorLog';
import { CHANGELOG } from '../../app/changelog';
import { syncStatus, requestSync } from '../../services/autoSync';
import { compareStore, storeStateRemote, unionListings, DOMAIN_LABEL } from '../../services/storeState';
import { r2ListObjects, mediaStoreKind } from '../../services/r2';
import { PURGE_DOMAINS } from '../../services/purge';
import { supabase } from '../../services/supabase/client';
import { deviceLabel, shortDeviceId } from '../../app/deviceId';
import { renderTool, levelFromMetrics, worst, type Verdict, type Metric, type Level } from './verdict';

/** 접힌 출처에 보일 사진 id 상한. 넘으면 "외 N건 생략"이라고 **적는다**(조용히 자르지 않는다). */
export const FILE_ID_CAP = 20;

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
    context: [{ label: '기기', value: env.device.platform }],
  };
  if (persisted !== true && canPersist) {
    v.actions.push({
      label: '저장소 보호 요청',
      primary: true,
      hook: 'data-ask-persist',
      run: async () => {
        const ok = await requestPersist();
        return ok
          ? '보호가 적용됐어요. 브라우저가 임의로 지우지 않습니다.'
          : '브라우저가 요청을 받아들이지 않았어요. 가장 확실한 보호는 [데이터 관리 › 백업]입니다.';
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
      actions: [],
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
  const filesPort = {
    list: async (): Promise<{ ids: string[]; foreign: number; truncated: boolean; error?: string | undefined }> => {
      const sb = await supabaseMediaIds(c, u.id);
      // 합치는 규칙(한쪽이라도 못 읽으면 통째로 확인 불가)은 `unionListings` 한 곳에 있다.
      const parts = mediaStoreKind() === 'r2' ? [await r2ListObjects(c), sb] : [sb];
      const u2 = unionListings(parts);
      return { ids: u2.ids, foreign: u2.foreign ?? 0, truncated: u2.truncated === true, error: u2.error };
    },
  };
  const cmp = await compareStore(storeStateRemote(c), filesPort);

  const metrics: Metric[] = PURGE_DOMAINS.map((d) => {
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

  // ── 사진 파일 대조 ──────────────────────────────────────────────
  // 두 방향을 **한 숫자로 합치지 않는다.** 사용자가 할 일이 정반대이기 때문이다
  // (진단 §4의 "대기 중인 작업 3건"이 정확히 그 실수였다).
  const fa = cmp.fileAudit;
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
    metrics.push({
      label: '기록 없는 사진 파일',
      actual: `${fa.orphans.length}개`,
      expected: '0개',
      level: fa.orphans.length ? 'problem' : 'ok',
      ...(fa.orphans.length
        ? { meaning: '기록은 지워졌는데 서버에 파일만 남았어요. 기억은 안전하고 용량만 차지합니다.' }
        : {}),
    });
    metrics.push({
      label: '파일이 없는 사진 기록',
      actual: fa.truncated ? '확인 못 함' : `${fa.missing.length}개`,
      expected: '0개',
      // 목록이 잘렸으면 "없다"고 말할 수 없다 — 뒤쪽 페이지에 있을 수 있다.
      level: fa.truncated ? 'unknown' : fa.missing.length ? 'problem' : 'ok',
      ...(fa.truncated
        ? { meaning: `사진이 너무 많아 목록을 다 보지 못했어요(${fa.files}개까지 확인). 이 판정은 보류합니다.` }
        : fa.missing.length
          ? { meaning: '기록은 있는데 서버에 사진 파일이 없어요. 사본을 가진 기기에서 동기화하면 다시 올라갑니다.' }
          : {}),
    });
  }

  const level = levelFromMetrics(metrics);
  const behind = cmp.devices.filter((d) => !d.isThis && cmp.lastCloudWriteAt && d.lastPushAt < cmp.lastCloudWriteAt);

  return {
    level,
    headline:
      level === 'ok'
        ? '이 기기는 클라우드와 같습니다'
        : `클라우드와 다른 항목이 ${metrics.filter((m) => m.level !== 'ok').length}가지 있어요`,
    because:
      cmp.devices.length > 1
        ? `기기 ${cmp.devices.length}대가 이 계정에 기록을 올렸어요.${behind.length ? ` 그중 ${behind.length}대는 최신본보다 오래됐습니다.` : ''}`
        : '아직 이 기기에서만 올렸어요.',
    metrics,
    actions: [
      {
        label: '지금 동기화',
        primary: level !== 'ok',
        hook: 'data-store-sync',
        run: async () => {
          await requestSync('저장 상태 확인');
          const s = syncStatus();
          return s.phase === 'failed' ? `동기화 실패: ${s.lastError ?? '사유 불명'}` : '동기화했어요. 다시 대조합니다.';
        },
      },
    ],
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
              label: `사진 파일 ${fa.files}개 · 기록 ${fa.rows}개${fa.truncated ? ' (다 못 봄)' : ''}`,
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
          table(
            cmp.devices.length
              ? cmp.devices.map((d): [string, string] => [
                  `${d.label}${d.isThis ? ' (이 기기)' : ''}`,
                  `마지막으로 올림 ${d.lastPushAt.replace('T', ' ').slice(0, 19)}`,
                ])
              : [['(없음)', '아직 이 계정으로 올린 기록이 없어요']],
          ),
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
export async function rollup(): Promise<{ level: Level; per: { id: string; label: string; level: Level; headline: string }[] }> {
  const per = await Promise.all(
    CORE_TOOLS.map(async (t) => {
      try {
        const v = await t.probe();
        return { id: t.id, label: t.label, level: v.level, headline: v.headline };
      } catch {
        // 판정을 못 했으면 '정상'이 아니라 '확인 불가'다 — 미검사를 통과로 적지 않는다(원칙 #4).
        return { id: t.id, label: t.label, level: 'unknown' as Level, headline: '확인하지 못했어요' };
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
    ...roll.per.map((p) => `  ${p.level.padEnd(7)} ${p.label} — ${p.headline}`),
    `--- 환경 ---`,
    `앱 ${env.app.version} · base ${env.app.base} · 사진저장소 ${env.app.mediaStore}`,
    `화면 ${env.screen.w}x${env.screen.h}@${env.screen.dpr} ${env.screen.orientation} · ${env.clock.tz}(UTC${env.clock.tzOffsetMin >= 0 ? '+' : ''}${env.clock.tzOffsetMin / 60}) · ${env.device.online ? '온라인' : '오프라인'}`,
    `UA ${env.device.ua}`,
    `저장 ${bytes(env.storage.usage)}/${bytes(env.storage.quota)} · persist=${String(env.storage.persisted)}`,
    `미지원 기능: ${
      Object.entries(env.features)
        .filter(([, v]) => !v)
        .map(([k]) => k)
        .join(', ') || '없음'
    }`,
    `SW ${env.sw.supported ? (env.sw.controlled ? '제어중' : '미제어') : '미지원'}`,
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
            : '다섯 가지 모두 정상입니다',
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
  hint: '다섯 결과를 한 번에 전달',
  lead: '위 다섯 도구의 결과를 한 덩어리 텍스트로 만듭니다.',
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
