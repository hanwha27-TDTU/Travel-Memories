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
