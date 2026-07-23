// media/editor-core.ts — 편집 상태(EditState)와 굽기(bake) 파이프라인.
// 비파괴: 입력 비트맵(원본)은 읽기만 하고, 결과는 항상 새 canvas.
// 미리보기와 최종 저장이 같은 bakeToCanvas를 사용한다(WYSIWYG 단일 경로).

import { applyColorAdjust, sharpen, grain, healSpot, isNoAdjust, type ColorAdjust } from './pixelops';

export type CropAspect = 'orig' | '1:1' | '4:5' | '16:9' | 'free';

/** 자유 크롭 사각형(회전 후 기하 공간, 0..1 정규화). */
export interface FreeCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 잡티 제거 지점(기하 공간 정규화 좌표 + 반경은 이미지 너비 비율). */
export interface HealPoint {
  x: number;
  y: number;
  r: number;
}

export interface EditState extends ColorAdjust {
  /** 90° 회전 횟수(0..3). */
  rotate90: 0 | 1 | 2 | 3;
  flipH: boolean;
  /** 수평 보정 각도(도, -10..10). */
  angle: number;
  aspect: CropAspect;
  /** 확대(1..3). */
  zoom: number;
  /** 팬(-1..1) — 크롭 창 이동. */
  panX: number;
  panY: number;
  /** aspect='free'일 때 사용하는 자유 크롭 사각형. */
  freeCrop: FreeCrop | null;
  /** 잡티 제거 지점들(적용 순서대로). */
  heals: HealPoint[];
  /** 0..1 비네팅 강도. */
  vignette: number;
  /** 0..1 선명도. */
  sharpenAmt: number;
  /** 0..1 그레인. */
  grainAmt: number;
}

export const DEFAULT_EDIT: EditState = {
  rotate90: 0,
  flipH: false,
  angle: 0,
  aspect: 'orig',
  zoom: 1,
  panX: 0,
  panY: 0,
  freeCrop: null,
  heals: [],
  brightness: 0,
  contrast: 0,
  saturation: 0,
  warmth: 0,
  exposure: 0,
  vignette: 0,
  sharpenAmt: 0,
  grainAmt: 0,
};

/** 초기 상태 사본(배열 공유 방지). */
export function freshEdit(): EditState {
  return { ...DEFAULT_EDIT, heals: [] };
}

/** 절제된 프리셋(사진 원색 존중 — 감성 과잉 금지). */
export const PRESETS: Record<string, Partial<EditState>> = {
  원본: {},
  자연: { saturation: 0.1, contrast: 0.06, brightness: 0.02 },
  필름: { warmth: 0.18, contrast: 0.1, saturation: -0.08, grainAmt: 0.18, vignette: 0.15 },
  흑백: { saturation: -1, contrast: 0.12 },
  따뜻: { warmth: 0.3, brightness: 0.04 },
  차분: { warmth: -0.18, saturation: -0.12, contrast: 0.04 },
};

export function isIdentity(s: EditState): boolean {
  return (
    s.rotate90 === 0 && !s.flipH && s.angle === 0 &&
    (s.aspect === 'orig' || (s.aspect === 'free' && !s.freeCrop)) &&
    s.zoom === 1 && s.panX === 0 && s.panY === 0 &&
    s.heals.length === 0 &&
    isNoAdjust(s) && s.vignette === 0 && s.sharpenAmt === 0 && s.grainAmt === 0
  );
}

export function aspectRatio(aspect: CropAspect, srcW: number, srcH: number): number {
  switch (aspect) {
    case '1:1': return 1;
    case '4:5': return 4 / 5;
    case '16:9': return 16 / 9;
    default: return srcW / srcH; // 'orig' | 'free'(freeCrop 없음)
  }
}

/** 회전(90° CW)·반전 시 정규화 좌표 변환 — 기존 잡티·자유크롭 위치를 보존한다. */
export function rotateHeals90(heals: HealPoint[]): HealPoint[] {
  return heals.map((h) => ({ x: 1 - h.y, y: h.x, r: h.r }));
}
export function flipHealsH(heals: HealPoint[]): HealPoint[] {
  return heals.map((h) => ({ x: 1 - h.x, y: h.y, r: h.r }));
}
export function rotateFreeCrop90(fc: FreeCrop): FreeCrop {
  return { x: 1 - (fc.y + fc.h), y: fc.x, w: fc.h, h: fc.w };
}
export function flipFreeCropH(fc: FreeCrop): FreeCrop {
  return { x: 1 - (fc.x + fc.w), y: fc.y, w: fc.w, h: fc.h };
}

export type FreeCropDragMode = 'move' | 'nw' | 'ne' | 'sw' | 'se';

/**
 * 자유 크롭 드래그(순수): 시작 사각형 f를 mode 방향으로 (dx,dy)만큼 끌었을 때의 새 사각형.
 * 모서리 리사이즈에서 반대쪽 변은 절대 움직이지 않는다 — 경계 클램프를 x/w가 아니라
 * 좌·우(상·하) "변" 좌표에 각각 적용해, 서쪽 핸들을 경계 밖으로 끌면 동쪽 변이
 * 따라 늘어나던 결함을 원천 차단한다.
 */
export function resizeFreeCrop(
  f: FreeCrop,
  mode: FreeCropDragMode,
  dx: number,
  dy: number,
  minSize: number,
): FreeCrop {
  if (mode === 'move') {
    return {
      x: Math.max(0, Math.min(1 - f.w, f.x + dx)),
      y: Math.max(0, Math.min(1 - f.h, f.y + dy)),
      w: f.w,
      h: f.h,
    };
  }
  let left = f.x;
  let top = f.y;
  let right = f.x + f.w;
  let bottom = f.y + f.h;
  if (mode.includes('w')) left = Math.max(0, Math.min(right - minSize, f.x + dx));
  if (mode.includes('e')) right = Math.min(1, Math.max(left + minSize, f.x + f.w + dx));
  if (mode.includes('n')) top = Math.max(0, Math.min(bottom - minSize, f.y + dy));
  if (mode.includes('s')) bottom = Math.min(1, Math.max(top + minSize, f.y + f.h + dy));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** 현재 상태의 크롭 창(회전 후 기하 공간 px). 자유 크롭이 있으면 그것을 우선. */
export function resolveWindow(
  W: number,
  H: number,
  s: Pick<EditState, 'aspect' | 'zoom' | 'panX' | 'panY' | 'freeCrop'>,
): { x: number; y: number; w: number; h: number } {
  if (s.aspect === 'free' && s.freeCrop) {
    return { x: s.freeCrop.x * W, y: s.freeCrop.y * H, w: s.freeCrop.w * W, h: s.freeCrop.h * H };
  }
  return cropWindow(W, H, s.aspect, s.zoom, s.panX, s.panY);
}

/** 회전(90 단위) 후 원본 축 크기. */
export function rotatedDims(w: number, h: number, rotate90: number): { w: number; h: number } {
  return rotate90 % 2 === 1 ? { w: h, h: w } : { w, h };
}

/**
 * 각도 보정 시 빈 모서리가 없도록 하는 확대 배율.
 * 근사식: cos|θ| + sin|θ|·max(가로세로비, 세로가로비).
 */
export function angleCoverScale(w: number, h: number, angleDeg: number): number {
  const t = Math.abs((angleDeg * Math.PI) / 180);
  if (t === 0) return 1;
  const r = Math.max(w / h, h / w);
  return Math.cos(t) + Math.sin(t) * r;
}

/**
 * 크롭 창 계산(순수): 회전 후 이미지(W,H) 안에서 aspect·zoom·pan에 따른 소스 사각형.
 */
export function cropWindow(
  W: number,
  H: number,
  aspect: CropAspect,
  zoom: number,
  panX: number,
  panY: number,
): { x: number; y: number; w: number; h: number } {
  const A = aspectRatio(aspect, W, H);
  // aspect A로 (W,H)에 내접하는 최대 창
  let w0 = W;
  let h0 = w0 / A;
  if (h0 > H) {
    h0 = H;
    w0 = h0 * A;
  }
  const w = w0 / zoom;
  const h = h0 / zoom;
  const maxDx = (W - w) / 2;
  const maxDy = (H - h) / 2;
  const cx = W / 2 + panX * maxDx;
  const cy = H / 2 + panY * maxDy;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** 결정적 PRNG(mulberry32). 그레인이 미리보기 갱신마다 어른거리지 않게 고정 시드로 쓴다. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 편집 상태를 적용해 새 canvas를 만든다(원본 불변).
 * maxEdge: 출력 긴 변 제한(미리보기 소형 / 저장 대형).
 */
export function bakeToCanvas(
  src: ImageBitmap | HTMLImageElement | HTMLCanvasElement,
  srcW: number,
  srcH: number,
  s: EditState,
  maxEdge: number,
): HTMLCanvasElement {
  // 0) 출력 배율을 먼저 정한다. 기하 중간 캔버스를 원본 전체 해상도로 만들면
  //    12MP급 사진에서 미리보기 프레임마다 수십 MB를 할당해 모바일이 버벅인다 —
  //    필요한 배율(scale)로 축소해 그린다(결과 픽셀은 동일 경로·동일 창).
  const rd = rotatedDims(srcW, srcH, s.rotate90);
  const win = resolveWindow(rd.w, rd.h, s);
  const scale = Math.min(1, maxEdge / Math.max(win.w, win.h));

  // 1) 기하: rotate90 + flip + angle(커버 확대) — scale 반영 크기로 굽는다.
  const g = document.createElement('canvas');
  g.width = Math.max(1, Math.round(rd.w * scale));
  g.height = Math.max(1, Math.round(rd.h * scale));
  const gx = g.getContext('2d');
  if (!gx) throw new Error('canvas 2d 컨텍스트 없음');
  gx.translate(g.width / 2, g.height / 2);
  gx.rotate((s.rotate90 * Math.PI) / 2 + (s.angle * Math.PI) / 180);
  const cover = angleCoverScale(rd.w, rd.h, s.angle);
  gx.scale((s.flipH ? -cover : cover) * scale, cover * scale);
  gx.drawImage(src, -srcW / 2, -srcH / 2);

  // 2) 크롭(비율/자유)/줌/팬 → 출력 크기 결정(창 좌표도 scale 공간으로)
  const outW = Math.max(1, Math.round(win.w * scale));
  const outH = Math.max(1, Math.round(win.h * scale));
  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const ox = out.getContext('2d');
  if (!ox) throw new Error('canvas 2d 컨텍스트 없음');
  ox.drawImage(g, win.x * scale, win.y * scale, win.w * scale, win.h * scale, 0, 0, outW, outH);

  // 3) 픽셀 조정(잡티 → 색 → 선명도 → 그레인). 잡티는 원색 기준으로 먼저 메꾼다.
  const needsPixels = !isNoAdjust(s) || s.sharpenAmt > 0 || s.grainAmt > 0 || s.heals.length > 0;
  if (needsPixels) {
    const img = ox.getImageData(0, 0, outW, outH);
    for (const hp of s.heals) {
      // 기하 정규화 좌표 → 출력 px (크롭 창 기준 재투영)
      const hx = ((hp.x * rd.w - win.x) / win.w) * outW;
      const hy = ((hp.y * rd.h - win.y) / win.h) * outH;
      const hr = ((hp.r * rd.w) / win.w) * outW;
      if (hx < -hr || hy < -hr || hx > outW + hr || hy > outH + hr) continue; // 창 밖
      healSpot(img.data, outW, outH, hx, hy, hr);
    }
    applyColorAdjust(img.data, s);
    if (s.sharpenAmt > 0) {
      // sharpen은 새 버퍼를 반환 → 원 ImageData 버퍼로 복사(타입·버퍼 안정)
      img.data.set(sharpen(img.data, outW, outH, s.sharpenAmt));
    }
    // 고정 시드: 미리보기 갱신마다 노이즈가 재추첨되어 어른거리는 문제 방지 + 저장 결과 재현성.
    if (s.grainAmt > 0) grain(img.data, s.grainAmt, mulberry32(0x51ab_cafe));
    ox.putImageData(img, 0, 0);
  }

  // 4) 비네팅(방사형 그라데이션)
  if (s.vignette > 0) {
    const r = Math.hypot(outW, outH) / 2;
    const grad = ox.createRadialGradient(outW / 2, outH / 2, r * 0.55, outW / 2, outH / 2, r);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, `rgba(0,0,0,${0.55 * s.vignette})`);
    ox.fillStyle = grad;
    ox.fillRect(0, 0, outW, outH);
  }

  return out;
}
