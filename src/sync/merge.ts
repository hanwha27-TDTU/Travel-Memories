// sync/merge.ts — 동기화 결정의 순수 함수 (docs/SYNC_PROTOCOL.md 불변식).
// 네트워크·DB 의존이 없어 직접 단위테스트로 잠근다(LESSONS §6: 미러 아닌 운영함수 테스트).

import { compareInstants } from '../domain/time';
import type { SyncMeta } from '../offline/db';

/**
 * 서버 행을 로컬에 반영할지 결정. **version 기반 tombstone 우위 + LWW**(SYNC_PROTOCOL 불변식 2).
 *
 * 좀비데이터 절대 방지의 핵심 규칙:
 *  - 삭제(tombstone)는 "강한 의도"다. 활성 사본이 tombstone을 이기려면 **오직 진짜 복원**
 *    (version이 tombstone보다 더 큼)이어야 한다. **벽시계(updatedAt)로는 절대 부활시키지 않는다** —
 *    기기 간 시계 스큐로 오래된 활성 사본의 시각이 우연히 앞서면 삭제가 되살아나던(좀비) 근본 원인.
 *  - 삭제상태가 다르면 version으로만 판정하고, version 동률이면 **삭제가 이긴다**(안전 편향).
 *    → 오래된 백업 복원·지연 pull이 삭제한 데이터를 되살리지 못한다.
 *  - 삭제상태가 같으면(둘 다 활성 또는 둘 다 tombstone) 평범한 LWW(updatedAt→version).
 *
 * SyncMeta만 참조하므로 모든 동기화 엔티티(Trip·Moment·Media·Expense…)에 공통 적용된다.
 */
export function mergeDecision(
  local: SyncMeta | undefined,
  server: SyncMeta,
): 'take-server' | 'keep-local' {
  if (!local) return 'take-server';

  const localDeleted = local.deletedAt != null;
  const serverDeleted = server.deletedAt != null;

  // ── 삭제상태가 다른 전이(활성 ↔ tombstone): version으로만 판정(시계 무시) ──
  if (localDeleted !== serverDeleted) {
    if (server.version > local.version) return 'take-server'; // 진짜 복원/진짜 삭제(더 높은 세대)만 수용
    if (server.version < local.version) return 'keep-local';
    return serverDeleted ? 'take-server' : 'keep-local'; // 동률 → 삭제가 이긴다(부활 금지)
  }

  // ── 삭제상태가 같으면 평범한 LWW(updatedAt 우선 → version → 안정) ──
  //
  // ⚠️ **시각은 문자열이 아니라 순간으로 비교한다**(M-0034, 2026-07-27). 같은 순간이 두 표기로
  // 저장될 수 있었다 — 서버(PostgREST) `…48.34+00:00` vs 로컬(JS) `…48.340Z`. 문자열 대소로 재면
  // 같은 순간인데 한쪽이 크게 나오고, **동률일 때만 도는 version 판정을 건너뛴다**(더 높은 세대의
  // 서버 행이 조용히 무시된다). 표기는 `isoInstant()`가 경계에서 정규화하지만, 비교 자체도
  // 표기에 의존하지 않게 둔다 — 방어선은 하나면 뚫린다.
  //
  // 파싱 불가는 `null` → 시각 판정을 건너뛰고 version으로 간다(모르는 값으로 승부를 내지 않는다).
  const byTime = compareInstants(server.updatedAt, local.updatedAt);
  if (byTime !== null && byTime > 0) return 'take-server';
  if (byTime !== null && byTime < 0) return 'keep-local';
  if (server.version !== local.version) return server.version > local.version ? 'take-server' : 'keep-local';
  return 'keep-local';
}

/**
 * 빈-클라우드 가드(불변식 4): 서버가 0행인데 로컬에 활성 데이터가 있으면 이상 상황.
 * RLS 오설정·잘못된 프로젝트일 수 있으므로 로컬을 절대 덮어쓰지 않는다.
 */
export function isEmptyCloudAnomaly(serverRowCount: number, localActiveCount: number): boolean {
  return serverRowCount === 0 && localActiveCount > 0;
}

/**
 * **재시도 대기 시간**(ms) — `docs/SYNC_PROTOCOL.md:31`의 계약을 코드로 옮긴 것.
 *
 * ⚠️ 2026-07-27까지 이 함수가 **없었다.** 계약은 문서에 5초/15초/60초/5분/15분으로 적혀
 * 있었는데 `markFail`은 `attempts`를 증가만 시키고 **아무도 읽지 않았다**(grep 0건).
 * 그래서 실패한 op이 `autoSync`의 트리거(`online`·`visibilitychange`·5분 주기)마다
 * **즉시 재시도**됐다 — 화면을 오갈 때마다 같은 요청이 다시 나간다.
 *
 * jitter는 여러 기기·여러 op이 **같은 순간에 몰리는 것**을 흩는다(thundering herd).
 * 주입 가능하게 둔 이유는 검사의 결정성 때문이다(그레인의 고정 시드와 같은 규율).
 *
 * @param attempts 지금까지의 실패 횟수(1부터). 0 이하는 1로 본다.
 * @param rand 0..1 난수. 기본 `Math.random` — 검사는 고정값을 넣는다.
 */
export const RETRY_SCHEDULE_MS = [5_000, 15_000, 60_000, 300_000, 900_000] as const;

export function retryDelayMs(attempts: number, rand: () => number = Math.random): number {
  const i = Math.min(Math.max(1, Math.floor(attempts)), RETRY_SCHEDULE_MS.length) - 1;
  const base = RETRY_SCHEDULE_MS[i]!;
  // ±20% jitter. 하한을 base의 80%로 두어 "계약보다 빨리 재시도"가 나오지 않게 한다.
  return Math.round(base * (0.8 + rand() * 0.4));
}

/**
 * **지금 이 op을 시도해도 되는가.** `nextRetryAt`이 없으면(옛 항목·첫 시도) 항상 참이다 —
 * 모르는 것을 "대기"로 반올림하면 옛 큐가 영영 안 나간다.
 */
export function isRetryDue(op: { nextRetryAt?: string }, nowIso: string): boolean {
  if (!op.nextRetryAt) return true;
  const t = Date.parse(op.nextRetryAt);
  const now = Date.parse(nowIso);
  if (Number.isNaN(t) || Number.isNaN(now)) return true; // 못 읽는 값으로 막지 않는다
  return now >= t;
}

/**
 * 오류 분류: 재시도 가능(네트워크·일시) vs 영구(검증·권한).
 * status undefined = 네트워크 미도달 → 재시도. 401/403 = 인증/권한 → 영구(사용자 개입).
 */
export function classifyError(status: number | undefined): 'retryable' | 'permanent' {
  if (status === undefined) return 'retryable';
  if (status === 429 || status >= 500) return 'retryable';
  if (status === 401 || status === 403) return 'permanent';
  if (status >= 400) return 'permanent';
  return 'retryable';
}

/**
 * **바이트를 서버에 올려야 하는가** — 사진·소리·영상이 **같은 문을 지난다**(§7 2층).
 *
 * ── 왜 이 함수가 생겼나 (2026-08-01 · M-0059, 사용자 실기기) ──────────────
 * 두 형제의 업로드 조건이 **손으로 따로 쓰여 있었고 갈라져 있었다**:
 *
 * ```
 * 소리: if (audio.deletedAt === null || !audio.storagePath)   ← 2026-07-28에 고침(M-0046)
 * 사진: if (media.deletedAt === null)                          ← 안 고침
 * ```
 *
 * 결과: **휴지통에 있는 사진의 바이트는 어떤 경로로도 다시 올라가지 못했다.** 진단은
 * 「서버에 없는 사진 3개」를 정확히 짚고 [다시 올리기] 버튼까지 줬는데, 눌러도 업로드를
 * 건너뛰고 **행만 다시 쓴 뒤 작업을 큐에서 지웠다** — 사용자에게는 *"3건을 다시 올렸어요"*
 * 라고 말하면서. 재판정은 영원히 3개였고, 그 자리는 §8이 금지하는 **거짓 완료 보고**다.
 *
 * ── 왜 「경로 기억이 없다」로는 판정할 수 없나 (사진 한정) ────────────────
 * 사진에서 `storagePath`가 없다는 것은 **두 가지**를 뜻한다:
 *
 *  · **옛 키 형식 시절 행** — 바이트는 서버에 **있는데** 이 기기가 키를 기억하지 않는다.
 *    올리면 새 키로 사본이 하나 더 생겨 고아가 된다(그리고 앱이 그걸 문제로 띄운다).
 *  · **복구 경로가 일부러 잊게 함** — 서버에 바이트가 **없음을 확인**했다.
 *
 * 소리에는 키 형식이 하나뿐이라 「기억이 없다 = 올라간 적 없다」가 성립했다. 사진은 아니다.
 * 그래서 **의도를 추측하지 않고 명시적으로 표시한다** — `bytesMissing`이 그 표시다.
 *
 * @param e 대상 엔티티(사진·소리·영상 공통 — `SyncMeta`가 아니라 필요한 필드만 받는다).
 * @param unknownPathMeansNeverUploaded
 *   경로 기억이 없을 때 「올라간 적 없다」로 볼 수 있는가. **소리는 true**(키 형식이 하나),
 *   **사진은 false**(옛 형식이 있어 그렇게 볼 수 없다). 기본값을 두지 않는다 — 기본값이 있으면
 *   새 형제가 안 넘겨도 컴파일되고, 그게 이 규율이 조용히 빠지는 길이다(§7 2층).
 *
 * ── 🔴 M-0100(2026-08-05, 실사용자 계정) — 「옛 키 형식」 보호가 **한 번도 push된 적
 * 없는 새 사진**까지 삼켰다 ───────────────────────────────────────────
 * 사진을 만들고 첫 push가 돌기 전에(같은 배치 안에서) 지우면, 그 시점의 `storagePath` 없음은
 * 「옛 키 형식」과 겉모습이 같지만 뜻이 정반대다 — **이 기기가 서버에 단 한 번도 착지시킨 적이
 * 없다.** 그런데도 `unknownPathMeansNeverUploaded=false`(사진)가 업로드를 건너뛰게 했고,
 * push는 (건너뛴 채로) storage_path를 서버에 적었다 — 그 경로엔 영원히 바이트가 없다. 다른
 * 기기의 동기화는 그 사진을 R2 GET 404로 영원히 실패한다. 정상 사용자 행동(빨리 만들고 빨리
 * 지움)이 결함처럼 보이면 안 된다(§7 「형제에게 대칭·공정을 기본값으로」의 시간축 버전 —
 * 「지금 막 태어난 나」도 형제다).
 *
 * 구분선은 `baseVersion`이다: 0이면 push 성공·pull 어느 쪽으로도 서버에 착지한 적이 없다는
 * 뜻이고(둘 다 baseVersion을 서버 version으로 전진시킨다 — `services/sync.ts`), 그때는 사진도
 * 「경로 기억 없음 = 올라간 적 없음」이 소리와 같은 근거로 성립한다.
 */
export function mustUploadBytes(
  e: { deletedAt: string | null; bytesMissing?: true; storagePath?: string; baseVersion?: number },
  unknownPathMeansNeverUploaded: boolean,
): boolean {
  if (e.deletedAt === null) return true; // 살아 있는 자료는 언제나 서버에 있어야 한다
  // 🔴 tombstone이어도 올린다 — ADR-0029: **휴지통에 있는 동안에도 바이트는 서버에 있어야**
  // 사본 없는 다른 기기에서 복원할 수 있다. "지운 건 안 올린다"는 규칙이었던 적이 없다.
  if (e.bytesMissing === true) return true; // 서버에 없음을 **확인**했다(추측이 아니다)
  const neverLanded = e.baseVersion === 0; // 이 기기가 서버에 단 한 번도 착지시킨 적 없음(M-0100)
  return (unknownPathMeansNeverUploaded || neverLanded) && !e.storagePath;
}

/**
 * 🔴 **내가 방금 보낸 쓰기가 서버에 실제로 착지했는가**(M-3 · 사진·소리·영상 read-back).
 *
 * 왜 「행이 있다」로는 부족한가(2026-08-01 감사): 사진·소리·영상 push는 upsert 뒤 `getById`로 되읽되
 * **행이 존재하기만 하면** 서버의 `updatedAt`/`version`을 자기 로컬에 덮어쓰고 op을 지웠다.
 * 그런데 그 사이 다른 기기가 **더 높은 version으로** 같은 행을 올렸으면 `getById`는 **그 행**을
 * 돌려준다 — 내 좌표는 안 갔는데 남의 stamp를 내 내용에 얹고 op을 지워, **로컬·서버가 영구히
 * 갈라진다**(형제 넷은 이미 제목·금액·좌표 대조로 이 창을 막고 있었다 — §7 비대칭).
 *
 * 그래서 **내가 보낸 operation id**로 대조한다. 제목·금액·좌표 한두 칸만 비교하면, 그 칸은
 * 우연히 같고 다른 필드가 다른 서버 행을 내 성공으로 오인할 수 있다. operation id는 한 로컬
 * 변경에 하나뿐이라 서버 read-back이 그 id를 돌려줄 때만 내 쓰기가 착지한 것이다.
 *
 * 서버 guard는 같은 상태의 최신 LWW 쓰기가 낮은 version을 들고 오면 version을 단조 증가시킬 수
 * 있으므로 서버 version은 보낸 값보다 **크거나 같으면** 된다. 사진·소리·영상은 여기에 객체 경로까지
 * 더해, 행과 바이트가 같은 쓰기인지 확인한다.
 */
export function writeLanded(
  server: { version: number; clientOperationId?: string; storagePath?: string | null },
  sentVersion: number,
  sentOperationId: string,
  sentPath?: string,
): boolean {
  if (server.clientOperationId !== sentOperationId || server.version < sentVersion) return false;
  return sentPath === undefined || server.storagePath === sentPath;
}

/**
 * **서버 고아를 만났을 때 이 행을 어떻게 할 것인가**(2026-08-15 · T-047에서 꺼냄).
 *
 * ── 왜 꺼냈나 ────────────────────────────────────────────────────────────────
 * 이 판정은 `pullMedia`의 for 루프 안에 인라인으로 있었다. 그런데 이게 지키는 것은
 * **파괴적 서버 쓰기**다 — 서버 행에 tombstone을 밀고 **R2 바이트를 지운다.**
 * 그 판정에 **유닛이 하나도 없었다.** IO 클로저 안이라 붙일 수가 없었다(§10 ③).
 *
 * ── 🔴 왜 `boolean`이 아니라 유니온인가 (내가 한 번 틀린 자리) ───────────────
 * 처음엔 `shouldSweepServerOrphan(): boolean`으로 꺼냈다. **그리고 거동이 바뀌었다.**
 * 원래 코드에서 `server-read-only`는 `continue`였다 — 즉 **그 행의 나머지 처리를 통째로
 * 건너뛴다.** 그런데 `false`를 돌려주니 호출부가 아래로 **흘러가서** 다운로드·로컬 쓰기까지
 * 했다(기존 유닛이 `r2: 0`을 기대했는데 `1`이 나와 잡혔다).
 *
 * 🔴 **교훈: `boolean`은 두 갈래인데 원래 흐름은 세 갈래였다.** 「순수 추출이니 거동은
 * 그대로」라는 말은 **반환 타입이 원래 제어흐름을 담을 수 있을 때만** 참이다. 그래서
 * 세 상태를 이름으로 만든다 — 다음 사람이 `if (x)`로 뭉갤 수 없다.
 *
 * ── 무엇을 판정하나 ─────────────────────────────────────────────────────────
 *  · `not-orphan` — 이 행은 이 부류가 아니다. **평소 처리로 계속 간다.**
 *  · `skip-row`   — 고아이긴 한데 `server-read-only`다. **아무것도 하지 않고 다음 행으로.**
 *                   capability 불명에서는 서버 쓰기도, 이미 영구삭제한 부모 아래로 다시
 *                   받는 것도 금지다(sync-offline-dev 11 · M-0093).
 *  · `sweep`      — tombstone을 밀고 바이트를 지운다.
 *
 * 고아의 조건 셋은 **모두** 참이어야 한다: ①로컬에 행이 없다(있으면 대기열이 처리한다 —
 * 여기서 손대면 두 손이 겹친다) ②서버가 아직 활성이다 ③그 여행을 **이 기기에서 영구삭제**했다.
 * 🔴 ③이 가장 위험한 자리다 — 없으면 **남의 멀쩡한 자료를 지운다.**
 *
 * ── 🔴 왜 `pullMedia`에만 있는가 — 재보고 답했다 (T-050 · 2026-08-15) ────────
 * 이 스윕은 **`pullMedia`에만 있다.** 나머지 여섯 pull은 자기 id만 보고 부모 여행의
 * 영구삭제는 안 본다. 처음엔 이걸 **형제 비대칭(§7 위반)으로 의심**했는데, 운영 DB를
 * 읽기 전용으로 재보니 **정당한 비대칭**이었다:
 *
 *     trips ──CASCADE──> moments ──CASCADE──> media · audio · videos · expenses
 *
 * 네 형제 모두 `moment_id`가 **NOT NULL**이고(실측: null 행 0), `trips`를 직접 참조하는
 * 것은 `moments`뿐이다. 즉 **여행 행이 지워지면 서버가 자식을 전부 데려간다** — 연쇄를
 * 빠져나갈 구멍이 없다. 헌장 §7-A(*"영구삭제의 가족 범위는 서버 FK가 데려가는 범위와
 * 같아야 한다"* · M-0107)가 이미 지켜지고 있는 상태다.
 *
 * 🔴 **그럼 이 스윕은 무엇인가**: FK 연쇄가 닿지 않는 **역사적 잔재**를 위한 안전망이다
 * (연쇄가 생기기 전에 지운 것, 또는 DELETE가 부분 실패한 것). 실측 결과 **다섯 도메인 전부
 * 활성 고아 0건**이었고, 모집단은 실재했다(`purged_ids` 102건).
 *
 * 🔴 **그러므로 형제에 확장하지 않는다.** 확장하면 FK가 이미 막는 경우를 위해 **파괴적 서버
 * 쓰기 경로를 넷 더 만드는 것**이고, 그건 안전을 사는 게 아니라 위험을 늘리는 것이다.
 * ⚠️ **이 이유가 참인 사정권**: 위 FK 연쇄와 `moment_id NOT NULL`이 유지되는 동안만이다
 * (M-0060 — 이유는 산문이고, 산문은 스키마가 바뀔 때 같이 안 바뀐다). 자식 테이블의
 * `moment_id`를 nullable로 바꾸거나 `trips` 직접 FK를 추가하면 **이 판단부터 다시 하라.**
 *
 * 🔴 **정직한 한계**: 소리·영상은 **서버 행이 0개**라 「고아 0건」은 그쪽에서 공허하다.
 * 위 판단이 기대는 것은 행 수가 아니라 **스키마 구조**다(FK + NOT NULL) — 그건 행이 0이어도 참이다.
 */
export type ServerOrphanAction = 'not-orphan' | 'skip-row' | 'sweep';

export function serverOrphanAction(input: {
  /** 로컬에 이 id의 행이 없는가. */
  readonly localMissing: boolean;
  /** 서버 행의 `deletedAt` — `null`이면 활성이다. */
  readonly serverDeletedAt: string | null;
  /** 이 행의 부모 여행이 **이 기기에서** 영구삭제됐는가. */
  readonly parentPurged: boolean;
  /** 전환 모드. `server-read-only`면 서버에 아무것도 쓰지 않는다. */
  readonly mode: 'merge' | 'server-read-only';
}): ServerOrphanAction {
  const isOrphan = input.localMissing && input.serverDeletedAt === null && input.parentPurged;
  if (!isOrphan) return 'not-orphan';
  return input.mode === 'server-read-only' ? 'skip-row' : 'sweep';
}

/**
 * **로컬은 지웠는데 서버는 아직 살아 있다** — 그 삭제를 다시 대기열에 올릴 것인가.
 *
 * ── 왜 꺼냈나 (T-047 · 2026-08-15) ──────────────────────────────────────────
 * 이 판정은 **일곱 pull 루프 전부**가 부른다(trip·moment·expense·media·place·audio·video).
 * 그런데 **유닛이 한 건도 없었다** — Dexie 큐 조회와 같은 함수 안에 있어 붙일 수가 없었다.
 * 그리고 이 판정이 참이면 만들어지는 것은 **`delete` op**이다. 즉 **서버 행을 지우는 길의
 * 입구**이고, 이 저장소에서 유닛 없이 두면 안 되는 부류다.
 *
 * ── 왜 pull 자리에서 판정하나 ───────────────────────────────────────────────
 * pull은 서버 상태를 **이미 받아왔으므로** 추가 비용 0으로 정확히 판정한다.
 * 「로컬 tombstone + 서버 활성」은 그 삭제가 서버에 **도달하지 못했다는 직접 증거**다.
 * 로컬만 보면 「이미 서버에 갔는지」를 알 수 없다 — 그 모호함이 2026-07-25에 실제 결함이었다
 * (1회 표식 방식은 표식 뒤에 생긴 고아를 영영 못 잡았고, 사용자는 지운 사진이 R2에 남는 것을 봤다).
 *
 * ── 🔴 왜 `boolean`이 아닌가 ────────────────────────────────────────────────
 * 갈래는 둘로 보이지만 **「안 한다」의 뜻이 둘**이다. 그리고 그 둘은 성격이 정반대다:
 *
 *  · `skip-read-only`   — **계약이라서** 안 한다. capability 불명 전환 모드에서는 서버뿐
 *                         아니라 **로컬 큐도 read-only**다(M-0095). 서버 활성을 봤다는
 *                         이유로 새 op을 만들면 「큐 보존」 계약이 **거짓말이 된다.**
 *  · `skip-not-stranded` — **해당 사항이 없어서** 안 한다(로컬에 행이 있거나·로컬이 안 지웠거나·
 *                         서버도 이미 지웠거나).
 *  · `queue-if-absent`   — 올린다. 단 **같은 대상의 op이 이미 있으면 안 올린다**(중복 방지) —
 *                         그 확인은 큐 조회라 여기 없다. 이름에 `if-absent`를 남겨 호출부가
 *                         그 단계를 빠뜨리면 이름과 코드가 어긋나 보이게 했다.
 *
 * 🔴 **`boolean`으로 뭉치면 계약이 사고와 섞인다** — 다음 사람이 `skip`을 「할 일 없음」으로
 * 읽고 read-only 갈래를 지운다. 그게 M-0170에서 실제로 일어난 일이다(같은 파일, 4일 전).
 */
export type RequeueDeleteAction = 'queue-if-absent' | 'skip-read-only' | 'skip-not-stranded';

export function requeueDeleteAction(input: {
  /** 로컬 행이 있는가 — 없으면 대기열이 손댈 대상이 아니다. */
  readonly hasLocal: boolean;
  /** 로컬 행의 `deletedAt` — `null`이면 사용자가 안 지운 것이다. */
  readonly localDeletedAt: string | null;
  /** 서버 행의 `deletedAt` — `null`이면 아직 살아 있다(= 삭제가 도달 못 함). */
  readonly serverDeletedAt: string | null;
  /** 전환 모드. `server-read-only`면 서버도 로컬 큐도 건드리지 않는다(M-0095). */
  readonly mode: 'merge' | 'server-read-only';
}): RequeueDeleteAction {
  // 🔴 순서가 계약이다 — read-only를 **먼저** 본다. 뒤에 두면 「대상이 아니다」와
  //    「계약상 안 한다」가 섞여, 진단에서 둘을 갈라 셀 수 없다(§8).
  if (input.mode === 'server-read-only') return 'skip-read-only';
  const stranded = input.hasLocal && input.localDeletedAt !== null && input.serverDeletedAt === null;
  return stranded ? 'queue-if-absent' : 'skip-not-stranded';
}

/**
 * **DB가 더 이상 가리키지 않는 옛 객체 키를 지울 것인가**(T-047 · 2026-08-15).
 *
 * operation별 객체 키를 쓰므로 같은 사진이 다시 올라가면 **옛 키가 R2에 남는다.** 그걸 걷는
 * 자리인데, 판정을 잘못하면 **DB가 지금 가리키고 있는 바이트를 지운다** — 행은 살아 있는데
 * 바이트만 사라지는, 이 앱에서 가장 나쁜 상태다(비타협 원칙 #1).
 *
 * ── 🔴 왜 두 침묵을 갈라 부르나 ────────────────────────────────────────────
 *  · `no-candidate`     — 걷을 옛 키 자체가 없다(첫 업로드 등). **정상이고 흔하다.**
 *  · `still-referenced` — 옛 키와 지금 키가 **같다.** 즉 이건 고아가 아니라 **현역**이다.
 *                         🔴 이 갈래가 무너지면 사용자의 사진 바이트가 사라진다.
 *  · `remove`           — 가리키는 데가 없다. 지운다.
 *
 * 둘을 `boolean`으로 뭉치면 「없어서 안 지운다」와 「현역이라 안 지운다」가 같은 말이 되고,
 * 다음 사람이 「어차피 안 지우는데」로 가드를 단순화한다 — 그 순간 현역이 지워진다(M-0170).
 *
 * **삭제 실패는 여기 판정이 아니다.** 실패하면 고아 사본을 남기고 재시도에 맡긴다 —
 * 기억(사용자 자료)보다 사본 하나가 싸다.
 */
export type UnreferencedByteAction = 'remove' | 'no-candidate' | 'still-referenced';

export function unreferencedByteAction(
  /** 걷을 후보 — 이번 operation 이전에 쓰던 객체 키. */
  candidate: string | undefined | null,
  /** DB가 **지금** 가리키는 객체 키. */
  referenced: string | null | undefined,
): UnreferencedByteAction {
  if (!candidate) return 'no-candidate';
  return candidate === referenced ? 'still-referenced' : 'remove';
}
