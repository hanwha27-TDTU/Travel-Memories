// domain/audio/note.ts — **오디오 노트의 순수 규칙.** DOM·Dexie 없음 → 유닛이 모든 갈래를 돈다.
//
// ── 왜 오디오 노트인가 (2026-07-27 결정) ──────────────────────────────
// `docs/PROJECT_SPEC.md:37`(S-01)이 **MVP 범위**로 이미 지정해 뒀는데 구현되지 않은 항목이다.
// 동영상 지원을 검토하다 드러났다: 영상이 사진 대비 추가로 회수하는 것은 **소리·움직임·말**
// 셋인데, 그중 **둘(소리·말)을 오디오가 두 자릿수 배 낮은 비용으로** 회수한다.
// 시장의 소음, 파도, 동행인의 웃음과 그때 한 말 — 사진에는 오디오 트랙이 없어 대체 불가다.
//
// ── 범위를 정한 두 문장 ───────────────────────────────────────────────
// **길이 상한이 이 기능의 정체성이다.** 긴 녹음은 "다시 찾아주는" 속도를 오히려 떨어뜨린다
// (회고 10분 목표 — 사진 200장은 3초에 훑지만 5분짜리 녹음은 훑을 수 없다).
// 그리고 **이 앱은 녹음기가 아니다** — 편집·자막·배경음은 범위 밖이다.

/** 녹음 길이 상한(초). 넘으면 자동으로 멈춘다 — 침묵 절삭이 아니라 **멈춤**이다. */
export const MAX_SECONDS = 60;

/** 이보다 짧으면 실수로 눌렀다고 본다(빈 항목이 쌓이지 않게). */
export const MIN_SECONDS = 1;

/**
 * 브라우저가 실제로 만들어 줄 수 있는 오디오 형식 중 **우리가 받는 것**.
 * 앞에서부터 지원되는 첫 형식을 쓴다 — Opus가 같은 품질에 가장 작다.
 * 확장자는 백업 ZIP 안 파일명과 재생 `type` 힌트에 쓰인다.
 */
export const AUDIO_TYPES: { mime: string; ext: string }[] = [
  { mime: 'audio/webm;codecs=opus', ext: 'webm' },
  { mime: 'audio/ogg;codecs=opus', ext: 'ogg' },
  { mime: 'audio/mp4', ext: 'm4a' }, // iOS Safari
  { mime: 'audio/webm', ext: 'webm' },
];

/**
 * 이 기기가 만들 수 있는 형식 하나를 고른다. 없으면 **null** — 「지원 안 함」을 정직하게 말한다.
 * @param supported `MediaRecorder.isTypeSupported` 같은 판정 함수(주입 — 유닛이 갈래를 돈다).
 */
export function pickAudioType(supported: (mime: string) => boolean): { mime: string; ext: string } | null {
  for (const t of AUDIO_TYPES) if (supported(t.mime)) return t;
  return null;
}

/** mime → 확장자. 모르는 형식은 `bin`이 아니라 **`webm`**으로 둔다(대부분이 그것이고, 재생이 된다). */
export function extForAudioMime(mime: string): string {
  const hit = AUDIO_TYPES.find((t) => mime.startsWith(t.mime.split(';')[0]!));
  return hit?.ext ?? 'webm';
}

/**
 * 초 → `M:SS`. 화면의 칩(`🔊 0:14`)과 녹음 중 표시가 **같은 함수**를 쓴다.
 * 음수·NaN은 `0:00` — 지어낸 값을 보여주지 않는다.
 */
export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 녹음을 저장할 수 있는가. 못 하면 **왜인지** 말한다(조용히 버리지 않는다). */
export function acceptRecording(seconds: number, bytes: number): { ok: boolean; reason: string } {
  if (!Number.isFinite(seconds) || seconds < MIN_SECONDS) {
    return { ok: false, reason: '너무 짧아요 — 1초 이상 녹음해 주세요.' };
  }
  if (bytes <= 0) {
    return { ok: false, reason: '소리가 녹음되지 않았어요. 마이크 권한을 확인해 주세요.' };
  }
  return { ok: true, reason: '' };
}

/**
 * 녹음 중 남은 시간 안내. **상한이 다가오는 것을 미리 말한다** — 갑자기 멈추면 사용자는
 * 고장이라고 생각한다(§12: 앱이 아는 것을 말하지 않으면 사람이 대신 알아내야 한다).
 */
export function recordingHint(elapsedSec: number): string {
  const left = Math.max(0, MAX_SECONDS - Math.floor(elapsedSec));
  if (left <= 10) return `${formatDuration(elapsedSec)} · ${left}초 뒤 자동으로 멈춥니다`;
  return formatDuration(elapsedSec);
}
