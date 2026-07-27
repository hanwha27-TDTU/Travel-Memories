// tests/unit/restoreAtomicity.test.ts — **복원한 행과 "서버 원장에서 빼라"는 의사는 한 커밋이다.**
//
// 왜 별도 파일인가: 이 검사는 `requestUnpurge`를 **실패하게 만들어** 원자성을 확인해야 하므로
// purge 모듈을 부분 모킹한다. 같은 파일의 다른 검사가 그 모킹에 오염되지 않게 갈라 둔다.
//
// ── 이 검사가 없어서 놓친 것(2026-07-26, v1.03이 반쪽이었던 이유) ──────────────────
// v1.03은 "복원이 되돌리기 의사를 큐에 남긴다"까지는 맞게 했는데, 그 한 줄을 트랜잭션
// **밖**에 두었다. 그래서 이런 창이 생겼다:
//
//   [행 커밋 · 로컬 표식 제거됨 · **되돌리기 의사 아직 없음**]  ← 여기서 동기화가 돌면
//   → applyPurgedLedger가 보호할 근거를 못 찾고 방금 되살린 행을 지운다.
//
// 그 창은 이론이 아니다. 파일 선택 창을 닫는 순간 `visibilitychange`가 즉시 동기화를 부르고,
// ZIP 해제와 blob 복원은 수 초가 걸린다. 사용자 실기기에서 복원이 **성공 메시지를 띄우고도**
// 앱에서 통째로 사라졌다(원장 24 → 11로 줄었으니 되돌리기 자체는 나중에 성공했다 —
// 지워진 것은 그 사이에 벌어진 일이었다).
//
// 그래서 이 검사가 잠그는 것은 "의사가 남는가"가 아니라 **"행과 의사가 같이 커밋되는가"**다.
// 옛 배치(트랜잭션 밖)에서는 의사 쓰기가 실패해도 **행은 커밋된 채 남는다** — 그 상태가 곧
// 위 사고의 상태다. 아래 두 번째 검사가 정확히 그것을 잡는다.

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const ctl = vi.hoisted(() => ({ fail: false }));

vi.mock('../../src/services/purge', async (importActual) => {
  const actual = await importActual<typeof import('../../src/services/purge')>();
  return {
    ...actual,
    requestUnpurge: (ids: string[]): Promise<number> =>
      ctl.fail ? Promise.reject(new Error('의도적 실패 — 원자성 확인용')) : actual.requestUnpurge(ids),
  };
});

import { db } from '../../src/offline/db';
import { importMergeRows, type CollectedRows } from '../../src/services/backup';
import { pendingUnpurgeIds } from '../../src/services/purge';
import type { LocalTrip } from '../../src/offline/db';

const T = 'aaaaaaaa-1111-4111-8111-111111111111';

function trip(id: string): LocalTrip {
  return {
    id, title: '되살린 여행', startDate: '2026-07-01', endDate: '2026-07-03', status: 'completed',
    createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z', version: 1, deletedAt: null,
  };
}
const rows = (): CollectedRows => ({ trips: [trip(T)], moments: [], media: [], expenses: [], audio: [] });

beforeEach(async () => {
  ctl.fail = false;
  const d = db();
  await Promise.all([
    d.localTrips.clear(), d.localMoments.clear(), d.localMedia.clear(),
    d.localExpenses.clear(), d.syncQueue.clear(), d.purgedIds.clear(),
  ]);
});

describe('복원: 행과 되돌리기 의사는 **같은 커밋**이다', () => {
  it('정상 복원이면 행과 의사가 함께 남는다', async () => {
    const r = await importMergeRows(rows());
    expect(r.trips).toBe(1);
    expect(r.unpurged).toBe(1);
    expect(await db().localTrips.get(T)).toBeDefined();
    expect([...(await pendingUnpurgeIds())]).toEqual([T]);
  });

  // **이 검사가 옛 배치를 잡는다.** 의사 쓰기가 실패했는데 행만 남으면, 그 행은 다음 동기화에서
  // 원장에 지워진다 — 사용자에겐 "복원됨"이라고 말해 놓고서.
  it('의사를 못 남기면 **행도 남지 않는다** — 반쪽 복원이 성공으로 보이면 안 된다', async () => {
    ctl.fail = true;
    await expect(importMergeRows(rows())).rejects.toThrow();

    expect(await db().localTrips.get(T)).toBeUndefined(); // ← 옛 배치에서는 여기가 남아 있었다
    expect(await db().syncQueue.count()).toBe(0); // 전파 op도 함께 되감긴다
  });

  it('되감긴 뒤 다시 복원하면 정상으로 끝난다(재시도가 막히지 않는다)', async () => {
    ctl.fail = true;
    await expect(importMergeRows(rows())).rejects.toThrow();
    ctl.fail = false;

    const r = await importMergeRows(rows());
    expect(r.trips).toBe(1);
    expect(await db().localTrips.get(T)).toBeDefined();
    expect([...(await pendingUnpurgeIds())]).toEqual([T]);
  });
});
