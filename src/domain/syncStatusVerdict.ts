// domain/syncStatusVerdict.ts — **자동 동기화 상태를 사용자 문장으로 옮기는 순수 함수.**
//
// ── 왜 이 파일이 따로 있나 (2026-07-27 사용자 실기기) ─────────────────
// 진단 요약의 총괄 판정이 `unknown`이었는데, 그걸 끈 항목이 이것 하나였다:
//
//   unknown  자동 동기화: 지금 마지막 성공 19:45:03 / 정상 최근에 성공
//
// **72초 전에 성공했는데 「판정 불가」다.** 원인은 판정이 `phase === 'ok'`일 때만 `ok`인데,
// 보고서를 만든 그 순간 동기화가 **한 번 더 돌고 있었기**(`phase === 'running'`) 때문이다.
// 그런데 화면 문구는 그 사실을 말하지 않고 「마지막 성공 …」만 적었다 — 사용자는 **왜 판정
// 불가인지 알 방법이 없었다.** 앱이 아는 것을 화면에 안 말한 것이다(§12).
//
// 그리고 그 하나가 **총괄 판정 전체를 `unknown`으로 끌어내렸다.** 나머지가 전부 `ok`인데도.
//
// ── 판정 규칙과 그 근거 ───────────────────────────────────────────────
// 이 지표가 묻는 것은 하나다: **"자동 동기화가 조용히 실패하고 있는가?"**
// 그 질문에 답할 수 있으면 `ok`/`problem`이고, 답할 수 없을 때만 `unknown`이다.
//
//  · `running` + 이번 세션에 성공 이력 있음 → **ok**. 마지막 결과가 성공이므로 "조용한 실패"는
//    아니다. 진행 중인 회차의 결과를 모르는 것은 사실이지만, 그건 이 지표가 묻는 질문이 아니다.
//    (§8 "모르는 것을 정상으로 반올림하지 않는다"는 **아는 것을 모른다고 하라**는 뜻이 아니다.)
//  · `running` + 성공 이력 없음 → **unknown**. 진짜로 결과를 모른다.
//  · `idle`(아직 안 돎)·`offline`·`signed-out` → **unknown**. 판정할 근거가 없다.
//  · `failed` → **problem**. 사유를 그대로 보여준다(조용히 삼키지 않는다).
//
// 순수 함수인 이유: 화면에 나가는 **문장 자체**가 결함일 수 있다(§10 ③ — M-0022에서 유닛
// 15건이 전부 통과했는데 화면 문장이 틀렸다). DOM 없이 모든 갈래를 유닛으로 돌린다.

/** 이 판정에 필요한 것만. `services/autoSync.ts`의 `SyncStatus`가 구조적으로 들어맞는다. */
export interface SyncStatusLike {
  phase: 'idle' | 'running' | 'ok' | 'failed' | 'offline' | 'signed-out';
  /** 이번 세션의 마지막 성공 시각(ISO). 없으면 한 번도 성공 못 함. */
  lastOkAt: string | null;
  lastError: string | null;
}

export interface SyncStatusVerdict {
  /** 지금 값 — **상태를 반드시 말한다**(진행 중이면 진행 중이라고). */
  actual: string;
  level: 'ok' | 'problem' | 'unknown';
  /** `ok`가 아닐 때만 화면에 함께 뜨는 한 줄. 없으면 undefined. */
  meaning?: string;
}

/** ISO → `HH:MM:SS`(로컬). 파싱 실패는 빈 문자열 — 지어내지 않는다. */
function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/** 「마지막 성공 HH:MM:SS」 — 시각을 못 읽으면 시각 없이 사실만 말한다. */
function lastOkPhrase(lastOkAt: string): string {
  const t = clock(lastOkAt);
  return t ? `마지막 성공 ${t}` : '마지막 시도는 성공';
}

/**
 * 자동 동기화 상태 → 사용자에게 보일 문장과 판정.
 *
 * 대응하는 기대값은 「최근에 성공」이다(호출부가 `expected`로 붙인다).
 */
export function autoSyncVerdict(st: SyncStatusLike): SyncStatusVerdict {
  if (st.phase === 'failed') {
    return {
      actual: `실패 — ${st.lastError ?? '사유 불명'}`,
      level: 'problem',
      meaning: '자동으로 보내려다 실패했어요. 저장한 기록은 이 기기에 안전합니다 — 연결을 확인하고 [지금 동기화]를 눌러 주세요.',
    };
  }

  if (st.phase === 'offline') {
    return { actual: '오프라인이라 대기 중', level: 'unknown' };
  }

  if (st.phase === 'signed-out') {
    return {
      actual: '로그인하지 않아 대기 중',
      level: 'unknown',
      meaning: '로그인하면 저장·삭제할 때마다 자동으로 서버에 올라갑니다.',
    };
  }

  // 진행 중 — **진행 중이라고 말한다.** 예전엔 이 갈래가 「마지막 성공 …」으로만 보여서
  // 사용자가 판정 불가의 이유를 알 수 없었다(이 파일이 생긴 이유).
  if (st.phase === 'running') {
    if (st.lastOkAt) {
      return { actual: `지금 동기화 중 · ${lastOkPhrase(st.lastOkAt)}`, level: 'ok' };
    }
    return {
      actual: '지금 동기화 중 — 이번 세션의 첫 회차',
      level: 'unknown',
      meaning: '결과가 아직 안 나왔어요. 잠시 후 [다시 확인]을 눌러 주세요.',
    };
  }

  if (st.lastOkAt) return { actual: lastOkPhrase(st.lastOkAt), level: 'ok' };

  return {
    actual: '이 세션에서 아직 실행 안 됨',
    level: 'unknown',
    meaning: '아직 한 번도 돌지 않아 판정할 근거가 없어요. [지금 동기화]를 누르면 바로 확인됩니다.',
  };
}
