// media/editor-core.ts — 편집 상태(EditState)와 굽기(bake) 파이프라인.
// 비파괴: 입력 비트맵(원본)은 읽기만 하고, 결과는 항상 새 canvas.
// 미리보기와 최종 저장이 같은 bakeToCanvas를 사용한다(WYSIWYG 단일 경로).

import { applyColorAdjust, sharpen, grain, isNoAdjust, type ColorAdjust } from './pixelops';

export type CropAspect = 'orig' | '1:1' | '4:5' | '16:9';

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
  brightness: 0,
  contrast: 0,
  saturation: 0,
  warmth: 0,
  exposure: 0,
  vignette: 0,
  sharpenAmt: 0,
  grainAmt: 0,
};

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
    s.rotate90 === 0 && !s.flipH && s.angle === 0 && s.aspect === 'orig' &&
    s.zoom === 1 && s.panX === 0 && s.panY === 0 &&
    isNoAdjust(s) && s.vignette === 0 && s.sharpenAmt === 0 && s.grainAmt === 0
  );
}

export function aspectRatio(aspect: CropAspect, srcW: number, srcH: number): number {
  switch (aspect) {
    case '1:1': return 1;
    case '4:5': return 4 / 5;
    case '16:9': return 16 / 9;
    default: return srcW / srcH;
  }
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
  // 1) 기하: rotate90 + flip + angle(커버 확대)
  const rd = rotatedDims(srcW, srcH, s.rotate90);
  const g = document.createElement('canvas');
  g.width = rd.w;
  g.height = rd.h;
  const gx = g.getContext('2d');
  if (!gx) throw new Error('canvas 2d 컨텍스트 없음');
  gx.translate(rd.w / 2, rd.h / 2);
  gx.rotate((s.rotate90 * Math.PI) / 2 + (s.angle * Math.PI) / 180);
  const cover = angleCoverScale(rd.w, rd.h, s.angle);
  gx.scale(s.flipH ? -cover : cover, cover);
  gx.drawImage(src, -srcW / 2, -srcH / 2);

  // 2) 크롭/줌/팬 → 출력 크기 결정
  const win = cropWindow(rd.w, rd.h, s.aspect, s.zoom, s.panX, s.panY);
  const scale = Math.min(1, maxEdge / Math.max(win.w, win.h));
  const outW = Math.max(1, Math.round(win.w * scale));
  const outH = Math.max(1, Math.round(win.h * scale));
  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const ox = out.getContext('2d');
  if (!ox) throw new Error('canvas 2d 컨텍스트 없음');
  ox.drawImage(g, win.x, win.y, win.w, win.h, 0, 0, outW, outH);

  // 3) 픽셀 조정(색·선명도·그레인)
  const needsPixels = !isNoAdjust(s) || s.sharpenAmt > 0 || s.grainAmt > 0;
  if (needsPixels) {
    const img = ox.getImageData(0, 0, outW, outH);
    applyColorAdjust(img.data, s);
    if (s.sharpenAmt > 0) {
      // sharpen은 새 버퍼를 반환 → 원 ImageData 버퍼로 복사(타입·버퍼 안정)
      img.data.set(sharpen(img.data, outW, outH, s.sharpenAmt));
    }
    if (s.grainAmt > 0) grain(img.data, s.grainAmt);
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
