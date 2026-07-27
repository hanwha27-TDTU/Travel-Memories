// ui/audioNote.ts — **오디오 노트의 녹음 버튼과 인라인 재생 칩.**
//
// ── 왜 격자가 아니라 칩 줄인가 ────────────────────────────────────────
// 사진 격자(`photo-thumbs`)는 **훑는 곳**이다. 거기에 소리를 넣으면 훑기가 나빠진다
// (재생해야만 내용을 안다). 소리는 장소·비용과 같은 **한 줄 정보**라 칩 줄이 맞는 자리다.
// 같은 성격은 같은 자리에 — §7 「사용자 대면 대칭」.
//
// ── 규율 ──────────────────────────────────────────────────────────────
//  · **자동재생 없음.** 사용자가 누를 때만 소리가 난다.
//  · **동시 1개.** 다른 것을 누르면 먼저 것이 멈춘다 — 두 소리가 겹치면 둘 다 못 듣는다.
//  · **화면을 떠나면 멈춘다.** 「닫아도 소리가 남는」 결함을 만들지 않는다(정리 한 곳에서).
//  · **objectURL은 반드시 회수한다.** 안 하면 blob이 메모리에 붙잡힌다.

import { el } from './dom';
import { formatDuration, MAX_SECONDS, pickAudioType, recordingHint, acceptRecording } from '../domain/audio/note';
import type { LocalAudio } from '../offline/db';

/**
 * 지금 재생 중인 것 하나. **모듈 하나에 하나** — 동시 재생을 구조적으로 막는다
 * (각 칩이 자기 상태를 들고 있으면 "누가 재생 중인지"를 아무도 모른다).
 */
let playing: { audio: HTMLAudioElement; url: string; onStop: () => void } | null = null;

/** 재생 중인 것을 멈추고 자원을 회수한다. **정리는 이 한 곳에서만** 한다(§7 2층). */
export function stopAudioPlayback(): void {
  if (!playing) return;
  const p = playing;
  playing = null; // 먼저 비운다 — onStop이 다시 이 함수를 부를 수 있다
  p.audio.pause();
  p.audio.src = '';
  p.audio.load(); // 디코더가 붙잡은 버퍼를 놓게 한다
  URL.revokeObjectURL(p.url);
  p.onStop();
}

/**
 * 오디오 노트 하나를 나타내는 칩. 탭하면 재생/정지.
 * @param onDelete 있으면 ✕ 버튼을 붙인다(삭제는 tombstone — 되살릴 수 있다).
 */
export function audioChip(a: LocalAudio, onDelete?: () => void): HTMLElement {
  const chip = el('span', 'chip audio');
  const btn = el('button', 'chip-audio-play', `🔊 ${formatDuration(a.durationSec)}`) as HTMLButtonElement;
  btn.type = 'button';
  btn.setAttribute('aria-label', `녹음 ${formatDuration(a.durationSec)} 재생`);

  const setIdle = (): void => {
    btn.textContent = `🔊 ${formatDuration(a.durationSec)}`;
    btn.setAttribute('aria-pressed', 'false');
  };
  setIdle();

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const mine = playing?.audio.dataset['id'] === a.id;
    stopAudioPlayback(); // 무엇을 누르든 먼저 멈춘다 — 동시 재생 없음
    if (mine) return; // 같은 것을 다시 누른 것 = 정지

    const url = URL.createObjectURL(a.blob);
    const audio = new Audio(url);
    audio.dataset['id'] = a.id;
    playing = { audio, url, onStop: setIdle };
    btn.textContent = `⏸ ${formatDuration(a.durationSec)}`;
    btn.setAttribute('aria-pressed', 'true');
    audio.addEventListener('ended', () => stopAudioPlayback());
    // 재생 실패(코덱 미지원 등)를 **조용히 넘기지 않는다** — 안 나는 이유를 말한다.
    audio.addEventListener('error', () => {
      stopAudioPlayback();
      btn.textContent = '🔇 재생 불가';
    });
    void audio.play().catch(() => {
      stopAudioPlayback();
      btn.textContent = '🔇 재생 불가';
    });
  });

  chip.appendChild(btn);
  if (onDelete) {
    const del = el('button', 'chip-clear', '✕') as HTMLButtonElement;
    del.type = 'button';
    del.setAttribute('aria-label', '녹음 지우기');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      stopAudioPlayback();
      onDelete();
    });
    chip.appendChild(del);
  }
  return chip;
}

export interface RecordResult {
  blob: Blob;
  mime: string;
  seconds: number;
}

/**
 * 녹음 버튼. 누르면 시작, 다시 누르면 멈춘다. 상한(60초)에 닿으면 **스스로 멈춘다**.
 *
 * 실패는 전부 버튼 라벨로 말한다 — 마이크 권한 거부·미지원은 사용자가 알아야 고친다(§12).
 */
export function recordButton(onDone: (r: RecordResult) => void): HTMLButtonElement {
  const btn = el('button', 'btn-ghost audio-rec', '🎙 소리 남기기') as HTMLButtonElement;
  btn.type = 'button';
  let rec: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let timer: number | null = null;
  let startedAt = 0;

  /** 자원 회수 — 마이크를 놓지 않으면 기기에 녹음 표시가 계속 남는다. */
  const cleanup = (): void => {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
    for (const t of stream?.getTracks() ?? []) t.stop();
    stream = null;
    rec = null;
    btn.textContent = '🎙 소리 남기기';
    btn.classList.remove('is-recording');
  };

  btn.addEventListener('click', async () => {
    if (rec) {
      rec.stop(); // 정지 → onstop에서 마무리
      return;
    }
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      btn.textContent = '🎙 이 기기는 녹음을 지원하지 않아요';
      return;
    }
    const type = pickAudioType((m) => MediaRecorder.isTypeSupported(m));
    if (!type) {
      btn.textContent = '🎙 이 브라우저가 만들 수 있는 형식이 없어요';
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      btn.textContent = '🎙 마이크 권한이 필요해요';
      return;
    }
    stopAudioPlayback(); // 녹음 중에 다른 소리가 나면 그게 녹음된다

    const chunks: Blob[] = [];
    rec = new MediaRecorder(stream, { mimeType: type.mime });
    rec.addEventListener('dataavailable', (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    });
    rec.addEventListener('stop', () => {
      const seconds = (Date.now() - startedAt) / 1000;
      const blob = new Blob(chunks, { type: type.mime });
      cleanup();
      const v = acceptRecording(seconds, blob.size);
      if (!v.ok) {
        btn.textContent = `🎙 ${v.reason}`;
        return;
      }
      onDone({ blob, mime: type.mime, seconds });
    });

    startedAt = Date.now();
    rec.start();
    btn.classList.add('is-recording');
    btn.textContent = `⏹ ${recordingHint(0)}`;
    timer = window.setInterval(() => {
      const sec = (Date.now() - startedAt) / 1000;
      btn.textContent = `⏹ ${recordingHint(sec)}`;
      if (sec >= MAX_SECONDS) rec?.stop(); // 상한에서 **스스로** 멈춘다
    }, 250);
  });

  return btn;
}
