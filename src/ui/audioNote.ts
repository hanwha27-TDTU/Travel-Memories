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
let playing: {
  audio: HTMLAudioElement;
  url: string;
  onStop: () => void;
  /** 이 재생에 붙인 이벤트 전부를 떼는 손잡이. **정리보다 먼저** 불러야 한다(아래 참조). */
  detach: () => void;
} | null = null;

/**
 * 재생 중인 것을 멈추고 자원을 회수한다. **정리는 이 한 곳에서만** 한다(§7 2층).
 *
 * ⚠️ 결함 이력(2026-07-28 사용자 실기기): *"재생불가가 아닌데 재생불가라고 안내하네요."*
 * 정리 과정 자체가 **`error` 이벤트를 발화시킨다** — 미디어 요소의 `src`를 비우고 `load()`를
 * 부르면 브라우저는 "실을 것이 없다"를 오류로 알린다. 그래서 순서가 이렇게 됐다:
 *
 *   ①재생 끝(`ended`) → ②정리(`src=''`+`load()`) → ③`setIdle()`로 라벨 정상 복귀
 *   → ④**뒤늦게 `error` 발화** → ⑤라벨을 「🔇 재생 불가」로 덮어씀
 *
 * 즉 **정상 재생을 마친 직후에만** 나타나는 거짓말이었다. 재생은 멀쩡히 됐는데 앱이
 * 안 됐다고 말한 것이라, 사용자는 자기 녹음이 깨진 줄 안다(§8 — 모르는 것도 아니고
 * **아는 것을 틀리게** 말한 경우다).
 *
 * 그래서 **떼는 것이 먼저다**: 정리로 인한 이벤트는 이미 이 재생의 것이 아니다.
 * 근본형: *"뒷정리가 만드는 신호를 실패 신호로 읽지 마라."*
 */
export function stopAudioPlayback(): void {
  if (!playing) return;
  const p = playing;
  playing = null; // 먼저 비운다 — onStop이 다시 이 함수를 부를 수 있다
  p.detach(); // 🔴 정리보다 먼저 — 아래 두 줄이 error를 발화시킨다
  p.audio.pause();
  p.audio.removeAttribute('src'); // `src=''`는 문서 URL을 미디어로 실으려 든다(또 다른 오류원)
  p.audio.load(); // 디코더가 붙잡은 버퍼를 놓게 한다
  URL.revokeObjectURL(p.url);
  p.onStop();
}

/**
 * 오디오 노트 하나를 나타내는 칩. 탭하면 재생/정지.
 * @param onDelete 있으면 ✕ 버튼을 붙인다(삭제는 tombstone — 되살릴 수 있다).
 */
/** 재생 중 이퀄라이저 세 칸. 멈추면 통째로 사라진다 — 장식이 아니라 **상태**다. */
function equalizer(): HTMLElement {
  const eq = el('span', 'eq');
  eq.setAttribute('aria-hidden', 'true'); // 뜻은 aria-pressed가 전한다(중복해 읽히지 않게)
  for (let i = 0; i < 3; i++) eq.appendChild(el('i'));
  return eq;
}

export function audioChip(a: LocalAudio, onDelete?: () => void): HTMLElement {
  const chip = el('span', 'chip audio');
  const label = formatDuration(a.durationSec);
  const btn = el('button', 'chip-audio-play') as HTMLButtonElement;
  btn.type = 'button';
  btn.setAttribute('aria-label', `녹음 ${label} 재생`);

  /** 글리프 자리 — 멈춤(🔊)과 재생 중(이퀄라이저)이 **같은 자리**에서 바뀐다(칩 폭이 안 흔들린다). */
  const icon = el('span', 'chip-audio-ic', '🔊');
  const time = el('span', 'chip-audio-time', label);
  btn.append(icon, time);

  const setIdle = (): void => {
    icon.replaceChildren('🔊');
    time.textContent = label;
    btn.setAttribute('aria-pressed', 'false');
    chip.style.setProperty('--p', '0'); // 진행 채움을 되돌린다
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
    // 이 재생에 붙는 이벤트를 한 손잡이로 묶는다 — 정리할 때 **통째로** 뗀다.
    const ac = new AbortController();
    const on = <K extends keyof HTMLMediaElementEventMap>(
      type: K,
      fn: (e: HTMLMediaElementEventMap[K]) => void,
    ): void => audio.addEventListener(type, fn, { signal: ac.signal });

    playing = { audio, url, onStop: setIdle, detach: () => ac.abort() };
    icon.replaceChildren(equalizer());
    btn.setAttribute('aria-pressed', 'true');

    // 남은 시간을 **세어 내려간다**: 소리는 눈에 안 보이므로, 얼마나 남았는지가 유일한 단서다.
    on('timeupdate', () => {
      const total = audio.duration || a.durationSec || 0;
      if (total > 0) chip.style.setProperty('--p', String(Math.min(1, audio.currentTime / total)));
      time.textContent = formatDuration(Math.max(0, Math.ceil(total - audio.currentTime)));
    });
    on('ended', () => stopAudioPlayback());
    // 재생 실패(코덱 미지원 등)를 **조용히 넘기지 않는다** — 안 나는 이유를 말한다.
    // 단, **이 재생이 아직 살아 있을 때만**이다. 정리 뒤에 오는 오류는 뒷정리가 만든 것이지
    // 재생이 실패한 것이 아니다(위 stopAudioPlayback 머리주석).
    const failed = (): void => {
      if (playing?.audio !== audio) return; // 이미 정리됐다 — 그 오류는 우리 것이 아니다
      stopAudioPlayback();
      icon.replaceChildren('🔇');
      time.textContent = '재생 불가';
    };
    on('error', failed);
    void audio.play().catch(failed);
  });

  chip.appendChild(btn);
  if (onDelete) {
    // `.chip-clear`(장소 해제)는 줄 안에 서는 24px 원형이라 작은 알약 안에서는 무겁다.
    // 보이는 크기는 줄이되 **누를 수 있는 크기는 CSS로 40px까지 넓힌다**(::after).
    const del = el('button', 'chip-x', '✕') as HTMLButtonElement;
    del.type = 'button';
    del.setAttribute('aria-label', `녹음 ${label} 지우기`);
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
