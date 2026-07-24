// 원근 보정(4점 펴기) 순수 함수 검증 — 호모그래피 계수·워프·quad 회전/반전·출력 크기.
import { describe, it, expect } from 'vitest';
import {
  squareToQuadCoeffs,
  quadOutputDims,
  rotateQuad90,
  flipQuadH,
  isIdentity,
  freshEdit,
  type Quad,
} from '../../src/media/editor-core';
import { warpPerspective } from '../../src/media/pixelops';

const FULL: Quad = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

/** (s,t) → 원본 px 사영 적용(테스트용). */
function apply(coeffs: number[], s: number, t: number): { x: number; y: number } {
  const [a, b, c, d, e, f, g, h] = coeffs as [number, number, number, number, number, number, number, number];
  const den = g * s + h * t + 1;
  return { x: (a * s + b * t + c) / den, y: (d * s + e * t + f) / den };
}

/** 4×4 테스트 이미지: 픽셀 (x,y)에 R=x*40, G=y*40 저장(위치 식별 가능). */
function grid4(): Uint8ClampedArray {
  const d = new Uint8ClampedArray(4 * 4 * 4);
  for (let y = 0; y < 4; y += 1)
    for (let x = 0; x < 4; x += 1) {
      const o = (y * 4 + x) * 4;
      d[o] = x * 40;
      d[o + 1] = y * 40;
      d[o + 3] = 255;
    }
  return d;
}

describe('squareToQuadCoeffs(호모그래피)', () => {
  it('전체 사각형(항등): 모서리·중앙이 그대로 매핑', () => {
    const c = squareToQuadCoeffs(FULL, 100, 80);
    expect(apply(c, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(apply(c, 1, 0)).toEqual({ x: 100, y: 0 });
    expect(apply(c, 1, 1)).toEqual({ x: 100, y: 80 });
    expect(apply(c, 0, 1)).toEqual({ x: 0, y: 80 });
    expect(apply(c, 0.5, 0.5)).toEqual({ x: 50, y: 40 });
  });

  it('사다리꼴(원근): 네 모서리가 정확히 quad 모서리로 매핑', () => {
    const q: Quad = [{ x: 0.2, y: 0.1 }, { x: 0.8, y: 0.15 }, { x: 0.95, y: 0.9 }, { x: 0.05, y: 0.85 }];
    const c = squareToQuadCoeffs(q, 200, 100);
    const near = (p: { x: number; y: number }, x: number, y: number) => {
      expect(p.x).toBeCloseTo(x, 6);
      expect(p.y).toBeCloseTo(y, 6);
    };
    near(apply(c, 0, 0), 40, 10);
    near(apply(c, 1, 0), 160, 15);
    near(apply(c, 1, 1), 190, 90);
    near(apply(c, 0, 1), 10, 85);
  });
});

describe('warpPerspective', () => {
  it('항등 quad → 픽셀 완전 동일', () => {
    const src = grid4();
    const out = warpPerspective(src, 4, 4, 4, 4, squareToQuadCoeffs(FULL, 4, 4));
    expect([...out]).toEqual([...src]);
  });

  it('왼쪽 절반 quad → 왼쪽 2열이 정확히 추출된다', () => {
    const src = grid4();
    const half: Quad = [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 1 }, { x: 0, y: 1 }];
    const out = warpPerspective(src, 4, 4, 2, 4, squareToQuadCoeffs(half, 4, 4));
    // 출력 (i,j)는 원본 (i,j)와 동일해야(픽셀 중심 정렬로 정확히 격자에 떨어짐)
    for (let j = 0; j < 4; j += 1)
      for (let i = 0; i < 2; i += 1) {
        const o = (j * 2 + i) * 4;
        expect(out[o]).toBe(i * 40); // R=x
        expect(out[o + 1]).toBe(j * 40); // G=y
      }
  });

  it('비공허: 기울어진 quad는 항등과 다른 픽셀을 만든다', () => {
    const src = grid4();
    const tilted: Quad = [{ x: 0.25, y: 0 }, { x: 1, y: 0 }, { x: 0.75, y: 1 }, { x: 0, y: 1 }];
    const out = warpPerspective(src, 4, 4, 4, 4, squareToQuadCoeffs(tilted, 4, 4));
    expect([...out]).not.toEqual([...src]);
  });
});

describe('quad 변환·상태', () => {
  const q: Quad = [{ x: 0.1, y: 0.2 }, { x: 0.9, y: 0.1 }, { x: 0.8, y: 0.9 }, { x: 0.2, y: 0.8 }];

  it('rotateQuad90 4회 = 원위치(순서 포함)', () => {
    let r = q;
    for (let i = 0; i < 4; i += 1) r = rotateQuad90(r);
    for (let i = 0; i < 4; i += 1) {
      expect(r[i]!.x).toBeCloseTo(q[i]!.x, 9);
      expect(r[i]!.y).toBeCloseTo(q[i]!.y, 9);
    }
  });

  it('rotateQuad90: 옛 TL이 새 TR 위치로(CW 회전 의미 보존)', () => {
    const r = rotateQuad90(q);
    // 새 TR = 옛 TL 점의 회전상: (x,y)→(1-y,x)
    expect(r[1]).toEqual({ x: 1 - q[0]!.y, y: q[0]!.x });
    // 새 TL = 옛 BL의 회전상
    expect(r[0]).toEqual({ x: 1 - q[3]!.y, y: q[3]!.x });
  });

  it('flipQuadH 2회 = 원위치(FP 오차 허용), TL↔TR 교환', () => {
    const f = flipQuadH(q);
    expect(f[0]).toEqual({ x: 1 - q[1]!.x, y: q[1]!.y });
    const ff = flipQuadH(f);
    for (let i = 0; i < 4; i += 1) {
      expect(ff[i]!.x).toBeCloseTo(q[i]!.x, 9);
      expect(ff[i]!.y).toBeCloseTo(q[i]!.y, 9);
    }
  });

  it('quadOutputDims: 전체=원크기, 절반폭 quad=절반폭', () => {
    expect(quadOutputDims(FULL, 200, 100)).toEqual({ w: 200, h: 100 });
    const half: Quad = [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 1 }, { x: 0, y: 1 }];
    expect(quadOutputDims(half, 200, 100)).toEqual({ w: 100, h: 100 });
  });

  it('isIdentity: quad가 있으면 무편집이 아니다', () => {
    const s = freshEdit();
    expect(isIdentity(s)).toBe(true);
    s.quad = FULL;
    expect(isIdentity(s)).toBe(false);
  });
});
