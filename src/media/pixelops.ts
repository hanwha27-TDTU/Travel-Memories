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

/**
 * 원근 워프(역매핑 + bilinear): 출력 (dw×dh)의 각 픽셀 (s,t)∈(0..1)²를
 * coeffs(단위정사각형→원본 px 사영계수 [a..h])로 원본 좌표에 투영해 샘플한다.
 * 순수 함수 — 출력 크기에서만 루프(§2-4), 원본 배열 불변. 경계 밖은 가장자리 클램프.
 */
export function warpPerspective(
  src: Uint8ClampedArray,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
  coeffs: number[],
): Uint8ClampedArray<ArrayBuffer> {
  const [a, b, c, d, e, f, g, h] = coeffs as [number, number, number, number, number, number, number, number];
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let j = 0; j < dh; j += 1) {
    const t = (j + 0.5) / dh;
    for (let i = 0; i < dw; i += 1) {
      const s = (i + 0.5) / dw;
      const den = g * s + h * t + 1;
      // 원본 px 좌표(픽셀 중심 관례: 연속좌표 X에서 샘플 인덱스는 X-0.5)
      const x = (a * s + b * t + c) / den - 0.5;
      const y = (d * s + e * t + f) / den - 0.5;
      // bilinear 샘플(경계 클램프)
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fx = x - x0;
      const fy = y - y0;
      const cx0 = x0 < 0 ? 0 : x0 >= sw ? sw - 1 : x0;
      const cx1 = x0 + 1 < 0 ? 0 : x0 + 1 >= sw ? sw - 1 : x0 + 1;
      const cy0 = y0 < 0 ? 0 : y0 >= sh ? sh - 1 : y0;
      const cy1 = y0 + 1 < 0 ? 0 : y0 + 1 >= sh ? sh - 1 : y0 + 1;
      const p00 = (cy0 * sw + cx0) * 4;
      const p10 = (cy0 * sw + cx1) * 4;
      const p01 = (cy1 * sw + cx0) * 4;
      const p11 = (cy1 * sw + cx1) * 4;
      const o = (j * dw + i) * 4;
      for (let ch = 0; ch < 4; ch += 1) {
        const top = src[p00 + ch]! * (1 - fx) + src[p10 + ch]! * fx;
        const bot = src[p01 + ch]! * (1 - fx) + src[p11 + ch]! * fx;
        out[o + ch] = top * (1 - fy) + bot * fy;
      }
    }
  }
  return out;
}

/** 자동 잡티 감지 결과 — 0..1 정규화 좌표(감지한 캔버스 기준)와 반경(폭 대비 비율). */
export interface DetectedSpot {
  x: number;
  y: number;
  r: number;
}

/**
 * 자동 잡티 감지 — **주변보다 어두운 작은 얼룩**을 찾는다.
 *
 * ── 왜 「어두운 것만」인가 ────────────────────────────────────────────────────
 * 잡티·점·먼지는 주변 피부·배경보다 어둡다. 밝은 쪽까지 잡으면 **하이라이트·반사·치아**가
 * 걸려 사람 얼굴이 뭉개진다. 한쪽만 보는 것은 성능이 아니라 **오탐을 줄이는 선택**이고,
 * 그래서 여기 적는다(§7 — 의도적 비대칭에는 이유를 남긴다).
 *
 * ── 판정 ─────────────────────────────────────────────────────────────────────
 * 격자를 훑으며 중심 원반 평균과 그 바깥 고리 평균을 비교한다. 고리가 충분히 더 밝으면
 * (`ring - center > threshold`) 얼룩으로 본다. 겹치는 후보는 점수가 높은 것만 남긴다(NMS).
 *
 * 🔴 **결정적이다** — 난수를 쓰지 않는다. 같은 사진에 두 번 누르면 같은 결과가 나와야
 * 사용자가 「되돌리기 → 다시」를 신뢰할 수 있다(§2-3의 같은 규율).
 *
 * 🔴 **한계**: 이건 「얼굴의 잡티」를 아는 게 아니라 **작고 어두운 얼룩**을 아는 것이다.
 * 점·모공·글자·작은 그림자를 구분하지 못한다. 그래서 결과는 항상 실행취소로 되돌릴 수
 * 있어야 하고(호출부 책임), 개수 상한을 둔다 — 사진 전체를 문지르지 않는다.
 */
export function detectBlemishes(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  opts: { maxSpots?: number; strength?: number } = {},
): DetectedSpot[] {
  const maxSpots = opts.maxSpots ?? 24;
  const strength = Math.min(1, Math.max(0, opts.strength ?? 0.5));
  const short = Math.min(width, height);
  if (short < 24) return []; // 너무 작으면 판정하지 않는다 — 억지로 찾지 않는다
  const rPx = Math.max(2, Math.round(short * 0.01)); // 얼룩 반경 후보(짧은 변의 1%)
  // 강도가 셀수록 문턱이 낮아진다(더 옅은 얼룩까지). 0.5에서 18/255.
  const threshold = 30 - strength * 24;

  const lum = (i: number): number => 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
  /** 원반/고리의 평균과 표준편차. 표준편차가 「주변이 균일한가」를 말한다. */
  const stat = (cx: number, cy: number, r0: number, r1: number): { mean: number; std: number } => {
    let sum = 0;
    let sq = 0;
    let n = 0;
    for (let dy = -r1; dy <= r1; dy += 1) {
      const y = cy + dy;
      if (y < 0 || y >= height) continue;
      for (let dx = -r1; dx <= r1; dx += 1) {
        const x = cx + dx;
        if (x < 0 || x >= width) continue;
        const d = Math.hypot(dx, dy);
        if (d < r0 || d > r1) continue;
        const l = lum((y * width + x) * 4);
        sum += l;
        sq += l * l;
        n += 1;
      }
    }
    if (!n) return { mean: 0, std: 0 };
    const mean = sum / n;
    return { mean, std: Math.sqrt(Math.max(0, sq / n - mean * mean)) };
  };

  const found: Array<DetectedSpot & { score: number }> = [];
  for (let cy = rPx * 2; cy < height - rPx * 2; cy += rPx) {
    for (let cx = rPx * 2; cx < width - rPx * 2; cx += rPx) {
      const center = stat(cx, cy, 0, rPx);
      const ring = stat(cx, cy, rPx * 2, rPx * 3);
      const score = ring.mean - center.mean; // 주변이 더 밝다 = 가운데가 어둡다
      if (score <= threshold) continue;
      // 🔴 **고리가 균일할 때만 얼룩이다.** 밝은 영역(하이라이트·치아·창문) 바로 바깥을 재면
      // 고리가 그 경계를 걸쳐 중심이 상대적으로 어두워 보인다 — 얼룩이 아니라 **헤일로**다.
      // 유닛이 이 오탐을 실제로 잡았다: 밝은 사각형 하나에 12건이 검출됐다.
      // 얼룩은 균일한 피부 위에 있고, 헤일로는 **경계** 위에 있다. 그 차이가 고리의 표준편차다.
      if (ring.std > score * 0.8) continue;
      found.push({ x: cx / width, y: cy / height, r: (rPx * 1.3) / width, score });
    }
  }

  // 겹치는 후보는 점수가 높은 것만 남긴다 — 같은 얼룩을 여러 번 문지르지 않게.
  found.sort((a, b) => b.score - a.score);
  const kept: DetectedSpot[] = [];
  const minGap = (rPx * 2) / width;
  for (const cand of found) {
    if (kept.length >= maxSpots) break;
    if (kept.some((k) => Math.hypot(k.x - cand.x, (k.y - cand.y) * (height / width)) < minGap)) continue;
    kept.push({ x: cand.x, y: cand.y, r: cand.r });
  }
  return kept;
}
