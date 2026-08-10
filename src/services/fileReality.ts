// services/fileReality.ts — 「🖼️ 파일 실물」의 실측: 바이트를 세고, **실제로 열어 본다**.
//
// 판정과 문장은 `domain/fileRealityVerdict.ts`(순수)에 있다. 여기는 **Dexie 읽기와 디코드**만 한다.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 안전 경계 (§0 — 원본 자료를 임의로 삭제/덮어쓰지 않는다)
// ─────────────────────────────────────────────────────────────────────────────
// ① **읽기 전용이다.** 이 파일은 Dexie에 쓰지 않는다. 스윕 결과만 `localStorage`에 남긴다.
// ② **바이트를 밖으로 내보내지 않는다.** 디코드는 전부 이 기기 안에서 일어난다(네트워크 0).
// ③ **id는 앞 8자만** 기억한다(진단 개인정보 규율 §6 — 제목·메모·바이트는 담지 않는다).
// ④ **서버 바이트는 안 받는다.** 사진 앱에서 egress는 실제 제약이고, 서버와의 개수 대조는
//    ☁️ 「저장 상태」가 이미 한다 — 같은 사실을 두 도구가 세지 않는다(§7).

import { db } from '../offline/db';
import type { OpenSweep, KindTally } from '../domain/fileRealityVerdict';

/** 스윕 결과를 기억하는 자리. 비싼 관측을 계기가 있을 때만 재는 규율은 `syncParity`와 같다(§7). */
const SWEEP_KEY = 'journey.fileReality.sweep';

/**
 * 이 기기의 사진·소리·영상 바이트를 **센다**(디코드 없음 — 허브가 열릴 때마다 도는 층이라 싸야 한다).
 *
 * 🔴 **휴지통도 센다.** 되살릴 수 있어야 하므로 휴지통 항목의 바이트도 성해야 한다 —
 * 「지운 것이니 깨져도 된다」는 순간, 복원은 빈 껍데기를 되살린다.
 */
export async function tallyLocalFiles(): Promise<{ photo: KindTally; audio: KindTally; video: KindTally }> {
  const [media, audio, video] = await Promise.all([
    db().localMedia.toArray(),
    db().localAudio.toArray(),
    db().localVideos.toArray(),
  ]);
  return {
    photo: {
      rows: media.length,
      // 표시본이 곧 사용자가 보는 것이다. 없거나 0바이트면 그 기록은 빈 껍데기다.
      empty: media.filter((m) => !m.displayBlob || m.displayBlob.size === 0).length,
      serverMissing: media.filter((m) => m.bytesMissing === true).length,
    },
    audio: {
      rows: audio.length,
      empty: audio.filter((a) => !a.blob || a.blob.size === 0).length,
      serverMissing: audio.filter((a) => a.bytesMissing === true).length,
    },
    video: {
      rows: video.length,
      empty: video.filter((v) => !v.blob || v.blob.size === 0).length,
      serverMissing: video.filter((v) => v.bytesMissing === true).length,
    },
  };
}

/**
 * 사진 한 장이 **실제로 열리는가.**
 *
 * `createImageBitmap`을 쓰는 이유: 진짜 디코더를 통과시킨다. `new Image()` + `src`는 브라우저마다
 * 게으르게 동작할 수 있고, 크기만 읽고 넘어가면 **깨진 바이트를 통과시킨다**(그러면 이 검사가
 * 공허해진다 · §4). 디코드에 실패하면 예외가 난다 — 그게 우리가 찾는 신호다.
 */
async function opensAsImage(blob: Blob): Promise<boolean> {
  if (!blob || blob.size === 0) return false;
  try {
    const bmp = await createImageBitmap(blob);
    const ok = bmp.width > 0 && bmp.height > 0;
    bmp.close(); // 메모리를 붙잡지 않는다 — 수백 장을 도는 순회다
    return ok;
  } catch {
    return false;
  }
}

/**
 * 소리 하나가 **실제로 열리는가.**
 *
 * `decodeAudioData`를 쓰지 않는 이유: 그건 **전체를 PCM으로 펼친다** — 20초 녹음 수십 개면
 * 메모리가 크게 튄다. 여기서 묻는 것은 *"재생 가능한 형식인가"*이므로 `HTMLAudioElement`가
 * 메타데이터를 읽어 **길이를 알아내는지**까지만 본다. 못 읽으면 `error` 이벤트가 온다.
 */
async function opensAsAudio(blob: Blob, mime: string): Promise<boolean> {
  if (!blob || blob.size === 0) return false;
  const url = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: mime }));
  try {
    return await new Promise<boolean>((resolve) => {
      const el = new Audio();
      const done = (v: boolean): void => {
        el.removeAttribute('src');
        resolve(v);
      };
      el.preload = 'metadata';
      el.onloadedmetadata = () => done(Number.isFinite(el.duration) || el.duration === Infinity);
      el.onerror = () => done(false);
      // 브라우저가 조용히 멈추는 경우가 있다 — 영원히 기다리지 않는다(진단이 멈추면 도구가 아니다).
      setTimeout(() => done(false), 5000);
      el.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 영상은 전체 프레임을 펼치지 않고 재생기가 메타데이터를 읽는지 확인한다. */
async function opensAsVideo(blob: Blob, mime: string): Promise<boolean> {
  if (!blob || blob.size === 0) return false;
  const url = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: mime }));
  try {
    return await new Promise<boolean>((resolve) => {
      const el = document.createElement('video');
      let settled = false;
      const done = (v: boolean): void => {
        if (settled) return;
        settled = true;
        el.removeAttribute('src');
        el.load();
        resolve(v);
      };
      el.preload = 'metadata';
      el.onloadedmetadata = () =>
        done(Number.isFinite(el.duration) && el.duration > 0 && el.videoWidth > 0 && el.videoHeight > 0);
      el.onerror = () => done(false);
      setTimeout(() => done(false), 5000);
      el.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 진단이 기억하는 id 길이 — 앞 8자(§6 개인정보 규율). */
const shortId = (id: string): string => id.slice(0, 8);

/**
 * 🔴 **전수로 열어 본다.** 사용자가 [열어 보기]를 눌렀을 때만 돈다.
 *
 * 순차로 도는 이유: 수백 장을 한꺼번에 디코드하면 **저사양 기기에서 메모리가 터진다**
 * (이 저장소는 저메모리 검토를 사진 변경의 필수 조건으로 둔다). 느린 대신 안전하다 —
 * 그리고 이건 사용자가 명시적으로 누른 관측이라 몇 초는 받아들일 수 있다.
 */
export async function sweepOpenFiles(now = new Date().toISOString()): Promise<OpenSweep> {
  const [media, audio, video] = await Promise.all([
    db().localMedia.toArray(),
    db().localAudio.toArray(),
    db().localVideos.toArray(),
  ]);
  const failed: string[] = [];
  let checked = 0;

  for (const m of media) {
    checked += 1;
    if (!(await opensAsImage(m.displayBlob))) failed.push(shortId(m.id));
  }
  for (const a of audio) {
    checked += 1;
    if (!(await opensAsAudio(a.blob, a.mime))) failed.push(shortId(a.id));
  }
  for (const v of video) {
    checked += 1;
    if (!(await opensAsVideo(v.blob, v.mime))) failed.push(shortId(v.id));
  }

  const sweep: OpenSweep = { at: now, checked, failed, totalAtRun: media.length + audio.length + video.length };
  rememberSweep(sweep);
  return sweep;
}

/** 마지막 스윕 — 없거나 형식이 깨졌으면 `null`(모른다). */
export function lastSweep(): OpenSweep | null {
  try {
    const raw = localStorage.getItem(SWEEP_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<OpenSweep>;
    // 🔴 모양이 안 맞으면 **「정상」이 아니라 「모른다」**로 떨어뜨린다 — 깨진 캐시를 초록으로
    //    읽으면 그게 곧 거짓 초록이다(§8).
    if (typeof v.at !== 'string' || !Array.isArray(v.failed) || typeof v.checked !== 'number') return null;
    return { at: v.at, checked: v.checked, failed: v.failed, totalAtRun: v.totalAtRun ?? v.checked };
  } catch {
    return null;
  }
}

function rememberSweep(s: OpenSweep): void {
  try {
    localStorage.setItem(SWEEP_KEY, JSON.stringify(s));
  } catch {
    // 저장에 실패해도 판정은 이미 났다 — 다음에 다시 누르면 된다(편의가 관측을 막지 않는다).
  }
}

/** 테스트용 초기화(모듈 밖 상태를 갖는 모듈의 의무). */
export function __resetFileRealityForTests(): void {
  try {
    localStorage.removeItem(SWEEP_KEY);
  } catch {
    /* 접근 불가 환경은 그냥 지나간다 */
  }
}
