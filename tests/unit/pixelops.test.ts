// tests/unit/pixelops.test.ts — 사진 편집 픽셀 연산·크롭 기하 비공허 검증.
import { describe, it, expect } from 'vitest';
import { applyColorAdjust, sharpen, grain, healSpot, NO_ADJUST } from '../../src/media/pixelops';
import {
  cropWindow,
  rotatedDims,
  angleCoverScale,
  resolveWindow,
  rotateHeals90,
  flipHealsH,
  rotateFreeCrop90,
  resizeFreeCrop,
  isIdentity,
  freshEdit,
} from '../../src/media/editor-core';

function px(r: number, g: number, b: number): Uint8ClampedArray {
  return new Uint8ClampedArray([r, g, b, 255]);
}

describe('applyColorAdjust', () => {
  it('무조정이면 픽셀 불변', () => {
    const d = px(120, 90, 200);
    applyColorAdjust(d, { ...NO_ADJUST });
    expect([...d]).toEqual([120, 90, 200, 255]);
  });

  it('밝기 +는 채널을 키운다(알파 불변)', () => {
    const d = px(100, 100, 100);
    applyColorAdjust(d, { ...NO_ADJUST, brightness: 0.5 });
    expect(d[0]).toBe(150);
    expect(d[3]).toBe(255);
  });

  it('채도 -1은 흑백(모든 채널 동일)', () => {
    const d = px(200, 50, 10);
    applyColorAdjust(d, { ...NO_ADJUST, saturation: -1 });
    expect(d[0]).toBe(d[1]);
    expect(d[1]).toBe(d[2]);
  });

  it('색온도 +는 R을 올리고 B를 내린다', () => {
    const d = px(100, 100, 100);
    applyColorAdjust(d, { ...NO_ADJUST, warmth: 0.5 });
    expect(d[0]!).toBeGreaterThan(100);
    expect(d[2]!).toBeLessThan(100);
  });

  it('노출 +1스탑은 2배 밝기(클램프 내)', () => {
    const d = px(60, 60, 60);
    applyColorAdjust(d, { ...NO_ADJUST, exposure: 1 });
    expect(d[0]).toBe(120);
  });
});

describe('sharpen / grain', () => {
  it('sharpen은 경계 대비를 키운다(에지 픽셀)', () => {
    // 3×3: 중앙만 밝음 → 언샤프로 중앙 더 밝아짐
    const w = 3, h = 3;
    const d = new Uint8ClampedArray(w * h * 4).fill(255);
    for (let i = 0; i < d.length; i += 4) { d[i] = 50; d[i+1] = 50; d[i+2] = 50; }
    const c = (1 * w + 1) * 4;
    d[c] = 200; d[c+1] = 200; d[c+2] = 200;
    const out = sharpen(d, w, h, 1);
    expect(out[c]!).toBeGreaterThan(200);
  });

  it('grain은 결정적 rand 주입 시 예측 가능하게 변한다', () => {
    const d = px(100, 100, 100);
    grain(d, 1, () => 1); // (1-0.5)*2*26 = +26
    expect(d[0]).toBe(126);
  });

  it('amount 0이면 불변', () => {
    const d = px(100, 100, 100);
    grain(d, 0);
    const s = sharpen(d, 1, 1, 0);
    expect([...s]).toEqual([100, 100, 100, 255]);
  });
});

describe('crop 기하', () => {
  it('rotate90 홀수면 가로세로 스왑', () => {
    expect(rotatedDims(400, 300, 1)).toEqual({ w: 300, h: 400 });
    expect(rotatedDims(400, 300, 2)).toEqual({ w: 400, h: 300 });
  });

  it('1:1 크롭 창은 정사각(짧은 변 기준)', () => {
    const w = cropWindow(400, 300, '1:1', 1, 0, 0);
    expect(Math.round(w.w)).toBe(300);
    expect(Math.round(w.h)).toBe(300);
    expect(Math.round(w.x)).toBe(50); // 중앙
  });

  it('zoom 2는 창을 절반 크기로, pan 1은 오른쪽 끝까지', () => {
    const w = cropWindow(400, 300, 'orig', 2, 1, 0);
    expect(Math.round(w.w)).toBe(200);
    expect(Math.round(w.x + w.w)).toBe(400); // 오른쪽 경계
  });

  it('angleCoverScale은 0도=1, 각도 커지면 >1', () => {
    expect(angleCoverScale(400, 300, 0)).toBe(1);
    expect(angleCoverScale(400, 300, 5)).toBeGreaterThan(1);
  });
});

describe('healSpot (잡티 제거)', () => {
  it('밝은 점을 주변 색으로 메꾼다', () => {
    // 21×21 균일(100) + 중앙 3×3 밝은 점(250)
    const w = 21, h = 21;
    const d = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < d.length; i += 4) { d[i] = 100; d[i+1] = 100; d[i+2] = 100; d[i+3] = 255; }
    for (let y = 9; y <= 11; y += 1) for (let x = 9; x <= 11; x += 1) {
      const i = (y * w + x) * 4; d[i] = 250; d[i+1] = 250; d[i+2] = 250;
    }
    healSpot(d, w, h, 10, 10, 6);
    const c = (10 * w + 10) * 4;
    expect(d[c]!).toBeLessThan(140); // 점이 주변(100)에 가깝게 메꿔짐
  });

  it('반경 밖 픽셀은 불변', () => {
    const w = 21, h = 21;
    const d = new Uint8ClampedArray(w * h * 4).fill(80);
    healSpot(d, w, h, 10, 10, 4);
    const corner = 0;
    expect(d[corner]).toBe(80);
  });
});

describe('자유 크롭·좌표 변환', () => {
  it('resolveWindow는 freeCrop을 px로 변환한다', () => {
    const win = resolveWindow(400, 300, {
      aspect: 'free', zoom: 1, panX: 0, panY: 0,
      freeCrop: { x: 0.25, y: 0.1, w: 0.5, h: 0.6 },
    });
    expect(win).toEqual({ x: 100, y: 30, w: 200, h: 180 });
  });

  it('freeCrop 없으면 기존 창 로직으로 폴백', () => {
    const a = resolveWindow(400, 300, { aspect: 'orig', zoom: 1, panX: 0, panY: 0, freeCrop: null });
    const b = cropWindow(400, 300, 'orig', 1, 0, 0);
    expect(a).toEqual(b);
  });

  it('rotateHeals90: (x,y) → (1-y, x)', () => {
    expect(rotateHeals90([{ x: 0.2, y: 0.4, r: 0.03 }])[0]).toEqual({ x: 0.6, y: 0.2, r: 0.03 });
  });

  it('flipHealsH: x → 1-x', () => {
    expect(flipHealsH([{ x: 0.2, y: 0.4, r: 0.03 }])[0]).toEqual({ x: 0.8, y: 0.4, r: 0.03 });
  });

  it('rotateFreeCrop90은 사각형을 보존 회전한다', () => {
    const fc = rotateFreeCrop90({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
    expect(fc.x).toBeCloseTo(1 - (0.2 + 0.4));
    expect(fc.y).toBeCloseTo(0.1);
    expect(fc.w).toBeCloseTo(0.4);
    expect(fc.h).toBeCloseTo(0.3);
  });

  it('isIdentity: 잡티가 있으면 편집으로 간주', () => {
    const s = freshEdit();
    expect(isIdentity(s)).toBe(true);
    s.heals.push({ x: 0.5, y: 0.5, r: 0.03 });
    expect(isIdentity(s)).toBe(false);
  });
});

describe('resizeFreeCrop (자유 크롭 드래그)', () => {
  const base = { x: 0.2, y: 0.2, w: 0.5, h: 0.5 };
  const MIN = 0.08;

  it('move는 크기를 보존하며 경계 안으로 클램프한다', () => {
    const fc = resizeFreeCrop(base, 'move', 10, 10, MIN);
    expect(fc).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  });

  it('서쪽 핸들을 경계 밖으로 끌어도 동쪽 변은 움직이지 않는다(회귀)', () => {
    const fc = resizeFreeCrop(base, 'nw', -0.9, 0, MIN);
    expect(fc.x).toBe(0); // 왼쪽 변만 경계에 붙고
    expect(fc.x + fc.w).toBeCloseTo(0.7); // 오른쪽 변(0.2+0.5)은 그대로
  });

  it('북쪽 핸들도 남쪽 변을 보존한다', () => {
    const fc = resizeFreeCrop(base, 'ne', 0, -0.9, MIN);
    expect(fc.y).toBe(0);
    expect(fc.y + fc.h).toBeCloseTo(0.7);
  });

  it('최소 크기 미만으로 줄이면 반대 변 기준으로 min을 지킨다', () => {
    const fc = resizeFreeCrop(base, 'se', -0.9, -0.9, MIN);
    expect(fc.w).toBeCloseTo(MIN);
    expect(fc.h).toBeCloseTo(MIN);
    expect(fc.x).toBeCloseTo(0.2); // nw 고정
    expect(fc.y).toBeCloseTo(0.2);
  });

  it('동·남쪽 확장은 1을 넘지 않는다', () => {
    const fc = resizeFreeCrop(base, 'se', 5, 5, MIN);
    expect(fc.x + fc.w).toBeLessThanOrEqual(1);
    expect(fc.y + fc.h).toBeLessThanOrEqual(1);
  });
});
