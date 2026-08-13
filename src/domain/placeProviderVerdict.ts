// domain/placeProviderVerdict.ts — 「장소 검색 도우미에 물어볼 수 있는가」의 판정과 문장(순수 함수).
//
// 이 지표가 묻는 질문:
//
//   **「국내 지도로 가는 문이 열려 있는가 — 그리고 우리가 그걸 실제로 확인했는가?」**
//
// 🔴 왜 이 지표가 생겼나(T-025 · M-0148): `geocode` Edge Function이 CORS 때문에 브라우저에서
//    **아예 안 불리는** 상태가 오래 조용했다. 앱이 「못 물어봤다」와 「제공자가 없다」를 같은
//    값(`[]`)으로 접었기 때문이다. 검색은 세계 지도(Nominatim)로 계속됐고 화면은 정상으로
//    보였으며, **운영 로그를 읽고서야** 알았다.
//
// 🔴 그래서 이 지표의 본체는 「국내 지도가 붙었는가」가 아니라 **「우리가 물어는 봤는가」**다.
//    붙어 있지 않은 것은 정상이다(키를 안 넣었으면 안 붙는 것이 맞다). 못 물어본 것은 다르다 —
//    그건 **모르는 상태**이고, 모르는 것을 정상으로 반올림하지 않는다(§8).
//
// 🔴 원인을 못박지 않는다(§8 · M-0056). 오류 하나로는 배포·네트워크·CORS·권한 중 무엇인지
//    가릴 수 없다. 화면 문장은 **관측까지만** 말하고, 다음에 할 일을 알려 준다.

import type { ProviderProbe } from '../services/geocode';

/** 사용자에게 보이는 제공자 이름 — 코드 이름을 그대로 내보내지 않는다. */
const LABEL: Record<string, string> = {
  kakao: '카카오맵',
  juso: '행정안전부 도로명주소',
  vworld: '국토교통부 VWorld',
};

interface ViewBase {
  actual: string;
  expected: string;
  /** `ok`가 아닐 때 화면에 함께 뜨는 한 줄. */
  meaning?: string;
}

/**
 * 🔴 **유니온으로 둔다 — `unknownKind`에 기본값을 주지 않는다.**
 * 기본값이 있으면 새 갈래가 그것을 안 적어도 컴파일되고, 그게 이 규율이 조용히 빠지는
 * 길이다(M-0060 · verdict의 `Metric`이 같은 이유로 유니온이다).
 */
export type PlaceProviderView =
  | (ViewBase & { level: 'ok' })
  | (ViewBase & { level: 'unknown'; unknownKind: 'structural' | 'transient' });

/** 이 지표가 정상이라고 부르는 상태 — **물어볼 수 있었다**(붙었는지와 무관하다). */
const EXPECTED = '물어볼 수 있음';

export function placeProviderView(probe: ProviderProbe): PlaceProviderView {
  if (probe.asked) {
    const names = probe.providers.map((p) => LABEL[p] ?? p);
    return {
      actual: names.length ? `물어봤어요 · ${names.join(', ')} 연결됨` : '물어봤어요 · 연결된 국내 지도 없음',
      expected: EXPECTED,
      level: 'ok',
    };
  }

  // 물어볼 서버가 없는 것은 결함이 아니라 **확인된 사실**이다 — 로그아웃·미설정이 그 상태다.
  if (probe.why === 'no-client') {
    return {
      actual: '물어보지 않았어요 · 로그인 안 됨',
      expected: EXPECTED,
      level: 'ok',
    };
  }

  return {
    actual: probe.why === 'error' ? '물어봤지만 답을 못 받았어요' : '답이 왔지만 모양이 달라요',
    expected: EXPECTED,
    level: 'unknown',
    // 오류는 다시 시도하면 풀릴 수 있다. 모양이 다른 것은 다시 눌러도 그대로다.
    unknownKind: probe.why === 'error' ? 'transient' : 'structural',
    meaning:
      probe.why === 'error'
        ? '장소 검색 도우미에 물어보지 못했어요. 검색은 세계 지도로 계속되니 지금 쓰는 데는 문제가 없고, 국내 지도가 붙어 있어도 쓰이지 않습니다. 잠시 뒤 다시 확인해 보세요.'
        : '장소 검색 도우미가 예상과 다른 답을 줬어요. 검색은 세계 지도로 계속됩니다. 앱과 서버 판이 어긋났을 수 있으니 개발자에게 알려 주세요.',
  };
}
