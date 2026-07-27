// services/externalMapConsent.ts — 「구글 지도로 나간다」는 사실을 **처음 한 번만** 확인받는다.
//
// 사용자 결정(2026-07-27): *"처음 한 번만 확인."* 개인정보 원칙은 지키되(무엇이 나가는지
// 말한다) 누를 때마다 묻지는 않는다 — 매번 묻는 확인은 읽히지 않고 반사적으로 눌리기 때문에,
// 세 번째부터는 **고지가 아니라 마찰**이다.
//
// 동의 여부는 기억(memory)이 아니라 **이 기기의 표시 상태**라 localStorage에 둔다
// (`backupMeta.ts`와 같은 판단 — 사이트데이터가 지워지면 다시 한 번 묻게 될 뿐 무해하다).
// 그래서 백업·동기화 대상이 아니다: `purgedIds`를 백업에서 제외한 것과 같은 근거다.

const KEY = 'bugeon:externalMapOk';

/** 이 기기에서 이미 확인했는가. */
export function hasAgreedExternalMap(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    // 프라이빗 모드 등으로 못 읽으면 **동의하지 않은 것으로 본다.**
    // 모르는 것을 동의로 반올림하지 않는다(비타협 원칙 #4).
    return false;
  }
}

export function rememberAgreedExternalMap(): void {
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    /* 못 적으면 다음에 한 번 더 묻게 될 뿐 — 링크 여는 것 자체는 막지 않는다. */
  }
}
