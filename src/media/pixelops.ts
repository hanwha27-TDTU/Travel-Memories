// media/pixelops.ts — 사진 편집 픽셀 연산(순수 함수, DOM 없음 → 유닛테스트 대상).
// 미리보기·최종 굽기(bake)가 같은 함수를 쓴다(WYSIWYG 단일 경로).
// 모든 조정값은 0이 "변화 없음"인 델타로 통일한다.

export interface ColorAdjust {
  /** -1..1 (0=원본). 곱연산 밝기. */
  brightness: number;
  /** -1..1. 대비. */
  contrast: number;
  /** -1..1. 채도(-1=흑백). */
  saturation: number;
  /** -1..1. 색온도(+따뜻/-차가움). */
  warmth: number;
  /** -1..1. 노출(2^x 스탑). */
  exposure: number;
}

export const NO_ADJUST: ColorAdjust = { brightness: 0, contrast: 0, saturation: 0, warmth: 0, exposure: 0 };

export function isNoAdjust(a: ColorAdjust): boolean {
  return a.brightness === 0 && a.contrast === 0 && a.saturation === 0 && a.warmth === 0 && a.exposure === 0;
}

/** RGBA 배열에 색 조정을 제자리 적용. */
export function applyColorAdjust(data: Uint8ClampedArray, adj: ColorAdjust): void {
  if (isNoAdjust(adj)) return;
  const bright = (1 + adj.brightness) * Math.pow(2, adj.exposure); // 밝기×노출 결합 곱
  const cont = 1 + adj.contrast;
  const sat = 1 + adj.saturation;
  const warmR = adj.warmth * 28; // 온도: R 가산, B 감산(선형)
  const warmB = -adj.warmth * 28;

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i]! * bright;
    let g = data[i + 1]! * bright;
    let b = data[i + 2]! * bright;

    // 대비: 중간값(128) 기준 스트레치
    r = (r - 128) * cont + 128;
    g = (g - 128) * cont + 128;
    b = (b - 128) * cont + 128;

    // 채도: 휘도(Rec.601)와 보간
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    r = lum + (r - lum) * sat;
    g = lum + (g - lum) * sat;
    b = lum + (b - lum) * sat;

    // 색온도
    r += warmR;
    b += warmB;

    data[i] = r < 0 ? 0 : r > 255 ? 255 : r;
    data[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
    data[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
  }
}

/**
 * 언샤프 마스크(3×3 블러와의 차이를 amount만큼 증폭). amount 0..1.
 * 별도 출력 버퍼를 반환한다(입력 불변).
 */
export function sharpen(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  amount: number,
): Uint8ClampedArray {
  if (amount <= 0) return data;
  const out = new Uint8ClampedArray(data);
  const w4 = width * 4;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const p = y * w4 + x * 4;
      for (let c = 0; c < 3; c += 1) {
        const i = p + c;
        const blur =
          (data[i - w4 - 4]! + data[i - w4]! + data[i - w4 + 4]! +
            data[i - 4]! + data[i]! + data[i + 4]! +
            data[i + w4 - 4]! + data[i + w4]! + data[i + w4 + 4]!) / 9;
        const v = data[i]! + (data[i]! - blur) * amount * 2;
        out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }
  return out;
}

/**
 * 스팟 힐링(잡티 제거): (cx,cy) 반경 r 안을 주변 링 샘플로 자연스럽게 메꾼다.
 * 링(r×1.25)에서 16방향 샘플을 뽑아 역거리제곱 가중 보간 + 가장자리 감쇠 블렌딩.
 * 제자리 수정(순수 픽셀 연산 — DOM 없음).
 */
export function healSpot(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  cx: number,
  cy: number,
  r: number,
): void {
  if (r < 1) return;
  const N = 16;
  const ringR = r * 1.25;
  const ring: Array<[number, number, number, number, number]> = []; // rx, ry, R, G, B
  for (let k = 0; k < N; k += 1) {
    const a = (2 * Math.PI * k) / N;
    const rx = Math.min(width - 1, Math.max(0, Math.round(cx + Math.cos(a) * ringR)));
    const ry = Math.min(height - 1, Math.max(0, Math.round(cy + Math.sin(a) * ringR)));
    const i = (ry * width + rx) * 4;
    ring.push([rx, ry, data[i]!, data[i + 1]!, data[i + 2]!]);
  }
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(height - 1, Math.ceil(cy + r));
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(width - 1, Math.ceil(cx + r));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const d = Math.hypot(x - cx, y - cy);
      if (d >= r) continue;
      let sr = 0, sg = 0, sb = 0, sw = 0;
      for (const [rx, ry, R, G, B] of ring) {
        const wgt = 1 / ((x - rx) * (x - rx) + (y - ry) * (y - ry) + 1);
        sr += R * wgt; sg += G * wgt; sb += B * wgt; sw += wgt;
      }
      const t = d / r;
      const a = 1 - t * t; // 중심 강하게, 가장자리 자연 감쇠
      const i = (y * width + x) * 4;
      data[i] = data[i]! * (1 - a) + (sr / sw) * a;
      data[i + 1] = data[i + 1]! * (1 - a) + (sg / sw) * a;
      data[i + 2] = data[i + 2]! * (1 - a) + (sb / sw) * a;
    }
  }
}

/** 필름 그레인(모노 노이즈 가산). amount 0..1. rand 주입 가능(테스트 결정성). */
export function grain(
  data: Uint8ClampedArray,
  amount: number,
  rand: () => number = Math.random,
): void {
  if (amount <= 0) return;
  const strength = amount * 26;
  for (let i = 0; i < data.length; i += 4) {
    const n = (rand() - 0.5) * 2 * strength;
    for (let c = 0; c < 3; c += 1) {
      const v = data[i + c]! + n;
      data[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
}
