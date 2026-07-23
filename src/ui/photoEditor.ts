// ui/photoEditor.ts — 사진 편집 모달(비파괴). 원본은 읽기만, 결과는 새 Blob.
// 미리보기 = bakeToCanvas(소형) — 저장과 같은 코드 경로(WYSIWYG).

import { el } from './dom';
import {
  DEFAULT_EDIT,
  PRESETS,
  bakeToCanvas,
  isIdentity,
  type CropAspect,
  type EditState,
} from '../media/editor-core';

const PREVIEW_MAX = 560;
const OUTPUT_MAX = 2400; // 편집 결과 상한(이후 compress가 1600 표시본 생성)

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
];

async function decodeBitmap(file: Blob): Promise<{ bmp: ImageBitmap | HTMLImageElement; w: number; h: number }> {
  if (typeof createImageBitmap === 'function') {
    const bmp = await createImageBitmap(file);
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

/**
 * 편집 모달을 열고 사용자의 선택을 기다린다.
 * 반환: 편집된 Blob(적용) | null(원본 그대로 사용).
 */
export async function openPhotoEditor(file: Blob, fileLabel: string): Promise<Blob | null> {
  const { bmp, w, h } = await decodeBitmap(file);
  const state: EditState = { ...DEFAULT_EDIT };

  return new Promise<Blob | null>((resolve) => {
    const overlay = el('div', 'pe-overlay');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', '사진 편집');

    const sheet = el('div', 'pe-sheet');
    overlay.appendChild(sheet);

    // ── 헤더 ──
    const head = el('div', 'pe-head');
    head.appendChild(el('b', undefined, `✨ 사진 편집`));
    head.appendChild(el('span', 'pe-file muted small', fileLabel));
    sheet.appendChild(head);

    // ── 미리보기 캔버스 ──
    const stage = el('div', 'pe-stage');
    const preview = el('canvas', 'pe-canvas') as HTMLCanvasElement;
    stage.appendChild(preview);
    sheet.appendChild(stage);

    let raf = 0;
    function repaint(): void {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const baked = bakeToCanvas(bmp, w, h, state, PREVIEW_MAX);
        preview.width = baked.width;
        preview.height = baked.height;
        preview.getContext('2d')?.drawImage(baked, 0, 0);
      });
    }

    // 팬(드래그)·줌 제스처
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    preview.addEventListener('pointerdown', (e) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      preview.setPointerCapture(e.pointerId);
    });
    preview.addEventListener('pointermove', (e) => {
      if (!dragging || state.zoom <= 1) return;
      const rect = preview.getBoundingClientRect();
      state.panX = Math.max(-1, Math.min(1, state.panX - ((e.clientX - lastX) / rect.width) * 2));
      state.panY = Math.max(-1, Math.min(1, state.panY - ((e.clientY - lastY) / rect.height) * 2));
      lastX = e.clientX;
      lastY = e.clientY;
      repaint();
    });
    preview.addEventListener('pointerup', () => {
      dragging = false;
    });

    // ── 프리셋 ──
    const presetRow = el('div', 'pe-presets');
    for (const [name, patch] of Object.entries(PRESETS)) {
      const b = el('button', 'pe-chip', name) as HTMLButtonElement;
      b.type = 'button';
      b.addEventListener('click', () => {
        // 프리셋 = 색감 리셋 후 적용(기하 편집은 유지)
        Object.assign(state, {
          brightness: 0, contrast: 0, saturation: 0, warmth: 0, exposure: 0,
          vignette: 0, sharpenAmt: 0, grainAmt: 0,
        }, patch);
        syncSliders();
        repaint();
      });
      presetRow.appendChild(b);
    }
    sheet.appendChild(presetRow);

    // ── 기하 컨트롤(회전·반전·비율·줌) ──
    const geoRow = el('div', 'pe-geo');
    const rotBtn = el('button', 'pe-chip', '↻ 회전') as HTMLButtonElement;
    rotBtn.type = 'button';
    rotBtn.addEventListener('click', () => {
      state.rotate90 = ((state.rotate90 + 1) % 4) as EditState['rotate90'];
      repaint();
    });
    const flipBtn = el('button', 'pe-chip', '⇋ 반전') as HTMLButtonElement;
    flipBtn.type = 'button';
    flipBtn.addEventListener('click', () => {
      state.flipH = !state.flipH;
      repaint();
    });
    geoRow.append(rotBtn, flipBtn);
    for (const a of ASPECTS) {
      const b = el('button', 'pe-chip pe-aspect', a.label) as HTMLButtonElement;
      b.type = 'button';
      b.setAttribute('aria-pressed', String(a.key === state.aspect));
      b.addEventListener('click', () => {
        state.aspect = a.key;
        geoRow.querySelectorAll('.pe-aspect').forEach((x) =>
          x.setAttribute('aria-pressed', String((x as HTMLButtonElement).textContent === a.label)),
        );
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
      repaint();
    });
    const zoomWrap = el('label', 'pe-zoom-wrap');
    zoomWrap.append(el('span', 'pe-slider-label', '🔍'), zoom);
    geoRow.appendChild(zoomWrap);
    sheet.appendChild(geoRow);

    // ── 슬라이더들 ──
    const sliderInputs = new Map<keyof EditState, HTMLInputElement>();
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
      input.addEventListener('input', () => {
        (state[spec.key] as number) = Number(input.value);
        repaint();
      });
      sliderInputs.set(spec.key, input);
      row.append(el('span', 'pe-slider-label', spec.label), input);
      sliders.appendChild(row);
    }
    sheet.appendChild(sliders);

    function syncSliders(): void {
      for (const [key, input] of sliderInputs) input.value = String(state[key]);
    }

    // ── 액션 ──
    const actions = el('div', 'pe-actions');
    const resetBtn = el('button', 'btn-ghost', '초기화') as HTMLButtonElement;
    resetBtn.type = 'button';
    resetBtn.addEventListener('click', () => {
      Object.assign(state, DEFAULT_EDIT);
      zoom.value = '1';
      syncSliders();
      geoRow.querySelectorAll('.pe-aspect').forEach((x) =>
        x.setAttribute('aria-pressed', String((x as HTMLButtonElement).textContent === '원본')),
      );
      repaint();
    });
    const skipBtn = el('button', 'btn-ghost', '원본 사용') as HTMLButtonElement;
    skipBtn.type = 'button';
    const applyBtn = el('button', 'btn-primary', '적용') as HTMLButtonElement;
    applyBtn.type = 'button';
    actions.append(resetBtn, skipBtn, applyBtn);
    sheet.appendChild(actions);

    function close(result: Blob | null): void {
      if ('close' in bmp && typeof (bmp as ImageBitmap).close === 'function') (bmp as ImageBitmap).close();
      overlay.remove();
      resolve(result);
    }

    skipBtn.addEventListener('click', () => close(null));
    applyBtn.addEventListener('click', () => {
      applyBtn.disabled = true;
      // 편집이 전혀 없으면 원본 사용과 동일(재인코딩 손실 방지)
      if (isIdentity(state)) {
        close(null);
        return;
      }
      const full = bakeToCanvas(bmp, w, h, state, OUTPUT_MAX);
      full.toBlob(
        (blob) => {
          if (blob) close(blob);
          else close(null); // 인코딩 실패 → 원본 사용(안전 폴백)
        },
        'image/jpeg',
        0.92,
      );
    });

    document.body.appendChild(overlay);
    repaint();
  });
}
