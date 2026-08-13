import { describe, expect, it } from 'vitest';
import { placeProviderView } from '../../src/domain/placeProviderVerdict';

// 🔴 이 유닛이 잠그는 것은 「국내 지도가 붙었는가」가 아니라 **「못 물어본 것이 정상으로
//    반올림되지 않는가」**다(T-025 · M-0148). 예전에는 두 상태가 같은 값이었고, 그래서
//    `geocode`가 브라우저에서 아예 안 불리는 상태가 오래 조용했다.

describe('장소 검색 도우미 판정', () => {
  it('물어봤고 국내 지도가 붙어 있으면 정상이고, 이름을 사람 말로 적는다', () => {
    const v = placeProviderView({ asked: true, providers: ['kakao', 'juso'] });

    expect(v.level).toBe('ok');
    expect(v.actual).toContain('카카오맵');
    expect(v.actual).toContain('행정안전부 도로명주소');
    expect(v.actual).not.toContain('kakao'); // 코드 이름을 화면에 내보내지 않는다
  });

  it('🔴 물어봤는데 하나도 없는 것은 **정상이다** — 키를 안 넣었으면 안 붙는 것이 맞다', () => {
    const v = placeProviderView({ asked: true, providers: [] });

    expect(v.level).toBe('ok');
    expect(v.actual).toContain('물어봤어요');
  });

  it('🔴 못 물어본 것은 정상이 아니다 — 「없다」와 같은 문장이 되면 안 된다', () => {
    const asked = placeProviderView({ asked: true, providers: [] });
    const failed = placeProviderView({ asked: false, why: 'error' });

    expect(failed.level).toBe('unknown');
    expect(failed.actual).not.toBe(asked.actual);
  });

  it('오류는 다시 시도하면 풀릴 수 있고(transient), 모양이 다른 것은 그대로다(structural)', () => {
    const err = placeProviderView({ asked: false, why: 'error' });
    const shape = placeProviderView({ asked: false, why: 'bad-shape' });

    expect(err.level === 'unknown' && err.unknownKind).toBe('transient');
    expect(shape.level === 'unknown' && shape.unknownKind).toBe('structural');
  });

  it('로그인 안 된 상태는 확인된 사실이므로 정상이다 — 물어볼 서버가 없다', () => {
    const v = placeProviderView({ asked: false, why: 'no-client' });

    expect(v.level).toBe('ok');
    expect(v.actual).toContain('로그인');
  });

  it('🔴 원인을 못박지 않는다 — 관측까지만 말한다(§8 · M-0056)', () => {
    for (const why of ['error', 'bad-shape'] as const) {
      const v = placeProviderView({ asked: false, why });
      const text = `${v.actual} ${v.meaning ?? ''}`;

      // 오류 하나로는 무엇이 원인인지 가릴 수 없다. 단정하면 사용자를 엉뚱한 곳으로 보낸다.
      expect(text).not.toMatch(/CORS|차단했|막았|때문입니다|지웠/);
    }
  });

  it('못 물어봤어도 검색은 계속된다는 사실을 함께 말한다 — 사용자가 고장으로 읽지 않게(§12)', () => {
    for (const why of ['error', 'bad-shape'] as const) {
      expect(placeProviderView({ asked: false, why }).meaning).toContain('세계 지도');
    }
  });
});
