// tests/unit/audioRowmap.test.ts — **소리의 서버 경계**(rowmap·객체 키·확장자 계약).
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 이 파일이 필요한가 (2026-07-27)
// ─────────────────────────────────────────────────────────────────────────────
// 소리가 서버로 가기 시작했다. 그 순간 **세 개의 이음매**가 생겼고, 셋 다 조용히 어긋난다:
//
//  ① 로컬 ↔ 서버 행(rowmap) — 왕복에서 한 칸이 새면 그 값이 다음 pull에서 사라진다.
//  ② 브라우저 ↔ Deno(Edge Function) — 확장자 목록이 어긋나면 **소리가 영영 안 올라간다**
//     (앱은 `.webm`으로 올리는데 함수의 `safeRest`가 거부한다). 배포 단위가 달라 손으로 맞출
//     수밖에 없는 자리라, 사진에서 이미 한 번 물린 곳이다(`mediaNaming.test.ts` 머리주석).
//  ③ 시각 표기(M-0034) — 서버는 `…48.34+00:00`, 로컬은 `…48.340Z`. 같은 순간을 다르게 적는다.
//     `recorded_at`은 R2 파일 이름의 앞부분이자 칩 정렬 기준이라, 사진의 `taken_at`과 정확히
//     같은 자리다 — 거기서 실제로 사고가 났었다.

import { describe, it, expect } from 'vitest';
import { toAudioRow, fromAudioRow, audioStoragePath, type AudioRow } from '../../src/domain/audio/rowmap';
import { audioExt, audioObjectName, AUDIO_EXTS } from '../../src/domain/media/naming';
import { mediaIdFromPath, restOfPath } from '../../src/services/r2';
import {
  mediaIdOfKey,
  safeRest,
  objectKey,
  isAudioKey,
  AUDIO_EXTS as FN_AUDIO_EXTS,
} from '../../supabase/functions/media-sign/index';
import type { LocalAudio } from '../../src/offline/db';

const USER = 'c9ff5188-51a7-4c01-b653-b6e1d73d0790';
const TRIP = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70';
const AID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const audio: LocalAudio = {
  id: AID,
  momentId: '22222222-2222-4222-8222-222222222222',
  tripId: TRIP,
  blob: new Blob([new Uint8Array(1234)], { type: 'audio/webm' }),
  mime: 'audio/webm;codecs=opus',
  durationSec: 14,
  recordedAt: '2026-07-16T14:32:00.000Z',
  version: 2,
  baseVersion: 2,
  baseCanonicalVersion: 'legacy',
  createdAt: '2026-07-16T14:32:00.000Z',
  updatedAt: '2026-07-16T14:33:10.000Z',
  deletedAt: null,
  clientOperationId: '55555555-5555-4555-8555-555555555555',
};

describe('① rowmap 왕복 — 한 칸도 새지 않는다', () => {
  it('메타가 손실 없이 돌아온다(blob은 행에 담지 않는다 — 바이트는 R2로 간다)', () => {
    const back = fromAudioRow(toAudioRow(audio, USER, 'k/x.webm'));
    expect(back).toEqual({
      id: audio.id,
      momentId: audio.momentId,
      tripId: audio.tripId,
      storagePath: 'k/x.webm',
      durationSec: 14,
      mime: 'audio/webm;codecs=opus',
      bytes: 1234,
      recordedAt: audio.recordedAt,
      version: 2,
      baseVersion: 2,
      baseCanonicalVersion: 'legacy',
      createdAt: audio.createdAt,
      updatedAt: audio.updatedAt,
      deletedAt: null,
      clientOperationId: audio.clientOperationId,
    });
  });

  it('snake_case 행을 만들고 user_id·기기를 주입한다', () => {
    const row = toAudioRow(audio, USER, null, '내폰#ab12');
    expect(row.user_id).toBe(USER);
    expect(row.moment_id).toBe(audio.momentId);
    expect(row.trip_id).toBe(audio.tripId);
    expect(row.duration_sec).toBe(14);
    expect(row.updated_by_device).toBe('내폰#ab12');
    expect(row.source).toBe('user'); // 파이프라인 생성물이 아니다
    expect(row.base_version).toBe(2);
    expect(row.base_canonical_version).toBe('legacy');
  });

  it('🔴 바이트 수는 blob에서 읽는다 — 사용자가 적는 값이 아니라 사실이다', () => {
    expect(toAudioRow(audio, USER, null).bytes).toBe(1234);
  });

  it('tombstone도 왕복 보존된다(휴지통이 서버에 전해져야 한다)', () => {
    const del: LocalAudio = { ...audio, deletedAt: '2026-07-22T12:00:00.000Z', version: 3 };
    const back = fromAudioRow(toAudioRow(del, USER, null));
    expect(back.deletedAt).toBe('2026-07-22T12:00:00.000Z');
    expect(back.version).toBe(3);
  });

  it('clientOperationId 없으면 행에서 null, 복원 시 키 없음', () => {
    const { clientOperationId: _drop, ...noCoi } = audio;
    const row = toAudioRow(noCoi as LocalAudio, USER, null);
    expect(row.client_operation_id).toBe(null);
    expect('clientOperationId' in fromAudioRow(row)).toBe(false);
  });
});

describe('🔴 ② 시각 표기는 반드시 정규형을 지난다 (M-0034)', () => {
  /** 서버가 실제로 돌려주는 모양 — 밀리초 자릿수가 다르고 `Z` 대신 `+00:00`이다. */
  const serverRow: AudioRow = {
    ...toAudioRow(audio, USER, 'k/x.webm'),
    created_at: '2026-07-16T14:32:00.34+00:00',
    updated_at: '2026-07-16T14:33:10.5+00:00',
    recorded_at: '2026-07-16T14:32:00.34+00:00',
    deleted_at: '2026-07-22T12:00:00+00:00',
  };

  it('created_at·updated_at·deleted_at이 전부 표준 표기가 된다', () => {
    const back = fromAudioRow(serverRow);
    expect(back.createdAt).toBe('2026-07-16T14:32:00.340Z');
    expect(back.updatedAt).toBe('2026-07-16T14:33:10.500Z');
    expect(back.deletedAt).toBe('2026-07-22T12:00:00.000Z');
  });

  it('🔴 recorded_at도 통과한다 — 사진에서 `taken_at` 한 줄을 빠뜨려 사고가 났던 자리', () => {
    expect(fromAudioRow(serverRow).recordedAt).toBe('2026-07-16T14:32:00.340Z');
  });

  it('빈 값은 빈 값으로 둔다(없는 시각을 지어내지 않는다)', () => {
    expect(fromAudioRow({ ...serverRow, recorded_at: null }).recordedAt).toBe('');
  });
});

describe('🔴 ③ 확장자 목록은 브라우저와 Deno가 **같아야** 한다', () => {
  it('두 목록이 정확히 일치한다 — 어긋나면 소리가 영영 안 올라간다', () => {
    expect([...AUDIO_EXTS].sort()).toEqual([...FN_AUDIO_EXTS].sort());
  });

  it('실제 녹음 MIME이 전부 확장자로 떨어진다', () => {
    expect(audioExt('audio/webm;codecs=opus')).toBe('webm'); // Chrome·Android
    expect(audioExt('audio/mp4')).toBe('m4a'); // iOS Safari
    expect(audioExt('audio/ogg;codecs=opus')).toBe('ogg'); // Firefox
    expect(audioExt('audio/mpeg')).toBe('mp3');
    expect(audioExt('audio/wav')).toBe('wav');
  });

  it('🔴 모르는 형식은 **null**이다 — 거짓 확장자를 붙이지 않는다', () => {
    expect(audioExt('audio/exotic-codec')).toBeNull();
    expect(audioExt('')).toBeNull();
    // 그래서 경로도 만들어지지 않는다(올리지 않고, 진단이 「서버에 없는 소리」로 말한다).
    expect(audioStoragePath(USER, { ...audio, mime: 'audio/exotic-codec' }, '제주여행')).toBeNull();
  });

  it('함수가 우리 확장자만 받는다 — 버킷을 임의 파일 저장소로 열지 않는다', () => {
    expect(safeRest('여행__aabbccdd/x__abc.webm')).toBe('여행__aabbccdd/x__abc.webm');
    expect(safeRest('여행__aabbccdd/x.exe')).toBeNull();
    expect(safeRest('여행__aabbccdd/x')).toBeNull();
  });
});

describe('🔴 ④ 객체 키 왕복 — 짓는 쪽(브라우저)과 읽는 쪽(Deno)이 같은 규칙인가', () => {
  const path = audioStoragePath(USER, audio, '제주여행')!;

  it('경로는 `{userId}/{여행폴더}/{이름}.{ext}` — 첫 칸은 반드시 userId다', () => {
    expect(path.startsWith(`${USER}/`)).toBe(true);
    expect(path.split('/')).toHaveLength(3);
    expect(path.endsWith('.webm')).toBe(true);
  });

  it('사진과 **같은 여행 폴더**에 산다 — 한 여행의 자료가 한 자리에 모인다', () => {
    expect(path.split('/')[1]).toBe('제주여행__d4e5f6a7');
  });

  it('함수가 그 키에서 원래 id를 되읽는다(왕복)', () => {
    const rest = restOfPath(path)!;
    expect(safeRest(rest)).toBe(rest);
    expect(mediaIdOfKey(objectKey(USER, rest))).toBe(AID);
  });

  it('브라우저 쪽 되읽기도 같은 답을 준다(두 구현이 어긋나지 않게)', () => {
    expect(mediaIdFromPath(path)).toBe(AID);
  });

  it('🔴 종류는 **확장자가 말한다** — 사진과 소리가 같은 폴더에 있어도 갈린다', () => {
    expect(isAudioKey(path)).toBe(true);
    expect(isAudioKey(`${USER}/제주여행__d4e5f6a7/20260716_1432_제주여행__aaaa.webp`)).toBe(false);
  });

  it('이름이 없어도 폴더·기본 이름이 생긴다(빈 칸을 만들지 않는다)', () => {
    const p = audioStoragePath(USER, audio, null)!;
    expect(p.split('/')[1]).toBe('여행__d4e5f6a7');
    expect(audioObjectName(audio.recordedAt, null, AID)).toContain('_소리__');
  });

  it('id를 **32자 전부** 넣는다 — 영구삭제 후엔 파일 이름이 유일한 근거다(M-0029)', () => {
    expect(audioObjectName(audio.recordedAt, '제주여행', AID)).toContain('aaaaaaaabbbb4ccc8dddeeeeeeeeeeee');
  });
});
