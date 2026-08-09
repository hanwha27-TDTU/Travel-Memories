import { describe, expect, it } from 'vitest';
import { detectBlemishes } from '../../src/media/pixelops';

/** 평평한 배경에 지정한 자리마다 어두운 원반을 찍은 이미지를 만든다. */
function craft(w: number, h: number, spots: Array<{ x: number; y: number; r: number; dark: number }>): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4).fill(200);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  for (const s of spots) {
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (Math.hypot(x - s.x, y - s.y) > s.r) continue;
        const i = (y * w + x) * 4;
        data[i] = s.dark;
        data[i + 1] = s.dark;
        data[i + 2] = s.dark;
      }
    }
  }
  return data;
}

describe('detectBlemishes', () => {
  it('평평한 이미지에서는 아무것도 찾지 않는다 — 없는 얼룩을 만들지 않는다', () => {
    expect(detectBlemishes(craft(200, 200, []), 200, 200)).toEqual([]);
  });

  it('어두운 얼룩 하나를 그 자리에서 찾는다', () => {
    const found = detectBlemishes(craft(200, 200, [{ x: 100, y: 60, r: 3, dark: 40 }]), 200, 200);
    expect(found.length).toBe(1);
    expect(found[0]!.x).toBeCloseTo(0.5, 1);
    expect(found[0]!.y).toBeCloseTo(0.3, 1);
    expect(found[0]!.r).toBeGreaterThan(0);
  });

  it('같은 얼룩을 여러 번 찍지 않는다(NMS)', () => {
    const found = detectBlemishes(craft(300, 300, [{ x: 150, y: 150, r: 5, dark: 30 }]), 300, 300);
    expect(found.length).toBe(1);
  });

  it('🔴 밝은 얼룩은 잡지 않는다 — 하이라이트·치아를 문지르면 얼굴이 뭉개진다', () => {
    const data = new Uint8ClampedArray(200 * 200 * 4).fill(60);
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    for (let y = 55; y < 65; y += 1) for (let x = 95; x < 105; x += 1) {
      const i = (y * 200 + x) * 4;
      data[i] = 250; data[i + 1] = 250; data[i + 2] = 250;
    }
    expect(detectBlemishes(data, 200, 200)).toEqual([]);
  });

  it('결정적이다 — 두 번 눌러도 같은 결과여야 되돌리기를 신뢰할 수 있다', () => {
    const img = craft(240, 240, [{ x: 60, y: 60, r: 3, dark: 20 }, { x: 180, y: 150, r: 3, dark: 20 }]);
    expect(detectBlemishes(img, 240, 240)).toEqual(detectBlemishes(img, 240, 240));
  });

  it('개수 상한을 지킨다 — 사진 전체를 문지르지 않는다', () => {
    const many = [];
    for (let gy = 0; gy < 10; gy += 1) for (let gx = 0; gx < 10; gx += 1) {
      many.push({ x: 20 + gx * 26, y: 20 + gy * 26, r: 3, dark: 30 });
    }
    expect(detectBlemishes(craft(300, 300, many), 300, 300, { maxSpots: 5 }).length).toBeLessThanOrEqual(5);
  });

  it('너무 작은 이미지는 판정하지 않는다(억지로 찾지 않는다)', () => {
    expect(detectBlemishes(craft(16, 16, [{ x: 8, y: 8, r: 2, dark: 0 }]), 16, 16)).toEqual([]);
  });
});
