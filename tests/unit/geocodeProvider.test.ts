import { describe, it, expect } from 'vitest';
import {
  dedupePlaces,
  hasHangul,
  inKoreaBox,
  isKoreaOnly,
  looksKorean,
  normalizeName,
  providerLabel,
  providerOrder,
  roughDistanceMeters,
  FALLBACK_PROVIDER,
  type ProviderId,
} from '../../src/domain/place/provider';

describe('한국 질의 판정', () => {
  it('한글이 있으면 한국 질의다', () => {
    expect(hasHangul('대학로')).toBe(true);
    expect(hasHangul('스타벅스 종로점')).toBe(true);
    expect(hasHangul('Roma Termini')).toBe(false);
  });
  it('보고 있는 위치가 한국 안이면 로마자 질의도 한국 질의다', () => {
    // 「Gyeongbokgung」처럼 로마자로 치는 국내 검색을 살린다.
    expect(looksKorean('Gyeongbokgung', { lat: 37.58, lng: 127.0 })).toBe(true);
    expect(looksKorean('Gyeongbokgung', null)).toBe(false);
  });
  it('제주·울릉도 근처도 한국 상자 안이다', () => {
    expect(inKoreaBox({ lat: 33.24, lng: 126.41 })).toBe(true); // 제주
    expect(inKoreaBox({ lat: 37.5, lng: 130.9 })).toBe(true); // 울릉
  });
  it('해외 좌표는 상자 밖이다', () => {
    expect(inKoreaBox({ lat: 41.9, lng: 12.5 })).toBe(false); // 로마
    expect(inKoreaBox({ lat: 41.3, lng: 69.2 })).toBe(false); // 타슈켄트
    expect(inKoreaBox({ lat: 35.68, lng: 139.7 })).toBe(false); // 도쿄
  });
  it('좌표가 없거나 깨졌으면 상자 밖으로 친다', () => {
    expect(inKoreaBox(null)).toBe(false);
    expect(inKoreaBox({ lat: Number.NaN, lng: 127 })).toBe(false);
  });
});

describe('providerOrder — 누구에게 먼저 묻는가', () => {
  it('설정이 하나도 없으면 Nominatim만(설정 0에서도 앱이 돈다)', () => {
    expect(providerOrder('대학로', { available: [] })).toEqual(['nominatim']);
    expect(providerOrder('Roma', { available: [] })).toEqual(['nominatim']);
  });
  it('한국 질의는 국내 제공자를 먼저 묻고 Nominatim으로 내려간다', () => {
    expect(providerOrder('대학로', { available: ['kakao'] })).toEqual(['kakao', 'nominatim']);
    expect(providerOrder('세종대로 110', { available: ['kakao', 'juso', 'vworld'] })).toEqual([
      'kakao',
      'juso',
      'vworld',
      'nominatim',
    ]);
  });
  it('🔴 해외 질의는 국내 제공자를 아예 부르지 않는다(답 없을 걸 알면서 부르지 않는다)', () => {
    expect(providerOrder('Roma Termini', { available: ['kakao', 'vworld'] })).toEqual(['nominatim']);
  });
  it('해외 좌표 근처의 한글 질의는 여전히 국내 제공자를 먼저 본다(한글이 강한 단서)', () => {
    const order = providerOrder('경복궁', { available: ['kakao'], near: { lat: 41.9, lng: 12.5 } });
    expect(order[0]).toBe('kakao');
  });
  it('Nominatim은 **언제나 마지막에 있다**', () => {
    for (const available of [[], ['kakao'], ['juso'], ['vworld'], ['kakao', 'juso', 'vworld']] as ProviderId[][]) {
      for (const q of ['대학로', 'Roma']) {
        const order = providerOrder(q, { available });
        expect(order[order.length - 1]).toBe(FALLBACK_PROVIDER);
      }
    }
  });
  it('국내 전용 제공자가 표시된다', () => {
    expect(isKoreaOnly('kakao')).toBe(true);
    expect(isKoreaOnly('vworld')).toBe(true);
    expect(isKoreaOnly('juso')).toBe(true);
    expect(isKoreaOnly('nominatim')).toBe(false);
  });
  it('모든 제공자에 사용자에게 보일 이름이 있다', () => {
    for (const p of ['nominatim', 'kakao', 'juso', 'vworld'] as const) expect(providerLabel(p)).toBeTruthy();
  });
});

describe('dedupePlaces — 여러 제공자의 결과 합치기', () => {
  it('이름이 같고 가까우면 접고, **먼저 온 것이 이긴다**', () => {
    const merged = dedupePlaces([
      { name: '경복궁', lat: 37.5796, lng: 126.977, tag: 'kakao' },
      { name: '경복궁', lat: 37.5797, lng: 126.9771, tag: 'nominatim' },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.tag).toBe('kakao'); // 앞선 제공자가 남는다(라우팅이 무의미해지지 않게)
  });
  it('🔴 이름이 같아도 멀면 둘 다 남는다(어느 「대학로」인지 사용자가 골라야 한다)', () => {
    const merged = dedupePlaces([
      { name: '대학로', lat: 37.587, lng: 127.0016 }, // 서울 종로
      { name: '대학로', lat: 36.35, lng: 127.34 }, // 대전
    ]);
    expect(merged).toHaveLength(2);
  });
  it('표기가 달라도 같은 이름으로 본다(공백·괄호·가운뎃점)', () => {
    expect(normalizeName('스타벅스 종로점')).toBe(normalizeName('스타벅스종로점'));
    expect(normalizeName('경복궁 (주차장)')).toBe(normalizeName('경복궁'));
  });
  it('거리 계산이 대략 맞다(중복 판정용)', () => {
    const d = roughDistanceMeters({ lat: 37.5, lng: 127.0 }, { lat: 37.5009, lng: 127.0 });
    expect(d).toBeGreaterThan(80);
    expect(d).toBeLessThan(120);
  });
  it('빈 목록은 빈 목록', () => {
    expect(dedupePlaces([])).toEqual([]);
  });
});
