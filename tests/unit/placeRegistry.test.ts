// tests/unit/placeRegistry.test.ts — 「위치관리대장」의 검색·좌표 미리보기·짧은 주소.
//
// 🔴 좌표 순서를 틀리면 **기억이 엉뚱한 곳에 찍힌다** — M-0057에서 실제로 기니만 앞바다에
// 찍혔다. 그 사고를 막는 장치가 `coordPreview`의 「뒤집으면 여기」이고, 이 유닛이 그 판정의
// 모든 갈래를 돌린다. 특히 **없어야 할 때 없는가**(명확한 좌표에 뒤집기를 권하지 않는가)를
// 함께 재야 공허하지 않다(§4).

import { describe, it, expect } from 'vitest';
import {
  searchRegistry,
  sortRegistry,
  shortAddress,
  coordPreview,
  needsAddress,
  liveLookupNote,
  placeRecordGroups,
  unlinkedPlaceMoments,
  type RegistryPlace,
  type PlaceRecordMoment,
} from '../../src/domain/place/registry';

const P = (over: Partial<RegistryPlace> & { name: string }): RegistryPlace => ({
  id: over.name,
  latitude: 0,
  longitude: 0,
  country: null,
  city: null,
  formattedAddress: null,
  provider: null,
  deletedAt: null,
  ...over,
});

const FIXTURE: RegistryPlace[] = [
  P({ name: '타슈켄트 의대 기숙사', country: '우즈베키스탄', city: '타슈켄트', latitude: 41.3111, longitude: 69.2797 }),
  P({ name: '집', country: '우즈베키스탄', city: '타슈켄트', formattedAddress: 'Yunusobod, Tashkent' }),
  P({ name: '제주 성산일출봉', country: '대한민국', city: '서귀포시', latitude: 33.4581, longitude: 126.9425 }),
  P({ name: '지운 곳', deletedAt: '2026-08-01T00:00:00.000Z' }),
];

describe('검색 — 한 글자라도 포함되면 나온다(사용자 요청)', () => {
  it('이름 부분일치', () => {
    const r = searchRegistry(FIXTURE, '타');
    expect(r.map((p) => p.name)).toContain('타슈켄트 의대 기숙사');
  });

  it('🔴 상한이 없다 — 여섯 번째 장소도 나온다', () => {
    const many = Array.from({ length: 30 }, (_, i) => P({ name: `카페 ${i}` }));
    expect(searchRegistry(many, '카페')).toHaveLength(30);
  });

  it('🔴 이름이 아니라 **도시**로도 찾는다 — 기억하는 실마리가 이름이라는 보장이 없다', () => {
    // 이름이 「집」인 장소를 「타슈켄트」로 찾을 수 있어야 한다.
    const r = searchRegistry(FIXTURE, '타슈켄트');
    expect(r.map((p) => p.name)).toContain('집');
  });

  it('주소 전문으로도 찾는다', () => {
    expect(searchRegistry(FIXTURE, 'yunusobod').map((p) => p.name)).toEqual(['집']);
  });

  it('대소문자를 가리지 않는다', () => {
    expect(searchRegistry(FIXTURE, 'YUNUSOBOD')).toHaveLength(1);
  });

  it('빈 검색어는 전부(대장 기본 상태)', () => {
    expect(searchRegistry(FIXTURE, '  ')).toHaveLength(3); // 지운 것 제외
  });

  it('🔴 지운 장소는 언제나 뺀다 — 검색어가 맞아도', () => {
    expect(searchRegistry(FIXTURE, '지운').map((p) => p.name)).toEqual([]);
  });
});

describe('정렬 — 찾으러 오는 화면이라 가나다순', () => {
  it('이름순으로 선다', () => {
    const r = sortRegistry(searchRegistry(FIXTURE, ''));
    expect(r[0].name).toBe('제주 성산일출봉'); // ㅈ < ㅈ... 한국어 로케일 정렬
    expect(r.map((p) => p.name)).toHaveLength(3);
  });

  it('원본을 바꾸지 않는다(부수효과 없음)', () => {
    const before = FIXTURE.map((p) => p.name);
    sortRegistry(FIXTURE);
    expect(FIXTURE.map((p) => p.name)).toEqual(before);
  });
});

describe('짧은 주소 — 국가·도시까지만(사용자 요청 ④)', () => {
  it('둘 다 있으면 국가 · 도시', () => {
    expect(shortAddress({ country: '우즈베키스탄', city: '타슈켄트' })).toBe('우즈베키스탄 · 타슈켄트');
  });

  it('하나만 있으면 그것만', () => {
    expect(shortAddress({ country: '대한민국', city: null })).toBe('대한민국');
  });

  it('🔴 없으면 「없음」이 아니라 null — 부르는 쪽이 왜 없는지 말한다(§8)', () => {
    expect(shortAddress({ country: null, city: null })).toBeNull();
  });

  it('국가와 도시가 같으면 한 번만 적는다', () => {
    expect(shortAddress({ country: '싱가포르', city: '싱가포르' })).toBe('싱가포르');
  });
});

describe('🔴 좌표 미리보기 — 순서를 틀리면 기억이 엉뚱한 곳에 찍힌다(M-0057)', () => {
  it('타슈켄트(41.3, 69.2)는 **모호하다** — 둘 다 위도로 가능하다', () => {
    const v = coordPreview(41.3111, 69.2797);
    expect(v.ambiguous).toBe(true);
    expect(v.current.label).toBe('41.3111, 69.2797');
    expect(v.swapped.label).toBe('69.2797, 41.3111');
  });

  it('🔴 서울(37.5, 127.0)은 **모호하지 않다** — 뒤집으면 위도 127로 불가능하다', () => {
    // 없어야 할 때 없는가 — 이걸 안 재면 「늘 뒤집기를 권하는」 오탐이 지나간다(§4).
    const v = coordPreview(37.5665, 127.0016);
    expect(v.ambiguous).toBe(false);
    expect(v.swapped.usable).toBe(false);
  });

  it('제주(33.4, 126.9)도 모호하지 않다', () => {
    expect(coordPreview(33.4581, 126.9425).ambiguous).toBe(false);
  });

  it('뒤집은 값이 실제로 뒤집혀 있다', () => {
    const v = coordPreview(10, 20);
    expect(v.swapped.lat).toBe(20);
    expect(v.swapped.lng).toBe(10);
  });

  it('소수점 4자리로 표시한다 — 사람이 눈으로 대조할 해상도', () => {
    expect(coordPreview(41.31111111, 69.27979999).current.label).toBe('41.3111, 69.2798');
  });

  it('범위 밖 좌표는 usable이 false', () => {
    expect(coordPreview(200, 300).current.usable).toBe(false);
  });
});

describe('치는 동안 못 찾았을 때의 한 줄 — 침묵은 「그런 곳은 없다」로 읽힌다(§7-C)', () => {
  it('🔴 안 친 상태에서는 먼저 말하지 않는다(§8 침묵이 정상)', () => {
    expect(liveLookupNote('', 12)).toBeNull();
    expect(liveLookupNote('   ', 12)).toBeNull();
  });

  it('🔴 시야의 경계를 밝힌다 — 「없다」가 아니라 「**내 장소** 중에 없다」', () => {
    const s = liveLookupNote('시', 12)!;
    expect(s).toContain('내 장소');
    expect(s).toContain('12곳');
    // 막다른 문장으로 끝내지 않는다 — 다음에 할 일을 준다.
    expect(s).toContain('검색');
  });

  it('🔴 대장이 비었으면 「없다」가 아니라 **아직 안 쌓였다**라고 말한다', () => {
    const s = liveLookupNote('시', 0)!;
    expect(s).toContain('아직');
    expect(s).not.toContain('0곳'); // 「0곳 중에 없어요」는 사람이 쓰는 말이 아니다
    expect(s).toContain('지도');
  });

  it('마크다운을 쓰지 않는다 — textContent로 그려진다(§5 7항)', () => {
    for (const total of [0, 1, 99]) expect(liveLookupNote('시', total)).not.toContain('**');
  });
});

describe('주소를 아직 못 받은 장소', () => {
  it('국가·도시가 둘 다 없으면 true', () => {
    expect(needsAddress(P({ name: 'x' }))).toBe(true);
  });

  it('하나라도 있으면 false', () => {
    expect(needsAddress(P({ name: 'x', country: '대한민국' }))).toBe(false);
  });
});

describe('이 장소가 담긴 기록 — 직접 링크와 이름만 같은 추정을 여행별로 분리', () => {
  const M = (over: Partial<PlaceRecordMoment> & { id: string; tripId: string; tripTitle: string }): PlaceRecordMoment => ({
    title: '사진 제목', occurredAt: '2026-08-07T00:00:00.000Z', placeName: '집', placeId: null,
    deletedAt: null, ...over,
  });

  it('직접 연결은 확실한 묶음, 이름만 같은 것은 별도 여행 묶음으로 만든다', () => {
    const groups = placeRecordGroups([
      M({ id: 'm1', tripId: 't1', tripTitle: '여름 여행', placeId: 'place-1' }),
      M({ id: 'm2', tripId: 't1', tripTitle: '여름 여행', placeId: 'place-1' }),
      M({ id: 'm3', tripId: 't2', tripTitle: '겨울 여행' }),
      M({ id: 'm4', tripId: 't3', tripTitle: '지운 여행', placeId: 'place-1', deletedAt: '2026-08-07T01:00:00.000Z' }),
      M({ id: 'm5', tripId: 't4', tripTitle: '다른 집', placeId: 'place-2' }),
    ], { id: 'place-1', name: '집' });

    expect(groups.linked).toHaveLength(1);
    expect(groups.linked[0]).toMatchObject({ tripId: 't1', tripTitle: '여름 여행' });
    expect(groups.linked[0]!.moments.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(groups.sameName).toHaveLength(1);
    expect(groups.sameName[0]!.tripId).toBe('t2');
  });

  it('대장 ID가 끊긴 활성 순간만 연결 필요 목록에 놓고 장소·순간·여행 이름으로 찾는다', () => {
    const moments = [
      M({ id: 'orphan', tripId: 't1', tripTitle: '유학 생활', title: '종강기념', placeName: 'TSMU 4번 건물' }),
      M({ id: 'linked', tripId: 't1', tripTitle: '유학 생활', placeId: 'p1', placeName: '연결됨' }),
      M({ id: 'blank', tripId: 't2', tripTitle: '빈 장소', placeName: '' }),
      M({ id: 'deleted', tripId: 't3', tripTitle: '휴지통', placeName: '옛 장소', deletedAt: '2026-08-07T00:00:00.000Z' }),
    ];

    expect(unlinkedPlaceMoments(moments, '').map((m) => m.id)).toEqual(['orphan']);
    expect(unlinkedPlaceMoments(moments, '종강').map((m) => m.id)).toEqual(['orphan']);
    expect(unlinkedPlaceMoments(moments, '유학').map((m) => m.id)).toEqual(['orphan']);
    expect(unlinkedPlaceMoments(moments, '없는 값')).toEqual([]);
  });
});
