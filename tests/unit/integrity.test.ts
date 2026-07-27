// tests/unit/integrity.test.ts — ID 무결성 점검이 **실제로 잡는가**
//
// 진단 도구는 틀리면 거짓 경보를 내고, 거짓 경보는 결함만큼 해롭다(M-0008에서 실제로 겪었다).
// 그래서 각 분류마다 **잡아야 할 경우와 잡으면 안 되는 경우를 쌍으로** 검사한다.

import { describe, it, expect } from 'vitest';
import { checkIntegrity, type IntegritySnapshot } from '../../src/domain/integrity';

const U = (n: number): string => `${String(n).padStart(8, '0')}-1111-4222-8333-444444444444`;
const base = (id: string): { id: string; deletedAt: null; createdAt: string; updatedAt: string; version: number } => ({
  id,
  deletedAt: null,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-02T00:00:00.000Z',
  version: 1,
});
const empty: IntegritySnapshot = { trips: [], moments: [], media: [], expenses: [], audio: [] };
/** 스냅샷을 **빈 것 위에 얹어** 만든다 — 도메인이 늘어도 검사가 손대야 할 곳이 한 줄이다. */
const snap = (p: Partial<IntegritySnapshot>): IntegritySnapshot => ({ ...empty, ...p });
const codes = (s: IntegritySnapshot): string[] => checkIntegrity(s).findings.map((f) => f.code);

describe('무결성 점검 — 정상은 조용하다', () => {
  it('빈 데이터는 아무 지적도 없다', () => {
    const r = checkIntegrity(empty);
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('앞뒤가 맞는 데이터는 사진 없는 순간(참고)만 낸다', () => {
    const trip = base(U(1));
    const moment = { ...base(U(2)), tripId: trip.id };
    const media = { ...base(U(3)), tripId: trip.id, momentId: moment.id };
    const r = checkIntegrity(snap({ trips: [trip], moments: [moment], media: [media] }));
    expect(r.findings).toEqual([]); // 사진이 있으므로 그 참고 항목도 안 뜬다
    expect(r.ok).toBe(true);
  });
});

describe('무결성 점검 — 잡아야 할 것을 잡는다', () => {
  it('부모 없는 자식(ORPHAN_PARENT)', () => {
    const moment = { ...base(U(2)), tripId: U(99) }; // 없는 여행
    expect(codes({ ...empty, moments: [moment] })).toContain('ORPHAN_PARENT');
  });

  it('지운 부모 아래 살아 있는 자식(ALIVE_UNDER_DELETED)', () => {
    const trip = { ...base(U(1)), deletedAt: '2026-07-03T00:00:00.000Z' };
    const moment = { ...base(U(2)), tripId: trip.id };
    const found = codes({ ...empty, trips: [trip], moments: [moment] });
    expect(found).toContain('ALIVE_UNDER_DELETED');
    expect(found).not.toContain('ORPHAN_PARENT'); // 부모는 존재한다 — 다른 진단이어야 한다
  });

  it('지운 부모 + 지운 자식은 정상 — 겁주지 않는다', () => {
    const trip = { ...base(U(1)), deletedAt: '2026-07-03T00:00:00.000Z' };
    const moment = { ...base(U(2)), tripId: trip.id, deletedAt: '2026-07-03T00:00:00.000Z' };
    expect(codes({ ...empty, trips: [trip], moments: [moment] })).not.toContain('ALIVE_UNDER_DELETED');
  });

  it('없는 사진을 대표로 지정(DANGLING_COVER)', () => {
    const trip = { ...base(U(1)), coverMediaId: U(77) };
    expect(codes({ ...empty, trips: [trip] })).toContain('DANGLING_COVER');
  });

  it('id 형식 위반(BAD_ID_FORMAT)', () => {
    expect(codes({ ...empty, trips: [base('not-a-uuid')] })).toContain('BAD_ID_FORMAT');
  });

  it('같은 id 중복(DUPLICATE_ID)', () => {
    const t = base(U(1));
    const m = { ...base(U(1)), tripId: U(1) }; // 다른 테이블에 같은 id
    expect(codes({ ...empty, trips: [t], moments: [m] })).toContain('DUPLICATE_ID');
  });

  it('시간 역전(TIME_INVERSION)', () => {
    const t = { ...base(U(1)), createdAt: '2026-07-05T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' };
    expect(codes({ ...empty, trips: [t] })).toContain('TIME_INVERSION');
  });

  it('세대 번호 이상(BAD_VERSION)', () => {
    expect(codes({ ...empty, trips: [{ ...base(U(1)), version: 0 }] })).toContain('BAD_VERSION');
  });

  it('좌표 범위 밖(COORD_RANGE)', () => {
    const trip = base(U(1));
    const m = { ...base(U(2)), tripId: trip.id, lat: 120, lng: 0 };
    expect(codes({ ...empty, trips: [trip], moments: [m] })).toContain('COORD_RANGE');
  });

  it('비용 금액 이상(BAD_AMOUNT)', () => {
    const trip = base(U(1));
    const moment = { ...base(U(2)), tripId: trip.id };
    const e = { ...base(U(3)), tripId: trip.id, momentId: moment.id, originalAmount: 0 };
    expect(codes(snap({ trips: [trip], moments: [moment], expenses: [e] }))).toContain('BAD_AMOUNT');
  });

  it('사진 없는 순간은 참고(info)일 뿐 문제가 아니다', () => {
    const trip = base(U(1));
    const moment = { ...base(U(2)), tripId: trip.id };
    const r = checkIntegrity({ ...empty, trips: [trip], moments: [moment] });
    expect(r.findings.map((f) => f.code)).toContain('MOMENT_NO_MEDIA');
    expect(r.ok).toBe(true); // info는 ok를 깨지 않는다
  });
});

describe('보고 형태 — 사람이 추적할 수 있어야 한다', () => {
  it('심각한 것이 먼저 오고, 대표 사례 id를 최대 3개 준다', () => {
    const trips = [1, 2, 3, 4].map((i) => ({ ...base(U(i)), coverMediaId: U(90 + i) }));
    const orphan = { ...base(U(50)), tripId: U(99) };
    const r = checkIntegrity({ ...empty, trips, moments: [orphan] });
    expect(r.findings[0]!.severity).toBe('now'); // 정렬: now → prevent → info
    const cover = r.findings.find((f) => f.code === 'DANGLING_COVER')!;
    expect(cover.count).toBe(4);
    expect(cover.samples).toHaveLength(3); // 개수는 전부, 사례는 3개까지
    expect(cover.samples[0]).toHaveLength(8); // id 앞 8자리
  });
});
