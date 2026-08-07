// ui/screens/placeRegistry.ts — 「위치관리대장」 패널(데이터 관리 안).
//
// 사용자 요청(2026-08-05): *"데이터 관리 내 '위치관리대장' 버튼을 만들고 나서 한 번 등록된
// 장소는 자동으로 위치관리대장에 등재하도록"*.
//
// 🔴 **등재는 이미 되고 있었다.** `savePlace()`가 장소를 만들 때마다 `localPlaces`에 넣는다 —
//    없었던 것은 **그걸 보여주고 고치는 화면**뿐이다. 그래서 이 파일은 새 저장소가 아니라
//    이미 쌓인 것을 꺼내는 창이고, 스키마 변경이 0이다.
//
// 판정·검색·좌표 미리보기는 전부 `domain/place/registry.ts`(순수 함수)가 한다 —
// 화면에 나가는 것 자체가 결함일 수 있어서다(§10 ③).

import { el, setNote } from '../dom';
import { listPlaces, updatePlace, fillAddressFromCoords, allPlaceRecordMoments, mediaForPlaceRecordMoments } from '../../services/places';
import { readHere } from '../../services/here';
import { hereFailMessage, hereLabel } from '../../domain/place/here';
import { orderPair } from '../../domain/place/coordInput';
import { openMapPicker } from '../lazyScreens';
import {
  searchRegistry,
  sortRegistry,
  shortAddress,
  coordPreview,
  needsAddress,
  type RegistryPlace,
  placeRecordGroups,
  type PlaceRecordMoment,
} from '../../domain/place/registry';

type GoToTrip = (tripId: string, target?: { momentId?: string; mediaId?: string }) => void;

/** `LocalPlace` → 대장이 아는 최소 모양. 화면은 이 형태만 안다. */
function toRegistry(p: {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  country: string | null;
  city: string | null;
  formattedAddress: string | null;
  provider: string | null;
  deletedAt: string | null;
}): RegistryPlace {
  return {
    id: p.id,
    name: p.name,
    latitude: p.latitude,
    longitude: p.longitude,
    country: p.country,
    city: p.city,
    formattedAddress: p.formattedAddress,
    provider: p.provider,
    deletedAt: p.deletedAt,
  };
}

/**
 * 좌표 편집 한 줄 — 지금 좌표와 **뒤집은 좌표를 나란히** 보여준다(사용자 결정 2026-08-05).
 *
 * 저장은 한 벌이고 보기가 두 벌이다. 두 벌을 저장하면 어느 쪽이 정본인지 앱이 모르게 되고,
 * 그러면 지도·통계가 조용히 한쪽을 고른다 — M-0057이 그 형태였다(기억이 기니만 앞바다에 찍힘).
 */
function coordEditor(p: RegistryPlace, onSaved: () => void, note: HTMLElement): HTMLElement {
  const box = el('div', 'pr-coord');
  const input = el('input', 'pr-coord-input') as HTMLInputElement;
  input.type = 'text';
  input.value = `${p.latitude}, ${p.longitude}`;
  input.setAttribute('aria-label', `${p.name} 좌표`);
  input.placeholder = '위도, 경도';

  const preview = el('div', 'pr-preview');
  const paint = (): void => {
    preview.replaceChildren();
    const parsed = orderPair(...parseTwo(input.value));
    if (!parsed) {
      // 🔴 억지로 만들지 않는다 — 못 읽었으면 못 읽었다고 말한다(§8).
      preview.appendChild(el('p', 'pr-preview-bad', '좌표를 읽지 못했어요. 「위도, 경도」 형식으로 적어 주세요.'));
      return;
    }
    const v = coordPreview(parsed.lat, parsed.lng);
    preview.appendChild(el('p', 'pr-preview-now', `지금 이것 → ${v.current.label}`));
    if (v.ambiguous) {
      // 둘 다 말이 되는 좌표라 **물리 제약으로는 못 가른다** — 그 사실을 밝히고 고를 수단을 준다.
      const row = el('div', 'pr-preview-swap');
      row.appendChild(el('span', undefined, `뒤집으면 → ${v.swapped.label}`));
      const swapBtn = el('button', 'btn-ghost', '↔ 이걸로 바꾸기') as HTMLButtonElement;
      swapBtn.type = 'button';
      swapBtn.addEventListener('click', () => {
        input.value = `${v.swapped.lat}, ${v.swapped.lng}`;
        paint();
      });
      row.appendChild(swapBtn);
      preview.appendChild(row);
      preview.appendChild(
        el('p', 'pr-preview-why', '두 숫자가 모두 위도로 가능해서 순서를 확신할 수 없어요. 저장하면 주소를 받아 어느 쪽이 맞는지 보여드릴게요.'),
      );
    }
  };
  input.addEventListener('input', paint);
  paint();

  const actions = el('div', 'pr-actions');

  const mapBtn = el('button', 'btn-ghost', '🗺 지도에서 수정') as HTMLButtonElement;
  mapBtn.type = 'button';
  mapBtn.addEventListener('click', () => {
    mapBtn.disabled = true;
    void openMapPicker({ lat: p.latitude, lng: p.longitude }).then((picked) => {
      if (!picked) return;
      input.value = `${picked.lat}, ${picked.lng}`;
      paint();
      setNote(note, '지도에서 고른 좌표예요. [저장]을 누르면 확정됩니다.', 'info', null);
    }).finally(() => { mapBtn.disabled = false; });
  });

  // [지금 여기] — 사용자 요청 ③. 기존 `readHere()`를 그대로 쓴다(§7 — 두 번째 구현을 만들지 않는다).
  const hereBtn = el('button', 'btn-ghost', '📍 지금 여기') as HTMLButtonElement;
  hereBtn.type = 'button';
  hereBtn.addEventListener('click', () => {
    hereBtn.disabled = true;
    setNote(note, '위치를 읽는 중…', 'info', null);
    void (async () => {
      // 🔴 `readHere()`는 **throw하지 않고 값으로** 실패를 준다 — 그 계약을 그대로 따른다.
      //    try/catch로 감싸면 `fail`을 안 읽게 되고, 그러면 사유가 조용히 사라진다(§13 4항 ③).
      const r = await readHere();
      if (r.coord) {
        input.value = `${r.coord.lat}, ${r.coord.lng}`;
        paint();
        setNote(note, hereLabel(r.coord, r.accuracyM), 'ok', null);
      } else {
        setNote(note, hereFailMessage(r.fail ?? 'unavailable'), 'error', null);
      }
      hereBtn.disabled = false;
    })();
  });

  const saveBtn = el('button', 'btn-primary', '저장') as HTMLButtonElement;
  saveBtn.type = 'button';
  saveBtn.addEventListener('click', () => {
    const parsed = orderPair(...parseTwo(input.value));
    if (!parsed) {
      setNote(note, '좌표를 읽지 못해 저장하지 않았어요.', 'error', null);
      return;
    }
    saveBtn.disabled = true;
    setNote(note, '저장하는 중…', 'info', null);
    void (async () => {
      try {
        // 사용자가 손으로 확정한 좌표다 — 지오코더 좌표보다 강한 진실(mapPicked와 같은 뜻).
        await updatePlace(p.id, { latitude: parsed.lat, longitude: parsed.lng, mapPicked: true });
        // 좌표가 바뀌었으니 주소도 다시 받는다(사용자 결정 — 자동). 실패해도 저장은 유지된다.
        const filled = await fillAddressFromCoords(p.id);
        setNote(note, filled ? '저장하고 주소도 새로 받았어요.' : '저장했어요. 주소는 받지 못했어요.', 'ok', null);
        onSaved();
      } catch (err) {
        setNote(note, `저장 실패: ${err instanceof Error ? err.message : String(err)}`, 'error', null);
      } finally {
        saveBtn.disabled = false;
      }
    })();
  });

  actions.append(mapBtn, hereBtn, saveBtn);
  box.append(input, preview, actions);
  return box;
}

/** `"41.3, 69.2"` → `[41.3, 69.2]`. 못 읽으면 NaN 쌍(orderPair가 null을 준다). */
function parseTwo(v: string): [number, number] {
  const m = v.split(/[,\s]+/).filter(Boolean);
  return [Number(m[0]), Number(m[1])];
}

/** 대장 한 줄. */
function registryRow(p: RegistryPlace, moments: PlaceRecordMoment[], onChanged: () => void, goToTrip: GoToTrip): HTMLElement {
  const row = el('div', 'pr-row');
  const summary = el('div', 'pr-sum');
  const openRecords = el('button', 'pr-record-open') as HTMLButtonElement;
  openRecords.type = 'button';
  openRecords.setAttribute('aria-label', `${p.name} 기록 보기`);
  openRecords.append(el('b', 'pr-name', p.name));
  const addr = shortAddress(p);
  // 🔴 주소가 없으면 「없음」이라 적지 않고 **왜 없는지**를 말한다 — 아직 안 받은 것이지
  //    그 자리에 주소가 없는 것이 아니다(§8 — 모르는 걸 아는 척하지 않는다).
  openRecords.append(el('span', 'pr-addr muted small', addr ?? (needsAddress(p) ? '주소 아직 못 받음' : '')));
  openRecords.append(el('span', 'pr-coord-label muted small', `${p.latitude.toFixed(4)}, ${p.longitude.toFixed(4)}`));
  const editOpen = el('button', 'btn-ghost pr-edit-open', '편집') as HTMLButtonElement;
  editOpen.type = 'button';
  editOpen.setAttribute('aria-label', `${p.name} 이름과 좌표 편집`);
  summary.append(openRecords, editOpen);
  row.appendChild(summary);

  const body = el('div', 'pr-body');
  const note = el('p', 'sync-note');
  note.setAttribute('role', 'status');
  note.hidden = true;

  const nameRow = el('div', 'pr-namerow');
  const nameInput = el('input', 'pr-name-input') as HTMLInputElement;
  nameInput.type = 'text';
  nameInput.value = p.name;
  nameInput.maxLength = 120;
  nameInput.setAttribute('aria-label', '장소 이름');
  const renameBtn = el('button', 'btn-ghost', '이름 저장') as HTMLButtonElement;
  renameBtn.type = 'button';
  renameBtn.addEventListener('click', () => {
    const next = nameInput.value.trim();
    if (!next) {
      setNote(note, '이름이 비었어요.', 'error', null);
      return;
    }
    renameBtn.disabled = true;
    void (async () => {
      try {
        await updatePlace(p.id, { name: next });
        setNote(note, '이름을 바꿨어요.', 'ok', null);
        onChanged();
      } catch (e) {
        setNote(note, `실패: ${e instanceof Error ? e.message : String(e)}`, 'error', null);
      } finally {
        renameBtn.disabled = false;
      }
    })();
  });
  nameRow.append(nameInput, renameBtn);

  const addrBtn = el('button', 'btn-ghost', '🌐 주소 다시 받기') as HTMLButtonElement;
  addrBtn.type = 'button';
  addrBtn.addEventListener('click', () => {
    addrBtn.disabled = true;
    setNote(note, '주소를 받는 중…', 'info', null);
    void (async () => {
      const ok = await fillAddressFromCoords(p.id);
      setNote(note, ok ? '주소를 받았어요.' : '주소를 받지 못했어요(그 자리에 주소가 없거나 연결이 끊겼어요).', ok ? 'ok' : 'info', null);
      addrBtn.disabled = false;
      if (ok) onChanged();
    })();
  });

  body.append(nameRow, coordEditor(p, onChanged, note), addrBtn, note);
  if (p.formattedAddress) {
    body.appendChild(el('p', 'pr-full muted small', p.formattedAddress));
  }
  body.hidden = true;
  editOpen.addEventListener('click', () => {
    body.hidden = !body.hidden;
    if (!body.hidden) nameInput.focus();
  });
  openRecords.addEventListener('click', () => openPlaceRecords(p, moments, goToTrip));
  row.appendChild(body);
  return row;
}


/**
 * 「이 장소를 쓰는 순간들」 — 고치기 전에 **어디에 영향이 가나**를 본다(사용자 결정 2026-08-05).
 *
 * 🔴 확실한 것(링크)과 짐작(이름만 같음)을 **나눠 보여준다.** 한 숫자로 합치면 그 숫자가
 * 거짓이 된다 — 「집」이라 적은 곳이 서울 집일 수도 타슈켄트 집일 수도 있다(§8).
 */
/** 장소 행은 길게 유지하고, 기록은 별도 모달에서만 보여 준다. */
function openPlaceRecords(place: RegistryPlace, moments: PlaceRecordMoment[], goToTrip: GoToTrip): void {
  const groups = placeRecordGroups(moments, place);
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = el('div', 'overlay-base pr-records-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '이 장소가 담긴 기록');
  const modal = el('div', 'modal-base pr-records-modal');
  const close = el('button', 'guide-close', '✕') as HTMLButtonElement;
  close.type = 'button'; close.setAttribute('aria-label', '이 장소가 담긴 기록 닫기');
  const header = el('div', 'guide-header');
  header.append(el('div', 'guide-title-wrap'), close);
  const titleWrap = header.firstElementChild!;
  titleWrap.append(el('h2', 'guide-title', '이 장소가 담긴 기록'), el('p', 'guide-sub', place.name));
  const body = el('div', 'guide-body pr-records-body');
  const urls: string[] = [];
  let dismissed = false;
  const release = (): void => { for (const url of urls) URL.revokeObjectURL(url); urls.length = 0; };
  const dismiss = (): void => {
    if (dismissed) return;
    dismissed = true;
    release(); overlay.remove(); document.removeEventListener('keydown', onKey, true);
    if (previousFocus && document.contains(previousFocus)) previousFocus.focus();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation(); // 아래 데이터 관리 창까지 한 번에 닫히지 않게 이 최상단 모달만 소비한다.
    dismiss();
  };
  close.addEventListener('click', dismiss);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) dismiss(); });
  document.addEventListener('keydown', onKey, true);

  type RecordMedia = { id: string; thumbBlob: Blob };
  const render = (mediaByMoment: Map<string, RecordMedia[]> | null): void => {
    // 사용자가 로딩 중 닫았으면 늦게 도착한 Blob으로 분리된 DOM과 object URL을 만들지 않는다.
    if (dismissed) return;
    release(); body.replaceChildren();
    const addSection = (heading: string, note: string, list: ReturnType<typeof placeRecordGroups>['linked']): void => {
    if (!list.length) return;
    const section = el('section', 'pr-record-section');
    section.append(el('h3', 'pr-record-heading', heading), el('p', 'pr-record-note', note));
    for (const group of list) {
      const trip = el('section', 'pr-record-trip');
      trip.appendChild(el('h4', 'pr-record-trip-title', group.tripTitle || '(제목 없는 여행)'));
      for (const moment of group.moments) {
        const card = el('article', 'pr-record-moment');
        const media = mediaByMoment?.get(moment.id) ?? [];
        if (media.length) {
          const photos = el('div', 'pr-record-photos');
          for (const item of media) {
            const photo = el('button', 'pr-record-photo') as HTMLButtonElement;
            photo.type = 'button'; photo.dataset.mediaId = item.id;
            photo.setAttribute('aria-label', `${moment.title || '제목 없는 순간'} 사진 보기`);
            const img = el('img', 'pr-record-thumb') as HTMLImageElement;
            const url = URL.createObjectURL(item.thumbBlob); urls.push(url);
            img.src = url; img.alt = ''; img.loading = 'lazy'; photo.appendChild(img);
            photo.addEventListener('click', () => { dismiss(); goToTrip(group.tripId, { momentId: moment.id, mediaId: item.id }); });
            photos.appendChild(photo);
          }
          card.appendChild(photos);
        }
        const details = el('div', 'pr-record-details');
        const jump = el('button', 'pr-record-moment-title', moment.title || '(제목 없는 순간)') as HTMLButtonElement;
        jump.type = 'button';
        jump.addEventListener('click', () => { dismiss(); goToTrip(group.tripId, { momentId: moment.id }); });
        details.append(jump, el('span', 'pr-record-media-count muted small', mediaByMoment ? `사진 ${media.length}장` : '사진 확인 불가'));
        if (!media.length) details.appendChild(el('button', 'btn-ghost pr-record-jump', '순간으로 이동'));
        const fallback = details.lastElementChild;
        if (fallback instanceof HTMLButtonElement && fallback.classList.contains('pr-record-jump')) {
          fallback.addEventListener('click', () => { dismiss(); goToTrip(group.tripId, { momentId: moment.id }); });
        }
        card.appendChild(details); trip.appendChild(card);
      }
      section.appendChild(trip);
    }
    body.appendChild(section);
    };
    addSection('직접 연결된 순간', '이 장소 ID로 연결된 확실한 기록입니다.', groups.linked);
    addSection('이름만 같은 순간', '장소 ID 연결은 없고 이름만 같아요. 같은 장소인지 확인해 주세요.', groups.sameName);
    if (!groups.linked.length && !groups.sameName.length) body.appendChild(el('p', 'guide-note', '아직 이 장소가 담긴 순간이 없어요.'));
  };
  body.appendChild(el('p', 'guide-note', '사진을 불러오는 중…'));
  modal.append(header, body); overlay.appendChild(modal); document.body.appendChild(overlay); close.focus();
  const ids = [...groups.linked, ...groups.sameName].flatMap((group) => group.moments.map((moment) => moment.id));
  void mediaForPlaceRecordMoments(ids).then(render).catch(() => render(null));
}

/**
 * 위치관리대장 패널.
 *
 * 사진에 위치가 없거나 고치고 싶을 때 여기서 장소를 찾아 좌표를 확인·수정한다.
 * 🔴 여기서 고치는 것은 **대장 항목뿐**이고 과거 순간의 기록은 바뀌지 않는다
 * (`updatePlace`의 계약 — 사용자가 쓴 것을 앱이 조용히 고쳐 쓰지 않는다).
 */
export function placeRegistryPanel(onChanged: () => void, goToTrip: GoToTrip): HTMLElement {
  const box = el('div', 'guide-detail-body');
  box.append(
    el('p', 'guide-p', '한 번 등록한 장소가 모두 여기 모입니다. 사진에 위치가 없거나 고치고 싶을 때 여기서 찾아 쓰세요.'),
  );

  const search = el('input', 'pr-search') as HTMLInputElement;
  search.type = 'search';
  search.placeholder = '이름·도시·국가로 찾기 (한 글자도 됩니다)';
  search.setAttribute('aria-label', '장소 찾기');
  box.appendChild(search);

  const count = el('p', 'pr-count muted small');
  box.appendChild(count);
  const list = el('div', 'pr-list');
  box.appendChild(list);

  let all: RegistryPlace[] = [];
  let moments: PlaceRecordMoment[] = [];

  const paint = (): void => {
    const found = sortRegistry(searchRegistry(all, search.value));
    list.replaceChildren();
    // 총 개수와 찾은 개수를 **함께** 말한다 — 「3개」만 보면 전체가 3개인 줄 안다(§7-C 한정 생략).
    count.textContent = search.value.trim()
      ? `${found.length}개 찾음 (전체 ${all.filter((p) => p.deletedAt === null).length}개)`
      : `전체 ${found.length}개`;
    if (!found.length) {
      list.appendChild(
        el('p', 'guide-note', all.length ? '찾는 장소가 없어요. 다른 글자로 찾아보세요.' : '아직 등록된 장소가 없어요. 순간에 장소를 붙이면 여기 모입니다.'),
      );
      return;
    }
    for (const p of found) list.appendChild(registryRow(p, moments, reload, goToTrip));
  };

  function reload(): void {
    void (async () => {
      const [places, ms] = await Promise.all([listPlaces(), allPlaceRecordMoments()]);
      all = places.map(toRegistry);
      moments = ms;
      paint();
      onChanged();
    })();
  }

  search.addEventListener('input', paint);
  reload();
  box.appendChild(
    el(
      'p',
      'guide-note',
      '좌표를 저장하면 국가·도시를 자동으로 받아 옵니다 — 이때 좌표가 지도 서비스로 나갑니다(이름·메모·사진은 나가지 않아요). 여기서 고친 내용은 대장에만 반영되고, 이미 기록한 순간의 위치는 그대로 남습니다.',
    ),
  );
  return box;
}
