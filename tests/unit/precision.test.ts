import { describe, it, expect } from 'vitest';
import {
  bboxSpanMeters,
  classifyPlace,
  needsRefine,
  precisionFromRank,
  precisionFromSpan,
  precisionGlyph,
  precisionLabel,
  precisionNoun,
  spanText,
  zoomForSpan,
  type BBox,
} from '../../src/domain/place/precision';

describe('bboxSpanMeters', () => {
  it('가늘고 긴 대상은 **긴 축**으로 잰다(짧은 축을 쓰면 정밀하다고 오판한다)', () => {
    // 대학로: 남북으로 길고 동서로 좁다.
    const bbox: BBox = [37.5745, 37.5878, 126.9985, 127.0015];
    const span = bboxSpanMeters(bbox);
    expect(span).not.toBeNull();
    // 남북 약 0.0133도 ≈ 1.48km — 동서(약 265m)가 아니라 이쪽이 나와야 한다.
    expect(span!).toBeGreaterThan(1_200);
    expect(span!).toBeLessThan(1_700);
  });
  it('경도 폭은 위도에 따라 줄어든다(cos 보정)', () => {
    const equator = bboxSpanMeters([0, 0.0001, 0, 1]);
    const high = bboxSpanMeters([60, 60.0001, 0, 1]);
    expect(high!).toBeLessThan(equator! * 0.6);
  });
  it('없거나 깨진 상자는 null — 0으로 반올림하지 않는다', () => {
    expect(bboxSpanMeters(null)).toBeNull();
    expect(bboxSpanMeters([Number.NaN, 1, 2, 3] as unknown as BBox)).toBeNull();
  });
});

describe('precisionFromRank / precisionFromSpan', () => {
  it('랭크 등급 경계', () => {
    expect(precisionFromRank(30)).toBe('point');
    expect(precisionFromRank(28)).toBe('point');
    expect(precisionFromRank(27)).toBe('street');
    expect(precisionFromRank(26)).toBe('street');
    expect(precisionFromRank(25)).toBe('area');
    expect(precisionFromRank(21)).toBe('settlement');
    expect(precisionFromRank(16)).toBe('region');
    expect(precisionFromRank(8)).toBe('region');
  });
  it('랭크가 없으면 unknown — 정밀한 쪽으로 반올림하지 않는다', () => {
    expect(precisionFromRank(null)).toBe('unknown');
    expect(precisionFromRank(Number.NaN)).toBe('unknown');
  });
  it('범위 등급 경계', () => {
    expect(precisionFromSpan(100)).toBe('point');
    expect(precisionFromSpan(1_500)).toBe('street');
    expect(precisionFromSpan(5_000)).toBe('area');
    expect(precisionFromSpan(30_000)).toBe('settlement');
    expect(precisionFromSpan(200_000)).toBe('region');
    expect(precisionFromSpan(null)).toBe('unknown');
  });
});

describe('classifyPlace', () => {
  it('🔴 신고된 그 사례 — 「대학로」는 점이 아니라 길이다', () => {
    const v = classifyPlace({ placeRank: 26, bbox: [37.5745, 37.5878, 126.9985, 127.0015] });
    expect(v.precision).toBe('street');
    expect(v.pinpoint).toBe(false);
    expect(needsRefine(v)).toBe(true);
    expect(v.spanMeters).toBeGreaterThan(1_000);
  });
  it('랭크가 범위를 이긴다 — 짧은 골목도 여전히 「어느 지점인지 모르는」 길이다', () => {
    // 범위만 보면 point(80m)로 보이지만 랭크가 도로라고 말한다.
    const v = classifyPlace({ placeRank: 26, bbox: [37.5, 37.5005, 127.0, 127.0005] });
    expect(v.precision).toBe('street');
    expect(v.pinpoint).toBe(false);
  });
  it('랭크가 없으면 범위로 판정한다(랭크 없는 제공자용 경로)', () => {
    expect(classifyPlace({ placeRank: null, bbox: [37.5, 37.5008, 127.0, 127.0008] }).precision).toBe('point');
    expect(classifyPlace({ placeRank: null, bbox: [37.0, 38.0, 127.0, 128.0] }).precision).toBe('region');
  });
  it('둘 다 없으면 unknown이고 spanMeters는 null이다(§8 확인 불가)', () => {
    const v = classifyPlace({ placeRank: null, bbox: null });
    expect(v).toEqual({ precision: 'unknown', spanMeters: null, pinpoint: false });
    expect(needsRefine(v)).toBe(true); // 모르는 것을 정밀한 쪽으로 반올림하지 않는다
  });
  it('건물은 점이고 미세조정을 권하지 않는다', () => {
    const v = classifyPlace({ placeRank: 30, bbox: [37.5, 37.5003, 127.0, 127.0003] });
    expect(v.pinpoint).toBe(true);
    expect(needsRefine(v)).toBe(false);
  });
});

describe('spanText / precisionLabel / precisionGlyph — 사용자에게 나가는 문장(§10 ③)', () => {
  it('거리 표기', () => {
    expect(spanText(85)).toBe('약 90m');
    expect(spanText(1_480)).toBe('약 1.5km');
    expect(spanText(42_000)).toBe('약 42km');
    expect(spanText(null)).toBeNull();
  });
  it('점이면 종류만, 넓으면 「가리켜요」로 한정한다', () => {
    expect(precisionLabel({ precision: 'point', spanMeters: 40, pinpoint: true })).toBe('건물·지점 · 약 40m');
    expect(precisionLabel({ precision: 'street', spanMeters: 1_480, pinpoint: false })).toBe(
      '길 전체를 가리켜요 · 약 1.5km',
    );
  });
  it('모르면 「확인 불가」라고 적는다 — 통과로도 문제로도 반올림하지 않는다', () => {
    expect(precisionLabel({ precision: 'unknown', spanMeters: null, pinpoint: false })).toBe('정밀도 확인 불가');
  });
  it('범위를 모르면 거리를 지어내지 않는다', () => {
    expect(precisionLabel({ precision: 'street', spanMeters: null, pinpoint: false })).toBe('길 전체를 가리켜요');
  });
  it('색과 함께 나갈 글리프가 등급마다 구분된다(모르는 것 ≠ 넓은 것)', () => {
    expect(precisionGlyph({ precision: 'point', spanMeters: 10, pinpoint: true })).toBe('📍');
    expect(precisionGlyph({ precision: 'street', spanMeters: 900, pinpoint: false })).toBe('⚠');
    expect(precisionGlyph({ precision: 'unknown', spanMeters: null, pinpoint: false })).toBe('?');
  });
  it('모든 등급에 이름이 있다(새 등급을 추가하고 이름을 빠뜨리면 여기서 잡힌다)', () => {
    for (const p of ['point', 'street', 'area', 'settlement', 'region', 'unknown'] as const) {
      expect(precisionNoun(p)).toBeTruthy();
    }
  });
});

describe('zoomForSpan — 확대수준(신고의 나머지 절반)', () => {
  it('범위를 모르면 지점 기본값이며, **10 같은 광역값이 아니다**', () => {
    // 예전 결함: 지점이 하나일 때 zoom이 10으로 남아 수도권 전체가 보였다.
    expect(zoomForSpan(null)).toBeGreaterThanOrEqual(15);
  });
  it('넓은 대상을 억지로 확대하지 않는다(거짓 정밀)', () => {
    expect(zoomForSpan(1_480)).toBeLessThan(zoomForSpan(50));
    expect(zoomForSpan(200_000)).toBeLessThan(zoomForSpan(1_480));
  });
  it('범위가 커질수록 확대수준은 단조 감소한다', () => {
    const spans = [50, 300, 1_500, 5_000, 30_000, 100_000];
    const zooms = spans.map(zoomForSpan);
    for (let i = 1; i < zooms.length; i++) expect(zooms[i]!).toBeLessThanOrEqual(zooms[i - 1]!);
  });
});
