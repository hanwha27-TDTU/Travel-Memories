// tests/unit/pixelops.test.ts — 사진 편집 픽셀 연산·크롭 기하 비공허 검증.
import { describe, it, expect } from 'vitest';
import { applyColorAdjust, sharpen, grain, NO_ADJUST } from '../../src/media/pixelops';
import { cropWindow, rotatedDims, angleCoverScale } from '../../src/media/editor-core';

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
