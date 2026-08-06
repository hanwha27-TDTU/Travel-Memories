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

import type { DiagGroup } from '../../domain/diagGroups';
import {
  fileRealityMetrics,
  fileRealityHeadline,
  fileRealityScopeNote,
  type FileRealityInput,
} from '../../domain/fileRealityVerdict';
import { tallyLocalFiles, lastSweep, sweepOpenFiles } from '../../services/fileReality';
import { localDateTime } from '../../domain/time';
import { el, downloadBlob } from '../dom';
import {
  auditOpLessTombstones,
  diagnoseSync,
  ITEM_CAP,
  loadIntegritySnapshot,
  tombstoneAuditRemote,
  type SyncDiagnosis,
} from '../../services/diagnostics';
import { retryFailedOps, requeueMissingBytes } from '../../services/sync';
import { checkIntegrity, CHECK_COUNT } from '../../domain/integrity';
import { autoSyncVerdict } from '../../domain/syncStatusVerdict';
import {
  isConfirmedTombstone,
  tombstoneFindingText,
  tombstoneSyncPresentation,
  type TombstoneSyncFinding,
} from '../../domain/syncTombstoneVerdict';
import { collectEnv, evictionRisk, requestPersist, lastPersistAsk, rememberPersistAsk } from '../../services/envReport';
import { persistSurface } from '../../services/capacitorShell';
import { persistResultNote, persistIsMeaningful, surfaceLabel, storageHeadline, persistAskNote } from '../../domain/persistAdvice';
import { recentErrors, clearErrors } from '../../app/errorLog';
import { CHANGELOG } from '../../app/changelog';
import { syncStatus, requestSync } from '../../services/autoSync';
import {
  compareStore,
  storeStateRemote,
  unionListings,
  DOMAIN_LABEL,
  type StoreComparison,
  type MediaFileAudit,
} from '../../services/storeState';
import { r2ListObjects, r2DeleteMany, r2AbortMultipart } from '../../services/r2';
import {
  PURGE_DOMAINS,
  requeueUnpropagatedPurges,
  purgeServerOnly,
  requestUnpurge,
  pendingUnpurgeIds,
} from '../../services/purge';
import { supabase, isConfigured } from '../../services/supabase/client';
import { exportBackup } from '../../services/backup';
import { recordBackupNow, getLastBackupAt, backupFreshness, STALE_DAYS } from '../../services/backupMeta';
import { collectTrashState } from '../../services/trashState';
import { trashMetrics, trashHeadline, TRASH_ITEM_CAP } from '../../domain/trashVerdict';
import { lastRoundTrip, runRoundTrip, cleanupRoundTripLeftovers } from '../../services/roundTrip';
import { collectServerContract } from '../../services/serverContract';
import { serverContractMetrics, serverContractHeadline } from '../../domain/serverContractVerdict';
import { collectSessionState } from '../../services/sessionState';
import { fleetMetrics, fleetHeadline, daysSince, type FleetObservation } from '../../domain/deviceFleetVerdict';
import { sessionMetrics, sessionHeadline, WANTED_SESSION_DAYS } from '../../domain/sessionVerdict';
import { AUTH_GATE_CASES } from '../../domain/authGate';
import {
  roundTripView,
  ROUND_TRIP_STEPS,
  ROUND_TRIP_TITLE_PREFIX,
  STEP_LABEL,
  STEP_PROVES,
} from '../../domain/roundTripVerdict';
import {
  deviceLabel,
  shortDeviceId,
  customDeviceName,
  setCustomDeviceName,
  detectDeviceLabel,
  readDeviceHints,
  DEVICE_NAME_MAX,
} from '../../app/deviceId';
import { renderTool, levelFromMetrics, worst, unknownIsStructural, levelOr, type Verdict, type Metric, type Level, type Action, type UnknownKind } from './verdict';

/** 접힌 출처에 보일 사진 id 상한. 넘으면 "외 N건 생략"이라고 **적는다**(조용히 자르지 않는다). */
export const FILE_ID_CAP = 20;

/**
 * 이 앱이 **기대하는** 사진 저장소 함수 판. 서버가 이보다 낮으면 새 지표를 믿을 수 없다.
 * 함수에 연산을 추가할 때 `FN_VERSION`과 **함께** 올린다 — 안 올리면 화면이 낡음을 못 알아본다.
 */
export const EXPECTED_FN_VERSION = 6;

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
/**
 * 근거 표. **비었을 때 무슨 뜻인지는 부르는 쪽이 말한다** — `whenEmpty`는 선택이 아니다.
 *
 * 왜 필수인가(2026-07-27 사용자 지적): 예전엔 비면 「없음」 한 단어만 찍었다. 그래서
 * 접힌 제목은 *「사진 파일 9개(2.1 MB) · 기록 9개」*인데 펼치면 **「없음」**이었다 —
 * 사용자가 물었다: *"사진파일 9개라고 적혀있는데 밑에 '없음' 이건 뭘 의미?"*
 *
 * 제목은 **가진 것**을 세고 표는 **어긋난 것**을 담는데, 그 한정을 아무도 말하지 않았다.
 * M-0028과 같은 형태다(문장이 한정을 생략하면 사용자는 전부를 다룬다고 읽는다).
 *
 * 타입으로 강제하는 이유(§7 2층): 다음 사람이 새 근거 표를 추가할 때 **빠뜨릴 수 없게**.
 * 산문으로 "빈 문구를 적으세요"라고 두면 언젠가 또 「없음」이 된다.
 */
function table(rows: [string, string][], whenEmpty: string): HTMLElement {
  const t = el('div', 'vd-src-table');
  for (const [k, v] of rows) {
    const r = el('div', 'vd-src-row');
    r.append(el('span', 'vd-src-k', k), el('span', 'vd-src-v', v));
    t.appendChild(r);
  }
  if (!rows.length) t.appendChild(el('p', 'vd-src-empty', whenEmpty));
  return t;
}

const countMap = (o: Record<string, number>): string =>
  Object.entries(o)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`)
    .join(' · ') || '없음';

// ────────────────────────────────────────────────────────────────────────────
/** 도메인 판정 뷰의 공통 모양 — 인라인 타입으로 두면 게이트가 지표 리터럴로 오인한다(§11 ③). */
interface MetricSource {
  actual: string;
  expected: string;
  level: Level;
  meaning?: string;
}

/**
 * 도메인 판정 뷰 → `Metric`. 🔴 **`kind`에 기본값이 없다** — 새 도구가 안 적으면 컴파일되지 않는다.
 *
 * 왜: `확인 불가`가 *구조적*(이 기기에선 원리적으로 못 잼)인지 *일시적*(재보면 알 수 있음)인지에
 * 따라 총괄 판정에 넣을지가 갈린다(사용자 지적 2026-08-06). 기본값을 두면 그 판단을 안 하고도
 * 통과하고, 그게 이 규율이 조용히 빠지는 길이다(M-0060).
 */
function metricFromView(label: string, v: MetricSource, kind: UnknownKind): Metric {
  const rest = v.meaning ? { meaning: v.meaning } : {};
  return v.level === 'unknown'
    ? { label, actual: v.actual, expected: v.expected, level: 'unknown', unknownKind: kind, ...rest }
    : { label, actual: v.actual, expected: v.expected, level: v.level, ...rest };
}

// ① 저장소 안전 — 앱 밖 원인의 유일한 기억 손실 경로
// ────────────────────────────────────────────────────────────────────────────

export async function storageProbe(): Promise<Verdict> {
  const env = await collectEnv(APP_VERSION);
  const risk = evictionRisk(env);
  const { usage, quota, persisted, canPersist } = env.storage;
  const pct = usage !== null && quota ? Math.round((usage / quota) * 100) : null;

  // T-005: 「어느 문으로 실행 중인가」를 **판정에 쓴다.** 옛 판은 이 값을 알 수 있는데도 안 써서
  // APK 사용자에게 「홈 화면에 추가」를, 이미 설치한 사용자에게 「설치하세요」를 말했다(M-0048의 형태).
  const surface = persistSurface();
  const meaningful = persistIsMeaningful(surface);
  const ask = lastPersistAsk();
  // 시각은 **로컬 표기**로 — 원시 UTC를 사용자 화면에 내보내지 않는다(M-0110).
  const askNote = persistAskNote(ask ? { granted: ask.granted, auto: ask.auto, when: localDateTime(ask.at) } : null, surface);

  const metrics: Metric[] = [
    {
      label: '저장소 보호(persist)',
      actual: persisted === null ? '알 수 없음' : persisted ? '적용됨' : '미적용',
      expected: meaningful ? '적용됨' : '설치된 앱이라 브라우저 보호와 무관',
      // 셸에서는 이 값이 무엇을 뜻하는지 **재본 적이 없다** — 정상으로도 문제로도 반올림하지
      // 않는다(§8). 재는 방법이 생기면 `persistIsMeaningful`부터 고친다.
      //
      // 🔴 **여기가 구조적 확인 불가의 대표 자리다**(사용자 지적 2026-08-06): 설치된 앱에서는
      // 다시 눌러도 알 수 없다 — 잘못된 상태가 아니므로 총괄 판정을 끌어내리지 않는다.
      // 반면 `persisted === null`(브라우저가 안 알려줌)은 브라우저·시점에 달린 **일시적**이다.
      ...(!meaningful
        ? { level: 'unknown' as const, unknownKind: 'structural' as const }
        : persisted === null
          ? { level: 'unknown' as const, unknownKind: 'transient' as const }
          : { level: persisted ? ('ok' as const) : ('todo' as const) }),
      // 🔴 **「왜 아직 미적용인가」에 답한다**(T-005) — 물어봤는지조차 안 말하면 사용자는
      // *"앱이 물어보긴 한 건가?"*에서 멈추고, 그 과제는 영원히 열려 있다(§12).
      ...(!meaningful
        ? { meaning: `설치된 앱으로 실행 중이에요. ${askNote} 이 값이 이 표면에서 무엇을 뜻하는지는 아직 재보지 못했으니, 확실한 보호는 [데이터 관리 › 백업]입니다.` }
        : persisted === false
          ? { meaning: `보호가 없으면 브라우저가 공간이 부족할 때 이 앱의 기록을 지울 수 있어요. ${askNote}` }
          : {}),
    },
    {
      label: '저장 공간 사용률',
      actual: pct === null ? '알 수 없음' : `${pct}% (${bytes(usage)} / ${bytes(quota)})`,
      expected: '80% 미만',
      ...levelOr(pct === null, 'transient', pct !== null && pct >= 80 ? 'problem' : 'ok'),
      ...(pct !== null && pct >= 80
        ? { meaning: '여유가 적어요. 브라우저가 공간을 회수하며 앱 데이터를 지울 수 있습니다. 지금 [데이터 관리 › 백업]으로 파일을 받아 두세요.' }
        : {}),
    },
  ];

  const level = levelFromMetrics(metrics);
  const v: Verdict = {
    level,
    // 🔴 판정문을 등급이 아니라 **이유**에서 만든다(M-0113) — `unknown`의 이유가 여럿인데
    // 문장이 하나면 한 화면이 자기와 모순된다(「용량을 모른다」 위에 「사용 0%」).
    headline: storageHeadline({ level, surface, quotaKnown: pct !== null }),
    because: risk.text,
    metrics,
    actions: [],
    evidence: [],
    // 같은 기기를 화면마다 다르게 부르지 않는다(§7 사용자 대면 대칭). `navigator.platform`은
    // 「Linux」처럼 사용자가 자기 태블릿을 못 알아보는 값을 준다 — 「저장 상태」가 쓰는 이름표와
    // **같은 것**을 쓴다(사용자가 지은 이름이 있으면 그게 이긴다).
    context: [
      { label: '기기', value: `${deviceLabel()} · ${shortDeviceId()}` },
      // 🔴 앱이 아는 것을 화면에 내놓는다(§12). 「설치는 했는데 왜 안 되지」를 사용자가 물을 때,
      // 앱이 **자기가 무엇으로 보이는지**를 말하지 않으면 그 질문에 답할 길이 없다.
      { label: '실행 표면', value: surfaceLabel(surface) },
    ],
  };
  if (persisted !== true && canPersist) {
    v.actions.push({
      label: '저장소 보호 요청',
      primary: true,
      hook: 'data-ask-persist',
      // ⚠️ 2026-07-26 사용자 실기기: 거절에서 멈추면 **판정만 하고 행동을 못 준 것**이다
      // (근본형 D). 브라우저가 거절한 것은 우리 잘못이 아니지만, *다음에 무엇을 하면 되는지*는
      // 알려줄 수 있다 — 그게 화면이 할 일이다.
      //
      // 문장은 `persistResultNote()`가 만든다 — 표면마다 할 일이 다르고(APK엔 「홈 화면에 추가」
      // 메뉴가 없다), 그 갈래는 DOM 안에 두면 검사할 수 없다(§10 ③).
      run: async () => {
        const granted = await requestPersist();
        rememberPersistAsk(granted, false); // 사용자가 누른 것도 **같은 자리**에 남긴다(기록이 두 벌이면 갈라진다)
        return persistResultNote({ surface, canPersist }, granted);
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

/**
 * 「막힌 작업」의 설명 문장. **순수 함수** — 사용자에게 가는 말은 유닛이 직접 돌린다(§10 ③).
 *
 * 🔴 왜 사유를 붙이나(2026-08-05 · M-0107): 옛 문장은 *"[실패 재시도]를 눌러 주세요"* 한 줄이었다.
 * 그런데 사용자 기기의 13건은 **눌러도 절대 풀리지 않는** 부류였다(부모가 영구삭제돼 서버에
 * 그 관계가 없어진 사진들). 즉 화면이 **안 되는 일을 시키고 있었다** — 진단 도구가 원자료
 * 덤프보다 나쁜 순간이다(§8: 엉뚱한 것을 판정하면 사용자를 틀린 곳으로 보낸다).
 *
 * 사유를 **앱이 아는 만큼만** 말한다. 모르면 모른다고 적는다(원칙 #4).
 */
export function stuckMeaning(reasons: ReadonlyArray<{ reason: string; count: number }>): string {
  const head = '보내다 실패해 멈춘 작업이에요. 동기화를 눌러도 저절로 풀리지 않습니다 — 아래 [실패 재시도]를 눌러 주세요.';
  if (!reasons.length) return head;
  const top = reasons.slice(0, 2).map((r) => `${r.reason} (${r.count}건)`).join(' · ');
  const more = reasons.length > 2 ? ` 외 ${reasons.length - 2}가지` : '';
  return `${head} 서버가 말한 이유: ${top}${more}`;
}

interface LoadedTombstoneAudit {
  findings: TombstoneSyncFinding[];
  unavailableReason: string | null;
}

/**
 * 로컬 숫자를 서버 판정으로 바꾼다. 한 요청이라도 실패하면 일부 결과를 정상으로 쓰지 않는다.
 * 데이터는 읽기만 하며, 로그인 전·오프라인에는 로컬 tombstone을 그대로 보존한다.
 */
async function loadTombstoneAudit(d: SyncDiagnosis): Promise<LoadedTombstoneAudit> {
  if (!d.opLessItems.length) return { findings: [], unavailableReason: null };
  const unknown = (reason: string): LoadedTombstoneAudit => ({
    findings: d.opLessItems.map((local) => ({ local, server: null, state: 'unknown' })),
    unavailableReason: reason,
  });
  const c = supabase();
  if (!c) return unknown('서버 연결이 설정되지 않았습니다.');
  const u = await currentUserSafe();
  if (!u) return unknown('로그인 상태가 아닙니다.');
  try {
    return { findings: await auditOpLessTombstones(tombstoneAuditRemote(c), d.opLessItems), unavailableReason: null };
  } catch (e) {
    return unknown((e as Error).message);
  }
}

function syncExplanationItems(d: SyncDiagnosis, findings: TombstoneSyncFinding[]) {
  const byKey = new Map(findings.map((x) => [`${x.local.domain}:${x.local.id}`, x]));
  const candidates = d.itemCandidates.filter((it) => {
    if (it.queued || !it.deleted) return true;
    const finding = byKey.get(`${it.type}:${it.id}`);
    return !finding || !isConfirmedTombstone(finding.state);
  });
  return {
    shown: candidates.slice(0, ITEM_CAP),
    omitted: Math.max(0, candidates.length - ITEM_CAP),
    byKey,
  };
}

export async function syncProbe(): Promise<Verdict> {
  const d = await diagnoseSync();
  const audit = await loadTombstoneAudit(d);
  const tombstone = tombstoneSyncPresentation(audit.findings, audit.unavailableReason);
  const explanation = syncExplanationItems(d, audit.findings);
  const stuck = Object.entries(d.queue.byState)
    .filter(([s]) => STUCK_STATES.has(s))
    .reduce((a, [, n]) => a + n, 0);
  const waiting = d.queue.total - stuck;

  const metrics: Metric[] = [
    {
      label: '막힌 작업',
      actual: stuck === 0 ? '없음' : `${stuck}건`,
      expected: '없음',
      level: stuck > 0 ? 'problem' : 'ok',
      ...(stuck > 0 ? { meaning: stuckMeaning(d.stuckReasons) } : {}),
    },
    {
      label: '보낼 대기',
      actual: waiting === 0 ? '없음' : `${waiting}건`,
      expected: '없음',
      level: waiting > 0 ? 'todo' : 'ok',
      ...(waiting > 0 ? { meaning: '아직 서버로 보내지 않은 변경이에요. 동기화를 누르면 올라갑니다 — 정상적인 대기 상태입니다.' } : {}),
    },
    // 서버 행·원장을 못 읽었을 때만 unknown이다 — 다시 확인하면 풀리므로 **일시적**.
    metricFromView('삭제 반영 확인', tombstone, 'transient'),
  ];

  // 자동 동기화가 **조용히 실패하고 있지 않은지** — 자동화의 가장 큰 위험이 여기다(M-0008 부류).
  // 판정과 문장은 `domain/syncStatusVerdict.ts`의 순수 함수가 만든다 — 화면에 나가는 문장
  // 자체가 결함일 수 있어서 유닛으로 모든 갈래를 돌려야 한다(§10 ③).
  const av = autoSyncVerdict(syncStatus());
  // 오프라인·첫 회차 진행 중 등 — 시간이 지나면 답이 나온다(**일시적**).
  metrics.push(metricFromView('자동 동기화', { ...av, expected: '최근에 성공' }, 'transient'));

  const level = levelFromMetrics(metrics);
  const v: Verdict = {
    level,
    headline:
      level === 'problem'
        ? `보내지 못하고 멈춘 작업이 ${stuck}건 있어요`
        : level === 'todo' && waiting > 0
          ? `서버로 보낼 변경이 ${waiting}건 남아 있어요`
          : tombstone.headline && tombstone.level === level
            ? tombstone.headline
            : level === 'todo'
              ? '동기화로 맞출 항목이 있어요'
            : level === 'unknown'
              ? '자동 동기화 상태를 아직 확인하는 중이에요'
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
          ], '셀 것이 없어요'),
      },
      {
        // 잘랐으면 잘랐다고 라벨에 적는다 — 조용한 절단은 "전부 봤다"로 읽힌다.
        label: `설명이 필요한 항목 ${explanation.shown.length}개${explanation.omitted ? ` (외 ${explanation.omitted}건 생략)` : ''}`,
        build: () =>
          table([
            ...explanation.shown.map(
              (it): [string, string] => [
                `${it.type} ${it.id.slice(0, 8)}`,
                it.queued
                  ? `${it.deleted ? '지움' : '활성'} · 보낼 목록에 있음`
                  : tombstoneFindingText(explanation.byKey.get(`${it.type}:${it.id}`)?.state ?? 'unknown'),
              ],
            ),
            ...(explanation.omitted ? ([['…', `외 ${explanation.omitted}건은 화면에서 생략했어요(전체는 [진단 요약 복사]에 담깁니다)`]] as [string, string][]) : []),
          ], '설명이 필요한 항목이 없어요 — 지운 것과 보낼 목록이 모두 맞습니다'),
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
    primary: stuck === 0 && (waiting > 0 || tombstone.actionable > 0 || tombstone.unknown > 0),
    hook: 'data-sync-now',
    run: async () => {
      // 수동 버튼도 **같은 경로**(§7). `deep`은 바이트 대조를 주기와 무관하게 돌린다.
      await requestSync('수동', { deep: true });
      const after = syncStatus();
      if (after.phase === 'failed') return `동기화 실패: ${after.lastError ?? '사유 불명'}`;
      if (after.phase === 'signed-out') return '로그인 상태가 아니에요. 홈 화면에서 로그인한 뒤 다시 시도해 주세요.';
      if (after.phase === 'offline') return '오프라인이에요. 연결되면 자동으로 다시 시도합니다.';
      const r = after.lastResult;
      return r ? `동기화했어요 — 올림 ${r.pushed}건 · 내림 ${r.pulled}건.` : '동기화했어요.';
    },
  });
  return v;
}

// ────────────────────────────────────────────────────────────────────────────
// ③ ID 무결성 — 기록이 서로 앞뒤가 맞나
// ────────────────────────────────────────────────────────────────────────────

export async function integrityProbe(): Promise<Verdict> {
  const r = checkIntegrity(await loadIntegritySnapshot());
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
        build: () =>
          table(
            r.findings.map((f) => [`${f.code} ×${f.count}`, `${f.title} — 예: ${f.samples.join(', ')}`]),
            '걸린 것이 없어요 — 검사한 기준을 모두 통과했습니다',
          ),
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
      {
        label: '기능 지원 전체',
        build: () =>
          table(
            Object.entries(env.features).map(([k, ok]) => [k, ok ? '지원' : '미지원']),
            '확인한 기능이 없어요 — 이 브라우저에서 조회하지 못했습니다',
          ),
      },
      {
        label: '화면·서비스워커·브라우저',
        build: () =>
          table([
            ['화면', `${env.screen.w}×${env.screen.h} · ${env.screen.orientation} · 배율 ${env.screen.dpr}`],
            ['서비스워커', env.sw.supported ? (env.sw.controlled ? '동작 중(캐시 사용)' : '지원하나 미제어') : '미지원'],
            ['브라우저', env.device.ua],
          ], '이 브라우저 정보를 읽지 못했어요'),
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
            build: () =>
              table(
                errs.map((e) => [`${e.kind} · ${e.at.slice(11, 19)}`, `${e.message}${e.where ? ` ← ${e.where}` : ''}`]),
                '기록된 오류가 없어요',
              ),
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
 * **파일이 없는 기록**을 세 갈래로 가른다. `classifyOrphanFiles`의 반대 방향이고, 가르는
 * 질문은 **하나뿐**이다 — *이 기기에 사본이 있는가.*
 *
 * 🔴 왜 이 질문이 먼저인가(2026-07-28 사용자 실기기, M-0046): 예전에는 묻지 않고
 * tombstone 여부만 봤다. 그래서 **로컬 휴지통에 멀쩡히 있는 녹음 3건**을 「지운 소리의 남은
 * 기록 · 소리 자체는 없습니다」로 띄우고 **정리를 권했다.** 그 버튼(`purgeServerOnly`)은
 * 로컬 행까지 지운다 — 따랐으면 되살릴 수 있던 기억 20초가 사라졌다.
 *
 * 🔴 **두 번째 질문은 「다른 기기가 있는가」다**(2026-07-28 사용자 실기기, M-0048).
 * 위 수정 뒤에도 같은 3건이 **기기마다 정반대 판정**을 받았다 — 사본을 가진 태블릿은
 * 「자료는 안전합니다」, 사본이 없는 폴드5는 **「치우세요」**. 두 문장 다 자기 기기에 대해서는
 * 참이었지만, 폴드5의 **결론**은 틀렸다. 그리고 그 결론을 따랐으면(`purgeServerOnly` →
 * 서버 원장 + `block_purged_reinsert` 트리거) **태블릿의 사본까지 되살릴 수 없게** 된다.
 *
 * > **「이 기기에 없다」에서 「없다」로 건너뛰지 않는다.** M-0046의 근본형이 기기 축에서
 * > 반복된 것이다 — *한 곳을 보고 전체를 말하면, 아직 안 본 곳이 곧 사용자의 기억이다.*
 * > 앱은 기기가 몇 대인지 **화면에 띄우면서도** 그 사실을 판정에 쓰지 않고 있었다.
 *
 *  · `recoverable` — **이 기기에 바이트가 있다.** 자료는 안전하고, 다시 올리면 끝난다.
 *    tombstone이든 활성이든 상관없다 — 사본이 있다는 사실이 나머지를 이긴다.
 *  · `clearable`   — 사본이 없고, 서버에서도 tombstone이고, **다른 기기도 없다.**
 *    그때만 「자료는 정말로 없다」고 말할 수 있다. 기록 줄만 치운다.
 *  · `atRisk`      — 나머지 전부. 활성이거나, **다른 기기가 사본을 가졌을 수 있다.**
 *    지우면 안 된다.
 */
export function classifyMissingFiles(
  missing: string[],
  serverTombstoned: string[],
  /** 이 기기가 바이트를 들고 있는 id들. 비어 있으면 "이 기기엔 사본 없음"으로 판정된다. */
  localBytes: ReadonlySet<string>,
  /**
   * **이 기기를 뺀** 기기 수. 0보다 크면 「사본이 없다」를 단정할 수 없다.
   *
   * 왜 인자인가: 기본값을 두면 호출부가 안 넘겨도 컴파일된다 — 그러면 이 규율이 **조용히
   * 빠지는 길**이 생긴다(§7 2층: 누락이 컴파일 오류가 되게).
   */
  otherDevices: number,
): { recoverable: string[]; clearable: string[]; atRisk: string[] } {
  const dead = new Set(serverTombstoned);
  const alone = otherDevices === 0;
  return {
    recoverable: missing.filter((id) => localBytes.has(id)),
    clearable: missing.filter((id) => !localBytes.has(id) && dead.has(id) && alone),
    atRisk: missing.filter((id) => !localBytes.has(id) && !(dead.has(id) && alone)),
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
/**
 * **전파되지 않은 영구삭제** 지표 — 내가 지웠다고 믿는데(로컬 표식) 서버엔 tombstone으로 남은 것.
 *
 * 로컬 표식 때문에 휴지통에도 안 보이므로 **어디서도 손댈 수 없는 상태**다 — 앱이 말해주지
 * 않으면 영원히 남는다.
 *
 * (형제인 `blockedByLedgerMetric`은 처음부터 함수였는데 이쪽만 `storeStateProbe` 안에 인라인으로
 *  있었다. `check-fn-size` 래칫이 그 비대칭을 밀어내 줬다 — §2-C 「게이트가 설계를 밀어준다」.)
 */
export function strandedMetric(stranded: number): Metric {
  return {
    label: '지웠는데 서버에 남은 항목',
    actual: stranded === 0 ? '없음' : `${stranded}건`,
    expected: '없음',
    level: stranded > 0 ? 'problem' : 'ok',
    ...(stranded > 0
      ? { meaning: '이 기기에서 영구삭제했지만 서버에 전하지 못한 항목이에요. 휴지통에도 안 보여서 손댈 수가 없습니다 — 아래 [서버에서도 지우기]를 눌러 주세요.' }
      : {}),
  };
}

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
      (restoringFiles ? ` 파일 ${restoringFiles}개는 되살아날 자료라 정리 대상에서 빼 뒀어요.` : ''),
  };
}

/** `storeBecause` 입력 — 판정 문장과 **같은 자료**를 받는다(다른 것을 보면 두 문장이 갈라진다). */
export interface StoreBecauseInput {
  countBad: number;
  /** `storeHeadline`과 **같은 모양**으로 받는다 — 개수를 세야 하고, 배열의 존재로 판정하면 안 된다. */
  fileBad: ReadonlyArray<{ noun: string; n: number }>;
  stranded: number;
  blocked: number;
  /** 이 계정에 기록을 올린 기기 수. */
  devices: number;
  /** 그중 최신본보다 오래된 기기 수. */
  behind: number;
}

export interface StoreHeadlineInput {
  level: Level;
  /** 개수 대조에서 어긋난 도메인 수. */
  countBad: number;
  /**
   * 파일 대조에서 어긋난 지표 수 — **종류별로** 받는다.
   *
   * 🔴 왜 숫자 하나가 아닌가(2026-07-28 사용자 실기기, M-0048): 예전엔 `fileBad: number`였고
   * 문장이 「**사진** 파일에 확인할 것이 N가지 있어요」로 못 박혀 있었다. 그런데 소리를
   * 형제로 들이면서 이 숫자가 **소리까지** 세게 됐고, 문장만 안 따라왔다 — 사진은 9:9로
   * 멀쩡한데 화면은 「사진 파일에…」라고 말했다. §7 최빈형(형제 하나만 조용히 빠짐)이다.
   *
   * 종류 이름을 **호출부가 넘기게** 해서, 다음 형제(영상 등)가 생기면 문장이 자동으로 따라온다.
   */
  fileBad: ReadonlyArray<{ noun: string; n: number }>;
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
  // 어긋난 종류만 남긴다 — **정상은 문장에서 사라진다**(§8 「침묵이 정상」).
  const bad = i.fileBad.filter((f) => f.n > 0);
  const fileTotal = bad.reduce((n, f) => n + f.n, 0);
  const nouns = bad.map((f) => f.noun).join('·');
  if (i.countBad && fileTotal) return `클라우드와 다른 항목 ${i.countBad}가지, ${nouns} 파일 문제 ${fileTotal}가지가 있어요`;
  if (i.countBad) return `클라우드와 다른 항목이 ${i.countBad}가지 있어요`;
  if (fileTotal) return `${nouns} 파일에 확인할 것이 ${fileTotal}가지 있어요`;
  // 어느 무리에도 안 잡혔는데 정상도 아니다 = 대조 자체를 못 했다(확인 불가).
  return '지금은 클라우드와 대조하지 못했어요';
}

/**
 * **판정 문장 밑의 설명 한 줄.** `storeHeadline`의 형제이고, **같은 규칙을 지나야 한다**(§7).
 *
 * 🔴 왜 순수 함수로 뽑았나(2026-08-01 사용자 실기기): 이 문장은 호출부에 **삼항 연산자로
 * 박혀 있었고**, 거기서 `fileBad`(배열)를 **불리언으로** 썼다. `fileBadByNoun`은 명사당 한 칸을
 * 돌려주므로 **빈 배열이 아닌 이상 언제나 참**이다 — 그래서 짝이 맞든 안 맞든
 * *"사진 기록과 서버 파일이 짝이 맞지 않아요"*가 나왔다.
 *
 * 사용자 화면이 그걸 잡았다: 판정은 **「✓ 정상 · 살아 있는 기록 40건이 클라우드와 같아요」**인데
 * 바로 밑은 **「짝이 맞지 않아요」**. 형제인 `storeHeadline`은 처음부터 `f.n > 0`을 세고 있었다 —
 * **같은 자료를 두 문장이 다른 규칙으로 읽고 있었다**(§7이 금지하는 바로 그것).
 *
 * 그리고 이건 §10 ③(전달 결함)이다: 자료구조는 옳았고 **화면에 나가는 문장만 틀렸다.**
 * 그래서 이제 순수 함수이고, 유닛이 직접 돌린다.
 */
export function storeBecause(i: StoreBecauseInput): string {
  if (i.blocked) {
    return '백업에서 되살린 기록을 서버가 「이미 영구삭제된 것」으로 알고 거부하고 있어요. 아래 버튼으로 서버에 되살렸다고 알릴 수 있습니다.';
  }
  if (i.stranded) return '이 기기에서 지운 것이 서버까지 가지 못했어요. 아래 버튼으로 다시 보낼 수 있습니다.';
  // 🔴 **개수를 센다.** 배열의 존재가 아니라 — 형제(`storeHeadline`)와 같은 규칙이다.
  const fileTotal = i.fileBad.reduce((n, f) => n + f.n, 0);
  if (fileTotal && !i.countBad) {
    return '사진 기록과 서버 파일이 짝이 맞지 않아요. 아래 지표에서 어느 쪽인지 볼 수 있습니다.';
  }
  if (i.devices > 1) {
    return `기기 ${i.devices}대가 이 계정에 기록을 올렸어요.${i.behind ? ` 그중 ${i.behind}대는 최신본보다 오래됐습니다.` : ''}`;
  }
  if (i.devices === 1) return '아직 이 기기에서만 올렸어요.';
  // 0대는 "기기가 없다"가 아니라 **"이름표를 붙이기 시작한 뒤로 올린 적이 없다"**이다.
  // 기기 이름은 push할 때만 서버에 찍히므로, 최근에 저장·수정한 적이 없으면 비어 있다.
  // 이걸 그냥 "0대"로 두면 사용자가 연동이 끊겼다고 오해한다(§5.9 — 말할 수 있는 것만).
  return '기기 이름은 무언가를 저장·수정해 서버로 올릴 때 찍혀요. 아직 그 뒤로 올린 것이 없습니다.';
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
  /** 자료 없이 기록 줄만 남은 소리 id. 사진과 **버튼을 나누는 이유**: `purgeServerOnly`가
   *  도메인을 받으므로 한 목록으로 합치면 어느 표를 지울지 알 수 없다. */
  clearableAudioIds: string[];
  /**
   * **서버엔 파일이 없는데 이 기기엔 있는** id들 — 다시 올리면 끝난다(M-0046).
   * 도메인별로 나눠 담는다: `requeueMissingBytes`가 어느 표의 행을 고칠지 알아야 한다.
   */
  recoverable: Record<'media' | 'audio', string[]>;
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
  const { c, cmp, stranded, blocked, leftoverFileIds, clearableIds, clearableAudioIds, recoverable } = i;
  /** 「먼저 눌러야 할 버튼」은 하나뿐이다 — 자료를 지키는 일이 남아 있으면 정리는 뒤로 미룬다. */
  const quiet = !blocked && !stranded && !recoverable.media.length && !recoverable.audio.length;
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
            // 사진·소리를 **한 버튼**이 치운다: 지우는 경로가 id 하나로 같기 때문이다
            // (함수가 R2 목록에서 그 id의 키를 찾아 지운다 — 확장자를 가리지 않는다).
            label: '남은 파일 정리',
            primary: quiet && !clearableIds.length && !clearableAudioIds.length,
            hook: 'data-clear-leftover-files',
            run: async (): Promise<string> => {
              // 건당 왕복 대신 **한 번에** 보내고, 함수가 지운 뒤 목록을 다시 읽어 확인한 결과를
              // 받는다(v0.98). 100장이면 100왕복이던 것이 1왕복이 되고, "성공 응답"이 아니라
              // **되읽기**가 완료의 근거다.
              const r = await r2DeleteMany(c, leftoverFileIds);
              if (r.error) return `치우지 못했어요: ${r.error}`;
              if (!r.verified) return `${r.sent}건 삭제를 요청했지만 다시 읽어 확인하지 못했어요.`;
              if (r.stillThere.length) return `${r.requested}건 중 ${r.stillThere.length}건이 아직 남아 있어요.`;
              return `파일 ${r.sent}건을 치웠어요. 다시 대조합니다.`;
            },
          },
        ]
      : []),
    ...(clearableIds.length
      ? [
          {
            label: '지운 사진 기록 정리',
            primary: quiet && !leftoverFileIds.length && !clearableAudioIds.length,
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
    // 소리도 **같은 규율을 같은 모양으로** 받는다(§7 사용자 대면 대칭 — 같은 성격의 일은
    // 같은 자리에 같은 어휘로). 다른 것은 지울 표 이름뿐이다.
    ...(clearableAudioIds.length
      ? [
          {
            label: '지운 소리 기록 정리',
            primary: quiet && !leftoverFileIds.length && !clearableIds.length,
            hook: 'data-clear-dead-audio',
            run: async (): Promise<string> => {
              const n = await purgeServerOnly('audio', clearableAudioIds);
              if (!n) return '큐에 이미 들어 있어요. [지금 동기화]를 눌러 주세요.';
              await requestSync('지운 소리 기록 정리');
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
  const { cmp, level, stranded, blocked, leftoverFileIds, clearableIds, recoverable } = i;
  const reup = recoverable.media.length + recoverable.audio.length;
  return [
    // 🔴 **자료를 지키는 일이 가장 먼저다**(2026-07-28, M-0046). 이 버튼이 없던 동안 화면은
    //    같은 상태를 보고 「치우세요」라고 말했다 — 로컬에 사본이 있는데도.
    ...(reup
      ? [
          {
            label: '서버에 없는 자료 다시 올리기',
            primary: true,
            hook: 'data-reupload-missing',
            run: async (): Promise<string> => {
              // 자료를 건드리지 않는다 — 이 기기가 기억하는 **착지 키만** 잊게 해서
              // 다음 동기화가 바이트를 다시 올리게 만든다.
              let n = 0;
              for (const dm of ['media', 'audio'] as const) n += await requeueMissingBytes(dm, recoverable[dm]);
              if (!n) return '다시 올릴 사본을 이 기기에서 찾지 못했어요.';
              await requestSync('서버에 없는 자료 다시 올리기', { deep: true });
              const st = syncStatus();
              return st.phase === 'failed'
                ? `${n}건을 큐에 넣었지만 동기화가 실패했어요: ${st.lastError ?? '사유 불명'}`
                : `${n}건을 다시 올렸어요. 다시 대조합니다.`;
            },
          },
        ]
      : []),
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
        // 의심해서 누른 버튼이다 — 바이트까지 대조한다(§12).
        await requestSync('저장 상태 확인', { deep: true });
        const s = syncStatus();
        return s.phase === 'failed' ? `동기화 실패: ${s.lastError ?? '사유 불명'}` : '동기화했어요. 다시 대조합니다.';
      },
    },
    renameDeviceAction(),
  ];
}

/**
 * 「사진 파일 N개 · 기록 M개 — 짝이 안 맞는 것은?」 근거 표.
 *
 * 제목이 **표의 내용을 예고해야** 한다(2026-07-27 사용자 지적). 예전엔 제목이 *"9개 · 9개"*인데
 * 펼치면 **「없음」**이었다 — 제목은 *가진 것*을 세고 표는 *어긋난 것*을 담는데 그 한정을
 * 아무도 말하지 않았다. 형제인 「서버에 남는 표식 N건 — 왜 남나요?」는 제목에 질문을 달아
 * 내용을 예고한다. 같은 어휘로 맞춘다(§7 사용자 대면 대칭).
 *
 * 총 바이트를 여기서 말하는 이유: 2026-07-26에 사용자가 대시보드의 「버킷 크기 2.87MB」와
 * 앱의 「사진 파일 0개」를 대조하지 못해 콘솔을 반복해서 열었다.
 */
function fileAuditEvidence(
  noun: string,
  fa: MediaFileAudit,
  /** 총 바이트를 표시할지 — 사진·소리가 **한 버킷**을 쓰므로 합계는 한 줄에서만 말한다(두 번 세지 않게). */
  totalBytes: number | null,
): { label: string; build: () => HTMLElement } {
  return {
    label:
      `${noun} 파일 ${fa.files}개${totalBytes === null ? '' : `(${bytes(totalBytes)})`} · 기록 ${fa.rows}개` +
      `${fa.truncated ? ' (다 못 봄)' : ''} — 짝이 안 맞는 것은?`,
    build: () => {
      const rows: [string, string][] = [];
      // 목록에 상한을 둔다 — 여행 사진 앱이라 수백 장이 정상이고, 상한이 없으면 수리 버튼이
      // 목록 뒤로 밀려 진단 도구가 스스로 수리 경로를 막는다(진단 §5.2).
      const show = (ids: string[], what: string): void => {
        for (const id of ids.slice(0, FILE_ID_CAP)) rows.push([id.slice(0, 8), what]);
        // 조용히 자르지 않는다 — 자른 것은 잘랐다고 적는다(진단 §5.3).
        if (ids.length > FILE_ID_CAP) rows.push(['…', `${what} 외 ${ids.length - FILE_ID_CAP}건 생략`]);
      };
      show(fa.orphans, '기록 없는 파일');
      show(fa.missing, '파일 없는 기록');
      if (fa.foreign) rows.push(['(형식 밖)', `${fa.foreign}개 — 이 앱이 만들지 않은 이름의 파일이에요`]);
      if (fa.truncated) rows.push(['⚠', '파일이 많아 목록을 다 보지 못했어요 — 위 개수는 확인한 범위까지입니다']);
      // 「없음」 한 단어로 두지 않는다 — **무엇이 없는지**를 말한다.
      return table(rows, `짝이 안 맞는 것이 없어요 — 파일 ${fa.files}개와 기록 ${fa.rows}개가 모두 1:1로 맞습니다`);
    },
  };
}

/**
 * **파일 대조 지표를 만드는 한 곳.** 사진·소리가 같은 규율을 지나게 한다(§7 2층).
 *
 * 왜 함수로 뽑았나(2026-07-27): 소리가 서버로 가면서 대조 대상이 둘이 됐다. 이 80줄을 손으로
 * 한 번 더 쓰면 그 순간 드리프트가 시작된다 — 이 저장소가 이미 세 번 겪은 모양이다(§7 머리말).
 * 지금은 `noun`만 다르고 판정·분류·문장 구조는 **구조적으로 같을 수밖에 없다.**
 *
 * 사용자에게 나가는 문장을 만드는 자리이므로 **순수 함수**로 둔다(§10 ③ — M-0022가 정확히
 * 여기서 났다: 자료구조는 옳았고 화면 문장만 틀렸는데 유닛 15건이 전부 통과했다).
 */
export function fileAuditMetrics(i: {
  /** 사용자에게 보일 종류 이름(「사진」·「소리」). 라벨·설명 문장이 전부 이걸 쓴다. */
  noun: string;
  fa: MediaFileAudit | null;
  note: string | null;
  serverPurged: string[];
  serverTombstoned: string[];
  restorePending: ReadonlySet<string>;
  /** 이 기기가 바이트를 들고 있는 id들 — **「없다」고 말하기 전에 묻는 것**(M-0046). */
  localBytes: ReadonlySet<string>;
  /** **이 기기를 뺀** 기기 수 — 「이 기기에 없다」를 「없다」로 반올림하지 않으려고(M-0048). */
  otherDevices: number;
}): {
  /** 이 감사가 다룬 종류 이름. **지표와 함께 다닌다** — 갈라지면 M-0048이 재발한다. */
  noun: string;
  metrics: Metric[];
  leftover: string[];
  clearable: string[];
  recoverable: string[];
  restoring: number;
} {
  const { noun, fa } = i;
  if (!fa) {
    // 못 본 것을 정상으로 반올림하지 않는다(비타협 원칙 #4).
    return {
      noun,
      metrics: [
        {
          label: `${noun} 파일 대조`,
          actual: '확인 못 함',
          expected: '기록과 파일이 1:1',
          level: 'unknown',
          // 서버 목록을 못 받은 것뿐 — 다시 확인하면 풀린다(**일시적**).
          unknownKind: 'transient',
          meaning: i.note ?? `서버 ${noun} 목록을 물어보지 못했어요`,
        },
      ],
      leftover: [],
      clearable: [],
      recoverable: [],
      restoring: 0,
    };
  }

  // 「기록 없는 파일」을 **두 갈래로 쪼갠다**(2026-07-26 사용자 실기기 — 서버 행이 전부 0인데
  // R2에 파일 3개가 남았다). 영구삭제 시 바이트 삭제는 **최선노력**이라 실패해도 op을 지운다
  // → 재시도 기회가 없다. 그래서 잔재가 생긴다. 성격이 정반대인 둘이 한 숫자에 섞여 있었다:
  //  · 원장에 있는 id → 영구삭제한 것의 잔재. **자료는 이미 없다.** 치우면 된다(todo).
  //  · 원장에 없는 id → **설명할 수 없는 파일.** 올리다 기록이 안 만들어졌다면 이 파일이
  //    그 기억의 **마지막 사본**이다. 지우면 기억을 잃는다(problem).
  const { leftover, restoring, unexplained } = classifyOrphanFiles(fa.orphans, i.serverPurged, i.restorePending);

  // 「파일이 없는 기록」은 **세 갈래**다. 가르는 질문은 하나 — *이 기기에 사본이 있는가*(M-0046).
  // 목록이 잘렸으면 아무것도 단정하지 않는다(뒤쪽 페이지에 있을 수 있다).
  const miss = fa.truncated
    ? { recoverable: [], clearable: [], atRisk: [] }
    : classifyMissingFiles(fa.missing, i.serverTombstoned, i.localBytes, i.otherDevices);
  const { recoverable, clearable, atRisk } = miss;

  const metrics: Metric[] = [
    {
      label: `영구삭제 후 남은 ${noun} 파일`,
      actual: `${leftover.length}개`,
      expected: '0개',
      // '문제'가 아니라 '할 일'이다 — 자료는 이미 없고 바이트만 남았다. 겁줄 일이 아니다(§5.10).
      level: leftover.length ? 'todo' : 'ok',
      ...(leftover.length
        ? { meaning: `영구삭제할 때 파일 지우기가 실패해 바이트만 남았어요. 기억은 이미 지워졌고 용량만 차지합니다 — 아래 [남은 파일 정리]로 치울 수 있어요.` }
        : {}),
    },
    {
      label: `설명할 수 없는 ${noun} 파일`,
      actual: `${unexplained.length}개`,
      expected: '0개',
      level: unexplained.length ? 'problem' : 'ok',
      ...(unexplained.length
        ? { meaning: `기록도 없고 영구삭제한 적도 없는 파일이에요. 올리다 기록이 안 만들어졌다면 **이 파일이 그 ${noun}의 마지막 사본**일 수 있습니다 — 앱이 자동으로 지우지 않습니다.` }
        : {}),
    },
    {
      // 🔴 사본이 있으면 이건 **손실이 아니라 심부름**이다. 겁주지 않고 할 일로 말한다.
      label: `서버에 없는 ${noun}`,
      actual: fa.truncated ? '확인 못 함' : `${recoverable.length}개`,
      expected: '0개',
      // 목록이 잘린 것은 다시 받으면 풀린다(**일시적**).
      ...levelOr(fa.truncated, 'transient', recoverable.length ? 'todo' : 'ok'),
      ...(fa.truncated || !recoverable.length
        ? {}
        : {
            meaning: `서버에 파일이 없지만 **이 기기에는 그대로 있어요.** 자료는 안전합니다 — 아래 [서버에 없는 자료 다시 올리기]를 누르면 올라가고, 그러면 다른 기기에서도 보입니다.`,
          }),
    },
    {
      label: `${noun} 파일이 사라진 기록`,
      actual: fa.truncated ? '확인 못 함' : `${atRisk.length}개`,
      expected: '0개',
      // 목록이 잘렸으면 "없다"고 말할 수 없다 — 뒤쪽 페이지에 있을 수 있다.
      ...levelOr(fa.truncated, 'transient', atRisk.length ? 'problem' : 'ok'),
      ...(fa.truncated
        ? { meaning: `파일이 너무 많아 목록을 다 보지 못했어요(${fa.files}개까지 확인). 이 판정은 보류합니다.` }
        : atRisk.length
          ? {
              meaning: i.otherDevices
                ? `서버에도 **이 기기에도** 파일이 없어요. 그런데 이 계정에는 기기가 ${i.otherDevices + 1}대 있습니다 — **다른 기기에 사본이 남아 있을 수 있어요.** 여기서 지우면 그 사본까지 되살릴 수 없게 됩니다(서버가 재등록을 거부합니다). 먼저 다른 기기에서 「앱 상태 확인」을 열어 [서버에 없는 자료 다시 올리기]가 보이는지 확인해 주세요.`
                : `살아 있는 ${noun}인데 서버에도 이 기기에도 파일이 없어요. **지우지 마세요** — 백업 파일에서 복원해야 합니다.`,
            }
          : {}),
    },
    {
      label: `지운 ${noun}의 남은 기록`,
      actual: fa.truncated ? '확인 못 함' : `${clearable.length}개`,
      expected: '0개',
      // '문제'가 아니라 '할 일'이다 — 자료는 이미 없고 기록 줄만 남았다.
      ...levelOr(fa.truncated, 'transient', clearable.length ? 'todo' : 'ok'),
      ...(clearable.length
        ? { meaning: `이미 지운 ${noun}의 기록 줄만 서버에 남아 있어요. **사본이 어디에도 없습니다**(이 기기를 찾아봤고, 다른 기기도 없습니다) — 아래 [지운 ${noun} 기록 정리]로 치울 수 있어요.` }
        : {}),
    },
  ];
  return { noun, metrics, leftover, clearable, recoverable, restoring: restoring.length };
}

/**
 * 파일 대조에서 어긋난 지표를 **종류별로** 센다 — 판정 문장이 이름을 부를 수 있게.
 *
 * 🔴 왜 순수 함수인가(M-0048): 예전엔 `metrics.slice(...)`로 **한 숫자에 합쳐** 놓고 문장은
 * 「사진 파일에…」로 못 박혀 있었다. 소리를 형제로 들이자 숫자는 소리까지 셌는데 이름은
 * 안 따라왔다 — 사진이 9:9로 멀쩡한 화면에서 「사진 파일 문제」라고 말했다.
 * 각 감사가 **자기 이름을 들고 오게** 하면 다음 형제(영상 등)가 자동으로 따라온다(§7 2층).
 */
export function fileBadByNoun(
  audits: ReadonlyArray<{ noun: string; metrics: Metric[] }>,
): Array<{ noun: string; n: number }> {
  return audits.map((a) => ({ noun: a.noun, n: a.metrics.filter((m) => m.level !== 'ok').length }));
}

/**
 * **개수 대조 지표** — 도메인별 활성 수와 휴지통 수를 서버와 나란히 놓는다. 순수 함수.
 *
 * (파일 대조와 함께 `storeStateProbe` 안에 있었는데 `check-fn-size` 래칫에 걸려 뽑아냈다.
 *  경계가 맞아떨어졌다 — 여기는 **몇 개인가**를 묻고, `fileAuditMetrics`는 **짝이 맞는가**를
 *  묻는다. 다른 관심사다. 게이트가 설계를 밀어준 자리다, §11.)
 */
export function countComparisonMetrics(cmp: StoreComparison): Metric[] {
  const out: Metric[] = PURGE_DOMAINS.map((d) => {
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
  const behind = cmp.trashed.local > cmp.trashed.cloud;
  out.push({
    label: '휴지통 항목',
    actual: `클라우드 ${cmp.trashed.cloud} · 이 기기 ${cmp.trashed.local}`,
    expected: '이 기기가 클라우드보다 많지 않음',
    level: behind ? ('todo' as const) : ('ok' as const),
    ...(behind
      ? { meaning: `이 기기에서 지운 것 중 ${cmp.trashed.local - cmp.trashed.cloud}건이 아직 클라우드에 안 올라갔어요. 동기화하면 올라갑니다.` }
      : {}),
  });
  return out;
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

  const countMetrics = countComparisonMetrics(cmp);

  // 개수 대조와 파일 대조를 **한 배열에 담되 경계를 기억한다** — 판정 문장이 둘을 구분해야 한다.
  const metrics: Metric[] = [...countMetrics];

  // ── 파일 대조(사진·소리) ────────────────────────────────────────
  // 두 방향을 **한 숫자로 합치지 않는다.** 사용자가 할 일이 정반대이기 때문이다
  // (진단 §4의 "대기 중인 작업 3건"이 정확히 그 실수였다).
  //
  // 🔴 종류도 합치지 않는다(2026-07-27). 사진과 소리는 **같은 폴더**에 살지만 대조 상대가
  //    다르다 — 섞으면 멀쩡한 소리가 전부 「기록 없는 사진 파일」이 되고 화면은 그걸 치우라고
  //    권한다. 대신 **판정 규칙은 한 곳**(`fileAuditMetrics`)에 두어, 소리가 사진의 규율을
  //    자동으로 물려받게 한다(§7 2층 — 다음 형제가 자동으로 따라오는가).
  // **이 기기를 뺀** 기기 수(M-0048). 화면은 이미 「내 기기들 N대」로 띄우면서 판정만 그
  // 사실을 몰랐다 — 앱이 아는 것을 판정에 안 쓴 §12의 형태다.
  const otherDevices = Math.max(0, cmp.devices.length - 1);
  const audit = fileAuditMetrics({
    noun: '사진',
    fa: cmp.fileAudit,
    note: cmp.fileAuditNote,
    serverPurged: cmp.serverPurged,
    serverTombstoned: cmp.serverTombstoned,
    restorePending,
    localBytes: cmp.localBytes.media,
    otherDevices,
  });
  const audioAudit = fileAuditMetrics({
    noun: '소리',
    fa: cmp.audioAudit,
    note: cmp.audioAuditNote,
    serverPurged: cmp.serverPurged,
    serverTombstoned: cmp.serverTombstoned,
    restorePending,
    localBytes: cmp.localBytes.audio,
    otherDevices,
  });
  metrics.push(...audit.metrics, ...audioAudit.metrics);
  // 치우기는 **id로** 하고 그 경로는 종류를 가리지 않는다(R2 목록에서 키를 찾아 지운다).
  // 그래서 잔재 목록은 합친다 — 버튼이 둘일 이유가 없다.
  const leftoverFileIds = [...audit.leftover, ...audioAudit.leftover];
  const clearableIds = audit.clearable;
  const clearableAudioIds = audioAudit.clearable;
  // 다시 올릴 것은 **종류를 합친다** — 고치는 방법이 같다(로컬이 기억하는 키를 잊고 재큐잉).
  const recoverable = { media: audit.recoverable, audio: audioAudit.recoverable };
  const restoringFiles = audit.restoring + audioAudit.restoring;

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
    ...levelOr(!cmp.outside.known, 'transient', cmp.outside.count ? 'todo' : 'ok'),
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
    ...levelOr(!cmp.multipart.known, 'transient', cmp.multipart.mine ? 'todo' : 'ok'),
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

  const stranded = cmp.unpropagatedPurges.length;
  metrics.push(strandedMetric(stranded));

  const blocked = cmp.blockedByLedger.length;
  metrics.push(blockedByLedgerMetric(blocked, restoringFiles));

  const level = levelFromMetrics(metrics);
  const behind = cmp.devices.filter((d) => !d.isThis && cmp.lastCloudWriteAt && d.lastPushAt < cmp.lastCloudWriteAt);

  const countBad = countMetrics.filter((m) => m.level !== 'ok').length;
  const fileBad = fileBadByNoun([audit, audioAudit]);
  // 살아 있는 기록이 하나도 없을 때 「클라우드와 같습니다」만 말하면 사용자는 **자기 자료가
  // 어디 갔는지 모른 채** 화면을 떠난다. 그래서 판정 문장에 대조한 대상(활성)과 자료의
  // 현재 위치(휴지통)를 함께 넘긴다.
  const alive = PURGE_DOMAINS.reduce((n, d) => n + cmp.counts[d].local, 0);
  const headline = storeHeadline({ level, countBad, fileBad, stranded, blocked, alive, trashed: cmp.trashed.cloud });

  return {
    level,
    headline,
    // 판정 문장이 사진 파일을 가리키면 **그 밑도 사진 얘기여야 한다**(M-0021). 그리고 둘은
    // **같은 규칙**을 지나야 한다 — 예전엔 여기 삼항이 박혀 있었고 `fileBad`(배열)를 불리언으로
    // 써서, 짝이 맞아도 「맞지 않아요」라고 말했다(2026-08-01 사용자 화면).
    because: storeBecause({ countBad, fileBad, stranded, blocked, devices: cmp.devices.length, behind: behind.length }),
    metrics,
    actions: storeActions({ c, cmp, level, stranded, blocked, leftoverFileIds, clearableIds, clearableAudioIds, recoverable }),
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
          ], '서버에 남은 표식이 없어요'),
      },
      ...(cmp.fileAudit ? [fileAuditEvidence('사진', cmp.fileAudit, cmp.bytes)] : []),
      // 소리는 **바이트 합계를 다시 말하지 않는다** — 사진과 한 버킷을 쓰므로 `cmp.bytes`가
      // 이미 둘을 합친 값이다. 여기서 또 붙이면 사용자가 두 배로 읽는다(§8 — 지표엔 기준이 필요하다).
      ...(cmp.audioAudit ? [fileAuditEvidence('소리', cmp.audioAudit, null)] : []),
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
          ], '아직 서버로 올린 기기가 없어요'),
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
/**
 * 총괄 배너 한 문장 — **순수 함수**. 라이브가 못 가르는 갈래를 유닛이 전수로 잰다(§10 ③).
 *
 * 왜 뽑았나: 「구조적 확인 불가는 총괄을 끌어내리지 않는다」를 실제 앱에서 재려면 *다른 이상이
 * 하나도 없는* 상태를 만들어야 하는데, 라이브 픽스처엔 늘 무언가 하나가 켜져 있다. 그 상태에선
 * 검사가 **가려져서 통과**한다 — 초록이 「없다」가 아니라 **「못 갈랐다」**인 자리다(§4).
 */
/**
 * 🔴 배너가 쓸 총괄 등급 — **구조적 확인 불가를 뺀 것**(사용자 지적 2026-08-06).
 *
 * 순수 함수인 이유는 §4다: 라이브에서 이 갈래를 재려면 *다른 이상이 하나도 없는* 상태가
 * 필요한데 실제 앱에는 늘 무언가가 켜져 있어, 라이브만 두면 **가려져서 통과**한다.
 */
export function bannerLevelOf(per: { level: Level; unknownKind: UnknownKind }[]): Level {
  const counted = per.filter((p) => !(p.level === 'unknown' && p.unknownKind === 'structural'));
  // 전부 구조적이라 셀 것이 없으면 「이상 없음」이다 — 잴 수 없는 것은 이상이 아니다.
  // (경계는 배너 문장이 개수로 따로 말한다.)
  return counted.length ? worst(counted.map((p) => p.level)) : 'ok';
}

export function rollupBanner(i: {
  bannerLevel: Level;
  badLabels: string[];
  todoLabels: string[];
  structuralCount: number;
}): string {
  const head =
    i.bannerLevel === 'problem'
      ? `지금 확인할 것 ${i.badLabels.length}가지 — ${i.badLabels.join(' · ')}`
      : i.bannerLevel === 'todo'
        ? `해두면 좋은 일 ${i.todoLabels.length}가지 — ${i.todoLabels.join(' · ')}`
        : i.bannerLevel === 'unknown'
          ? '확인하지 못한 항목이 있어요'
          : '이상 없음 · 방금 확인했어요';
  // 🔴 숨기지 않는다 — 분류만 바꾸고 **경계는 개수로 말한다**(§8 · §7-C 시야의 경계).
  return i.structuralCount ? `${head} · 이 기기에서 잴 수 없는 항목 ${i.structuralCount}개` : head;
}

export async function rollup(): Promise<{
  level: Level;
  /** 🔴 구조적 확인 불가를 뺀 총괄 — 화면 배너가 쓰는 값이다(아래 주석 참조). */
  bannerLevel: Level;
  /** 구조적 확인 불가로 빠진 도구 수. 0이 아니면 배너가 그 사실을 함께 말한다(§8 경계 밝히기). */
  structuralCount: number;
  per: { id: string; label: string; level: Level; unknownKind: UnknownKind; headline: string; metrics: Metric[] }[];
}> {
  const per = await Promise.all(
    CORE_TOOLS.map(async (t) => {
      try {
        const v = await t.probe();
        // 지표까지 들고 온다 — 요약 복사가 이걸 그대로 쓴다. 도구를 새로 만들면 **자동으로**
        // 요약에 들어간다(§7 2층: 다음 형제가 손대지 않아도 따라오게).
        const kind: UnknownKind = unknownIsStructural(v.metrics) ? 'structural' : 'transient';
        return { id: t.id, label: t.label, level: v.level, unknownKind: kind, headline: v.headline, metrics: v.metrics };
      } catch {
        // 판정을 못 했으면 '정상'이 아니라 '확인 불가'다 — 미검사를 통과로 적지 않는다(원칙 #4).
        // 🔴 그리고 이건 **일시적**이다: 예외는 다시 열면 안 날 수 있다. 구조적으로 밀면
        // 진짜 고장이 총괄에서 조용히 사라진다.
        return {
          id: t.id, label: t.label, level: 'unknown' as Level, unknownKind: 'transient' as UnknownKind,
          headline: '확인하지 못했어요', metrics: [],
        };
      }
    }),
  );
  // 🔴 **구조적 확인 불가는 총괄을 끌어내리지 않는다**(사용자 지적 2026-08-06:
  // *"구조적으로 확인불가이면 확인불가로 판정은 하되 비정상으로 분류하면 안 될 거 같아요"*).
  // 카드에는 여전히 `?`가 붙는다 — 판정을 숨기는 게 아니라 **분류만** 바꾼다.
  // 반대로 일시적 확인 불가는 그대로 반영한다: 사용자가 눌러서 풀 수 있는 상태이기 때문이다(§8).
  const structural = per.filter((p) => p.level === 'unknown' && p.unknownKind === 'structural');
  return {
    level: worst(per.map((p) => p.level)),
    bannerLevel: bannerLevelOf(per),
    structuralCount: structural.length,
    per,
  };
}

/**
 * 진단 요약 텍스트. 🔴 **한 곳에서만 만든다** — 허브 상단의 [결과 복사]와 「진단 요약 복사」 도구가
 * 같은 것을 쓴다. 두 벌로 만들면 두 화면이 다른 것을 복사하기 시작한다(§7 2층).
 */
/**
 * 요약을 클립보드로. **결과 문장을 돌려준다** — 부르는 쪽이 그대로 화면에 띄운다(§13 4항:
 * 누르면 결과가 화면에 나와야 한다). 실패도 조용히 삼키지 않고 다음 행동을 말한다(§7-D).
 */
export async function copyDiagSummary(): Promise<string> {
  const text = await summaryText();
  if (!navigator.clipboard?.writeText) return '이 브라우저는 자동 복사가 막혀 있어요. [진단 요약 복사] 도구의 [원문 보기]를 열어 길게 눌러 복사해 주세요.';
  try {
    await navigator.clipboard.writeText(text);
    return '복사했어요. 대화창에 붙여넣으시면 됩니다.';
  } catch {
    return '복사가 막혔어요. [진단 요약 복사] 도구의 [원문 보기]를 열어 길게 눌러 복사해 주세요.';
  }
}

export async function summaryText(): Promise<string> {
  const [env, sync, roll] = await Promise.all([collectEnv(APP_VERSION), diagnoseSync(), rollup()]);
  const integ = checkIntegrity(await loadIntegritySnapshot());
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
    // 🔴 사유를 요약에 넣는다(M-0107). 사용자가 붙여 넣는 건 이 글이고, 옛 요약은 「13건 막힘」
    // 까지만 말해 **왜인지 알려면 실서버를 조회해야 했다**(§12).
    ...sync.stuckReasons.map((r) => `  사유 x${r.count}: ${r.reason}`),
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
  // 요약은 각 도구의 판정을 그대로 옮긴다. 종류도 **원래 도구가 정한 것**을 물려받는다 —
  // 여기서 다시 고르면 같은 판정이 두 화면에서 달라진다(§7 사용자 대면 대칭).
  const metrics: Metric[] = roll.per.map((p) => {
    const src: MetricSource = { actual: p.headline, expected: '정상', level: p.level };
    return metricFromView(p.label, src, p.unknownKind);
  });
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
        run: copyDiagSummary,
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
// ⑦ 백업 신선도 — 클라우드와 독립된, 이 손에 있는 사본이 있는가
// ────────────────────────────────────────────────────────────────────────────
//
// 왜(사용자 제안 2026-08-05): "백업 진단도구가 없다면 추가하면 좋을 거 같아요." 실측해 보니
// `backupMeta.ts`(마지막 백업 시각·신선도 판정)는 이미 있었지만 [데이터 관리 › 백업] 패널
// 안에서만 조용히 쓰였다 — **판정 도구**로 진단 허브에 없었다. §8("진단 도구는 판정을 한다")
// 대상에서 이 조각만 빠져 있었다.
//
// 클라우드 동기화는 백업의 대체물이 아니다 — 계정 잠김·서버 사고·사용자 실수(영구삭제)에도
// 살아남는 것은 **이 기기 밖으로 나간 파일**뿐이다. 그래서 로컬 전용 모드(`!isConfigured()`)
// 에서 오래됐거나 없으면 '문제'(다른 사본이 전혀 없음), 클라우드 모드에서는 '할 일'(클라우드가
// 있지만 독립 사본도 있으면 더 안전함)로 급을 가른다 — §7: 같은 "없음"도 사정에 따라 다르다.
export function backupProbe(): Promise<Verdict> {
  const last = getLastBackupAt();
  const fresh = backupFreshness(last);
  const cloud = isConfigured();
  const noOtherCopy = !cloud && fresh.stale; // 클라우드도 없고 백업도 없거나 낡음 = 사본이 전혀 없다
  const metrics: Metric[] = [
    {
      label: '마지막 백업',
      actual: fresh.text,
      expected: `${STALE_DAYS}일 이내`,
      level: fresh.stale ? (noOtherCopy ? 'problem' : 'todo') : 'ok',
      ...(fresh.stale
        ? {
            meaning: noOtherCopy
              ? '클라우드 동기화도 꺼져 있고 백업 파일도 없어요 — 이 기기가 사라지면 기록도 함께 사라집니다. 아래 [지금 백업 만들기]를 눌러 주세요.'
              : '클라우드 동기화는 되고 있지만, 계정 문제나 실수(영구삭제)에서도 살아남는 건 이 기기 밖으로 받아 둔 파일뿐이에요. 가끔 받아 두세요.',
          }
        : {}),
    },
  ];
  const level = levelFromMetrics(metrics);
  const v: Verdict = {
    level,
    headline:
      level === 'problem'
        ? '백업 파일이 없어요 — 이 기기가 유일한 사본입니다'
        : level === 'todo'
          ? '백업을 받아 두면 더 안전해요'
          : '최근 백업 파일이 있습니다',
    because: cloud ? '클라우드 동기화와 별개로, 이 기기 밖으로 받아 둔 파일만이 계정·서버 사고에서도 살아남습니다.' : '이 배포는 클라우드 동기화가 꺼져 있어요 — 백업 파일이 유일한 사본입니다.',
    metrics,
    actions: [
      {
        label: '지금 백업 만들기',
        primary: fresh.stale,
        hook: 'data-backup-now',
        run: async () => {
          const { blob, stats } = await exportBackup(true);
          const now = new Date();
          const p = (n: number) => String(n).padStart(2, '0');
          const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}`;
          downloadBlob(blob, `bugeon-journey_${stamp}.json`);
          recordBackupNow();
          return `내려받았어요 · 여행 ${stats.trips} · 순간 ${stats.moments} · 사진 ${stats.media} · 비용 ${stats.expenses} · 소리 ${stats.audio}`;
        },
      },
    ],
    evidence: [],
    context: [{ label: '이 기기의 자료 사본 경로', value: cloud ? '클라우드 동기화 + 백업 파일(선택)' : '백업 파일뿐(로컬 전용 배포)' }],
  };
  return Promise.resolve(v);
}

// ────────────────────────────────────────────────────────────────────────────
// ⑧ 저장·삭제·휴지통 — 지운 것을 되살릴 수 있는가, 모든 기기가 같은 휴지통을 보는가
// ────────────────────────────────────────────────────────────────────────────
//
// 사용자 요청(2026-08-05): *"저장/삭제/휴지통 진단도구 등이 없다면 추가하면 좋을 거 같아요."*
// 기존 도구가 덮는 부분을 **실측해서 빼고** 남은 빈칸만 잰다(겹치는 지표는 만들지 않는다):
//   · 「동기화 상태」가 이미 재는 것 = 삭제가 서버까지 **갔는가**. 이 도구는 **간 뒤**를 본다.
//   · 「저장 상태」가 이미 재는 것 = 개수 대조. 이 도구는 개수를 대조하지 **않는다**(아래 참조).
//   · 「ID 무결성」이 못 보는 것 = 🔴 그 검사는 **살아 있는 행만** 본다. 휴지통 항목은 지금까지
//     어느 도구의 시야에도 없었다 — 이 도구가 그 자리다.
//
// 판정과 문장은 전부 `domain/trashVerdict.ts`(순수 함수)가 만든다. 여기서는 Metric으로 옮기고
// 접힌 출처만 붙인다 — 화면에 나가는 문장 자체가 결함일 수 있어서다(§10 ③).
export async function trashProbe(): Promise<Verdict> {
  const o = await collectTrashState();
  const views = trashMetrics(o);
  const labels = ['휴지통 목록의 기준', '되살려도 자료가 비는 항목', '되살릴 곳이 없는 항목'];
  // 이 도메인의 `확인 불가`는 전부 **일시적**이다 — 서버 조회·로그인·목록 확보가 되면 풀린다.
  const metrics: Metric[] = views.map((v, i) => metricFromView(labels[i] ?? '', v, 'transient'));

  const cap = (rows: { label: string }[]): [string, string][] => {
    const shown: [string, string][] = rows.slice(0, TRASH_ITEM_CAP).map((r) => [r.label, '']);
    const omitted = rows.length - shown.length;
    // 조용히 자르지 않는다 — 자른 사실을 **적는다**(§5 3항).
    if (omitted > 0) shown.push([`외 ${omitted}건 생략`, '']);
    return shown;
  };

  const evidence: Verdict['evidence'] = [];
  if (o.emptyOnRestore.length) {
    evidence.push({
      label: `되살려도 자료가 비는 항목 ${o.emptyOnRestore.length}건`,
      build: () => table(cap(o.emptyOnRestore), '해당 항목이 없어요'),
    });
  }
  if (o.orphans.length) {
    evidence.push({
      label: `되살릴 곳이 없는 항목 ${o.orphans.length}건`,
      build: () => table(cap(o.orphans), '해당 항목이 없어요'),
    });
  }

  return {
    level: levelFromMetrics(metrics),
    headline: trashHeadline(o),
    // 🔴 「휴지통이 비었다」와 「이 기기 기준으로 비어 보인다」는 다른 말이다(§7-C 한정 생략).
    //    그리고 클라우드가 없는 배포에는 「다른 기기」 자체가 없다 — 셋을 구분해 말한다.
    because: !o.cloudConfigured
      ? `이 배포는 클라우드를 쓰지 않아 이 기기의 기록 ${o.localTrashCount}건이 전부입니다.`
      : o.serverTrashCount === null
        ? `이 기기에 남은 휴지통 기록 ${o.localTrashCount}건을 기준으로 본 결과예요 — 다른 기기가 지운 것은 여기 안 보일 수 있습니다.`
        : '온라인이면 휴지통은 서버가 정본이라 어느 기기에서 열어도 같은 목록입니다(ADR-0049).',
    metrics,
    // 🔴 파괴적 행동(영구삭제·정리)을 여기 두지 않는다. 이 도구는 **관측과 판정**만 하고,
    // 지우는 일은 [데이터 관리 › 휴지통]에서 2단계 확인을 거쳐야 한다(§0 · §13 4항).
    actions: [],
    evidence,
    context: [{ label: '이 기기의 휴지통 기록', value: `${o.localTrashCount}건` }],
  };
}

// ────────────────────────────────────────────────────────────────────────────
// ⑨ 왕복 시험 — 저장한 것이 서버까지 갔다가 지운 흔적까지 남기고 사라지는가 (쓰기 시험)
// ────────────────────────────────────────────────────────────────────────────
//
// 사용자 결정(2026-08-05): 진단 범위를 *"쓰기 시험까지"*로 확장. 읽기 전용 관측은 **지금
// 상태**만 말한다 — 「저장이 실제로 도착하는가」는 한 번 보내 봐야 안다. 이 저장소의 결함
// 셋(M-0100·M-0101·M-0015)이 전부 *"코드는 맞는데 실제로는 안 갔다"*였고, 그때마다 사용자의
// 실기기가 유일한 검출기였다.
//
// 🔴 `probe()`는 **읽기 전용**이다 — 지난 결과만 보여준다. 실제 왕복은 사용자가 버튼을 눌러야
//    돈다. 진단 도구가 열릴 때마다 서버에 쓰면 그건 관측이 아니라 부작용이다(§8).
export function roundTripProbe(): Promise<Verdict> {
  const run = lastRoundTrip();
  const v = roundTripView(run);
  const metrics: Metric[] = [
    // 아직 안 돌렸거나 결과를 못 읽은 상태 — 버튼을 누르면 풀린다(**일시적**).
    metricFromView('왕복 시험', v, 'transient'),
  ];
  const evidence: Verdict['evidence'] = [];
  if (run) {
    evidence.push({
      label: `단계별 결과 ${run.steps.length}단계`,
      build: () =>
        table(
          run.steps.map((s): [string, string] => {
            const mark = s.state === 'pass' ? '통과' : s.state === 'fail' ? '실패' : '안 쟀음';
            const time = s.ms === null ? '' : ` · ${s.ms}ms`;
            // 🔴 통과한 단계도 **본 것이 있으면 말한다**(§12). 실패 사유만 보여주면
            // 「서버가 시각을 바꿨는가」처럼 *결함은 아니지만 알아야 하는 사실*이 갈 곳이 없다.
            const why = s.error ? ` — ${s.error}` : s.note ? ` — ${s.note}` : '';
            return [`${STEP_LABEL[s.step]}`, `${mark}${time}${why}`];
          }),
          '단계 기록이 없어요',
        ),
    });
    evidence.push({
      label: '각 단계가 무엇을 증명하나',
      build: () =>
        table(
          ROUND_TRIP_STEPS.map((s): [string, string] => [STEP_LABEL[s], STEP_PROVES[s]]),
          // 단계 목록은 상수라 비는 일이 없다. 그래도 문구를 적는다 — 비었다면 그건
          // 「단계가 없다」가 아니라 **등록부가 깨진 것**이고, 그 사실이 화면에 나와야 한다.
          '단계 정의를 읽지 못했어요(등록부 이상)',
        ),
    });
  }

  const actions: Action[] = [
    {
      label: run ? '다시 시험' : '시험 실행',
      primary: true,
      hook: 'data-roundtrip-run',
      run: async () => {
        const r = await runRoundTrip();
        const view = roundTripView(r);
        return view.level === 'ok' ? `통과 — ${view.actual}` : `${view.headline} (${view.actual})`;
      },
    },
  ];
  // 잔재가 있을 때만 치우는 버튼을 준다 — 지울 것이 없는데 「정리」를 띄우면 사용자가
  // 자기 자료가 지워지는 줄 안다(§8 침묵이 정상 · M-0046의 교훈).
  if (run?.leftover) {
    actions.push({
      label: '남은 시험용 기록 치우기',
      hook: 'data-roundtrip-cleanup',
      run: async () => {
        const stuck = await cleanupRoundTripLeftovers();
        return stuck.length ? `${stuck.length}건을 아직 치우지 못했어요.` : '치웠어요.';
      },
    });
  }

  return Promise.resolve({
    level: v.level,
    headline: v.headline,
    because:
      '시험용 여행 하나를 만들었다가 스스로 지웁니다. 제목이 「' +
      ROUND_TRIP_TITLE_PREFIX +
      '」로 시작하며, 기존 기록은 읽지도 쓰지도 않아요.',
    metrics,
    actions,
    evidence,
    context: run ? [{ label: '마지막 시험', value: run.at.slice(0, 19).replace('T', ' ') }] : [],
  });
}

// ────────────────────────────────────────────────────────────────────────────
// ⑩ 서버 계약 — 서버가 앱이 가정한 대로 행동하는가 (읽기 전용 실측)
// ────────────────────────────────────────────────────────────────────────────
//
// 오늘 고친 결함 셋(M-0100·M-0101·M-0102)이 전부 *"서버가 내 가정과 다르게 행동한다"*였고,
// 그걸 좁히려고 **운영 DB에 직접 SQL을 질의**해야 했다(개발 컨테이너의 프록시가 막는다).
// 사용자의 앱은 진짜 서버에 붙어 있으므로 그 자리에서 재면 다음 고장이 훨씬 싸다.
export async function serverContractProbe(): Promise<Verdict> {
  const o = await collectServerContract();
  const views = serverContractMetrics(o);
  const labels = ['로그인 없는 접근', '한 번에 받는 행수', '페이지 경계'];
  // 이 도메인의 `확인 불가`는 전부 **일시적**이다 — 서버 조회·로그인·목록 확보가 되면 풀린다.
  const metrics: Metric[] = views.map((v, i) => metricFromView(labels[i] ?? '', v, 'transient'));
  return {
    level: levelFromMetrics(metrics),
    headline: serverContractHeadline(o),
    because:
      '전부 읽기 전용입니다 — 서버에 아무것도 쓰지 않아요. 쓰기 쪽 계약은 [왕복 시험]이 따로 봅니다.',
    actions: [],
    metrics,
    evidence: [],
    context: [
      { label: '앱이 쓰는 페이지 크기', value: `${o.assumedPageSize}행` },
      { label: '로그인 상태', value: o.signedIn ? '로그인됨' : '로그인 전' },
    ],
  };
}

// ────────────────────────────────────────────────────────────────────────────
// ⑪ 세션·로그인 — 로그인이 유지되고, 로그아웃하면 기록이 가려지는가
// ────────────────────────────────────────────────────────────────────────────
//
// 사각지대 3건을 한 번에 덮는다(BLIND_SPOTS의 device 그룹) — 셋 다 로그인 상태를 읽어야
// 답할 수 있어 따로 두면 사용자가 같은 것을 세 번 묻게 된다.
//
// 🔴 잠금은 **선언이 아니라 실행으로** 확인한다: `canViewLocalRecords`에 알려진 입력 4갈래를
//    먹여 기대한 답이 나오는지 그 자리에서 돌린다. 「그 함수가 있다」는 아무것도 보장하지 않고,
//    「옳은 답을 준다」가 질문이다(§4 — 대조군이 있는 검사).
export async function sessionProbe(): Promise<Verdict> {
  const o = await collectSessionState();
  const views = sessionMetrics(o);
  const labels = ['로그인 유지', '로그아웃하면 가려짐'];
  // 이 도메인의 `확인 불가`는 전부 **일시적**이다 — 서버 조회·로그인·목록 확보가 되면 풀린다.
  const metrics: Metric[] = views.map((v, i) => metricFromView(labels[i] ?? '', v, 'transient'));
  return {
    level: levelFromMetrics(metrics),
    headline: sessionHeadline(o),
    because:
      '가리는 것과 지우는 것은 다릅니다 — 로그아웃해도 이 기기의 기록은 그대로 남고, 다시 로그인하면 보입니다.',
    actions: [],
    metrics,
    evidence: [
      {
        label: `잠금 판정 갈래 ${AUTH_GATE_CASES.length}가지`,
        build: () =>
          table(
            AUTH_GATE_CASES.map((c): [string, string] => [
              `${c.cloudConfigured ? '클라우드 씀' : '클라우드 안 씀'} · ${c.signedIn ? '로그인됨' : '로그아웃'}`,
              `${c.expected ? '보임' : '가려짐'} — ${c.why}`,
            ]),
            '갈래 정의를 읽지 못했어요(등록부 이상)',
          ),
      },
    ],
    context: [{ label: '바라는 유지 기간', value: `${WANTED_SESSION_DAYS}일` }],
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 🖼️ 파일 실물 — 기록이 가리키는 바이트가 **있고, 실제로 열리는가**
// ────────────────────────────────────────────────────────────────────────────
//
// 경로축의 `files` 단계는 v1.76에 이름만 생기고 **도구가 하나도 없었다.** 허브가 그 자리에
// 「아직 이 단계를 보는 도구가 없어요」를 띄우고 있었다 — 빈 자리를 숨기지 않은 덕에 이 구멍이
// 계속 보였고(§8), 사각지대 등록부(T-010·T-011)가 이유를 들고 있었다. 이 도구가 그걸 닫는다.
//
// 🔴 **디코드는 probe가 아니라 행동이 한다.** 허브를 열면 `rollup()`이 모든 probe를 도는데,
// 전수 디코드를 여기 넣으면 진단 도구가 **자기 자신을 느리게 만든다.** 존재 검사(크기만 본다)만
// 매번 돌고, 실제로 열어 보는 것은 [열어 보기]가 하고 결과를 기억한다.
export async function fileRealityProbe(): Promise<Verdict> {
  const { photo, audio } = await tallyLocalFiles();
  const input: FileRealityInput = { photo, audio, sweep: lastSweep() };
  // 아직 안 열어 본 상태 — [열어 보기]를 누르면 풀린다(**일시적**).
  const metrics: Metric[] = fileRealityMetrics(input).map((m) => metricFromView(m.label, m, 'transient'));
  const sweep = input.sweep;
  return {
    level: levelFromMetrics(metrics),
    headline: fileRealityHeadline(input),
    // 🔴 시야의 경계를 **판정 바로 아래**에서 말한다 — 「같습니다」류 문장이 무엇을 안 봤는지
    //    빠뜨리는 것이 이 저장소의 반복 결함이다(§7-C 한정 생략).
    because: fileRealityScopeNote(),
    actions: [
      {
        label: '사진·소리 실제로 열어 보기',
        primary: true,
        hook: 'file-open-sweep',
        // 🔴 **읽기 전용이다.** 여는 것은 지우거나 고치는 것이 아니므로 라이브가 실제로 눌러도
        //    사용자의 기억이 위험하지 않다(§13 4항의 파괴적 행동 예외에 해당하지 않는다).
        run: async () => {
          const s = await sweepOpenFiles();
          return s.failed.length === 0
            ? `${s.checked}개를 열어 봤고 전부 열렸어요.`
            : `${s.checked}개 중 ${s.failed.length}개가 열리지 않았어요. 지우지 마시고 다른 기기를 확인해 주세요.`;
        },
      },
    ],
    metrics,
    evidence: sweep
      ? [
          {
            label: `마지막으로 열어 본 결과 (${sweep.checked}개)`,
            build: () =>
              table(
                sweep.failed.length
                  ? sweep.failed.map((id): [string, string] => [id, '열리지 않음'])
                  : [['열리지 않은 파일', '없음']],
                '결과를 읽지 못했어요',
              ),
          },
        ]
      : [],
    context: [
      { label: '이 기기의 사진 기록', value: `${photo.rows}개` },
      { label: '이 기기의 소리 기록', value: `${audio.rows}개` },
      // 「서버에 바이트 없음」은 **아는 사실**이지 결함이 아니다 — 지표로 또 세지 않고 맥락에 둔다.
      { label: '서버에 바이트가 없다고 확인된 것', value: `${photo.serverMissing + audio.serverMissing}개` },
      // 🔴 **원시 ISO(UTC)를 사용자에게 내보내지 않는다**(2026-08-05 실기기 캡처 · M-0110).
      //    화면에 `2026-08-05T23:17:41.750Z`가 그대로 나갔다 — 기기 시계는 08:17이었다.
      //    `check-timezone`이 `iso.slice(0,10)`을 금지하는 것과 **같은 이유**다: UTC는
      //    사용자의 시각이 아니다. 로컬 파생은 `domain/time.ts` 한 곳에서만 한다.
      { label: '마지막으로 열어 본 때', value: sweep ? localDateTime(sweep.at) : '아직 없음' },
    ],
  };
}

// ────────────────────────────────────────────────────────────────────────────
// ⑫ 기기별 현황 — 내 기기들이 서로 뒤처지지 않았는가
// ────────────────────────────────────────────────────────────────────────────
//
// 접힌 출처에서 **도구로 승격**했다. 「내 기기들 N대」는 M-0048에서 판정을 뒤집은 결정적
// 근거였는데(다른 기기가 있으면 파괴적 정리를 권하면 안 된다) 펼쳐야 보였다 — 판정을 뒤집는
// 정보가 접혀 있는 것은 §8 위반이다. 그리고 사용자가 여러 날 겪은 문제가 정확히 이 축이었다.
export async function deviceFleetProbe(): Promise<Verdict> {
  const c = supabase();
  const u = c ? await currentUserSafe() : null;
  let devices: FleetObservation['devices'] = null;
  let reason: string | null = null;
  if (!c) reason = '서버 연결이 설정되지 않았습니다';
  else if (!u) reason = '로그인 상태가 아닙니다';
  else {
    try {
      const cmp = await compareStore(storeStateRemote(c));
      devices = cmp.devices.map((d) => ({ label: d.label, id: d.id, lastPushAt: d.lastPushAt, isThis: d.isThis }));
    } catch (e) {
      reason = (e as Error).message || '기기 목록 조회에 실패했습니다';
    }
  }
  const o: FleetObservation = {
    cloudConfigured: isConfigured(),
    signedIn: Boolean(u),
    devices,
    unavailableReason: reason,
    now: new Date().toISOString(),
  };
  const views = fleetMetrics(o);
  const labels = ['이 계정의 기기', '오래 안 올린 기기'];
  // 이 도메인의 `확인 불가`는 전부 **일시적**이다 — 서버 조회·로그인·목록 확보가 되면 풀린다.
  const metrics: Metric[] = views.map((v, i) => metricFromView(labels[i] ?? '', v, 'transient'));
  return {
    level: levelFromMetrics(metrics),
    headline: fleetHeadline(o),
    // 🔴 라벨이 말할 수 있는 것만 말한다(§5 9항) — 이 목록은 **올린 기록**에서 나온다.
    because: '이 목록은 서버에 무언가를 올린 기기만 보여줍니다. 받아만 간 기기는 흔적이 남지 않아요.',
    actions: [],
    metrics,
    evidence: devices?.length
      ? [
          {
            label: `기기 ${devices.length}대 — 마지막으로 올린 시각`,
            build: () =>
              table(
                devices.map((d): [string, string] => {
                  const days = daysSince(d.lastPushAt, o.now);
                  const ago = days === null ? '' : days === 0 ? '오늘' : `${days}일 전`;
                  return [`${d.label}${d.isThis ? ' (지금 이 기기)' : ''}`, ago];
                }),
                '올린 기기가 없어요',
              ),
          },
        ]
      : [],
    context: [],
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
  /**
   * 🔴 **기억이 지나는 길의 어느 단계인가**(`domain/diagGroups.ts`).
   *
   * 왜 **필수**인가: v1.76에서 경로축 8단계를 만들어 놓고 **도구에는 안 걸었다.** 분류는
   * 사각지대 등록부에만 붙었고 사용자가 보는 목록은 평평한 채로 남았다 — M-0015
   * (*"전파 기능을 만들어 놓고 화면에서 부르지 않음"*)의 재발이고, 인계 문서는
   * 「재분류했다」고 적혀 있었다. 선택 필드로 뒀으면 다음 도구도 조용히 빠졌을 것이다.
   * 필수로 두면 **누락이 컴파일 오류**가 된다(§7 2층).
   */
  group: DiagGroup;
}

/** 판정 롤업에 참여하는 도구 — 요약 자신은 롤업 대상이 아니다(자기참조가 된다). */
export const CORE_TOOLS: DiagTool[] = [
  {
    id: 'storage',
    group: 'safety',
    icon: '💾',
    label: '저장소 안전',
    hint: '브라우저가 데이터를 지울 위험',
    lead: '브라우저가 공간이 부족하면 앱 데이터를 지울 수 있어요. 그 위험을 봅니다.',
    probe: storageProbe,
  },
  {
    id: 'sync',
    group: 'upload',
    icon: '🔄',
    label: '동기화 상태',
    hint: '서버와 얼마나 어긋나 있나',
    lead: '이 기기의 변경이 서버까지 갔는지 봅니다.',
    probe: syncProbe,
  },
  {
    id: 'integrity',
    group: 'local',
    icon: '🧷',
    label: 'ID 무결성',
    hint: '기록이 서로 앞뒤가 맞나',
    lead: '저장된 기록끼리 참조가 끊기지 않았는지 봅니다. 읽기 전용이라 아무것도 바꾸지 않아요.',
    probe: integrityProbe,
  },
  {
    id: 'environment',
    group: 'device',
    icon: '🧩',
    label: '환경·기능',
    hint: '이 기기가 갖춘 기능',
    lead: '이 기기·브라우저가 앱에 필요한 기능을 갖췄는지 봅니다.',
    probe: environmentProbe,
  },
  {
    id: 'store',
    group: 'compare',
    icon: '☁️',
    label: '저장 상태 · 기기별 현황',
    hint: '클라우드와 같은가 · 어느 기기가 뒤처졌나',
    lead: '클라우드와 이 기기의 기록 수를 나란히 놓고, 각 기기가 마지막으로 올린 시각을 봅니다.',
    probe: storeStateProbe,
  },
  {
    id: 'errors',
    group: 'meta',
    icon: '📄',
    label: '오류 기록',
    hint: '이 세션에서 생긴 오류',
    lead: '앱이 도는 동안 생긴 오류를 모아 둡니다. 새로고침하면 사라져요.',
    probe: errorProbe,
  },
  {
    id: 'fleet',
    group: 'device',
    icon: '📱',
    label: '기기별 현황',
    hint: '내 기기들이 뒤처지지 않았나',
    lead: '이 계정에서 서버에 올린 적 있는 기기들과, 각 기기가 마지막으로 올린 시각을 봅니다.',
    probe: deviceFleetProbe,
  },
  {
    id: 'session',
    group: 'device',
    icon: '🔑',
    label: '세션·로그인',
    hint: '로그인이 유지되나 · 로그아웃하면 가려지나',
    lead: '로그인이 얼마나 유지되는지, 그리고 로그아웃했을 때 이 기기의 기록을 가리는 배선이 실제로 도는지 확인합니다.',
    probe: sessionProbe,
  },
  {
    id: 'contract',
    group: 'contract',
    icon: '📡',
    label: '서버 계약',
    hint: '서버가 가정대로 행동하나',
    lead: '로그인 없는 접근이 실제로 막히는지, 서버가 한 번에 주는 행수가 앱의 가정과 맞는지 실제로 물어봅니다. 읽기 전용이에요.',
    probe: serverContractProbe,
  },
  {
    id: 'files',
    group: 'files',
    icon: '🖼️',
    label: '파일 실물',
    hint: '사진·소리가 실제로 열리나',
    lead: '기록이 가리키는 바이트가 이 기기에 있고, 실제로 열리는지 하나씩 확인합니다.',
    probe: fileRealityProbe,
  },
  {
    id: 'roundtrip',
    group: 'upload',
    icon: '🔁',
    label: '왕복 시험',
    hint: '저장한 게 서버까지 갔다 오나',
    lead: '시험용 여행 하나를 만들어 서버까지 보냈다가 지우고 흔적까지 확인한 뒤 스스로 치웁니다. 기존 기록은 건드리지 않아요.',
    probe: roundTripProbe,
  },
  {
    id: 'trash',
    group: 'safety',
    icon: '🗑️',
    label: '저장·삭제·휴지통',
    hint: '지운 것을 되살릴 수 있나',
    lead: '휴지통을 모든 기기가 같이 보는지, 되살렸을 때 자료가 온전히 돌아오는지 봅니다. 읽기 전용이라 아무것도 지우지 않아요.',
    probe: trashProbe,
  },
  {
    id: 'backup',
    group: 'safety',
    icon: '🗄️',
    label: '백업 신선도',
    hint: '이 손에 있는 사본이 있나',
    lead: '클라우드와 별개로, 이 기기 밖으로 받아 둔 백업 파일이 얼마나 최근인지 봅니다.',
    probe: backupProbe,
  },
];

export const SUMMARY_TOOL: DiagTool = {
  id: 'summary',
  group: 'meta',
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


