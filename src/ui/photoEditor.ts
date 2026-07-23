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
  resolveWindow,
  rotatedDims,
  rotateHeals90,
  flipHealsH,
  rotateFreeCrop90,
  flipFreeCropH,
  resizeFreeCrop,
  DEFAULT_EDIT,
  type CropAspect,
  type EditState,
  type FreeCropDragMode,
} from '../media/editor-core';
import { isNoAdjust } from '../media/pixelops';

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
  { key: 'angle', label: '수평', min: -10, max: 10, step: 0.5 },
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
  /** apply=편집 적용, skip=원본 사용/닫기, back=이전 사진으로, skipAll=이 사진 포함 나머지 모두 원본. */
  action: 'apply' | 'skip' | 'back' | 'skipAll';
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
  };
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
    const overlay = el('div', 'pe-overlay');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', '사진 편집');

    const sheet = el('div', 'pe-sheet');
    overlay.appendChild(sheet);

    // ── 헤더 ──
    const head = el('div', 'pe-head');
    head.appendChild(el('b', undefined, '✨ 사진 편집'));
    head.appendChild(el('span', 'pe-file muted small', fileLabel));
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

    const isCropMode = (): boolean => state.aspect === 'free';

    function ensureFreeCrop(): void {
      if (!state.freeCrop) state.freeCrop = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
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
        const showOverlay = isCropMode() && !cropApplied;
        const s = showOverlay
          ? { ...state, aspect: 'orig' as CropAspect, zoom: 1, panX: 0, panY: 0, freeCrop: null }
          : state;
        drawState(s, quality);
        syncCropBox(showOverlay);
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
      if (healMode) {
        // 탭 위치 → 기하 정규화 좌표(현재 크롭 창 기준 역투영)
        const rect = preview.getBoundingClientRect();
        const u = (e.clientX - rect.left) / rect.width;
        const v = (e.clientY - rect.top) / rect.height;
        const rd = rotatedDims(w, h, state.rotate90);
        const win = resolveWindow(rd.w, rd.h, state);
        state.heals.push({
          x: (win.x + u * win.w) / rd.w,
          y: (win.y + v * win.h) / rd.h,
          r: ((brushPct / 100) * win.w) / rd.w, // 화면 체감 크기 유지
        });
        undoBtn.disabled = false;
        repaint();
        return;
      }
      activePts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      preview.setPointerCapture(e.pointerId);
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
      if (dragging && activePts.size === 0) {
        dragging = false;
        repaint();
      }
    }
    preview.addEventListener('pointerup', endPointer);
    preview.addEventListener('pointercancel', endPointer);

    // ── 크롭 오버레이 드래그(이동/모서리 리사이즈) ──
    let cropDrag: { mode: FreeCropDragMode; sx: number; sy: number; fc: { x: number; y: number; w: number; h: number } } | null = null;
    cropBox.addEventListener('pointerdown', (e) => {
      ensureFreeCrop();
      const corner = (e.target as HTMLElement).dataset['corner'] as 'nw' | 'ne' | 'sw' | 'se' | undefined;
      cropDrag = { mode: corner ?? 'move', sx: e.clientX, sy: e.clientY, fc: { ...state.freeCrop! } };
      cropBox.setPointerCapture(e.pointerId);
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
      state.rotate90 = ((state.rotate90 + 1) % 4) as EditState['rotate90'];
      state.heals = rotateHeals90(state.heals); // 기존 잡티 좌표 보존
      if (state.freeCrop) state.freeCrop = rotateFreeCrop90(state.freeCrop);
      repaint();
    });
    const flipBtn = el('button', 'pe-chip', '⇋ 반전') as HTMLButtonElement;
    flipBtn.type = 'button';
    flipBtn.addEventListener('click', () => {
      state.flipH = !state.flipH;
      state.heals = flipHealsH(state.heals);
      if (state.freeCrop) state.freeCrop = flipFreeCropH(state.freeCrop);
      repaint();
    });
    // 표시 방식 토글: 폭 100%(세로 스크롤) ↔ 높이 맞춤(여백 최소). 세로로 긴 사진용.
    const fitBtn = el('button', 'pe-chip pe-fit', '↕ 폭 채우기') as HTMLButtonElement;
    fitBtn.type = 'button';
    fitBtn.setAttribute('aria-pressed', 'false');
    fitBtn.title = '세로로 긴 사진을 폭에 꽉 채워 크게 보기(세로 스크롤)';
    fitBtn.addEventListener('click', () => {
      fitMode = fitMode === 'width' ? 'contain' : 'width';
      const on = fitMode === 'width';
      fitBtn.textContent = on ? '🔳 높이 맞춤' : '↕ 폭 채우기';
      fitBtn.setAttribute('aria-pressed', String(on));
      stage.classList.toggle('is-fill', on);
      canvasWrap.classList.toggle('is-fill', on);
      repaint();
    });
    geoRow.append(rotBtn, flipBtn, fitBtn);
    for (const a of ASPECTS) {
      const b = el('button', 'pe-chip pe-aspect', a.label) as HTMLButtonElement;
      b.type = 'button';
      b.setAttribute('aria-pressed', String(a.key === state.aspect));
      b.addEventListener('click', () => {
        state.aspect = a.key;
        cropApplied = false; // 비율을 바꾸면 크롭 확정 해제(다시 지정 흐름)
        if (a.key === 'free') {
          ensureFreeCrop();
          setHealMode(false); // 크롭 중엔 잡티 오프
        }
        geoRow.querySelectorAll('.pe-aspect').forEach((x) =>
          x.setAttribute('aria-pressed', String((x as HTMLButtonElement).textContent === a.label)),
        );
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
      state.zoom = Number(zoom.value);
      if (state.zoom === 1) {
        state.panX = 0;
        state.panY = 0;
      }
      repaint(true);
    });
    zoom.addEventListener('change', () => repaint());
    const zoomWrap = el('label', 'pe-zoom-wrap');
    zoomWrap.append(el('span', 'pe-slider-label', '🔍'), zoom);
    geoRow.appendChild(zoomWrap);
    sheet.appendChild(geoRow);

    // ── 잡티 제거 도구줄 ──
    const healRow = el('div', 'pe-geo pe-heal-row');
    const healBtn = el('button', 'pe-chip', '🩹 잡티 제거') as HTMLButtonElement;
    healBtn.type = 'button';
    healBtn.setAttribute('aria-pressed', 'false');
    const brush = el('input') as HTMLInputElement;
    brush.type = 'range';
    brush.min = '1';
    brush.max = '8';
    brush.step = '0.5';
    brush.value = String(brushPct);
    brush.setAttribute('aria-label', '브러시 크기');
    brush.addEventListener('input', () => {
      brushPct = Number(brush.value);
    });
    const brushWrap = el('label', 'pe-zoom-wrap');
    brushWrap.append(el('span', 'pe-slider-label', '크기'), brush);
    brushWrap.hidden = true;
    const undoBtn = el('button', 'pe-chip', '↺ 되돌리기') as HTMLButtonElement;
    undoBtn.type = 'button';
    undoBtn.disabled = true;
    undoBtn.hidden = true;
    undoBtn.addEventListener('click', () => {
      state.heals.pop();
      undoBtn.disabled = state.heals.length === 0;
      repaint();
    });
    const healHint = el('span', 'pe-hint muted small', '지우고 싶은 점을 사진에서 톡 누르세요');
    healHint.hidden = true;
    function setHealMode(on: boolean): void {
      healMode = on;
      healBtn.setAttribute('aria-pressed', String(on));
      brushWrap.hidden = !on;
      undoBtn.hidden = !on;
      healHint.hidden = !on;
      preview.classList.toggle('pe-heal-cursor', on);
    }
    healBtn.addEventListener('click', () => {
      if (isCropMode()) {
        // 크롭 모드 종료 후 잡티 모드로
        state.aspect = 'orig';
        cropApplied = false;
        geoRow.querySelectorAll('.pe-aspect').forEach((x) =>
          x.setAttribute('aria-pressed', String((x as HTMLButtonElement).textContent === '원본')),
        );
        updateCropBar();
        repaint();
      }
      setHealMode(!healMode);
    });
    healRow.append(healBtn, brushWrap, undoBtn, healHint);
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
        (state[spec.key] as number) = DEFAULT_EDIT[spec.key] as number;
        input.value = String(state[spec.key]);
        val.textContent = fmtSliderVal(spec, state[spec.key] as number);
        if (spec.key !== 'angle') setPresetActive(null);
        repaint();
      });
      input.addEventListener('input', () => {
        (state[spec.key] as number) = Number(input.value);
        val.textContent = fmtSliderVal(spec, Number(input.value));
        if (spec.key !== 'angle') setPresetActive(null); // 수동 조정 → 프리셋 해제 표시
        repaint(true);
      });
      input.addEventListener('change', () => repaint()); // 손 떼면 고해상 재굽기
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
    resetBtn.addEventListener('click', () => {
      Object.assign(state, DEFAULT_EDIT, { heals: [], freeCrop: null });
      zoom.value = '1';
      cropApplied = false;
      setHealMode(false);
      undoBtn.disabled = true;
      setPresetActive('원본');
      syncSliders();
      geoRow.querySelectorAll('.pe-aspect').forEach((x) =>
        x.setAttribute('aria-pressed', String((x as HTMLButtonElement).textContent === '원본')),
      );
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
    undoBtn.disabled = state.heals.length === 0;
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
