import { describe, expect, it } from 'vitest';
import { findPlaceZombieCandidates, type PlaceZombieRow } from '../../src/domain/placeZombieVerdict';

const row = (overrides: Partial<PlaceZombieRow> = {}): PlaceZombieRow => ({
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  name: 'TSMU 대학병원 4번 건물',
  latitude: 41.3505,
  longitude: 69.172,
  deletedAt: null,
  updatedAt: '2026-08-08T00:00:00.000Z',
  ...overrides,
});

describe('삭제 뒤 장소 재생성 후보', () => {
  it('삭제 표식과 정규화한 이름·좌표가 같은 새 활성 UUID만 후보로 남긴다', () => {
    const found = findPlaceZombieCandidates([
      row({ id: 'deleted', deletedAt: '2026-08-07T00:00:00.000Z' }),
      row({ id: 'active', name: ' TSMU   대학병원 4번 건물 ' }),
      row({ id: 'other', name: 'TSMU 대학병원 4번 건물', longitude: 69.172001 }),
    ]);
    expect(found).toEqual([{ activeId: 'active', deletedIds: ['deleted'] }]);
  });

  it('삭제 표식이 여러 개여도 활성 장소 하나를 중복 경보하지 않는다', () => {
    const found = findPlaceZombieCandidates([
      row({ id: 'deleted-b', deletedAt: '2026-08-07T00:00:00.000Z' }),
      row({ id: 'deleted-a', deletedAt: '2026-08-06T00:00:00.000Z' }),
      row({ id: 'active' }),
    ]);
    expect(found).toEqual([{ activeId: 'active', deletedIds: ['deleted-a', 'deleted-b'] }]);
  });

  it('이름만 같은 다른 좌표나 삭제 표식이 없는 장소는 후보로 만들지 않는다', () => {
    expect(findPlaceZombieCandidates([
      row({ id: 'same-name-far', latitude: 41.35, longitude: 69.17 }),
      row({ id: 'active', name: '같은 이름' }),
    ])).toEqual([]);
  });
});
