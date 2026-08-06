// 한 순간 안의 사진 순서 — 사용자가 손으로 정한 자리가 기계가 만든 값(촬영시각)을 이긴다.
//
// 🔴 이 검사가 지키는 것: 예전엔 정렬이 **아예 없어** 화면 순서가 무작위 uuid 순이었다.
// 기기마다 다를 수도 있었다. 「순서를 바꾸는 기능」보다 **순서가 있는 것**이 먼저였다.

import { describe, it, expect } from 'vitest';
import { orderPhotos, moveItem, renumber, dropIndex, type OrderableMedia } from '../../src/domain/media/order';

const p = (id: string, takenAt: string, sortOrder: number | null = null): OrderableMedia => ({ id, takenAt, sortOrder });
const ids = (rows: OrderableMedia[]): string[] => rows.map((r) => r.id);

describe('orderPhotos — 아무도 손대지 않은 순간', () => {
  it('촬영시각 순으로 놓는다 — 그날의 흐름이 그 순서다', () => {
    const rows = [p('c', '2026-08-06T10:00:00Z'), p('a', '2026-08-06T08:00:00Z'), p('b', '2026-08-06T09:00:00Z')];
    expect(ids(orderPhotos(rows))).toEqual(['a', 'b', 'c']);
  });

  // 🔴 M-0034: 서버는 `…+00:00`, 로컬은 `…Z`로 **같은 순간을 다르게 적는다.**
  // 문자열 대소로 비교하면 `'0'`(0x30) > `'+'`(0x2B)라 같은 순간이 다르게 읽힌다.
  it('표기가 달라도 같은 순간은 같게 읽는다(문자열 대소가 아니다)', () => {
    const rows = [p('later', '2026-08-06T10:00:00.000Z'), p('same', '2026-08-06T09:00:00+00:00')];
    expect(ids(orderPhotos(rows))).toEqual(['same', 'later']);
  });

  it('시각이 같으면 id로 가른다 — 기기마다 같은 화면이 나와야 한다', () => {
    const t = '2026-08-06T09:00:00Z';
    expect(ids(orderPhotos([p('b', t), p('a', t)]))).toEqual(['a', 'b']);
    // 두 번 돌려도 같은 결과(결정적)
    expect(ids(orderPhotos([p('a', t), p('b', t)]))).toEqual(['a', 'b']);
  });

  it('원본 배열을 바꾸지 않는다', () => {
    const rows = [p('b', '2026-08-06T10:00:00Z'), p('a', '2026-08-06T08:00:00Z')];
    orderPhotos(rows);
    expect(ids(rows)).toEqual(['b', 'a']);
  });
});

describe('orderPhotos — 사용자가 정한 순서가 있을 때', () => {
  it('사용자가 정한 자리가 촬영시각을 이긴다', () => {
    const rows = [
      p('a', '2026-08-06T08:00:00Z', 2),
      p('b', '2026-08-06T09:00:00Z', 0),
      p('c', '2026-08-06T10:00:00Z', 1),
    ];
    expect(ids(orderPhotos(rows))).toEqual(['b', 'c', 'a']);
  });

  // 🔴 새로 넣은 사진이 **중간에 끼어들면** 사용자가 정해 둔 배열이 소리 없이 흐트러진다.
  it('아직 자리를 안 정한 사진은 맨 뒤에 붙는다', () => {
    const rows = [p('new', '2026-01-01T00:00:00Z'), p('a', '2026-08-06T08:00:00Z', 0)];
    expect(ids(orderPhotos(rows))).toEqual(['a', 'new']);
  });

  // 0은 값이다 — falsy로 뭉개면 첫 번째 사진이 「자리 없음」으로 읽힌다(M-0057의 형태).
  it('sortOrder 0을 「없음」으로 읽지 않는다', () => {
    const rows = [p('zero', '2026-08-06T10:00:00Z', 0), p('none', '2026-08-06T08:00:00Z', null)];
    expect(ids(orderPhotos(rows))).toEqual(['zero', 'none']);
  });
});

describe('moveItem — 드래그가 끝났을 때', () => {
  const list = ['a', 'b', 'c', 'd'];

  it('앞으로 옮긴다', () => expect(moveItem(list, 2, 0)).toEqual(['c', 'a', 'b', 'd']));
  it('뒤로 옮긴다', () => expect(moveItem(list, 0, 3)).toEqual(['b', 'c', 'd', 'a']));
  it('제자리면 그대로', () => expect(moveItem(list, 1, 1)).toEqual(list));

  // 잘못된 입력을 「그럴듯한 결과」로 바꾸면 그 결함이 화면까지 살아서 간다(§8).
  it('범위 밖 인덱스는 조용히 자르지 않고 그대로 돌려준다', () => {
    expect(moveItem(list, -1, 2)).toEqual(list);
    expect(moveItem(list, 0, 9)).toEqual(list);
  });

  it('원본을 바꾸지 않는다', () => {
    const src = ['a', 'b'];
    moveItem(src, 0, 1);
    expect(src).toEqual(['a', 'b']);
  });
});

describe('renumber — 한 번 손대면 그 순간은 전부 사용자 것', () => {
  it('0부터 차례로 매긴다', () => {
    const m = renumber(['x', 'y', 'z']);
    expect([m.get('x'), m.get('y'), m.get('z')]).toEqual([0, 1, 2]);
  });

  // 🔴 일부만 매기면 「일부는 내 순서, 일부는 촬영시각」이 되어 규칙을 예측할 수 없다.
  it('전부에 번호가 붙는다 — 빠지는 것이 없다', () => {
    const list = ['a', 'b', 'c', 'd', 'e'];
    const m = renumber(list);
    expect(m.size).toBe(list.length);
    for (const id of list) expect(typeof m.get(id)).toBe('number');
  });
});

describe('dropIndex — 지금 놓으면 몇 번째인가', () => {
  // 🔴 돌려주는 값의 뜻은 `moveItem`의 `to`와 **같다**(= 앉을 자리). 처음엔 「앞에 끼운다」로
  // 짰다가 두 뜻이 섞여 이 유닛이 RED로 잡았다 — 같은 이름이 두 가지를 뜻하면 결함의 씨앗이다.
  const row = [0, 1, 2, 3].map((i) => ({ left: i * 100, right: i * 100 + 100, top: 0, bottom: 100 }));

  it('포인터가 올라간 칸의 번호를 준다', () => {
    expect(dropIndex(row, 210, 50, 9)).toBe(2);
    expect(dropIndex(row, 260, 50, 9)).toBe(2); // 같은 칸 안이면 왼/오른쪽 절반과 무관하다
    expect(dropIndex(row, 5, 50, 9)).toBe(0);
    expect(dropIndex(row, 390, 50, 9)).toBe(3);
  });

  it('칸 바깥으로 끌면 그 줄의 첫/마지막으로 붙인다', () => {
    expect(dropIndex(row, -50, 50, 9)).toBe(0);
    expect(dropIndex(row, 999, 50, 9)).toBe(3);
  });

  // 격자가 접히면 y가 다른 줄의 칸과 비교되면 안 된다.
  it('두 줄일 때 같은 줄 안에서만 비교한다', () => {
    const grid = [
      { left: 0, right: 100, top: 0, bottom: 100 },
      { left: 100, right: 200, top: 0, bottom: 100 },
      { left: 0, right: 100, top: 110, bottom: 210 },
      { left: 100, right: 200, top: 110, bottom: 210 },
    ];
    expect(dropIndex(grid, 10, 150, 9)).toBe(2); // 둘째 줄 첫 칸
    expect(dropIndex(grid, 190, 50, 9)).toBe(1); // 첫 줄 둘째 칸
  });

  it('줄 사이(간격)로 끌면 방향대로 붙인다', () => {
    const grid = [
      { left: 0, right: 100, top: 0, bottom: 100 },
      { left: 0, right: 100, top: 110, bottom: 210 },
    ];
    expect(dropIndex(grid, 50, 105, 9)).toBe(1); // 아래로 끌었다 → 마지막
    expect(dropIndex(grid, 50, -20, 9)).toBe(0); // 위로 끌었다 → 첫 칸
  });

  it('빈 목록이면 넘겨준 기본값을 그대로 돌려준다(지어내지 않는다)', () => {
    expect(dropIndex([], 10, 10, 7)).toBe(7);
  });
});
