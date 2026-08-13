// ui/photoEditor.ts — 사진 편집 모달(비파괴). 원본은 읽기만, 결과는 새 Blob.
// 미리보기 = bakeToCanvas(소형) — 저장과 같은 코드 경로(WYSIWYG).
// 반응성: 드래그 중엔 저해상(FAST_MAX)으로 굽고 손을 떼면 고해상(PREVIEW_MAX)으로 재굽기.
// 자유 크롭: aspect='free' 동안 미리보기는 크롭 없이 전체를 보여주고 오버레이로 영역 지정.
// 잡티 제거: 힐 모드에서 탭 → 기하 정규화 좌표로 저장(bake 시 해상도 무관 재적용).

import { el } from './dom';
import {
  PRESETS,
  bakeToCanvas,
  freshEdit,
  isIdentity,
  screenToGeo,
  rotateHeals90,
  flipHealsH,
  rotateFreeCrop90,
  flipFreeCropH,
  resizeFreeCrop,
  moveQuadEdge,
  rotateQuad90,
  flipQuadH,
  DEFAULT_EDIT,
  type CropAspect,
  type EditState,
  type FreeCropDragMode,
  type Quad,
  type QuadEdge,
} from '../media/editor-core';
import { isNoAdjust } from '../media/pixelops';
import { autoHealPoints } from '../media/editor-core';

const PREVIEW_MAX = 900; // 미리보기 해상도(표시 폭에 맞춰 선명하게 — 확대 시 흐려짐 방지)
const FAST_MAX = 420; // 드래그 중 임시 해상도 — 프레임당 픽셀 연산을 줄여 슬라이더가 즉답하게
const OUTPUT_MAX = 2400; // 편집 결과 상한(이후 compress가 1600 표시본 생성)
const MIN_CROP = 0.08;

interface SliderSpec {
  key: keyof EditState;
  label: string;
  min: number;
  max: number;
  step: number;
}

const SLIDERS: SliderSpec[] = [
  { key: 'brightness', label: '밝기', min: -0.5, max: 0.5, step: 0.02 },
  { key: 'contrast', label: '대비', min: -0.5, max: 0.5, step: 0.02 },
  { key: 'saturation', label: '채도', min: -1, max: 1, step: 0.05 },
  { key: 'warmth', label: '색온도', min: -1, max: 1, step: 0.05 },
  { key: 'exposure', label: '노출', min: -1, max: 1, step: 0.05 },
  { key: 'sharpenAmt', label: '선명도', min: 0, max: 1, step: 0.05 },
  { key: 'vignette', label: '비네팅', min: 0, max: 1, step: 0.05 },
  { key: 'grainAmt', label: '그레인', min: 0, max: 1, step: 0.05 },
  { key: 'angle', label: '수평(기울기)', min: -15, max: 15, step: 0.5 },
];

const ASPECTS: { key: CropAspect; label: string }[] = [
  { key: 'orig', label: '원본' },
  { key: '1:1', label: '1:1' },
  { key: '4:5', label: '4:5' },
  { key: '16:9', label: '16:9' },
  { key: 'free', label: '✂️ 자유' },
];

/** 프리셋이 관리하는 색·효과 값(0 = 변화 없음). 프리셋 적용·원본 비교의 공통 초기값. */
const COLOR_ZERO = {
  brightness: 0, contrast: 0, saturation: 0, warmth: 0, exposure: 0,
  vignette: 0, sharpenAmt: 0, grainAmt: 0,
} as const;

async function decodeBitmap(file: Blob): Promise<{ bmp: ImageBitmap | HTMLImageElement; w: number; h: number }> {
  if (typeof createImageBitmap === 'function') {
    // EXIF 방향 반영(M-exif-orientation) — 편집기도 원본을 바로 세워 보여주고 굽는다.
    let bmp: ImageBitmap;
    try {
      bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      bmp = await createImageBitmap(file);
    }
    return { bmp, w: bmp.width, h: bmp.height };
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return { bmp: img, w: img.naturalWidth, h: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface EditorResult {
  /**
   * apply=편집 적용, skip=원본 사용/닫기, back=이전 사진으로,
   * skipAll=이 사진 포함 나머지 모두 원본, discard=**이 사진을 아예 담지 않는다**.
   *
   * 🔴 `discard`는 「저장하지 않는다」이지 「지운다」가 아니다. 사용자 기기의 원본 파일에는
   * 손대지 않는다(§0 — 원본 자료를 임의로 삭제하지 않는다). 고르는 중에 빼는 것뿐이다.
   */
  action: 'apply' | 'skip' | 'back' | 'skipAll' | 'discard';
  /** 이 사진의 편집 상태(재방문 시 복원용). */
  state: EditState;
  /** apply일 때 편집본(무편집이면 null), 그 외 null. */
  blob: Blob | null;
}

export interface EditorOpts {
  /** 이전 사진 존재 여부(← 이전 버튼 노출). */
  canGoBack?: boolean;
  /** 재방문 시 복원할 편집 상태. */
  initialState?: EditState;
  /** 배치 편집에서 이 사진을 포함해 남은 장수(2 이상이면 "나머지 모두 원본" 버튼 노출). */
  batchRemaining?: number;
}

function cloneState(s: EditState): EditState {
  return {
    ...s,
    heals: s.heals.map((hp) => ({ ...hp })),
    freeCrop: s.freeCrop ? { ...s.freeCrop } : null,
    quad: s.quad ? (s.quad.map((p) => ({ ...p })) as Quad) : null,
  };
}

interface PerspectiveOverlay {
  box: HTMLElement;
  polygon: SVGPolygonElement;
  edges: SVGLineElement[];
  handles: HTMLElement[];
}

function createPerspectiveOverlay(): PerspectiveOverlay {
  const box = el('div', 'pe-quad-box');
  box.hidden = true;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'pe-quad-svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');
  const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  svg.appendChild(polygon);
  const edges = Array.from({ length: 4 }, (_, edge) => {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('class', 'pe-quad-edge');
    line.dataset['edge'] = String(edge);
    svg.appendChild(line);
    return line;
  });
  box.appendChild(svg);
  const handles = Array.from({ length: 4 }, (_, idx) => {
    const handle = el('div', 'pe-handle pe-quad-h');
    handle.dataset['idx'] = String(idx);
    box.appendChild(handle);
    return handle;
  });
  return { box, polygon, edges, handles };
}

function freshQuadDraft(): Quad {
  return [{ x: 0.08, y: 0.08 }, { x: 0.92, y: 0.08 }, { x: 0.92, y: 0.92 }, { x: 0.08, y: 0.92 }];
}

function syncPerspectiveOverlay(overlay: PerspectiveOverlay, draft: Quad, show: boolean): void {
  overlay.box.hidden = !show;
  if (!show) return;
  overlay.polygon.setAttribute('points', draft.map((p) => `${p.x * 100},${p.y * 100}`).join(' '));
  overlay.edges.forEach((line, edge) => {
    const a = draft[edge]!;
    const b = draft[(edge + 1) % 4]!;
    for (const [name, value] of [['x1', a.x], ['y1', a.y], ['x2', b.x], ['y2', b.y]] as const) {
      line.setAttribute(name, String(value * 100));
    }
  });
  draft.forEach((point, idx) => {
    overlay.handles[idx]!.style.left = `${point.x * 100}%`;
    overlay.handles[idx]!.style.top = `${point.y * 100}%`;
  });
}

/** 슬라이더 값 표시: 각도는 °, 나머지는 -100..100 정수(0=원본). */
function fmtSliderVal(spec: SliderSpec, v: number): string {
  if (spec.key === 'angle') return `${v.toFixed(1)}°`;
  const n = Math.round(v * 100);
  return n > 0 ? `+${n}` : String(n);
}

/**
 * 편집 모달을 열고 사용자의 선택을 기다린다(배치 편집: 이전/다음/닫기).
 * 반환: EditorResult(action + state + blob).
 */
/** 미리보기 캔버스의 현재 픽셀. 자동 보정이 「지금 화면에 보이는 것」을 재게 한다(WYSIWYG). */
function readPreviewPixels(preview: HTMLCanvasElement): ImageData | null {
  const rect = preview.getBoundingClientRect();
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(rect.width));
  cv.height = Math.max(1, Math.round(rect.height));
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(preview, 0, 0, cv.width, cv.height);
  return ctx.getImageData(0, 0, cv.width, cv.height);
}

/**
 * 표시 방식(높이 맞춤 ↔ 폭 채우기) 전환기를 만든다 — **바꾸는 길은 이 하나뿐**이다.
 *
 * 🔴 예전엔 이 로직이 클릭 핸들러 안에 손으로 박혀 있었다. 그래서 [초기화]가 재사용할 수
 * 없었고, `fitMode`는 `EditState` 밖 변수라 `Object.assign(state, DEFAULT_EDIT)`도 못
 * 건드렸다 — **초기화를 눌러도 사진이 확대된 채 남았다**(사용자 보고 2026-08-09, 라이브에서
 * 눌러 재현). 상태를 바꾸는 길이 둘이면 하나는 반드시 빠진다(§7 2층).
 */
function makeFitMode(
  fitBtn: HTMLButtonElement,
  stage: HTMLElement,
  canvasWrap: HTMLElement,
  store: (m: 'contain' | 'width') => void,
  repaint: () => void,
): (on: boolean) => void {
  return (on: boolean) => {
    store(on ? 'width' : 'contain');
    fitBtn.textContent = on ? '\uD83D\uDD33 높이 맞춤' : '\u2195 폭 채우기';
    fitBtn.setAttribute('aria-pressed', String(on));
    stage.classList.toggle('is-fill', on);
    canvasWrap.classList.toggle('is-fill', on);
    repaint();
  };
}

/** 잡티 브러시 크기 슬라이더. 값 변경만 바깥에 알린다(표시 로직은 여기 가둔다). */
function makeBrushSlider(initial: number, onChange: (v: number) => void): HTMLLabelElement {
  const brush = el('input') as HTMLInputElement;
  brush.type = 'range';
  brush.min = '1';
  brush.max = '8';
  brush.step = '0.5';
  brush.value = String(initial);
  brush.setAttribute('aria-label', '브러시 크기');
  brush.addEventListener('input', () => onChange(Number(brush.value)));
  const wrap = el('label', 'pe-zoom-wrap') as HTMLLabelElement;
  wrap.append(el('span', 'pe-slider-label', '크기'), brush);
  wrap.hidden = true;
  return wrap;
}

/**
 * 「✨ 자동 보정」 버튼 — 어두운 작은 얼룩을 찾아 한 번에 지운다.
 *
 * 🔴 셋을 함께 지킨다. ①실행 **직전** 이력을 남겨 ↺ 한 번으로 전부 원복되게 하고
 * ②결과를 **문장으로 말한다**(조용히 아무 일도 안 일어나면 사용자는 고장으로 읽는다 · §8)
 * ③찾은 게 없으면 그 사실도 말한다 — 「없음」과 「안 해봄」을 같은 침묵으로 두지 않는다.
 */
function makeAutoHealButton(d: {
  preview: HTMLCanvasElement;
  healHint: HTMLElement;
  state: EditState;
  srcW: number;
  srcH: number;
  pushHistory: () => void;
  repaint: () => void;
}): HTMLButtonElement {
  const btn = el('button', 'btn-ghost', '\u2728 자동 보정') as HTMLButtonElement;
  btn.type = 'button';
  btn.title = '어두운 작은 얼룩을 찾아 한 번에 지웁니다 (↺로 되돌릴 수 있어요)';
  btn.addEventListener('click', () => {
    const img = readPreviewPixels(d.preview);
    const pts = img ? autoHealPoints(img.data, img.width, img.height, d.srcW, d.srcH, d.state) : [];
    d.healHint.hidden = false;
    if (!pts.length) {
      d.healHint.textContent = '자동으로 찾을 만한 얼룩이 안 보여요. 지우고 싶은 곳을 직접 톡 눌러 주세요.';
      return;
    }
    d.pushHistory();
    d.state.heals.push(...pts);
    d.healHint.textContent = `얼룩 ${pts.length}곳을 지웠어요. 마음에 안 들면 상단 ↺로 되돌리세요.`;
    d.repaint();
  });
  return btn;
}

/**
 * 「이 사진 버리기」 버튼.
 *
 * 🔴 **되돌릴 수 없는 방향이라 묻는다**(닫기 보호와 같은 자세). 그리고 문장이 반드시
 * *「기기의 원본 파일은 지워지지 않는다」*를 말한다 — 이 앱에서 「버린다」는 낱말은
 * 사용자에게 원본 삭제로 읽힐 수 있고, 그건 §0이 절대 금지하는 일이다.
 */
function makeDiscardButton(onDiscard: () => void): HTMLButtonElement {
  const btn = el('button', 'btn-ghost pe-discard', '\uD83D\uDDD1 이 사진 버리기') as HTMLButtonElement;
  btn.type = 'button';
  btn.title = '이 사진을 기록에 담지 않습니다 (기기의 원본 파일은 그대로예요)';
  btn.addEventListener('click', () => {
    if (!confirm('이 사진을 기록에 담지 않을까요?\n\n기기에 있는 원본 사진 파일은 지워지지 않습니다.')) return;
    onDiscard();
  });
  return btn;
}

export async function openPhotoEditor(
  file: Blob,
  fileLabel: string,
  opts: EditorOpts = {},
): Promise<EditorResult> {
  const { bmp, w, h } = await decodeBitmap(file);
  const state: EditState = opts.initialState ? cloneState(opts.initialState) : freshEdit();
  let healMode = false;
  let brushPct = 3; // 이미지 너비의 %
  let cropApplied = false; // 자유 크롭: 영역을 확정해 잘린 결과를 미리보기로 볼지 여부
  let fitMode: 'contain' | 'width' = 'contain'; // 표시 방식: 높이 맞춤(여백 최소) ↔ 폭 100%(세로 스크롤)

  return new Promise<EditorResult>((resolve) => {
    const overlay = el('div', 'overlay-base pe-overlay');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', '사진 편집');

    const sheet = el('div', 'modal-base pe-sheet');
    overlay.appendChild(sheet);

    // ── 헤더 ──
    const head = el('div', 'pe-head');
    head.appendChild(el('b', undefined, '✨ 사진 편집'));
    head.appendChild(el('span', 'pe-file muted small', fileLabel));
    const undoAllBtn = el('button', 'pe-close pe-undo', '↺') as HTMLButtonElement;
    undoAllBtn.type = 'button';
    undoAllBtn.disabled = true;
    undoAllBtn.setAttribute('aria-label', '실행취소 — 마지막 편집 한 단계 되돌리기');
    undoAllBtn.title = '실행취소';
    undoAllBtn.addEventListener('click', () => undoLast());
    head.appendChild(undoAllBtn);
    const closeBtn = el('button', 'pe-close', '✕') as HTMLButtonElement;
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', '닫기(원본 사용)');
    closeBtn.addEventListener('click', () => attemptClose());
    head.appendChild(closeBtn);
    sheet.appendChild(head);

    // ── 미리보기(캔버스 + 크롭 오버레이) ──
    const stage = el('div', 'pe-stage');
    const canvasWrap = el('div', 'pe-canvas-wrap');
    const preview = el('canvas', 'pe-canvas') as HTMLCanvasElement;
    canvasWrap.appendChild(preview);
    // 자유 크롭 오버레이
    const cropBox = el('div', 'pe-crop-rect');
    cropBox.hidden = true;
    for (const corner of ['nw', 'ne', 'sw', 'se']) {
      const hnd = el('div', `pe-handle pe-h-${corner}`);
      hnd.dataset['corner'] = corner;
      cropBox.appendChild(hnd);
    }
    canvasWrap.appendChild(cropBox);
    // 원근 펴기 오버레이: 4개의 독립 모서리 핸들 + 사다리꼴 윤곽(SVG). 좌표는 캔버스 %.
    const quadOverlay = createPerspectiveOverlay();
    const quadBox = quadOverlay.box;
    canvasWrap.appendChild(quadBox);
    // 브러시 크기 표시(잡티 제거): 크기 조절·탭 순간에 실제 반경을 원으로 잠깐 보여준다.
    const brushDot = el('div', 'pe-brush-dot');
    brushDot.hidden = true;
    canvasWrap.appendChild(brushDot);
    let brushDotTimer = 0;
    function showBrushDot(cx: number, cy: number, diamPx: number, ms: number): void {
      brushDot.style.left = `${cx}px`;
      brushDot.style.top = `${cy}px`;
      brushDot.style.width = `${diamPx}px`;
      brushDot.style.height = `${diamPx}px`;
      brushDot.hidden = false;
      window.clearTimeout(brushDotTimer);
      brushDotTimer = window.setTimeout(() => {
        brushDot.hidden = true;
      }, ms);
    }
    stage.appendChild(canvasWrap);
    sheet.appendChild(stage);

    // ── 자르기 확정 바(자유 크롭 시에만 노출) ──
    // 모서리를 끌어 영역을 정한 뒤 "이 영역으로 자르기"를 눌러 잘린 결과를 바로 확인한다.
    const cropBar = el('div', 'pe-cropbar');
    cropBar.hidden = true;
    const cropApplyBtn = el('button', 'pe-chip pe-crop-apply', '✂️ 이 영역으로 자르기') as HTMLButtonElement;
    cropApplyBtn.type = 'button';
    const cropHint = el('span', 'pe-hint muted small', '모서리를 끌어 영역을 정한 뒤 눌러 적용하세요');
    cropBar.append(cropApplyBtn, cropHint);
    sheet.appendChild(cropBar);

    // ── 원근 펴기 확정 바(펴기 모드 시에만 노출) ──
    // 4모서리를 대상(화면·간판·문서) 모서리에 맞춘 뒤 "반듯하게 펴기"로 사다리꼴을 직사각형으로 편다.
    const perspBar = el('div', 'pe-cropbar pe-perspbar');
    perspBar.hidden = true;
    const perspApplyBtn = el('button', 'pe-chip pe-crop-apply', '📐 반듯하게 펴기') as HTMLButtonElement;
    perspApplyBtn.type = 'button';
    const perspClearBtn = el('button', 'pe-chip', '펴기 해제') as HTMLButtonElement;
    perspClearBtn.type = 'button';
    perspClearBtn.hidden = true;
    const perspHint = el('span', 'pe-hint muted small', '동그란 점이나 점선을 끌어 대상 테두리에 맞춘 뒤 누르세요');
    perspBar.append(perspApplyBtn, perspClearBtn, perspHint);
    sheet.appendChild(perspBar);

    const isCropMode = (): boolean => state.aspect === 'free';

    function ensureFreeCrop(): void {
      if (!state.freeCrop) state.freeCrop = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
    }

    // ── 원근 펴기 모드 상태 ──
    let perspMode = false;
    // 드래프트는 적용 전까지 state를 건드리지 않는다(적용이 이산 undo 한 단계).
    let quadDraft = freshQuadDraft();
    function syncQuadBox(show: boolean): void {
      syncPerspectiveOverlay(quadOverlay, quadDraft, show);
    }

    // 펴기 모드 진입 칩(기하 도구줄에 부착 — 생성만 여기서).
    const perspBtn = el('button', 'pe-chip pe-persp', '📐 펴기') as HTMLButtonElement;
    perspBtn.type = 'button';
    perspBtn.setAttribute('aria-pressed', 'false');
    perspBtn.title = '비스듬히 찍힌 화면·간판·문서를 반듯하게 폅니다';

    function setPerspMode(on: boolean): void {
      perspMode = on;
      perspBtn.setAttribute('aria-pressed', String(on));
      perspBar.hidden = !on;
      if (on) {
        // 기존 적용값이 있으면 그 모서리에서 이어서 조정.
        if (state.quad) quadDraft = state.quad.map((p) => ({ ...p })) as Quad;
        perspClearBtn.hidden = !state.quad;
      }
      repaint();
    }
    perspBtn.addEventListener('click', () => {
      if (!perspMode) {
        if (isCropMode()) {
          // 크롭 모드 종료 후 펴기 모드로(잡티 모드 진입과 동일 규율)
          pushHistory();
          state.aspect = 'orig';
          cropApplied = false;
          syncAspectChips();
          updateCropBar();
        }
        setHealMode(false);
      }
      setPerspMode(!perspMode);
    });
    perspApplyBtn.addEventListener('click', () => {
      pushHistory();
      state.quad = quadDraft.map((p) => ({ ...p })) as Quad;
      setPerspMode(false);
    });
    perspClearBtn.addEventListener('click', () => {
      pushHistory();
      state.quad = null;
      setPerspMode(false);
    });

    // 모서리 점 또는 점선 변 드래그: 적용 전 드래프트만 갱신(상태 불변 → undo는 "펴기" 시 한 단계).
    type QuadDrag =
      | { kind: 'corner'; idx: number }
      | { kind: 'edge'; edge: QuadEdge; startX: number; startY: number; startQuad: Quad };
    let quadDrag: QuadDrag | null = null;
    quadBox.addEventListener('pointerdown', (e) => {
      const target = e.target as HTMLElement | SVGElement;
      const idxStr = target.dataset['idx'];
      const edgeStr = target.dataset['edge'];
      if (idxStr !== undefined) {
        quadDrag = { kind: 'corner', idx: Number(idxStr) };
      } else if (edgeStr !== undefined) {
        quadDrag = {
          kind: 'edge',
          edge: Number(edgeStr) as QuadEdge,
          startX: e.clientX,
          startY: e.clientY,
          startQuad: quadDraft.map((p) => ({ ...p })) as Quad,
        };
      } else {
        return;
      }
      try {
        quadBox.setPointerCapture(e.pointerId);
      } catch {
        /* 합성/종료 포인터 캡처 불가 시에도 드래그 추적은 계속 */
      }
      e.preventDefault();
    });
    quadBox.addEventListener('pointermove', (e) => {
      if (!quadDrag) return;
      const rect = canvasWrap.getBoundingClientRect();
      if (quadDrag.kind === 'corner') {
        quadDraft[quadDrag.idx] = {
          x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
          y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
        };
      } else {
        quadDraft = moveQuadEdge(
          quadDrag.startQuad,
          quadDrag.edge,
          (e.clientX - quadDrag.startX) / rect.width,
          (e.clientY - quadDrag.startY) / rect.height,
        );
      }
      syncQuadBox(true);
    });
    const endQuadDrag = (): void => {
      quadDrag = null;
    };
    quadBox.addEventListener('pointerup', endQuadDrag);
    quadBox.addEventListener('pointercancel', endQuadDrag);

    // ── 전역 실행취소(모든 편집 이력) ──
    // 각 조작 "직전" 상태를 스냅샷으로 쌓는다. 슬라이더·팬·핀치 같은 연속 제스처는
    // 시작 시점을 pendingSnap으로 잡아 손을 뗄 때 한 번만 커밋한다(틱마다 쌓이지 않게).
    const history: EditState[] = [];
    let pendingSnap: EditState | null = null;
    function pushHistory(snap?: EditState): void {
      history.push(snap ?? cloneState(state));
      if (history.length > 50) history.shift();
      undoAllBtn.disabled = false;
    }
    function commitPending(): void {
      // 실제로 값이 바뀐 제스처만 이력에 남긴다(무변화 탭이 빈 undo 단계가 되지 않게).
      if (pendingSnap && JSON.stringify(pendingSnap) !== JSON.stringify(state)) pushHistory(pendingSnap);
      pendingSnap = null;
    }
    function undoLast(): void {
      commitPending();
      const prev = history.pop();
      if (!prev) return;
      Object.assign(state, cloneState(prev));
      undoAllBtn.disabled = history.length === 0;
      cropApplied = false;
      if (perspMode) setPerspMode(false); // 되돌린 상태와 드래프트가 어긋나지 않게 모드 종료
      zoom.value = String(state.zoom);
      syncSliders();
      syncAspectChips();
      setPresetActive(
        isNoAdjust(state) && state.vignette === 0 && state.sharpenAmt === 0 && state.grainAmt === 0
          ? '원본'
          : null,
      );
      updateCropBar();
      repaint();
    }

    // 자유 크롭 UI 상태 갱신(바 노출·버튼 라벨·힌트).
    function updateCropBar(): void {
      const on = isCropMode();
      cropBar.hidden = !on;
      if (!on) cropApplied = false;
      cropApplyBtn.textContent = cropApplied ? '✏️ 자르기 영역 다시 지정' : '✂️ 이 영역으로 자르기';
      cropHint.textContent = cropApplied
        ? '잘린 결과 미리보기 중 · 저장하려면 아래 “적용”'
        : '모서리를 끌어 영역을 정한 뒤 눌러 적용하세요';
    }
    cropApplyBtn.addEventListener('click', () => {
      ensureFreeCrop();
      cropApplied = !cropApplied; // 확정 ↔ 재지정 토글
      updateCropBar();
      repaint();
    });

    function syncCropBox(show: boolean): void {
      if (!show || !state.freeCrop) {
        cropBox.hidden = true;
        return;
      }
      cropBox.hidden = false;
      cropBox.style.left = `${state.freeCrop.x * 100}%`;
      cropBox.style.top = `${state.freeCrop.y * 100}%`;
      cropBox.style.width = `${state.freeCrop.w * 100}%`;
      cropBox.style.height = `${state.freeCrop.h * 100}%`;
    }

    // 상태 s를 maxEdge 해상도로 구워 미리보기에 그린다(표시 폭·비율도 함께 갱신).
    function drawState(s: EditState, maxEdge: number): void {
      const baked = bakeToCanvas(bmp, w, h, s, maxEdge);
      preview.width = baked.width;
      preview.height = baked.height;
      preview.getContext('2d')?.drawImage(baked, 0, 0);
      // 표시 방식:
      //  - contain(기본): 폭을 채우되 높이를 화면 62%(최대 640px)로 제한 → 스크롤 없이 한눈에.
      //  - width: 폭 100%로 꽉 채우고 세로로 길면 시트가 스크롤 → 세로 사진을 크게(여백 0).
      // 두 방식 모두 래퍼가 캔버스 비율에 맞춰 잡히므로 크롭 오버레이(%)가 이미지와 정렬된다.
      if (fitMode === 'width') {
        canvasWrap.style.maxWidth = '';
      } else {
        const ar = baked.width / baked.height;
        const capH = Math.min(Math.round(window.innerHeight * 0.62), 640);
        canvasWrap.style.maxWidth = `${Math.round(capH * ar)}px`;
      }
    }

    // 2단계 미리보기: 드래그 중(fast)엔 저해상으로 즉답, 손 떼면 고해상 재굽기.
    let raf = 0;
    let rafFast = true;
    function repaint(fast = false): void {
      if (!fast) rafFast = false; // 예약된 프레임이 있어도 품질은 상향만 한다
      if (raf) return;
      rafFast = fast;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const quality = rafFast ? FAST_MAX : PREVIEW_MAX;
        rafFast = true;
        // 영역 지정 중에는 크롭을 뺀 전체를 보여주고 오버레이로 선택한다.
        // 확정(cropApplied) 후엔 state 그대로 구워 잘린 결과를 미리 보여준다.
        // 펴기 모드에선 quad·크롭을 뺀 전체(기하 원판)를 보여주고 4점 오버레이로 지정한다.
        const showQuad = perspMode;
        const showOverlay = !showQuad && isCropMode() && !cropApplied;
        const s = showQuad
          ? { ...state, quad: null, aspect: 'orig' as CropAspect, zoom: 1, panX: 0, panY: 0, freeCrop: null }
          : showOverlay
            ? { ...state, aspect: 'orig' as CropAspect, zoom: 1, panX: 0, panY: 0, freeCrop: null }
            : state;
        drawState(s, quality);
        syncCropBox(showOverlay);
        syncQuadBox(showQuad);
      });
    }

    // ── 포인터: 팬 / 잡티 탭 / 핀치 줌 ──
    const activePts = new Map<number, { x: number; y: number }>();
    let pinch: { dist: number; zoom: number } | null = null;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    function pinchDist(): number {
      const [a, b] = [...activePts.values()];
      return Math.hypot(a!.x - b!.x, a!.y - b!.y);
    }
    preview.addEventListener('pointerdown', (e) => {
      if (isCropMode()) return; // 크롭 모드는 오버레이가 처리
      if (perspMode) return; // 펴기 모드는 4점 오버레이가 처리
      if (healMode) {
        // 탭 위치 → 기하 정규화 좌표(현재 크롭 창 기준 역투영)
        const rect = preview.getBoundingClientRect();
        const u = (e.clientX - rect.left) / rect.width;
        const v = (e.clientY - rect.top) / rect.height;
        // ⚠️ 여기서 좌표를 손으로 계산하지 않는다(2026-07-27). 예전엔 `rotatedDims`(rd) 기준으로
        // 직접 계산했는데 bake는 `gd`(원근 펴기 후) 기준으로 재투영한다 — **원근 펴기를 적용한 뒤
        // 잡티를 찍으면 엉뚱한 곳에 찍혔다.** 이제 bake와 같은 순수 함수를 지난다(§7 2층).
        pushHistory();
        state.heals.push(screenToGeo(u, v, w, h, state, brushPct));
        // 탭 지점에 적용 반경을 잠깐 보여준다(지름 = 반경(brushPct% of 폭) × 2).
        showBrushDot(e.clientX - rect.left, e.clientY - rect.top, (brushPct / 50) * rect.width, 400);
        repaint();
        return;
      }
      activePts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try {
        preview.setPointerCapture(e.pointerId);
      } catch {
        /* 이미 끝난 포인터(합성 이벤트 포함)는 캡처 불가 — 제스처 추적은 계속 */
      }
      if (!pendingSnap) pendingSnap = cloneState(state); // 팬/핀치 제스처 시작점(undo 단위)
      if (activePts.size === 2) {
        // 두 손가락 → 핀치 줌 시작(팬 중단)
        dragging = false;
        pinch = { dist: pinchDist(), zoom: state.zoom };
        return;
      }
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
    });
    preview.addEventListener('pointermove', (e) => {
      if (activePts.has(e.pointerId)) activePts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && activePts.size === 2) {
        const z = Math.max(1, Math.min(3, (pinch.zoom * pinchDist()) / pinch.dist));
        state.zoom = Math.round(z * 20) / 20; // 슬라이더 step(0.05)에 맞춤
        zoom.value = String(state.zoom);
        if (state.zoom === 1) {
          state.panX = 0;
          state.panY = 0;
        }
        repaint(true);
        return;
      }
      if (!dragging || state.zoom <= 1) return;
      const rect = preview.getBoundingClientRect();
      state.panX = Math.max(-1, Math.min(1, state.panX - ((e.clientX - lastX) / rect.width) * 2));
      state.panY = Math.max(-1, Math.min(1, state.panY - ((e.clientY - lastY) / rect.height) * 2));
      lastX = e.clientX;
      lastY = e.clientY;
      repaint(true);
    });
    function endPointer(e: PointerEvent): void {
      activePts.delete(e.pointerId);
      if (pinch && activePts.size < 2) {
        pinch = null;
        repaint(); // 핀치 종료 → 고해상 재굽기
      }
      if (activePts.size === 0) {
        commitPending(); // 제스처 종료 → 값이 바뀌었으면 undo 이력에 한 단계로
        if (dragging) {
          dragging = false;
          repaint();
        }
      }
    }
    preview.addEventListener('pointerup', endPointer);
    preview.addEventListener('pointercancel', endPointer);

    // ── Ctrl+휠 확대/축소(PC) — 트랙패드 핀치도 브라우저가 ctrlKey+wheel로 전달한다.
    // 연속 제스처 규칙(§2-2): 틱마다 fast 재굽기, 350ms 잠잠하면 커밋+고해상. undo 한 단계.
    let wheelTimer = 0;
    stage.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey) return; // 일반 휠은 시트 스크롤로 통과
        if (isCropMode()) return; // 자유 크롭 창은 zoom/pan을 쓰지 않아 보이지 않는 상태 변경 방지
        if (perspMode) return; // 펴기 모드도 동일(전체 뷰 고정)
        e.preventDefault(); // 브라우저 페이지 확대 차단
        if (!pendingSnap) pendingSnap = cloneState(state);
        const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY; // line 모드 정규화
        const z = Math.max(1, Math.min(3, state.zoom * Math.exp(-dy * 0.002)));
        state.zoom = Math.round(z * 20) / 20; // 슬라이더 step(0.05)에 맞춤
        zoom.value = String(state.zoom);
        if (state.zoom === 1) {
          state.panX = 0;
          state.panY = 0;
        }
        repaint(true);
        window.clearTimeout(wheelTimer);
        wheelTimer = window.setTimeout(() => {
          commitPending();
          repaint();
        }, 350);
      },
      { passive: false },
    );

    // ── 크롭 오버레이 드래그(이동/모서리 리사이즈) ──
    let cropDrag: { mode: FreeCropDragMode; sx: number; sy: number; fc: { x: number; y: number; w: number; h: number } } | null = null;
    cropBox.addEventListener('pointerdown', (e) => {
      if (!pendingSnap) pendingSnap = cloneState(state); // 크롭 드래그도 undo 한 단계
      ensureFreeCrop();
      const corner = (e.target as HTMLElement).dataset['corner'] as 'nw' | 'ne' | 'sw' | 'se' | undefined;
      cropDrag = { mode: corner ?? 'move', sx: e.clientX, sy: e.clientY, fc: { ...state.freeCrop! } };
      try {
        cropBox.setPointerCapture(e.pointerId);
      } catch {
        /* 합성/종료 포인터 캡처 불가 시에도 드래그 추적은 계속 */
      }
      e.preventDefault();
    });
    cropBox.addEventListener('pointermove', (e) => {
      if (!cropDrag || !state.freeCrop) return;
      const rect = canvasWrap.getBoundingClientRect();
      const dx = (e.clientX - cropDrag.sx) / rect.width;
      const dy = (e.clientY - cropDrag.sy) / rect.height;
      state.freeCrop = resizeFreeCrop(cropDrag.fc, cropDrag.mode, dx, dy, MIN_CROP);
      syncCropBox(true);
    });
    cropBox.addEventListener('pointerup', () => {
      cropDrag = null;
      commitPending();
    });

    // ── 프리셋 + 원본 비교 ──
    const presetRow = el('div', 'pe-presets');
    const presetBtns = new Map<string, HTMLButtonElement>();
    function setPresetActive(name: string | null): void {
      for (const [n, b] of presetBtns) b.setAttribute('aria-pressed', String(n === name));
    }
    for (const [name, patch] of Object.entries(PRESETS)) {
      const b = el('button', 'pe-chip', name) as HTMLButtonElement;
      b.type = 'button';
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => {
        pushHistory();
        Object.assign(state, COLOR_ZERO, patch);
        setPresetActive(name);
        syncSliders();
        repaint();
      });
      presetBtns.set(name, b);
      presetRow.appendChild(b);
    }
    // 누르는 동안 색·효과·잡티를 뺀 상태를 보여준다(기하는 유지 — 같은 구도로 비교).
    const cmpBtn = el('button', 'pe-chip pe-compare', '👁 원본 비교') as HTMLButtonElement;
    cmpBtn.type = 'button';
    cmpBtn.title = '누르고 있는 동안 보정 전 모습을 보여줍니다';
    cmpBtn.addEventListener('contextmenu', (e) => e.preventDefault()); // 모바일 길게 누르기 메뉴 차단
    cmpBtn.addEventListener('pointerdown', (e) => {
      cmpBtn.setPointerCapture(e.pointerId);
      drawState({ ...state, ...COLOR_ZERO, heals: [] }, PREVIEW_MAX);
    });
    const endCompare = (): void => repaint();
    cmpBtn.addEventListener('pointerup', endCompare);
    cmpBtn.addEventListener('pointercancel', endCompare);
    presetRow.appendChild(cmpBtn);
    sheet.appendChild(presetRow);

    // ── 기하·도구 컨트롤 ──
    const geoRow = el('div', 'pe-geo');
    const rotBtn = el('button', 'pe-chip', '↻ 회전') as HTMLButtonElement;
    rotBtn.type = 'button';
    rotBtn.addEventListener('click', () => {
      if (perspMode) setPerspMode(false); // 회전 중 드래프트 좌표가 낡지 않게 모드 종료
      pushHistory();
      state.rotate90 = ((state.rotate90 + 1) % 4) as EditState['rotate90'];
      state.heals = rotateHeals90(state.heals); // 기존 잡티 좌표 보존
      if (state.freeCrop) state.freeCrop = rotateFreeCrop90(state.freeCrop);
      if (state.quad) state.quad = rotateQuad90(state.quad); // 펴기 모서리도 함께 회전
      repaint();
    });
    const flipBtn = el('button', 'pe-chip', '⇋ 반전') as HTMLButtonElement;
    flipBtn.type = 'button';
    flipBtn.addEventListener('click', () => {
      if (perspMode) setPerspMode(false);
      pushHistory();
      state.flipH = !state.flipH;
      state.heals = flipHealsH(state.heals);
      if (state.freeCrop) state.freeCrop = flipFreeCropH(state.freeCrop);
      if (state.quad) state.quad = flipQuadH(state.quad);
      repaint();
    });
    // 표시 방식 토글: 폭 100%(세로 스크롤) ↔ 높이 맞춤(여백 최소). 세로로 긴 사진용.
    const fitBtn = el('button', 'pe-chip pe-fit', '↕ 폭 채우기') as HTMLButtonElement;
    fitBtn.type = 'button';
    fitBtn.setAttribute('aria-pressed', 'false');
    fitBtn.title = '세로로 긴 사진을 폭에 꽉 채워 크게 보기(세로 스크롤)';
    const setFitMode = makeFitMode(fitBtn, stage, canvasWrap, (m) => { fitMode = m; }, () => repaint());
    fitBtn.addEventListener('click', () => {
      setFitMode(fitMode !== 'width');
    });
    geoRow.append(rotBtn, flipBtn, perspBtn, fitBtn);
    // 비율 칩 활성 표시를 state.aspect 기준으로 일괄 동기화(개별 손편집 대신 단일 경로).
    function syncAspectChips(): void {
      const label = ASPECTS.find((a) => a.key === state.aspect)?.label ?? '원본';
      geoRow.querySelectorAll('.pe-aspect').forEach((x) =>
        x.setAttribute('aria-pressed', String((x as HTMLButtonElement).textContent === label)),
      );
    }
    for (const a of ASPECTS) {
      const b = el('button', 'pe-chip pe-aspect', a.label) as HTMLButtonElement;
      b.type = 'button';
      b.setAttribute('aria-pressed', String(a.key === state.aspect));
      b.addEventListener('click', () => {
        if (state.aspect !== a.key) pushHistory();
        state.aspect = a.key;
        cropApplied = false; // 비율을 바꾸면 크롭 확정 해제(다시 지정 흐름)
        if (a.key === 'free') {
          ensureFreeCrop();
          setHealMode(false); // 크롭 중엔 잡티 오프
        }
        syncAspectChips();
        updateCropBar();
        repaint();
      });
      geoRow.appendChild(b);
    }
    const zoom = el('input', 'pe-zoom') as HTMLInputElement;
    zoom.type = 'range';
    zoom.min = '1';
    zoom.max = '3';
    zoom.step = '0.05';
    zoom.value = '1';
    zoom.setAttribute('aria-label', '확대');
    zoom.addEventListener('input', () => {
      if (!pendingSnap) pendingSnap = cloneState(state);
      state.zoom = Number(zoom.value);
      if (state.zoom === 1) {
        state.panX = 0;
        state.panY = 0;
      }
      repaint(true);
    });
    zoom.addEventListener('change', () => {
      commitPending();
      repaint();
    });
    const zoomWrap = el('label', 'pe-zoom-wrap');
    zoomWrap.append(el('span', 'pe-slider-label', '🔍'), zoom);
    geoRow.appendChild(zoomWrap);
    sheet.appendChild(geoRow);

    // ── 잡티 제거 도구줄 ──
    const healRow = el('div', 'pe-geo pe-heal-row');
    const healBtn = el('button', 'pe-chip', '🩹 잡티 제거') as HTMLButtonElement;
    healBtn.type = 'button';
    healBtn.setAttribute('aria-pressed', 'false');
    const brushWrap = makeBrushSlider(brushPct, (v) => {
      brushPct = v;
      const rect = canvasWrap.getBoundingClientRect();
      showBrushDot(rect.width / 2, rect.height / 2, (brushPct / 50) * rect.width, 600);
    });
    const healHint = el('span', 'pe-hint muted small', '지우고 싶은 점을 사진에서 톡 누르세요 · 되돌리기는 상단 ↺');
    healHint.hidden = true;
    const setHealMode = (on: boolean): void => {
      healMode = on;
      healBtn.setAttribute('aria-pressed', String(on));
      brushWrap.hidden = !on;
      healHint.hidden = !on;
      preview.classList.toggle('pe-heal-cursor', on);
    };
    healBtn.addEventListener('click', () => {
      if (perspMode) setPerspMode(false); // 펴기 모드와 잡티 모드는 동시 불가
      if (isCropMode()) {
        // 크롭 모드 종료 후 잡티 모드로
        pushHistory();
        state.aspect = 'orig';
        cropApplied = false;
        syncAspectChips();
        updateCropBar();
        repaint();
      }
      setHealMode(!healMode);
    });
    const autoHealBtn = makeAutoHealButton({ preview, healHint, state, srcW: w, srcH: h, pushHistory, repaint });
    healRow.append(healBtn, autoHealBtn, brushWrap, healHint);
    sheet.appendChild(healRow);

    // ── 슬라이더들(값 표시 + 라벨 두 번 탭 = 그 항목만 초기화) ──
    const sliderCtl = new Map<keyof EditState, { input: HTMLInputElement; val: HTMLSpanElement; spec: SliderSpec }>();
    const sliders = el('div', 'pe-sliders');
    for (const spec of SLIDERS) {
      const row = el('label', 'pe-slider');
      const input = el('input') as HTMLInputElement;
      input.type = 'range';
      input.min = String(spec.min);
      input.max = String(spec.max);
      input.step = String(spec.step);
      input.value = String(state[spec.key]);
      input.setAttribute('aria-label', spec.label);
      const val = el('span', 'pe-slider-val', fmtSliderVal(spec, state[spec.key] as number));
      const lab = el('span', 'pe-slider-label', spec.label);
      lab.title = '두 번 탭하면 이 항목만 초기화';
      lab.addEventListener('dblclick', () => {
        if (state[spec.key] === DEFAULT_EDIT[spec.key]) return; // 이미 초기값 → 빈 undo 방지
        pushHistory();
        (state[spec.key] as number) = DEFAULT_EDIT[spec.key] as number;
        input.value = String(state[spec.key]);
        val.textContent = fmtSliderVal(spec, state[spec.key] as number);
        if (spec.key !== 'angle') setPresetActive(null);
        repaint();
      });
      input.addEventListener('input', () => {
        if (!pendingSnap) pendingSnap = cloneState(state); // 드래그 시작점 = undo 한 단계
        (state[spec.key] as number) = Number(input.value);
        val.textContent = fmtSliderVal(spec, Number(input.value));
        if (spec.key !== 'angle') setPresetActive(null); // 수동 조정 → 프리셋 해제 표시
        repaint(true);
      });
      input.addEventListener('change', () => {
        commitPending();
        repaint(); // 손 떼면 고해상 재굽기
      });
      sliderCtl.set(spec.key, { input, val, spec });
      row.append(lab, input, val);
      sliders.appendChild(row);
    }
    sheet.appendChild(sliders);

    function syncSliders(): void {
      for (const { input, val, spec } of sliderCtl.values()) {
        input.value = String(state[spec.key]);
        val.textContent = fmtSliderVal(spec, state[spec.key] as number);
      }
    }

    // ── 액션 ──
    const actions = el('div', 'pe-actions');
    const resetBtn = el('button', 'btn-ghost', '초기화') as HTMLButtonElement;
    resetBtn.type = 'button';
    // 「해당 사진에 한해서」를 화면에 적는다 — 배치 편집에서 다른 사진까지 지워질까 봐 못 누른다.
    resetBtn.title = '이 사진의 편집만 처음 상태로 되돌립니다 (다른 사진은 그대로)';
    resetBtn.addEventListener('click', () => {
      if (!isIdentity(state)) pushHistory(); // 초기화 전 상태를 이력에 — ↺로 복구 가능
      Object.assign(state, DEFAULT_EDIT, { heals: [], freeCrop: null });
      zoom.value = '1';
      cropApplied = false;
      setHealMode(false);
      // 🔴 EditState 밖 표시 상태도 함께 되돌린다 — 안 되돌리면 「초기화했는데 확대된 채」가 된다.
      setFitMode(false);
      setPerspMode(false);
      setPresetActive('원본');
      syncSliders();
      syncAspectChips();
      updateCropBar();
      repaint();
    });
    const skipBtn = el('button', 'btn-ghost', '원본 사용') as HTMLButtonElement;
    skipBtn.type = 'button';
    const applyBtn = el('button', 'btn-primary', '적용') as HTMLButtonElement;
    applyBtn.type = 'button';
    if (opts.canGoBack) {
      const backBtn = el('button', 'btn-ghost', '← 이전') as HTMLButtonElement;
      backBtn.type = 'button';
      backBtn.addEventListener('click', () => finish('back', null));
      actions.appendChild(backBtn);
    }
    actions.append(resetBtn, skipBtn);
    // 배치 추가에서 여러 장 남았으면 나머지를 한 번에 원본으로 저장(장당 편집기 강제 통과 제거).
    if ((opts.batchRemaining ?? 0) > 1) {
      const skipAllBtn = el('button', 'btn-ghost', `⏭ 남은 ${opts.batchRemaining}장 모두 원본`) as HTMLButtonElement;
      skipAllBtn.type = 'button';
      skipAllBtn.addEventListener('click', () => finish('skipAll', null));
      actions.appendChild(skipAllBtn);
    }
    // 🔴 배치에서만 「이 사진 버리기」를 준다. 한 장짜리에는 없다 — 그 자리에선 ✕(원본 사용)가
    // 이미 「담지 않고 닫기」와 같은 뜻이고, 버튼을 하나 더 두면 뜻이 겹쳐 오히려 헷갈린다.
    if (opts.batchRemaining !== undefined) actions.appendChild(makeDiscardButton(() => finish('discard', null)));
    actions.appendChild(applyBtn);
    sheet.appendChild(actions);

    function finish(action: EditorResult['action'], blob: Blob | null): void {
      document.removeEventListener('keydown', onKey);
      if ('close' in bmp && typeof (bmp as ImageBitmap).close === 'function') (bmp as ImageBitmap).close();
      overlay.remove();
      resolve({ action, state, blob });
    }

    // 닫기 보호: 편집한 게 있으면 버릴지 확인한다(실수로 ✕/Esc → 작업 유실 방지).
    function attemptClose(): void {
      if (!isIdentity(state) && !window.confirm('편집한 내용을 적용하지 않고 닫을까요?\n이 사진은 원본 그대로 사용됩니다.')) return;
      finish('skip', null);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') attemptClose();
    }
    document.addEventListener('keydown', onKey);

    skipBtn.addEventListener('click', () => finish('skip', null));
    applyBtn.addEventListener('click', () => {
      applyBtn.disabled = true;
      if (isIdentity(state)) {
        finish('apply', null); // 무편집 → 재인코딩 손실 방지(원본 사용)
        return;
      }
      applyBtn.textContent = '적용 중…';
      // 한 프레임 양보해 진행 라벨을 먼저 그린다(굽기는 메인스레드 동기 작업).
      requestAnimationFrame(() => {
        setTimeout(() => {
          const full = bakeToCanvas(bmp, w, h, state, OUTPUT_MAX);
          full.toBlob(
            (blob) => finish('apply', blob ?? null), // 인코딩 실패 → 원본 폴백
            'image/jpeg',
            0.92,
          );
        }, 0);
      });
    });

    // 재방문 복원: 상태에서 UI 반영(슬라이더·비율은 빌드 시 state를 읽어 이미 반영됨).
    zoom.value = String(state.zoom);
    setPresetActive(
      isNoAdjust(state) && state.vignette === 0 && state.sharpenAmt === 0 && state.grainAmt === 0
        ? '원본'
        : null,
    );
    updateCropBar();

    document.body.appendChild(overlay);
    repaint();
  });
}
