// tests/unit/photoHint.test.ts — **사진이 스스로 말하는 것**을 어떻게 읽는가(순수).
//
// 사용자 제안(2026-07-30): *"장소도 사진 입력하면 사진정보에서 우선 가져오도록 하면 어떨까요?"*
//
// 왜 유닛이 필요한가: 여기서 나오는 것은 값만이 아니라 **사용자에게 가는 문장**이다
// (「📷 사진 위치에서 · 37.58700, 127.00160 (3장 중 첫 장)」). M-0022가 그 자리였다 —
// 숫자는 다 맞았는데 화면 문장을 검사한 것이 하나도 없었다(§10 ③).

import { describe, it, expect } from 'vitest';
import {
  photoHintOf,
  photoPlaceLabel,
  photoPlaceNotice,
  type PhotoMetaLike,
} from '../../src/domain/place/photoHint';
import { photoProbeLine, photoProbeNext } from '../../src/domain/place/photoProbe';

const meta = (p: Partial<PhotoMetaLike> = {}): PhotoMetaLike => ({
  takenAt: null,
  gpsLat: null,
  gpsLng: null,
  tzOffsetMin: null,
  tzSource: 'device',
  ...p,
});

describe('photoHintOf — 좌표', () => {
  it('시각을 모르면 좌표가 있는 첫 사진을 쓴다(고른 순서)', () => {
    const h = photoHintOf([
      meta(), // GPS 없는 스크린샷이 먼저 와도
      meta({ gpsLat: 16.0544, gpsLng: 108.2022 }), // 이게 답이다
      meta({ gpsLat: 21.0278, gpsLng: 105.8342 }),
    ]);
    expect(h.coord).toEqual({ lat: 16.0544, lng: 108.2022 });
    expect(h.coordCount).toBe(2);
  });

  // 🔴 사용자 지적(2026-07-31): *"사진여러장이면 가장 앞 시간 사진을 기준으로"*
  // 시각(`guessOccurredAt`)이 이미 「가장 이른 것」을 쓰므로, 장소도 같은 자를 써야
  // **시각과 장소가 같은 사진을 가리킨다**(§7 사용자 대면 대칭).
  it('🔴 촬영시각을 알면 **가장 이른 사진**의 좌표다(고른 순서가 아니라)', () => {
    const h = photoHintOf([
      meta({ takenAt: '2026-07-16T12:00:00.000Z', gpsLat: 21.0278, gpsLng: 105.8342 }), // 늦게 찍힘
      meta({ takenAt: '2026-07-16T09:30:00.000Z', gpsLat: 16.0544, gpsLng: 108.2022 }), // 가장 이르다
      meta({ takenAt: '2026-07-16T18:00:00.000Z', gpsLat: 10.7769, gpsLng: 106.7009 }),
    ]);
    expect(h.coord).toEqual({ lat: 16.0544, lng: 108.2022 });
  });

  it('시각을 아는 사진이 하나라도 있으면 그것이 이긴다(시각 없는 첫 장에 밀리지 않는다)', () => {
    const h = photoHintOf([
      meta({ gpsLat: 21.0278, gpsLng: 105.8342 }), // 시각 없음 · 먼저 고름
      meta({ takenAt: '2026-07-16T09:30:00.000Z', gpsLat: 16.0544, gpsLng: 108.2022 }),
    ]);
    expect(h.coord).toEqual({ lat: 16.0544, lng: 108.2022 });
  });

  it('좌표 없는 사진의 시각은 끼어들지 않는다(그 사진은 위치를 말할 수 없다)', () => {
    const h = photoHintOf([
      meta({ takenAt: '2026-07-16T06:00:00.000Z' }), // 가장 이르지만 좌표가 없다
      meta({ takenAt: '2026-07-16T09:30:00.000Z', gpsLat: 16.0544, gpsLng: 108.2022 }),
    ]);
    expect(h.coord).toEqual({ lat: 16.0544, lng: 108.2022 });
  });

  it('못 읽는 시각은 정렬에 끼우지 않는다 — 지어낸 순서를 만들지 않는다', () => {
    const h = photoHintOf([
      meta({ takenAt: 'not-a-date', gpsLat: 21.0278, gpsLng: 105.8342 }),
      meta({ takenAt: '2026-07-16T09:30:00.000Z', gpsLat: 16.0544, gpsLng: 108.2022 }),
    ]);
    expect(h.coord).toEqual({ lat: 16.0544, lng: 108.2022 });
  });

  it('평균을 내지 않는다 — 아무도 서 있지 않은 지점을 지어내지 않는다', () => {
    const h = photoHintOf([meta({ gpsLat: 10, gpsLng: 20 }), meta({ gpsLat: 90, gpsLng: 180 })]);
    expect(h.coord).toEqual({ lat: 10, lng: 20 }); // 첫 장 그대로(중간값 50,100이 아니다)
  });

  // 🔴 **이 케이스는 뒤집혔다**(2026-07-31 · M-0057). 예전엔 *"0,0도 값이다"*로 잠가 뒀고,
  // 그 계약 때문에 **사용자의 순간에 「📍 0.0000, 0.0000」이 실제로 들어갔다.**
  // 안드로이드가 넘긴 사진의 GPS 태그가 **지워진 게 아니라 0으로 덮여** 있었기 때문이다.
  // §11 ②: 통과시키려 로직을 되돌리지 말고 **케이스를 뒤집는다.**
  it('🔴 0,0(기니만 앞바다)은 **좌표가 아니다** — 비어 있는 태그의 관례적 표현이다', () => {
    expect(photoHintOf([meta({ gpsLat: 0, gpsLng: 0 })]).coord).toBeNull();
    expect(photoHintOf([meta({ gpsLat: 0, gpsLng: 0 })]).coordCount).toBe(0);
  });

  it('한쪽만 0인 것은 **정상 좌표다**(적도·본초자오선은 실재한다) — 막는 것은 둘 다 0일 때뿐', () => {
    expect(photoHintOf([meta({ gpsLat: 0, gpsLng: 127.0 })]).coord).toEqual({ lat: 0, lng: 127.0 });
    expect(photoHintOf([meta({ gpsLat: 37.5, gpsLng: 0 })]).coord).toEqual({ lat: 37.5, lng: 0 });
  });

  it('좌표가 하나도 없으면 null이고 세지도 않는다', () => {
    const h = photoHintOf([meta(), meta()]);
    expect(h.coord).toBeNull();
    expect(h.coordCount).toBe(0);
  });

  it('한쪽만 있는 좌표는 좌표가 아니다', () => {
    expect(photoHintOf([meta({ gpsLat: 16.05, gpsLng: null })]).coord).toBeNull();
  });

  it('NaN·Infinity는 버린다(지어낸 좌표로 핀을 찍지 않는다)', () => {
    expect(photoHintOf([meta({ gpsLat: Number.NaN, gpsLng: 108 })]).coord).toBeNull();
    expect(photoHintOf([meta({ gpsLat: Number.POSITIVE_INFINITY, gpsLng: 108 })]).coord).toBeNull();
  });

  it('빈 목록도 조용히 지나간다', () => {
    expect(photoHintOf([]).coord).toBeNull();
  });
});

describe('photoHintOf — 오프셋은 **EXIF가 직접 말한 것만**', () => {
  // 🔴 이게 이 파일에서 가장 중요한 검사다. `readPhotoMeta`는 오프셋이 없으면 여행 시간대나
  // **기기 시간대**로 채워 준다(그래야 시각 추천이 죽지 않는다). 그 값을 근거로 쓰면
  // **자기가 채운 값을 근거로 자기를 확신하는** 꼴이 된다 — M-0049의 근본형이 그것이었다.
  it('tzSource가 exif일 때만 오프셋을 인정한다', () => {
    expect(photoHintOf([meta({ tzOffsetMin: 420, tzSource: 'exif' })]).exifOffsetMin).toBe(420);
  });

  it('여행 시간대에서 파생한 값은 근거가 아니다', () => {
    expect(photoHintOf([meta({ tzOffsetMin: 420, tzSource: 'trip' })]).exifOffsetMin).toBeNull();
  });

  it('🔴 기기 시간대로 읽은 값은 더더욱 근거가 아니다', () => {
    expect(photoHintOf([meta({ tzOffsetMin: 540, tzSource: 'device' })]).exifOffsetMin).toBeNull();
  });

  it('여럿 중 EXIF가 말한 것을 골라낸다(순서와 무관하게)', () => {
    const h = photoHintOf([
      meta({ tzOffsetMin: 540, tzSource: 'device' }),
      meta({ tzOffsetMin: 420, tzSource: 'exif' }),
    ]);
    expect(h.exifOffsetMin).toBe(420);
  });

  it('0(UTC)은 값이다 — 「없음」으로 뭉개지 않는다', () => {
    expect(photoHintOf([meta({ tzOffsetMin: 0, tzSource: 'exif' })]).exifOffsetMin).toBe(0);
  });
});

describe('photoPlaceLabel — 근거를 값과 함께 말한다', () => {
  it('좌표가 없으면 **아무 말도 하지 않는다**(§8 침묵이 정상)', () => {
    expect(photoPlaceLabel(photoHintOf([meta()]))).toBe('');
  });

  it('한 장이면 좌표만 말한다', () => {
    const s = photoPlaceLabel(photoHintOf([meta({ gpsLat: 16.0544, gpsLng: 108.2022 })]));
    expect(s).toContain('📷 사진 위치에서');
    expect(s).toContain('16.05440');
    expect(s).toContain('108.20220');
    expect(s).not.toContain('중'); // 「N장 중」이 붙지 않는다
  });

  it('여러 장이면 **어느 것을 골랐는지** 말한다(추측을 사실처럼 두지 않는다)', () => {
    const s = photoPlaceLabel(
      photoHintOf([meta({ gpsLat: 16.05, gpsLng: 108.2 }), meta({ gpsLat: 21.02, gpsLng: 105.83 })]),
    );
    expect(s).toContain('2장 중 가장 이른 사진');
  });

  it('좌표 없는 사진은 세지 않는다 — 「3장 중」이라 말하면 거짓이다', () => {
    const s = photoPlaceLabel(photoHintOf([meta(), meta({ gpsLat: 16.05, gpsLng: 108.2 }), meta()]));
    expect(s).not.toContain('중'); // 좌표를 가진 건 한 장뿐이다
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 사용자 2026-07-31: *"아직도 해결이 안되네..어려운 기능인건가요?"*
//
// v1.30이 「말하지 않으면 안 한 것과 구별되지 않는다」를 고쳤는데 **형제 하나만** 고쳤고,
// 하필 사용자가 쓴 화면이 침묵하는 쪽이었다. 그리고 그때 문장은 *"없어요"*까지만 말했다 —
// **왜 없는지도, 그럼 뭘 해야 하는지도** 말하지 않았다(§8: 도구는 관측이 아니라 판정을 한다).
// ─────────────────────────────────────────────────────────────────────────────
describe('photoPlaceNotice — 없을 때 **왜 없는지**와 **그럼 어떻게 하는지**', () => {
  it('좌표를 얻었으면 아무 말도 하지 않는다(할 말이 없다)', () => {
    expect(photoPlaceNotice(photoHintOf([meta({ gpsLat: 16.05, gpsLng: 108.2 })]))).toBe('');
  });

  it('🔴 사진이 하나도 없으면 침묵한다 — 사진을 다 뺐는데 위치 얘기를 꺼내면 소음이다', () => {
    expect(photoPlaceNotice(photoHintOf([]))).toBe('');
  });

  it('🔴 시각은 읽었는데 위치가 없으면 — **파서 탓이 아니라는 것**을 말한다', () => {
    const s = photoPlaceNotice(photoHintOf([meta({ takenAt: '2026-07-31T05:09:00.000Z' })]));
    expect(s).toContain('촬영시각은 읽었'); // 앱이 사진을 읽긴 했다는 사실
    expect(s).toContain('위치 정보가 없어요');
  });

  // 🔴 정정(2026-07-31 · M-0056): 처음엔 *"안드로이드 사진 선택기가 지웠어요"*라고 **단정**했다.
  // 사용자가 사후 업로드로 시험하자 **좌표가 그대로 들어왔다** — 늘 지우는 것이 아니었다.
  // 원인을 하나로 못박으면 사용자가 엉뚱한 곳을 뒤지고 진짜 원인을 못 찾는다(§8).
  it('🔴 확인하지 않은 원인을 **단정하지 않는다**(§8 · M-0056)', () => {
    const s = photoPlaceNotice(photoHintOf([meta({ takenAt: '2026-07-31T05:09:00.000Z' })]));
    expect(s).not.toMatch(/지웠어요|지웁니다/);
  });

  // 🔴 실측(M-0058): 사용자가 준 원본 JPEG의 GPS 태그는 **껍데기만 있고 값이 비어** 있었다
  // (`0/0, 0/0, 0/0`). 그런데 갤러리는 그 사진을 지도로 보여준다 — 갤러리는 **파일이 아니라
  // 폰의 미디어 DB**를 읽기 때문이다. 이 어긋남을 설명하지 않으면 사용자는 앱을 의심한다.
  it('🔴 **갤러리가 지도를 보여주는데 앱은 못 본다**는 어긋남을 설명한다', () => {
    const s = photoPlaceNotice(photoHintOf([meta({ takenAt: '2026-07-31T05:09:00.000Z' })]));
    expect(s).toContain('위치가 안 담겨');
    expect(s).toContain('갤러리');
  });

  // 🔴 **케이스를 뒤집었다**(2026-08-01 · M-0059 · §11 ②). 전에는 *"이 **사진 파일**에 위치가
  // 안 담겨 있어요"*를 정상으로 못박아 뒀다. 그 문장은 **원인을 파일로 단정**한다.
  //
  // 그런데 사용자가 같은 사진을 두 경로(ZIP / 채팅 직접)로 보내 실측한 결과, **전달 경로가
  // GPS를 0으로 덮었다**(25바이트만, 파일 크기는 동일). 즉 「앱이 받은 것에 없다」는 참이지만
  // 「그 파일에 원래 없었다」는 **모르는 것**이다. 통과시키려고 문장을 되돌리지 않는다.
  it('🔴 원인을 **파일 하나로 못박지 않는다** — 전달 과정도 지운다(§8 · M-0059)', () => {
    const s = photoPlaceNotice(photoHintOf([meta({ takenAt: '2026-07-31T05:09:00.000Z' })]));
    expect(s).toContain('앱이 받은'); // 참인 범위까지만 말한다
    expect(s).toMatch(/주고받는|메신저|클라우드/); // 다른 가능성도 말한다
    expect(s).not.toContain('이 사진 파일에 위치가 안 담겨'); // 옛 단정형
  });

  it('🔴 **다시 안 겪게 하는 조치**를 알려 준다(§12 — 가장 좋은 답은 재발을 없애는 것)', () => {
    const s = photoPlaceNotice(photoHintOf([meta({ takenAt: '2026-07-31T05:09:00.000Z' })]));
    expect(s).toContain('위치 태그');
  });

  // 🔴 2026-08-01 사용자 실기기: **갤러리 선택기가 위치를 가리고 넘긴다**(직접 촬영·파일
  // 선택기는 그대로 온다). 기본 경로를 원본 보존 쪽으로 뒤집었으므로, 안내도 *어느 버튼으로
  // 고르면 되는지*를 말해야 한다 — §12가 원하는 것은 설명이 아니라 **다음 행동**이다.
  it('🔴 **어느 버튼으로 고르면 되는지**를 말한다(고칠 수 있는 것을 먼저)', () => {
    const s = photoPlaceNotice(photoHintOf([meta({ takenAt: '2026-07-31T05:09:00.000Z' })]));
    expect(s).toContain('사진 추가');
    expect(s).toContain('원본 그대로');
  });

  it('시각조차 없으면 **다른 원인**을 말한다(스크린샷·메신저)', () => {
    const s = photoPlaceNotice(photoHintOf([meta()]));
    expect(s).toContain('촬영 정보가 없어요');
    expect(s).toContain('스크린샷');
    expect(s).not.toContain('안드로이드'); // 원인이 다르므로 같은 말을 하면 안 된다
  });

  it('🔴 두 경우 다 **탈출구**로 데려간다 — 「안 된다」로 끝내지 않는다(§12)', () => {
    for (const metas of [[meta()], [meta({ takenAt: '2026-07-31T05:09:00.000Z' })]]) {
      const s = photoPlaceNotice(photoHintOf(metas));
      expect(s).toContain('지도로 찍거나');
      expect(s).toContain('좌표를');
    }
  });

  // 🔴 v1.33 — 탈출구가 셋이 됐고 **가장 짧은 길이 맨 앞**이어야 한다.
  // 사용자 요구는 *"어떤 방식이든 결과가 중요함"*이었고, 결과가 가장 확실한 것은
  // [📍 내 위치] 한 번이다(안드로이드가 사진에서 지운 위치와 달리 막히지 않는다).
  it('🔴 [📍 내 위치]를 **가장 먼저** 가리킨다(한 번 눌러 끝나는 길)', () => {
    for (const metas of [[meta()], [meta({ takenAt: '2026-07-31T05:09:00.000Z' })]]) {
      const s = photoPlaceNotice(photoHintOf(metas));
      expect(s).toContain('내 위치');
      expect(s.indexOf('내 위치')).toBeLessThan(s.indexOf('지도로 찍거나'));
    }
  });

  it('못 읽는 시각은 「읽었다」의 근거가 아니다', () => {
    const s = photoPlaceNotice(photoHintOf([meta({ takenAt: 'not-a-date' })]));
    expect(s).toContain('촬영 정보가 없어요'); // 시각을 읽은 것으로 세면 거짓 위로가 된다
  });

  it('한 장이라도 시각을 읽었으면 그 사실을 말한다(전부일 필요는 없다)', () => {
    const s = photoPlaceNotice(photoHintOf([meta(), meta({ takenAt: '2026-07-31T05:09:00.000Z' })]));
    expect(s).toContain('촬영시각은 읽었');
  });
});

describe('photoHintOf — 세는 것들', () => {
  it('photoCount는 고른 전부, timedCount는 시각을 읽은 것, coordCount는 좌표를 가진 것', () => {
    const h = photoHintOf([
      meta(),
      meta({ takenAt: '2026-07-31T05:09:00.000Z' }),
      meta({ takenAt: '2026-07-31T06:00:00.000Z', gpsLat: 16.05, gpsLng: 108.2 }),
    ]);
    expect(h.photoCount).toBe(3);
    expect(h.timedCount).toBe(2);
    expect(h.coordCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔬 **앱이 받은 바이트의 사실** (2026-08-01 · M-0066)
//
// 나흘 동안 원인을 추측으로 좁혔고 네 번 틀렸다. 그동안 사용자는 스크린샷을 날랐고 앱은
// 그 바이트를 손에 쥐고도 아무 말을 안 했다(§12). 이 문장이 그 자리를 메운다.
//
// 🔴 여기서 검사하는 것은 **판정을 하지 않는가**이다. 원인을 말하는 순간 이 도구는
// 지난 나흘의 실수를 반복한다 — 관측만 적어야 한다(§8).
// ─────────────────────────────────────────────────────────────────────────────
describe('photoProbeLine / photoProbeNext — 관측만 적는다', () => {
  const base = { name: 'a.jpg', bytes: 2918760, sha16: 'fdfd864c57d62ed7' };
  const P = (over: Partial<import('../../src/media/exif').ExifProbe> = {}) => ({
    isJpeg: true,
    app1: ['exif' as const],
    gps: 'no-ifd' as const,
    ...over,
  });

  it('크기와 해시를 **눈으로 대조할 수 있게** 적는다(폰의 원본과 맞춰 보라고)', () => {
    const s = photoProbeLine({ ...base, probe: P() });
    expect(s).toContain('2,918,760바이트');
    expect(s).toContain('fdfd864c57d62ed7');
  });

  it('위치 칸이 **비워진 것**과 **없는 것**을 다르게 말한다(처방이 다르다)', () => {
    expect(photoProbeLine({ ...base, probe: P({ gps: 'zeroed', gpsRaw: 'N 0/0,0/0,0/0' }) })).toContain('값이 비어 있음');
    expect(photoProbeLine({ ...base, probe: P({ gps: 'no-ifd' }) })).toContain('위치 칸 자체가 없음');
  });

  it('원자료를 그대로 보여준다 — 가공하면 대조할 수 없다', () => {
    const s = photoProbeLine({ ...base, probe: P({ gps: 'value', gpsRaw: 'N 36/1,36/1,32809680/1000000' }) });
    expect(s).toContain('36/1,36/1,32809680/1000000');
  });

  it('🔴 **원인을 말하지 않는다**(§8 — 이 건에서 네 번 틀렸다)', () => {
    for (const g of ['no-ifd', 'zeroed', 'value'] as const) {
      const s = `${photoProbeLine({ ...base, probe: P({ gps: g }) })} ${photoProbeNext(P({ gps: g }))}`;
      expect(s).not.toMatch(/지웠어요|지웁니다|때문입니다|안드로이드가/);
    }
  });

  it('🔴 값이 정상인데 안 들어갔으면 **앱 결함이라고 말한다**(내 탓을 사용자에게 미루지 않는다)', () => {
    expect(photoProbeNext(P({ gps: 'value' }))).toContain('앱 결함');
  });

  it('JPEG이 아니면 그 사실을 말하고 탈출구를 준다', () => {
    const s = photoProbeLine({ ...base, probe: P({ isJpeg: false }) });
    expect(s).toContain('JPEG이 아니라');
    expect(photoProbeNext(P({ isJpeg: false }))).toContain('내 위치');
  });
});
