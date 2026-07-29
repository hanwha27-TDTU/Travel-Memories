// tests/unit/audioNote.test.ts — **오디오 노트의 규칙과 백업 왕복.**
//
// 왜 이 기능인가: `PROJECT_SPEC.md:37`(S-01)이 MVP로 지정했는데 미구현이었다. 동영상을 검토하다
// 드러났다 — 영상이 사진 대비 추가로 회수하는 셋(소리·움직임·말) 중 **둘을 오디오가 두 자릿수
// 배 낮은 비용으로** 회수한다.
//
// 🔴 이 파일의 가장 중요한 검사는 **백업 왕복**이다. 오디오는 서버로 가지 않으므로
// **백업이 두 번째 계층**이고, 거기서 빠지면 계층이 ①밖에 안 남는다 — `DISASTER_RECOVERY.md:13`이
// "축출·사이트데이터 삭제·기기 분실로 죽는다"고 명시한 그 계층이다. 비타협 원칙 #1 위반이 된다.

import { describe, it, expect } from 'vitest';
import {
  MAX_SECONDS,
  MIN_SECONDS,
  pickAudioType,
  extForAudioMime,
  formatDuration,
  acceptRecording,
  recordingHint,
} from '../../src/domain/audio/note';
import { serializeJson, deserializeJson, serializeZip, deserializeZip } from '../../src/services/backup';
import { audioFileBase, photoFileBase } from '../../src/domain/media/naming';
import { unzip } from '../../src/services/zip';

/** ZIP 안 실제 파일 이름 목록 — 이름을 재려면 되읽기가 아니라 **엔트리**를 봐야 한다. */
const deserializeZipNames = (buf: ArrayBuffer): string[] => unzip(buf).map((e) => e.name);
import type { CollectedRows } from '../../src/services/backup';
import type { LocalAudio, LocalTrip } from '../../src/offline/db';

const U = (n: number): string => `0000000${n}-0000-4000-8000-000000000000`.slice(-36);
const ISO = '2026-07-27T05:36:00.000Z';

const audio = (id: number, bytes: number[]): LocalAudio => ({
  id: U(id),
  momentId: U(2),
  tripId: U(1),
  blob: new Blob([new Uint8Array(bytes)], { type: 'audio/webm;codecs=opus' }),
  mime: 'audio/webm;codecs=opus',
  durationSec: 14,
  recordedAt: ISO,
  version: 1,
  createdAt: ISO,
  updatedAt: ISO,
  deletedAt: null,
});

const trip = (): LocalTrip => ({
  id: U(1), title: '제주', startDate: '2026-07-16', endDate: '2026-07-19', status: 'completed',
  version: 1, createdAt: ISO, updatedAt: ISO, deletedAt: null,
});

describe('① 형식 고르기 — 만들 수 있는 것만 쓰고, 없으면 없다고 말한다', () => {
  it('지원되는 첫 형식을 고른다(Opus가 같은 품질에 가장 작다)', () => {
    const t = pickAudioType(() => true);
    expect(t?.mime).toContain('opus');
  });

  it('iOS처럼 webm이 안 되면 mp4로 내려간다', () => {
    const t = pickAudioType((m) => m === 'audio/mp4');
    expect(t).toEqual({ mime: 'audio/mp4', ext: 'm4a' });
  });

  it('🔴 아무것도 안 되면 **null** — 「지원 안 함」을 정직하게 말한다', () => {
    expect(pickAudioType(() => false)).toBeNull();
  });

  it('확장자는 mime에서 파생한다(백업 ZIP 안 파일명이 이걸 쓴다)', () => {
    expect(extForAudioMime('audio/webm;codecs=opus')).toBe('webm');
    expect(extForAudioMime('audio/mp4')).toBe('m4a');
    expect(extForAudioMime('audio/과연무엇')).toBe('webm'); // 모르면 대부분인 쪽으로(재생은 된다)
  });
});

describe('② 길이 상한이 이 기능의 정체성이다', () => {
  it('상한은 60초(긴 녹음은 회고를 느리게 한다)', () => {
    expect(MAX_SECONDS).toBe(60);
  });

  it('너무 짧으면 저장하지 않고 **이유를 말한다**', () => {
    const v = acceptRecording(0.3, 1000);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('짧아요');
  });

  it('소리가 안 담겼으면 마이크 권한을 짚어 준다(원인을 추측하게 두지 않는다)', () => {
    const v = acceptRecording(5, 0);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('마이크');
  });

  it('최소 길이를 넘고 바이트가 있으면 받는다', () => {
    expect(acceptRecording(MIN_SECONDS, 1).ok).toBe(true);
  });

  it('상한이 다가오면 **미리** 말한다 — 갑자기 멈추면 고장으로 보인다(§12)', () => {
    expect(recordingHint(5)).toBe('0:05');
    expect(recordingHint(55)).toContain('5초 뒤 자동으로 멈춥니다');
  });

  it('길이 표기는 화면 칩과 녹음 중이 **같은 함수**를 쓴다', () => {
    expect(formatDuration(14)).toBe('0:14');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(-1)).toBe('0:00'); // 지어낸 값을 보여주지 않는다
    expect(formatDuration(NaN)).toBe('0:00');
  });
});

describe('🔴 ③ 백업 왕복 — 오디오는 서버에 안 가므로 **백업이 두 번째 계층**이다', () => {
  const rows = (): CollectedRows => ({
    trips: [trip()],
    moments: [],
    media: [],
    expenses: [],
    audio: [audio(3, [1, 2, 3, 4, 5]), audio(4, [9, 8, 7])],
    places: [],
  });

  it('JSON: 넣은 만큼 그대로 돌아온다', async () => {
    const back = deserializeJson(await serializeJson(rows()));
    expect(back.audio).toHaveLength(2);
    expect(back.audio.map((a) => a.id).sort()).toEqual([U(3), U(4)].sort());
  });

  it('JSON: 바이트가 살아 있다(메타만 돌아오면 소리가 없는 것이다)', async () => {
    const back = deserializeJson(await serializeJson(rows()));
    const a = back.audio.find((x) => x.id === U(3))!;
    expect(a.blob.size).toBe(5);
    expect(new Uint8Array(await a.blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it('JSON: 길이·형식·녹음시각도 함께 돌아온다', async () => {
    const back = deserializeJson(await serializeJson(rows()));
    const a = back.audio[0]!;
    expect(a.durationSec).toBe(14);
    expect(a.mime).toContain('opus');
    expect(a.recordedAt).toBe(ISO);
  });

  it('ZIP: 넣은 만큼 그대로 돌아온다(바이트 포함)', async () => {
    const blob = await serializeZip(rows());
    const back = deserializeZip(await blob.arrayBuffer());
    expect(back.audio).toHaveLength(2);
    const a = back.audio.find((x) => x.id === U(3))!;
    expect(new Uint8Array(await a.blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it('**옛 백업 파일에는 audio가 없다** — 없으면 빈 배열(하위호환)', () => {
    const old = JSON.stringify({ app: 'bugeon-journey', backupVersion: 1, trips: [trip()], moments: [], media: [], expenses: [] });
    expect(deserializeJson(old).audio).toEqual([]);
  });

  it('오디오가 없어도 백업은 정상이다(빈 배열이 형식을 깨지 않는다)', async () => {
    const back = deserializeJson(await serializeJson({ ...rows(), audio: [], places: [] }));
    expect(back.audio).toEqual([]);
    expect(back.trips).toHaveLength(1);
  });
});

// ⚠️ 아래 무리가 이 파일에서 **가장 늦게 생긴 이유**를 적어 둔다(사용자 지적 2026-07-27).
// 처음엔 왕복(넣고 꺼내기)만 쟀다. 그런데 이름을 손으로 조립해 실제로는
// `audio/[object Object]_a1b2c3d4.webm`이 만들어지고 있었는데 — **같은 키로 넣고 꺼내니
// 왕복은 통과했다.** 이름이 사용자에게 보이는 산출물이면 **이름 자체를 재야 한다.**
describe('🔴 ④ ZIP 안 파일명 — 사진과 **같은 규칙**이어야 한다 (§7 사용자 대면 대칭)', () => {
  it('사진과 같은 모양: 날짜_시간_제목__id8', () => {
    expect(audioFileBase(ISO, '제주여행', U(3))).toMatch(/^\d{8}_\d{4}_제주여행__[0-9a-f]{8}$/);
  });

  it('사진 규칙과 **자릿수·구분자가 같다**(나란히 놓으면 같은 형태로 보인다)', () => {
    const a = audioFileBase(ISO, '제주여행', U(3));
    const p = photoFileBase(ISO, '제주여행', U(3));
    expect(a.replace(/__[0-9a-f]{8}$/, '')).toBe(p.replace(/__[0-9a-f]{8}$/, ''));
  });

  it('🔴 `[object Object]`가 들어가지 않는다 — 실제로 그랬다', () => {
    expect(audioFileBase(ISO, '제주여행', U(3))).not.toContain('[object');
  });

  it('제목이 없으면 「소리」로(사진은 「사진」 — 같은 자리에 같은 어휘)', () => {
    expect(audioFileBase(ISO, '', U(3))).toContain('_소리__');
  });

  it('시각을 못 읽으면 사진과 같은 폴백(`00000000_0000`)', () => {
    expect(audioFileBase('nope', '제주', U(3))).toMatch(/^00000000_0000_/);
  });

  it('ZIP 안 실제 경로가 그 규칙을 따른다(조립하는 쪽까지 확인)', async () => {
    const blob = await serializeZip({ trips: [trip()], moments: [], media: [], expenses: [], audio: [audio(3, [1, 2])], places: [] });
    const names = deserializeZipNames(await blob.arrayBuffer());
    const hit = names.find((n) => n.includes('/audio/'));
    expect(hit).toBeDefined();
    expect(hit).toMatch(/\/audio\/\d{8}_\d{4}_[^/]*__[0-9a-f]{8}\.webm$/);
  });
});
