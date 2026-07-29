// ui/externalMapRow.ts — **바깥 지도 칩 줄**을 그리는 단 한 곳.
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 뽑았나 (2026-07-30 사용자 제안)
// ─────────────────────────────────────────────────────────────────────────────
// *"카카오 네이버 구글 좌표를 얻기 위한 링크를 칩 형태로 제공해주는게 어때요?"*
//
// 맞는 지적이었다. 장소 검색이 실패하면 화면이 *"네이버·카카오·구글 지도에서 찾은 좌표를
// 붙여넣어 보세요"*라고 **말만** 했다 — 앱이 검색어를 **이미 손에 쥐고 있으면서** 사용자에게
// *"다른 앱을 열고 그걸 다시 치세요"*를 시킨 것이다(§12가 묻는 바로 그 형태).
//
// 그런데 열기 로직(제공자별 동의 → `window.open` → caveat)은 `mapView.ts` 안에 **인라인으로**
// 있었다. 그대로 복사했으면 같은 규율이 두 곳에 손으로 구현되고, §7이 말하듯 **드리프트는
// 시간 문제**다 — 특히 여기 담긴 것이 *개인정보 동의*라 한쪽만 낡으면 조용히 새어 나간다.
// 그래서 **한 곳에만 구현하고 두 화면이 통과하게** 한다(§7 2층).
//
// ─────────────────────────────────────────────────────────────────────────────
// 이 부품이 지키는 계약 (전부 `domain/place/externalMap.ts`에서 옴)
// ─────────────────────────────────────────────────────────────────────────────
//  · **제공자마다 처음 한 번** 무엇이 어디로 나가는지 확인받는다. 거절하면 **열지 않는다.**
//    구글에 동의한 것이 얀덱스 동의는 아니다 — 받는 회사가 다르면 다른 결정이다.
//  · `noreferrer` — 앱 주소(여행 id가 든 URL)가 Referer로 함께 새지 않게.
//  · **좌표로 집은 것과 이름으로 찾은 것을 같은 문장으로 말하지 않는다**(`caveat`).
//  · 열 곳이 없으면 **아무것도 그리지 않는다**(빈 칩 줄을 만들지 않는다).

import { el } from './dom';
import { externalMapTargets, externalMapConsentText, type PlaceLike } from '../domain/place/externalMap';
import { hasAgreedExternalMap, rememberAgreedExternalMap } from '../services/externalMapConsent';

export interface ExternalMapRowOptions {
  /** 칩 줄 위에 붙는 한 줄. 자리마다 목적이 달라 **호출부가 정한다.** */
  lead: string;
  /** 바깥 컨테이너에 얹을 클래스(자리별 여백). 배치는 CSS가, 구조는 여기가 정한다. */
  className?: string;
}

/**
 * 바깥 지도 칩 줄. 열 곳이 없으면 `null`.
 *
 * @param place 좌표가 없어도 된다 — 이름만 있으면 **이름으로 찾는** 링크를 만든다
 *   (`precision: 'name'`). 그게 이 부품이 장소 검색 실패 자리에서 쓰이는 이유다.
 */
export function externalMapRow(place: PlaceLike, opts: ExternalMapRowOptions): HTMLElement | null {
  const targets = externalMapTargets(place);
  if (!targets.length) return null;

  const wrap = el('div', opts.className ? `map-ext ${opts.className}` : 'map-ext');
  wrap.appendChild(el('span', 'map-ext-lead muted small', opts.lead));

  const row = el('div', 'map-ext-row');
  for (const t of targets) {
    const btn = el('button', 'btn-ghost map-ext-btn', t.label) as HTMLButtonElement;
    btn.type = 'button';
    btn.setAttribute('aria-label', `${t.company} 지도에서 열기`);
    // 라이브 검사가 **어느 제공자인지 알고 누를 수 있게** 손잡이를 남긴다(§13 4항).
    btn.setAttribute('data-ext-map', t.id);
    btn.addEventListener('click', () => {
      if (!hasAgreedExternalMap(t.id)) {
        if (!window.confirm(externalMapConsentText(t))) return;
        rememberAgreedExternalMap(t.id);
      }
      // noopener는 noreferrer에 포함되지만 명시해 의도를 남긴다.
      window.open(t.url, '_blank', 'noopener,noreferrer');
    });
    row.appendChild(btn);
  }
  wrap.appendChild(row);

  // caveat는 제공자마다 같으므로(좌표가 없다는 사실은 하나다) **한 번만** 적는다.
  const caveat = targets.find((t) => t.caveat)?.caveat;
  if (caveat) {
    const note = el('p', 'map-ext-note muted small');
    note.textContent = caveat;
    wrap.appendChild(note);
  }
  return wrap;
}
