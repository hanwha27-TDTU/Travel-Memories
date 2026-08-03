// domain/syncTombstoneVerdict.ts — 큐에서 사라진 tombstone을 서버 증거로 판정한다.
//
// 삭제 push가 성공하면 큐 op은 없어지는 것이 정상이다. 따라서 "tombstone + 큐 없음"만으로
// 실패를 판정하면 성공한 삭제가 영원히 경고로 남는다(M-0095). 이 파일은 로컬 tombstone과
// 서버 행·영구삭제 원장을 비교하는 순수 결정만 맡는다. 네트워크와 화면은 이 결정을 소비한다.

import type { SyncMeta } from '../offline/db';
import { mergeDecision } from '../sync/merge';

export type TombstoneSyncState =
  | 'confirmed-operation'
  | 'confirmed-tombstone'
  | 'needs-delete'
  | 'take-server'
  | 'purged'
  | 'unknown';

export interface TombstoneSyncRef extends SyncMeta {
  domain: string;
}

export interface TombstoneSyncFinding {
  local: TombstoneSyncRef;
  server: TombstoneSyncRef | null;
  state: TombstoneSyncState;
}

/**
 * 서버 증거 하나를 판정한다.
 *
 * - 서버도 tombstone이면 삭제 의도는 이미 반영됐다. operation이 같으면 가장 강한 증거이고,
 *   달라도 삭제 상태 자체는 확인됐으므로 다시 보내지 않는다.
 * - 서버가 활성이면 기존 좀비 차단 규칙(`mergeDecision`)이 승자를 정한다. 더 최신 복원을
 *   삭제로 덮지 않는다.
 * - 서버 행이 없을 때 영구삭제 원장이 있으면 재삽입하지 않는다.
 * - 행도 원장도 없으면 자동 복구하지 않는다. 서버 세대 경합·옛 로컬 전용 행을 구분할 증거가
 *   부족하므로 `unknown`이 안전한 판정이다.
 */
export function classifyTombstoneSync(
  local: TombstoneSyncRef,
  server: TombstoneSyncRef | null,
  serverPurged: boolean,
): TombstoneSyncState {
  if (!server) return serverPurged ? 'purged' : 'unknown';
  if (server.deletedAt !== null) {
    return local.clientOperationId &&
      server.clientOperationId === local.clientOperationId &&
      server.version >= local.version
      ? 'confirmed-operation'
      : 'confirmed-tombstone';
  }
  return mergeDecision(local, server) === 'take-server' ? 'take-server' : 'needs-delete';
}

export function isConfirmedTombstone(state: TombstoneSyncState): boolean {
  return state === 'confirmed-operation' || state === 'confirmed-tombstone';
}

export interface TombstoneSyncPresentation {
  actual: string;
  expected: string;
  level: 'ok' | 'todo' | 'unknown';
  meaning?: string;
  headline: string | null;
  confirmed: number;
  actionable: number;
  unknown: number;
}

/** 사용자에게 보이는 수와 문장도 순수 함수로 잠근다(§10 전달 결함 방지). */
export function tombstoneSyncPresentation(
  findings: TombstoneSyncFinding[],
  unavailableReason: string | null = null,
): TombstoneSyncPresentation {
  if (!findings.length) {
    return {
      actual: '확인할 항목 없음',
      expected: '모두 서버 반영',
      level: 'ok',
      headline: null,
      confirmed: 0,
      actionable: 0,
      unknown: 0,
    };
  }

  const confirmed = findings.filter((x) => isConfirmedTombstone(x.state)).length;
  const unknown = findings.filter((x) => x.state === 'unknown').length;
  const actionable = findings.length - confirmed - unknown;
  const parts = [
    confirmed ? `서버 반영 ${confirmed}건` : '',
    actionable ? `동기화 필요 ${actionable}건` : '',
    unknown ? `확인 불가 ${unknown}건` : '',
  ].filter(Boolean);

  if (actionable > 0) {
    return {
      actual: parts.join(' · '),
      expected: '모두 서버 반영',
      level: 'todo',
      meaning:
        '서버의 더 최신 복원본 또는 영구삭제 상태를 이 기기에 반영하거나, 아직 활성인 서버 행에 삭제를 다시 전달해야 합니다. [지금 동기화]가 안전한 순서로 처리합니다.' +
        (unknown ? ` 다만 ${unknown}건은 증거가 부족해 자동 수정하지 않습니다.` : ''),
      headline: `서버와 맞출 삭제 기록이 ${actionable}건 있어요`,
      confirmed,
      actionable,
      unknown,
    };
  }

  if (unknown > 0) {
    return {
      actual: parts.join(' · '),
      expected: '모두 서버 반영',
      level: 'unknown',
      meaning: unavailableReason
        ? `서버 대조를 마치지 못했습니다: ${unavailableReason} 기록은 이 기기에 그대로 두며 자동 수정하지 않습니다.`
        : '서버 행과 영구삭제 표식 모두에서 찾지 못했습니다. 세대 경합이나 옛 로컬 자료일 수 있어 자동 수정하지 않습니다.',
      headline: `삭제 기록 ${unknown}건을 서버에서 확인하지 못했어요`,
      confirmed,
      actionable,
      unknown,
    };
  }

  return {
    actual: `${confirmed}건 모두 서버 반영`,
    expected: '모두 서버 반영',
    level: 'ok',
    headline: null,
    confirmed,
    actionable,
    unknown,
  };
}

/** 접힌 근거에 쓰는 상태 설명. 정상 둘은 화면에서 숨기므로 여기 들어오지 않는다. */
export function tombstoneFindingText(state: TombstoneSyncState): string {
  switch (state) {
    case 'needs-delete':
      return '서버는 아직 활성 · 삭제 재전파 필요';
    case 'take-server':
      return '서버에 더 최신 복원본 · 동기화 필요';
    case 'purged':
      return '서버에서 영구삭제됨 · 이 기기 정리 필요';
    case 'unknown':
      return '서버 행·영구삭제 표식 없음 · 자동 수정 안 함';
    case 'confirmed-operation':
      return '같은 작업으로 서버 반영 확인';
    case 'confirmed-tombstone':
      return '서버 삭제 상태 확인';
  }
}
