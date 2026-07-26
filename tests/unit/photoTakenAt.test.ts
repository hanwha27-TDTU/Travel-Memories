// tests/unit/photoTakenAt.test.ts — **사진의 촬영시각을 무엇으로 정하는가.**
//
// 이 값이 그냥 메타데이터가 아닌 이유: **R2 파일 이름의 앞부분이 여기서 나온다**
// (`20260717_0536_제주여행__…`). 틀리면 사용자가 저장소를 열었을 때 사진이 엉뚱한 날짜로
// 정렬된다 — 이름을 사람이 읽게 만든 목적 자체가 무너진다.
//
// ── 실제로 밟은 것(2026-07-27 사용자 실기기) ──────────────────────────
// 7/17 여행 사진 9장을 올렸는데 **2장이 `20260727_0225`**(앱에 넣은 날 새벽)로 붙었다.
// 그 2장은 스크린샷·탑승권 QR이라 EXIF `DateTimeOriginal`이 없었고, 예전 코드는 그때
// **파일 수정시각**으로 폴백했다 — 그건 "촬영 시각"이 아니라 *"기기에 저장된 시각"*이다.
//
// 더 나은 근거가 이미 있었다: 사용자가 그 사진을 **어떤 순간에 넣었는지**. 그건 사용자가
// 직접 "이건 그때 것"이라고 말해 준 것이라 파일 수정시각보다 훨씬 강하다.
//
// 그래서 순서가 이렇게 된다: **EXIF → 그 순간의 발생 시각 → 파일 수정시각**.
// 그리고 `readPhotoMeta`는 EXIF가 없으면 **null**을 준다 — 폴백을 부르는 쪽이 정하도록,
// 그리고 화면이 「📷 사진에서」라는 **거짓 근거**를 대지 못하도록(비타협 원칙 #4).

import { describe, it, expect } from 'vitest';
import { readPhotoMeta, resolveTakenAt } from '../../src/services/media';

const MOMENT_AT = '2026-07-17T05:36:00.000Z';

/** EXIF 없는 이미지(스크린샷·저장한 이미지가 이렇다). */
const noExif = (mtime: string): File =>
  new File([new Uint8Array([1, 2, 3, 4])], 'screenshot.png', { type: 'image/png', lastModified: Date.parse(mtime) });

describe('① readPhotoMeta는 EXIF가 없으면 **모른다고 말한다**', () => {
  it('EXIF 없는 파일이면 takenAt이 null — 파일 수정시각으로 채우지 않는다', async () => {
    const meta = await readPhotoMeta(noExif('2026-07-27T02:25:00.000Z'));
    expect(meta.takenAt).toBeNull();
  });

  it('GPS도 없으면 null (모르는 것을 0으로 반올림하지 않는다)', async () => {
    const meta = await readPhotoMeta(noExif('2026-07-27T02:25:00.000Z'));
    expect(meta.gpsLat).toBeNull();
    expect(meta.gpsLng).toBeNull();
  });
});

describe('② 결정 순서: EXIF → 그 순간의 발생 시각 → 파일 수정시각', () => {
  const MTIME = Date.parse('2026-07-27T02:25:00.000Z'); // 앱에 넣은 날 새벽

  it('EXIF가 있으면 그것을 쓴다(가장 강한 근거)', () => {
    expect(resolveTakenAt('2026-07-17T05:36:00.000Z', MOMENT_AT, MTIME)).toBe('2026-07-17T05:36:00.000Z');
  });

  // 이게 이 파일의 핵심 한 줄이다. 실패하면 파일 이름이 `20260727_…`로 붙는다.
  it('EXIF가 없으면 **순간의 시각** — 앱에 넣은 날이 아니라', () => {
    expect(resolveTakenAt(null, MOMENT_AT, MTIME)).toBe(MOMENT_AT);
  });

  it('순간도 모르면 그때서야 파일 수정시각(마지막 수단은 남겨 둔다)', () => {
    expect(resolveTakenAt(null, null, MTIME)).toBe(new Date(MTIME).toISOString());
  });

  it('순간이 undefined여도 같다(찾지 못한 경우)', () => {
    expect(resolveTakenAt(null, undefined, MTIME)).toBe(new Date(MTIME).toISOString());
  });

  it('수정시각조차 0이면 지금을 쓴다(값은 반드시 있어야 한다 — 정렬에 쓰인다)', () => {
    expect(Number.isNaN(Date.parse(resolveTakenAt(null, null, 0)))).toBe(false);
  });
});
