// services/externalMapConsent.ts — 「바깥 지도로 나간다」는 사실을 **제공자마다 처음 한 번만** 확인받는다.
//
// 사용자 결정(2026-07-27): *"처음 한 번만 확인."* 개인정보 원칙은 지키되(무엇이 나가는지
// 말한다) 누를 때마다 묻지는 않는다 — 매번 묻는 확인은 읽히지 않고 반사적으로 눌리기 때문에,
// 세 번째부터는 **고지가 아니라 마찰**이다.
//
// 🔴 2026-07-28에 **제공자별**로 바꿨다(지도가 넷이 되면서). 예전엔 키가 하나여서, 구글에
// 한 번 동의하면 얀덱스·네이버·카카오까지 **묻지 않고 열렸을** 것이다. 그건 동의가 아니다 —
// 받는 회사가 다르면 다른 결정이고, 좌표가 어느 회사로 가느냐가 바로 그 결정의 내용이다.
// (넓히면서 그 자리를 안 봤으면 조용히 셋을 끼워 판 셈이 된다 — §7 「새 형제」의 반대 방향.)
//
// 동의 여부는 기억(memory)이 아니라 **이 기기의 표시 상태**라 localStorage에 둔다
// (`backupMeta.ts`와 같은 판단 — 사이트데이터가 지워지면 다시 한 번 묻게 될 뿐 무해하다).
// 그래서 백업·동기화 대상이 아니다: `purgedIds`를 백업에서 제외한 것과 같은 근거다.

import type { MapProviderId } from '../domain/place/externalMap';
import { hasAgreed, rememberAgreed } from './consent';

/**
 * 제공자별 키. 옛 키(`bugeon:externalMapOk`)는 **일부러 읽지 않는다** — 그걸 구글 동의로
 * 물려받으면 "구글에만 동의했는데 넷 다 열림"이 되진 않지만, 사용자가 *하나뿐이던 시절*에
 * 누른 확인을 지금의 넷 중 하나로 해석하는 셈이라 다시 묻는 쪽이 정직하다. 비용은 한 번의 확인이다.
 */
function keyOf(id: MapProviderId): string {
  return `bugeon:externalMapOk:${id}`;
}

// 🔴 저장·판정은 `services/consent.ts` **한 곳**이 한다(2026-07-30). 「처음 한 번만 확인」이
// 두 번째 자리(사진 위치 → 지오코더)에 생기면서 뽑았다 — 같은 규율을 손으로 두 벌 구현하면
// 한쪽이 낡을 때 **개인정보 동의가 조용히 새어 나간다**(§7 2층). 이 파일에 남는 것은
// *"제공자마다 별개의 결정이다"*라는 **이 도메인의 판단**뿐이다.

/** 이 기기에서 **이 제공자에 대해** 이미 확인했는가. */
export function hasAgreedExternalMap(id: MapProviderId): boolean {
  return hasAgreed(keyOf(id));
}

export function rememberAgreedExternalMap(id: MapProviderId): void {
  rememberAgreed(keyOf(id));
}
