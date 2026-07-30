// services/homeZone.ts — 「집 시간대」 하나만 들고 있는 곳.
//
// 왜 필요한가 (사용자 2026-07-29):
//   *"적당한 위치에 한국시간으로 자동 환산해주면 좋을 거 같아요."*
//
// 환산에는 **기준이 되는 집**이 필요하다. 그런데 `deviceZone()`을 그때그때 읽으면
// 🔴 **여행 중에 환산이 사라진다** — 폰이 현지 시간대로 자동 전환되면 「집 = 현지」가 되고,
// `homeConversion`은 같을 때 침묵하도록 설계됐으므로(§8) 정확히 환산이 가장 필요한 순간에
// 아무것도 안 나온다. 그래서 **한 번 정해서 붙잡는다.**
//
// 첫 읽기에서 기기 시간대를 적어 둔다(대부분 집에서 앱을 처음 연다). 추측이 섞이는 지점이므로
// **숨기지 않는다** — 여행 편집 패널이 이 값을 글자로 보여주고 거기서 바꿀 수 있다.
// (숨은 추측은 M-0049의 형태였다. 추측 자체가 아니라 *말하지 않은 것*이 결함이었다.)
//
// 기억 데이터가 아니라 **표시 설정**이므로 Dexie가 아니라 localStorage다(`fxBase`와 같은 층).
// 기기마다 다를 수 있고 그게 맞다 — 집이 어디인지는 그 기기를 쓰는 상황의 사실이다.

import { deviceZone } from '../domain/time';

const KEY = 'bj.homeZone';

/** 집 시간대(IANA id). 저장된 값이 없으면 **지금 기기 시간대를 적어 두고** 그것을 쓴다. */
export function homeZone(): string {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return saved;
    const z = deviceZone();
    localStorage.setItem(KEY, z);
    return z;
  } catch {
    return deviceZone(); // 저장 자체가 막힌 브라우저 — 값은 여전히 답한다
  }
}

export function setHomeZone(zone: string): void {
  try {
    localStorage.setItem(KEY, zone);
  } catch {
    /* 저장 실패는 무시(표시 선호값) */
  }
}
