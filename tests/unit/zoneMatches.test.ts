// zoneMatches.test.ts — 시간대 검색 판정(domain/time.ts).
//
// 사용자 지적(2026-08-01): *"시간대가 너무 많아서 찾기가 힘들어요. 검색해서 찾을 수
// 있도록 할 수 있나요?"* — 화면(tripDetail.ts buildZoneSelect)이 이 순수 함수로 option을
// 숨긴다. 사용자에게 나가는 필터링 로직이라 유닛이 직접 돌린다(§10 ③).

import { describe, it, expect } from 'vitest';
import { zoneMatches } from '../../src/domain/time';

describe('zoneMatches', () => {
  it('빈 검색어는 전부 통과시킨다(필터 없음 상태)', () => {
    expect(zoneMatches('', 'Asia/Seoul', 'Seoul · 대한민국')).toBe(true);
    expect(zoneMatches('   ', 'Asia/Seoul', 'Seoul · 대한민국')).toBe(true);
  });

  it('id로 찾는다(대소문자 무시)', () => {
    expect(zoneMatches('seoul', 'Asia/Seoul', 'Seoul · 대한민국')).toBe(true);
    expect(zoneMatches('SEOUL', 'Asia/Seoul', 'Seoul · 대한민국')).toBe(true);
    expect(zoneMatches('asia', 'Asia/Seoul', 'Seoul · 대한민국')).toBe(true);
  });

  it('표시 문구(도시명·지역명)로도 찾는다', () => {
    expect(zoneMatches('대한민국', 'Asia/Seoul', 'Seoul · 대한민국')).toBe(true);
    expect(zoneMatches('타슈켄트', 'Asia/Tashkent', 'Tashkent · 우즈베키스탄')).toBe(false); // 표시엔 도시명 로마자만
    expect(zoneMatches('tashkent', 'Asia/Tashkent', 'Tashkent · 우즈베키스탄')).toBe(true);
  });

  it('공백을 지우고 비교한다 — "asia seoul"도 찾는다', () => {
    expect(zoneMatches('asia seoul', 'Asia/Seoul', 'Seoul · 대한민국')).toBe(true);
  });

  it('맞지 않으면 false', () => {
    expect(zoneMatches('paris', 'Asia/Seoul', 'Seoul · 대한민국')).toBe(false);
  });
});
