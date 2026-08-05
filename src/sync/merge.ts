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
 * **바이트를 서버에 올려야 하는가** — 사진·소리가 **같은 문을 지난다**(§7 2층).
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
 * @param e 대상 엔티티(사진·소리 공통 — `SyncMeta`가 아니라 필요한 필드만 받는다).
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
 * 🔴 **내가 방금 보낸 쓰기가 서버에 실제로 착지했는가**(M-3 · 사진·소리 read-back).
 *
 * 왜 「행이 있다」로는 부족한가(2026-08-01 감사): 사진·소리 push는 upsert 뒤 `getById`로 되읽되
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
 * 있으므로 서버 version은 보낸 값보다 **크거나 같으면** 된다. 사진·소리는 여기에 객체 경로까지
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
