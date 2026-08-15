// ui/screens/companionRecords.ts — 「이 사람과 함께한 기록」 창(사용자 지시 2026-08-15).
//
// 🔴 **왜 이 화면이 있어야 하는가 — §7이 이미 요구하고 있었다.**
// 장소 배지를 누르면 「이 장소가 담긴 기록」이 열려 그 장소의 순간·사진이 다 나온다
// (`placeRegistry.ts`의 `openPlaceRecords`). **동행인만 그 대칭을 못 받고 있었다.**
// 사용자가 요청하기 전부터 이건 「아직 안 한 것」이 아니라 **차별한 것**이었다 —
// *"형제끼리 차별하면 엇나가잖아요. 현실세계에서도."*(사용자 2026-07-27)
//
// 🔴 **왜 `openPlaceRecords`를 일반화하지 않았나 — 정직하게 적는다.**
// 그쪽은 「직접 연결 / 이름만 같음」이라는 **장소 고유의 두 갈래**를 판정하고 삭제 경로까지
// 들고 있다. 사람에는 그 갈래가 없다(연결 id가 아예 없다 — 아래 「정직한 한계」). 억지로
// 합치면 두 화면 모두 자기 것이 아닌 분기를 이고 가게 된다. **대신 겹치는 것은 CSS 클래스**
// (`pr-record-*`)를 그대로 쓴다 — 사용자에게 같은 성격의 화면은 **같은 자리에 같은 어휘**로
// 보여야 하기 때문이다(§7 사용자 대면 대칭).
//
// 🔴 **정직한 한계 — 사람의 동일성은 「적은 글자」로만 판정된다.**
// 인물 원장이 없으므로(ADR-0074) 「러원이」와 「러원」은 기계에겐 남남이다. 이 화면은 그것을
// **숨기지 않고 화면에 적는다** — 모르는 것을 아는 척하지 않는다(§8).

import { db, type LocalMedia, type LocalMoment, type LocalTrip } from '../../offline/db';
import { momentHasCompanion, parseCompanions } from '../../domain/moment/companions';
// 🔴 시각 비교는 **문자열 대소가 아니라 순간으로** 한다(M-0034). 형제(`timeline.ts`)가 이미
//    그 규율을 쓰는데 이 새 화면만 `localeCompare`로 태어났고, `check-instant-normalization`이
//    잡았다 — §7의 최빈형이 또 나왔고 이번엔 **기계가 먼저** 잡았다.
import { compareInstants } from '../../domain/time';
import { el } from '../dom';

export interface CompanionRecordsOptions {
  /** 사진을 누르면 그 순간(그리고 그 사진)으로 데려간다. */
  goToTrip: (tripId: string, target?: { momentId?: string; mediaId?: string }) => void;
}

interface TripBucket {
  tripId: string;
  tripTitle: string;
  moments: LocalMoment[];
}

/** 여행별로 묶는다. **순수 함수** — 화면을 모른다(§10 ③, 유닛으로 잰다). */
export function companionBuckets(
  moments: readonly LocalMoment[],
  trips: readonly LocalTrip[],
  person: string,
): TripBucket[] {
  const titleById = new Map(trips.map((t) => [t.id, t.title]));
  const byTrip = new Map<string, LocalMoment[]>();
  for (const m of moments) {
    if (m.deletedAt !== null) continue;
    if (!momentHasCompanion(m.companionNames, person)) continue;
    const arr = byTrip.get(m.tripId);
    if (arr) arr.push(m);
    else byTrip.set(m.tripId, [m]);
  }
  return [...byTrip.entries()]
    .map(([tripId, list]) => ({
      tripId,
      tripTitle: titleById.get(tripId) ?? '(제목 없는 여행)',
      // 여행 안에서는 시간순 — 이 창은 **회고**이므로 이야기 순서로 읽는다.
      moments: list.slice().sort((a, b) => compareInstants(a.occurredAt || a.createdAt, b.occurredAt || b.createdAt) ?? 0),
    }))
    // 최근 여행이 위로 — 「누구와 최근에 뭘 했나」가 먼저 궁금한 것이다.
    .sort((a, b) => compareInstants(b.moments[0]?.occurredAt ?? '', a.moments[0]?.occurredAt ?? '') ?? 0);
}

/**
 * 표기가 흔들린 이름이 **같은 사람일 수 있다**는 사실을 사용자에게 알릴 문장.
 * 🔴 **단정하지 않는다**(§8 · M-0056): 「같은 사람입니다」가 아니라 **「같은 사람이라면」**이다.
 * 앱은 그걸 모른다 — 아는 것은 *비슷한 이름이 따로 적혀 있다*는 사실뿐이다.
 */
export function similarNameNote(person: string, allNames: readonly string[]): string | null {
  const target = person.trim();
  const others = allNames.filter((n) => {
    const o = n.trim();
    if (o === target) return false;
    return o.startsWith(target) || target.startsWith(o);
  });
  if (!others.length) return null;
  return `이름이 비슷한 기록이 따로 있어요: ${others.join(' · ')}. 같은 사람이라면 이름을 똑같이 맞춰 주시면 한 곳에 모입니다.`;
}


/**
 * 순간 한 장 — 사진 줄 + 제목. 🔴 **`openCompanionRecords`에서 뽑았다**: 길이 래칫
 * (`check-fn-size`)이 걸렸고, 우회하는 대신 덜어냈더니 창의 뼈대와 카드 그리기가 갈렸다.
 * 게이트가 설계를 밀어준 자리다(§11 마지막 문단).
 *
 * 🔴 `mediaByMoment`가 `null`이면 **「0장」이 아니라 「확인 불가」**라고 적는다(§8).
 */
function momentCard(
  moment: LocalMoment,
  tripId: string,
  mediaByMoment: Map<string, LocalMedia[]> | null,
  urls: string[],
  dismiss: () => void,
  opts: CompanionRecordsOptions,
): HTMLElement {
  const card = el('article', 'pr-record-moment');
  const media = mediaByMoment?.get(moment.id) ?? [];
  if (media.length) {
    const photos = el('div', 'pr-record-photos');
    for (const item of media) {
      const thumb = item.thumbBlob;
      if (!thumb) continue;
      const photo = el('button', 'pr-record-photo') as HTMLButtonElement;
      photo.type = 'button';
      photo.dataset['mediaId'] = item.id;
      photo.setAttribute('aria-label', `${moment.title || '제목 없는 순간'} 사진 보기`);
      const img = el('img', 'pr-record-thumb') as HTMLImageElement;
      const url = URL.createObjectURL(thumb);
      urls.push(url);
      img.src = url;
      img.alt = '';
      img.loading = 'lazy';
      photo.appendChild(img);
      photo.addEventListener('click', () => { dismiss(); opts.goToTrip(tripId, { momentId: moment.id, mediaId: item.id }); });
      photos.appendChild(photo);
    }
    card.appendChild(photos);
  }
  const details = el('div', 'pr-record-details');
  const jump = el('button', 'pr-record-moment-title', moment.title || '(제목 없는 순간)') as HTMLButtonElement;
  jump.type = 'button';
  jump.addEventListener('click', () => { dismiss(); opts.goToTrip(tripId, { momentId: moment.id }); });
  details.append(
    jump,
    el('span', 'pr-record-media-count muted small', mediaByMoment ? `사진 ${media.length}장` : '사진 확인 불가'),
  );
  card.appendChild(details);
  return card;
}

export async function openCompanionRecords(person: string, opts: CompanionRecordsOptions): Promise<void> {
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = el('div', 'overlay-base pr-records-overlay companion-records-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '이 사람과 함께한 기록');
  const modal = el('div', 'modal-base pr-records-modal');
  const close = el('button', 'guide-close', '✕') as HTMLButtonElement;
  close.type = 'button';
  close.setAttribute('aria-label', '이 사람과 함께한 기록 닫기');
  const header = el('div', 'guide-header');
  const titleWrap = el('div', 'guide-title-wrap');
  titleWrap.append(el('h2', 'guide-title', '이 사람과 함께한 기록'), el('p', 'guide-sub', `👥 ${person}`));
  header.append(titleWrap, close);
  const body = el('div', 'guide-body pr-records-body');
  modal.append(header, body);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const urls: string[] = [];
  let dismissed = false;
  const release = (): void => { for (const u of urls) URL.revokeObjectURL(u); urls.length = 0; };
  const dismiss = (): void => {
    if (dismissed) return;
    dismissed = true;
    release();
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    if (previousFocus && document.contains(previousFocus)) previousFocus.focus();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    // 이 창만 소비한다 — 아래 화면까지 한 번에 닫히지 않게(장소 기록 창이 쓰는 규율 그대로).
    event.stopImmediatePropagation();
    dismiss();
  };
  close.addEventListener('click', dismiss);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) dismiss(); });
  document.addEventListener('keydown', onKey, true);

  body.appendChild(el('p', 'muted', '기록을 불러오는 중이에요…'));

  const d = db();
  const [moments, trips] = await Promise.all([d.localMoments.toArray(), d.localTrips.toArray()]);
  if (dismissed) return; // 늦게 도착한 자료로 분리된 DOM을 만들지 않는다
  const buckets = companionBuckets(moments, trips, person);
  const total = buckets.reduce((n, b) => n + b.moments.length, 0);

  // 사진은 순간별로 모아 한 번에 읽는다.
  const momentIds = buckets.flatMap((b) => b.moments.map((m) => m.id));
  let mediaByMoment: Map<string, LocalMedia[]> | null = null;
  try {
    const media = await d.localMedia.where('momentId').anyOf(momentIds).toArray();
    const map = new Map<string, LocalMedia[]>();
    for (const item of media) {
      if (item.deletedAt !== null) continue;
      const arr = map.get(item.momentId);
      if (arr) arr.push(item);
      else map.set(item.momentId, [item]);
    }
    mediaByMoment = map;
  } catch {
    // 🔴 못 읽었으면 **0장이라고 말하지 않는다** — 「없다」와 「못 봤다」는 다른 말이다(§8).
    mediaByMoment = null;
  }
  if (dismissed) return;

  body.replaceChildren();
  body.appendChild(el('p', 'pr-record-note', total
    ? `함께한 순간 ${total}개 · 여행 ${buckets.length}개`
    : '아직 이 사람과 함께한 기록이 없어요.'));

  const allNames: string[] = [...new Set(moments.flatMap((m: LocalMoment) => parseCompanions(m.companionNames)))];
  const note = similarNameNote(person, allNames);
  if (note) body.appendChild(el('p', 'pr-record-note companion-similar-note', note));

  for (const bucket of buckets) {
    const section = el('section', 'pr-record-trip');
    section.appendChild(el('h4', 'pr-record-trip-title', bucket.tripTitle));
    for (const moment of bucket.moments) {
      section.appendChild(momentCard(moment, bucket.tripId, mediaByMoment, urls, dismiss, opts));
    }
    body.appendChild(section);
  }

  close.focus();
}
