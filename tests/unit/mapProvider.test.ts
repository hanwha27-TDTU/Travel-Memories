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
    expect(displayProviderForPoints([seoul, busan], true)).toBe('kakao');
    expect(displayProviderForPoints([seoul, busan], false)).toBe('maplibre');
    expect(displayProviderForPoints([seoul, tashkent], true)).toBe('maplibre');
    expect(displayProviderForPoints([], true)).toBe('maplibre');
  });

  it('선택기는 초기 좌표가 한국으로 확인된 경우만 카카오를 쓴다', () => {
    expect(displayProviderForPicker({ lat: 37.5665, lng: 126.978 }, true)).toBe('kakao');
    expect(displayProviderForPicker({ lat: 41.2995, lng: 69.2401 }, true)).toBe('maplibre');
    expect(displayProviderForPicker(null, true)).toBe('maplibre');
  });

  it('카카오 실패 시 기존 MapLibre로 한 번만 폴백한다', () => {
    expect(displayProviderFallbackOrder('kakao')).toEqual(['kakao', 'maplibre']);
    expect(displayProviderFallbackOrder('maplibre')).toEqual(['maplibre']);
  });
});

