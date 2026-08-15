import { describe, expect, it } from 'vitest';
import {
  addCompanion,
  companionKey,
  companionTally,
  formatCompanions,
  momentHasCompanion,
  parseCompanions,
  removeCompanion,
} from '../../src/domain/moment/companions';

describe('parseCompanions — 한 덩어리를 사람 단위로 읽는다', () => {
  it('쉼표로 나누고 앞뒤 공백을 버린다', () => {
    expect(parseCompanions('러윈형님, 러원이')).toEqual(['러윈형님', '러원이']);
    expect(parseCompanions('  아빠 ,엄마  ')).toEqual(['아빠', '엄마']);
  });

  it('전각 쉼표와 가운뎃점도 구분자다(한국어 입력에서 실제로 섞인다)', () => {
    expect(parseCompanions('아빠，엄마·형')).toEqual(['아빠', '엄마', '형']);
  });

  it('빈 값·구분자만 있는 값은 사람이 아니다', () => {
    for (const raw of ['', '   ', ',,,', null, undefined]) {
      expect(parseCompanions(raw)).toEqual([]);
    }
  });

  it('🔴 같은 이름이 두 번 나오면 한 번만 센다(칩이 두 개 그려지면 안 된다)', () => {
    expect(parseCompanions('아빠, 아빠, 엄마')).toEqual(['아빠', '엄마']);
  });

  it('🔴 사용자가 적은 순서를 지어낸 순서로 덮지 않는다(가나다 정렬 금지)', () => {
    expect(parseCompanions('하늘, 가람, 나무')).toEqual(['하늘', '가람', '나무']);
  });
});

describe('companionKey — 같은 사람인가의 판정은 여기 한 곳에서만', () => {
  it('대소문자와 안쪽 공백만 무시한다', () => {
    expect(companionKey('John  Doe')).toBe(companionKey('john doe'));
    expect(companionKey(' 아빠 ')).toBe(companionKey('아빠'));
  });

  it('🔴 별명·부분 일치를 짐작하지 않는다 — 사용자의 기억을 앱이 지어내지 않는다', () => {
    expect(companionKey('러원이')).not.toBe(companionKey('러원'));
    expect(companionKey('김민수')).not.toBe(companionKey('김민수아버지'));
  });
});

describe('addCompanion / removeCompanion — 토큰 입력의 계약', () => {
  it('없으면 더하고 있으면 그대로 둔다', () => {
    expect(addCompanion(['아빠'], '엄마')).toEqual(['아빠', '엄마']);
    expect(addCompanion(['아빠'], '아빠')).toEqual(['아빠']);
    expect(addCompanion(['아빠'], ' 아 빠 ')).toEqual(['아빠', '아 빠']); // 안쪽 공백은 다른 이름이다
  });

  it('빈 입력은 아무 일도 하지 않는다', () => {
    expect(addCompanion(['아빠'], '   ')).toEqual(['아빠']);
  });

  it('🔴 목록을 통째로 붙여넣어도 한 사람으로 저장하지 않는다', () => {
    expect(addCompanion([], '아빠, 엄마·형')).toEqual(['아빠', '엄마', '형']);
  });

  it('🔴 원본 배열을 조용히 바꾸지 않는다', () => {
    const before = ['아빠'];
    addCompanion(before, '엄마');
    removeCompanion(before, '아빠');
    expect(before).toEqual(['아빠']);
  });

  it('뺄 때도 같은 사람 판정을 쓴다', () => {
    expect(removeCompanion(['아빠', '엄마'], ' 아빠 ')).toEqual(['엄마']);
  });
});

describe('formatCompanions — 저장 계약은 예전 그대로다', () => {
  it('왕복해도 사람이 늘거나 줄지 않는다', () => {
    const names = ['러윈형님', '러원이'];
    expect(parseCompanions(formatCompanions(names))).toEqual(names);
  });
});

describe('momentHasCompanion — 「이 사람과 함께한 기록」의 판정', () => {
  it('덩어리 안에 있으면 참이다', () => {
    expect(momentHasCompanion('러윈형님, 러원이', '러원이')).toBe(true);
    expect(momentHasCompanion('러윈형님, 러원이', ' 러윈형님 ')).toBe(true);
  });

  it('🔴 부분 일치는 거짓이다 — 「러원」은 「러원이」가 아니다', () => {
    expect(momentHasCompanion('러원이', '러원')).toBe(false);
  });

  it('비어 있으면 거짓이다', () => {
    expect(momentHasCompanion('', '아빠')).toBe(false);
    expect(momentHasCompanion(null, '아빠')).toBe(false);
  });
});

describe('companionTally — 누구와 몇 번', () => {
  it('많이 함께한 사람이 먼저 온다', () => {
    const tally = companionTally([
      { companionNames: '아빠, 엄마' },
      { companionNames: '아빠' },
      { companionNames: '' },
    ]);
    expect(tally).toEqual([{ name: '아빠', count: 2 }, { name: '엄마', count: 1 }]);
  });

  it('🔴 표기가 흔들리면 **가장 많이 쓰인 표기**를 보여 준다(지어내지 않는다)', () => {
    const tally = companionTally([
      { companionNames: '러원이' },
      { companionNames: '러원이' },
      { companionNames: '러원이  ' }, // 앞뒤 공백은 같은 이름이다
      { companionNames: 'Lee  Won' },
      { companionNames: 'lee won' },
    ]);
    expect(tally[0]).toEqual({ name: '러원이', count: 3 });
    expect(tally[1]?.count).toBe(2);
  });

  it('아무도 없으면 빈 목록이다(0을 지어내지 않는다)', () => {
    expect(companionTally([{ companionNames: null }, {}])).toEqual([]);
  });
});
