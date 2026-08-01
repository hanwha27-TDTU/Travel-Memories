// momentTz.test.ts — 순간의 시간대 오프셋 예외(tzOffsetMin) 저장·수정 (M-1).
//
// 🔴 이 필드는 저장·동기화·백업·표시(momentWhen)까지 배선돼 있었는데 **값을 넣는 곳이 없어**
// 죽어 있었다(2026-08-01 감사 연결지도). 사진 EXIF가 환승·국경 오프셋을 알려줘도 버려졌다.
// 이 검사가 「create가 넣고 update가 바꾼다」를 잠근다.

import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '../../src/offline/db';
import { createMomentLocalFirst, updateMomentLocalFirst } from '../../src/services/moments';

beforeEach(async () => {
  const d = db();
  await Promise.all([d.localMoments.clear(), d.syncQueue.clear()]);
});

describe('M-1 · moment.tzOffsetMin 파이프', () => {
  it('create가 넘긴 오프셋을 저장한다(환승·국경: +420 = UTC+7)', async () => {
    const m = await createMomentLocalFirst({
      tripId: 't1',
      title: '베트남 도착',
      occurredAt: '2026-07-01T12:00:00.000Z',
      tzOffsetMin: 420,
    });
    expect(m.tzOffsetMin).toBe(420);
    expect((await db().localMoments.get(m.id))?.tzOffsetMin).toBe(420);
  });

  it('안 넘기면 null이다(여행 시간대로 파생됨을 의미)', async () => {
    const m = await createMomentLocalFirst({ tripId: 't1', title: '오프셋 없음' });
    expect(m.tzOffsetMin).toBe(null);
  });

  it('update가 오프셋을 바꾼다(사용자가 시각을 고쳤을 때)', async () => {
    const m = await createMomentLocalFirst({ tripId: 't1', title: 'x', tzOffsetMin: 420 });
    const u = await updateMomentLocalFirst(m.id, { tzOffsetMin: 540 }); // 한국으로 정정
    expect(u.tzOffsetMin).toBe(540);
    expect(u.version).toBe(m.version + 1);
  });

  it('update에서 안 건드리면 기존 오프셋을 보존한다', async () => {
    const m = await createMomentLocalFirst({ tripId: 't1', title: 'x', tzOffsetMin: 420 });
    const u = await updateMomentLocalFirst(m.id, { title: 'y' });
    expect(u.tzOffsetMin).toBe(420);
  });
});
