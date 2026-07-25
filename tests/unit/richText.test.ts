// tests/unit/richText.test.ts — `**강조**`가 **화면에서 별표로 보이지 않는가**.
//
// 실제 결함(M-0012, 2026-07-26 사용자 화면 캡처에서 발견): 휴지통의 영구삭제 설명이
// "영구삭제는 되돌릴 수 없어요. **이 기기의 저장공간**을 비우는 것이며…" 로 **별표가 그대로**
// 찍혔다. 렌더가 textContent였기 때문이다.
//
// 처음 처방은 "화면 문자열에 마크다운 쓰지 마라 + 게이트"였는데, 그 게이트의 대상 파일을 손으로
// 6개 골라 dataManager·r2Setup·changelog가 통째로 빠졌다 — 규칙을 문자열 쪽에 걸었기 때문이다.
// 지금은 렌더러 한 곳(el/applyText)이 처리한다. 이 검사가 그 규칙을 지킨다.
//
// 층 분리(정직): 여기서는 **순수 파싱 규칙**만 검사한다(유닛 환경에 DOM 없음).
// 실제로 `<strong>`이 그려지고 별표가 화면에 없다는 것은 verify-editor-live가 실제 브라우저에서 본다.

import { describe, it, expect } from 'vitest';
import { parseEmphasis } from '../../src/ui/dom';

const rendered = (s: string): string => parseEmphasis(s).map((r) => r.text).join('');
const bolds = (s: string): string[] => parseEmphasis(s).filter((r) => r.bold).map((r) => r.text);

describe('강조 파싱 — 별표는 화면에 남지 않는다', () => {
  it('실제 결함 문구: 별표가 사라지고 강조 조각이 생긴다', () => {
    const s = '영구삭제는 되돌릴 수 없어요. **이 기기의 저장공간**을 비우는 것이며, 다른 기기에는 그대로 남아 있을 수 있습니다.';
    expect(bolds(s)).toEqual(['이 기기의 저장공간']);
    expect(rendered(s)).not.toContain('*');
    expect(rendered(s)).toBe('영구삭제는 되돌릴 수 없어요. 이 기기의 저장공간을 비우는 것이며, 다른 기기에는 그대로 남아 있을 수 있습니다.');
  });

  it('강조가 여러 개여도 전부 처리된다', () => {
    expect(bolds('**하나** 그리고 **둘**')).toEqual(['하나', '둘']);
    expect(rendered('**하나** 그리고 **둘**')).toBe('하나 그리고 둘');
  });

  it('문장 맨 앞·맨 뒤 강조도 처리된다', () => {
    expect(bolds('**앞**은 강조')).toEqual(['앞']);
    expect(bolds('끝이 **뒤**')).toEqual(['뒤']);
  });

  it('강조가 없는 문자열은 조각 하나로 그대로 (동작 변화 없음)', () => {
    expect(parseEmphasis('평범한 문장입니다')).toEqual([{ text: '평범한 문장입니다', bold: false }]);
  });
});

describe('강조 파싱 — 정직함(사용자 글자를 삼키지 않는다)', () => {
  it('짝이 안 맞는 **는 먹지 않고 평문으로 되돌린다', () => {
    expect(rendered('앞 **닫히지 않은 강조')).toBe('앞 **닫히지 않은 강조');
    expect(bolds('앞 **닫히지 않은 강조')).toEqual([]);
  });

  it('세 개짜리 **도 글자를 잃지 않는다', () => {
    const s = '**하나** 그리고 **열린채';
    expect(rendered(s)).toBe('하나 그리고 **열린채');
    expect(bolds(s)).toEqual(['하나']);
  });

  it('어떤 입력이든 별표를 제외한 글자 수가 보존된다', () => {
    for (const s of ['a**b**c', '**', '****', 'x**y', '**a**b**c**', '별표 없음', '']) {
      const out = parseEmphasis(s).map((r) => r.text).join('');
      expect(out.replace(/\*/g, '').length).toBe(s.replace(/\*/g, '').length);
    }
  });

  it('빈 문자열은 조각 없음', () => {
    expect(parseEmphasis('')).toEqual([]);
  });

  it('마크업처럼 보이는 글자는 텍스트로 남는다(삽입되지 않음)', () => {
    const s = '<img src=x onerror=alert(1)> **강조**';
    expect(rendered(s)).toContain('<img src=x onerror=alert(1)>');
    expect(bolds(s)).toEqual(['강조']);
  });
});
