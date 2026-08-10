// 백업 사진 파일명 규칙(순수) — 날짜_시간_제목_용도__id8. 충돌 방지·FS 안전.
import { describe, it, expect } from 'vitest';
import { backupFilename, stampFromISO, photoFileBase } from '../../src/services/backup';

describe('backupFilename', () => {
  const now = new Date(2026, 7, 10, 2, 31, 45);

  it('전체 ZIP은 날짜_시간_앱이름 순서다', () => {
    expect(backupFilename(now, 'zip')).toBe('20260810_0231_Bugeon-Journey.zip');
  });

  it('접미사와 암호화 확장자는 앱이름 뒤에만 붙는다', () => {
    expect(backupFilename(now, 'zip', { suffix: '표시본만', encrypted: true }))
      .toBe('20260810_0231_Bugeon-Journey_표시본만.zip.enc');
    expect(backupFilename(now, 'json', { encrypted: true }))
      .toBe('20260810_0231_Bugeon-Journey.json.enc');
  });
});

describe('stampFromISO', () => {
  it('로컬 시각 기준 YYYYMMDD_HHMM', () => {
    // 로컬 타임존 영향 없는 표현으로 확인: 파싱 성공 시 8자리·4자리 형식
    const s = stampFromISO('2026-07-17T06:17:00');
    expect(s.date).toMatch(/^\d{8}$/);
    expect(s.time).toMatch(/^\d{4}$/);
    expect(s.date).toBe('20260717');
    expect(s.time).toBe('0617');
  });
  it('빈/잘못된 값 → 0 채움', () => {
    expect(stampFromISO(null)).toEqual({ date: '00000000', time: '0000' });
    expect(stampFromISO('쓰레기')).toEqual({ date: '00000000', time: '0000' });
  });
});

describe('photoFileBase', () => {
  it('규칙: 날짜_시간_제목__id8', () => {
    const base = photoFileBase('2026-07-17T06:17:00', '사전등록 정보 확인', '2e843b46-2d42-424e-959e-219f222c2829');
    expect(base).toBe('20260717_0617_사전등록_정보_확인__2e843b46');
  });
  it('FS 금지문자 제거·제목 없으면 사진', () => {
    expect(photoFileBase('2026-07-17T06:17:00', 'a/b:c*?', 'aaaaaaaa-bbbb')).toBe('20260717_0617_abc__aaaaaaaa');
    expect(photoFileBase('2026-07-17T06:17:00', '', 'ffffffff-0000')).toBe('20260717_0617_사진__ffffffff');
  });
  it('충돌 방지: 같은 분·같은 제목이어도 id8이 다르면 파일명이 다르다', () => {
    const a = photoFileBase('2026-07-17T06:17:00', '제주', '11111111-aaaa');
    const b = photoFileBase('2026-07-17T06:17:00', '제주', '22222222-bbbb');
    expect(a).not.toBe(b);
    expect(a.endsWith('__11111111')).toBe(true);
    expect(b.endsWith('__22222222')).toBe(true);
  });
});
