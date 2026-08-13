// momentCompanions.test.ts — 순간에 함께한 사람의 로컬우선 저장·수정 파이프.
import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '../../src/offline/db';
import { createMomentLocalFirst, updateMomentLocalFirst } from '../../src/services/moments';

beforeEach(async () => {
  const d = db();
  await Promise.all([d.localMoments.clear(), d.syncQueue.clear()]);
});

describe('moment.companionNames 파이프', () => {
  it('생성할 때 앞뒤 공백을 정리해 저장하고 큐 의사와 함께 남긴다', async () => {
    const moment = await createMomentLocalFirst({
      tripId: 'trip-1',
      title: '함께한 저녁',
      companionNames: '  아버지, 어머니  ',
    });

    expect(moment.companionNames).toBe('아버지, 어머니');
    expect((await db().localMoments.get(moment.id))?.companionNames).toBe('아버지, 어머니');
    expect(await db().syncQueue.where('entityId').equals(moment.id).count()).toBe(1);
  });

  it('수정과 명시적 비우기를 모두 보존한다', async () => {
    const moment = await createMomentLocalFirst({ tripId: 'trip-1', title: '산책', companionNames: '아버지' });
    const updated = await updateMomentLocalFirst(moment.id, { companionNames: ' 아버지, 친구 ' });
    expect(updated.companionNames).toBe('아버지, 친구');

    const cleared = await updateMomentLocalFirst(moment.id, { companionNames: '' });
    expect(cleared.companionNames).toBe('');
  });
});
