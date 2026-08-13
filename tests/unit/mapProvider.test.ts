import { describe, expect, it } from 'vitest';
import {
  displayProviderFallbackOrder,
  displayProviderForPicker,
  displayProviderForPoints,
  isKoreaMapCoordinate,
} from '../../src/domain/place/mapProvider';

describe('지도 표시 제공자 판정', () => {
  it('서울·제주·독도는 한국 지도 경계다', () => {
    expect(isKoreaMapCoordinate({ lat: 37.5665, lng: 126.978 })).toBe(true);
    expect(isKoreaMapCoordinate({ lat: 33.4996, lng: 126.5312 })).toBe(true);
    expect(isKoreaMapCoordinate({ lat: 37.241, lng: 131.865 })).toBe(true);
  });

  it('타슈켄트·모스크바·도쿄는 기존 세계지도 경계다', () => {
    expect(isKoreaMapCoordinate({ lat: 41.2995, lng: 69.2401 })).toBe(false);
    expect(isKoreaMapCoordinate({ lat: 55.7558, lng: 37.6173 })).toBe(false);
    expect(isKoreaMapCoordinate({ lat: 35.6762, lng: 139.6503 })).toBe(false);
  });

  it('키가 있고 모든 지점이 한국일 때만 카카오를 쓴다', () => {
    const seoul = { lat: 37.5665, lng: 126.978 };
    const busan = { lat: 35.1796, lng: 129.0756 };
    const tashkent = { lat: 41.2995, lng: 69.2401 };
    const allKeys = { kakaoKeyConfigured: true, jusoMapKeyConfigured: true, tomtomKeyConfigured: true };
    expect(displayProviderForPoints([seoul, busan], allKeys)).toBe('kakao');
    expect(displayProviderForPoints([seoul, busan], { ...allKeys, kakaoKeyConfigured: false })).toBe('juso');
    expect(displayProviderForPoints([seoul, tashkent], allKeys)).toBe('maplibre');
    expect(displayProviderForPoints([], allKeys)).toBe('maplibre');
  });

  it('선택기는 한국 Kakao, 확인된 시범국 TomTom, 나머지는 기존 지도를 쓴다', () => {
    const allKeys = { kakaoKeyConfigured: true, jusoMapKeyConfigured: true, tomtomKeyConfigured: true };
    expect(displayProviderForPicker({ lat: 37.5665, lng: 126.978 }, 'kr', allKeys)).toBe('kakao');
    expect(displayProviderForPicker({ lat: 41.2995, lng: 69.2401 }, 'uz', allKeys)).toBe('tomtom');
    expect(displayProviderForPicker({ lat: 43.2389, lng: 76.8897 }, 'kz', allKeys)).toBe('tomtom');
    expect(displayProviderForPicker({ lat: 42.8746, lng: 74.5698 }, 'kg', allKeys)).toBe('tomtom');
    expect(displayProviderForPicker({ lat: 55.7558, lng: 37.6173 }, 'ru', allKeys)).toBe('maplibre');
    expect(displayProviderForPicker({ lat: 41.2995, lng: 69.2401 }, null, allKeys)).toBe('maplibre');
    expect(displayProviderForPicker(null, 'uz', allKeys)).toBe('maplibre');
  });

  it('지역별 키가 없으면 기존 지도로 안전하게 돌아간다', () => {
    expect(displayProviderForPicker(
      { lat: 37.5665, lng: 126.978 },
      'kr',
      { kakaoKeyConfigured: false, jusoMapKeyConfigured: false, tomtomKeyConfigured: true },
    )).toBe('maplibre');
    expect(displayProviderForPicker(
      { lat: 41.2995, lng: 69.2401 },
      'uz',
      { kakaoKeyConfigured: true, jusoMapKeyConfigured: false, tomtomKeyConfigured: false },
    )).toBe('maplibre');
  });

  it('지역 지도 실패 시 기존 MapLibre로 한 번만 폴백한다', () => {
    expect(displayProviderFallbackOrder('kakao')).toEqual(['kakao', 'maplibre']);
    expect(displayProviderFallbackOrder('kakao', true)).toEqual(['kakao', 'juso', 'maplibre']);
    expect(displayProviderFallbackOrder('juso')).toEqual(['juso', 'maplibre']);
    expect(displayProviderFallbackOrder('tomtom')).toEqual(['tomtom', 'maplibre']);
    expect(displayProviderFallbackOrder('maplibre')).toEqual(['maplibre']);
  });
});

