// domain/place/photoHint.ts — **사진이 스스로 말하는 것**을 한 곳에서 읽는다(순수).
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 (사용자 제안 2026-07-30)
// ─────────────────────────────────────────────────────────────────────────────
// *"장소도 사진 입력하면 사진정보에서 우선 가져오도록 하면 어떨까요?"*
// *"여행시간대를 드롭다운해서 선택하게끔하고. 초기값은 사진찍은 장소로 셋팅..어때?"*
//
// 맞는 지적이었고, **부품이 이미 다 있었다.** `readPhotoMeta`는 GPS와 오프셋을 이미 읽고
// 있었고 지도 화면은 그 GPS로 마커를 찍고 있었다 — 그런데 **순간을 만드는 화면**은 그걸
// 안 쓰고 사용자에게 장소를 다시 치게 했다. §12가 묻는 그 형태다.
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 순수 함수로 뽑았나
// ─────────────────────────────────────────────────────────────────────────────
// 「여러 장 중 무엇을 고르나」가 규칙이고, 규칙은 화면 클로저 안에 있으면 검사할 수 없다
// (§10 ③ — M-0022가 그 자리였다). 그리고 이 규칙은 시각 추측(`guessOccurredAt`)과
// **같은 성질**이라 나란히 놓여야 다음 사람이 둘을 같은 눈으로 본다.

/** `readPhotoMeta`가 돌려주는 것 중 이 판단에 필요한 부분만. */
export interface PhotoMetaLike {
  /** EXIF 촬영시각(ISO). 없으면 `null` — **대표 사진을 고르는 기준**이다(아래 참조). */
  takenAt: string | null;
  gpsLat: number | null;
  gpsLng: number | null;
  tzOffsetMin: number | null;
  tzSource: 'exif' | 'trip' | 'device';
}

export interface PhotoHint {
  /** 첫 번째로 좌표를 가진 사진의 좌표. 없으면 `null`. */
  coord: { lat: number; lng: number } | null;
  /** 좌표를 가진 사진이 몇 장인가. 화면이 「3장 중 첫 장」을 말할 때 쓴다. */
  coordCount: number;
  /**
   * 🔴 **EXIF가 직접 말한** 오프셋(분)만. `tzSource === 'exif'`가 아니면 `null`이다.
   *
   * 왜 등급을 보나: `readPhotoMeta`는 오프셋이 없으면 여행 시간대나 **기기 시간대**로
   * 채워 준다(그래야 시각 추천이 죽지 않는다 — M-0049 수정 때 라이브 게이트가 잡았다).
   * 그런데 여기서 하려는 일은 *"이 사진이 어느 시간대에서 찍혔나"*를 **추론하는 것**이라,
   * 기기 시간대로 채워진 값을 근거로 쓰면 **자기가 채운 값을 근거로 자기를 확신하는** 꼴이 된다.
   */
  exifOffsetMin: number | null;
}

/**
 * 고른 사진들에서 **위치·시간대 힌트**를 뽑는다.
 *
 * 🔴 여러 장이면 **가장 이른 촬영시각**의 사진을 쓴다(사용자 지적 2026-07-31:
 * *"사진여러장이면 가장 앞 시간 사진을 기준으로"*).
 *
 * 처음엔 「고른 순서의 첫 장」이었다. 그런데 **시각은 이미 「가장 이른 것」을 쓰고 있었다**
 * (`guessOccurredAt` — 순간의 *시작*이 그 순간이므로). 두 기준이 다르면 **시각과 장소가
 * 서로 다른 사진을 가리킨다** — 3장을 역순으로 골랐으면 「09:30에 여기 있었다」가 되는데
 * 09:30 사진은 다른 곳에서 찍힌 것이다. 사용자에게는 그 어긋남이 보이지 않고, 그래서 더 나쁘다
 * (§7 사용자 대면 대칭 — 같은 성격의 값은 같은 자로 재야 한다).
 *
 * 촬영시각이 **없는** 사진만 있으면 고른 순서를 쓴다 — 정렬 기준이 없을 때의 유일하게
 * 설명 가능한 규칙이다. 평균 좌표는 **실제로 아무도 서 있지 않은 지점**이라 쓰지 않는다.
 */
export function photoHintOf(metas: readonly PhotoMetaLike[]): PhotoHint {
  const located = metas.filter(
    (m) => m.gpsLat !== null && m.gpsLng !== null && Number.isFinite(m.gpsLat) && Number.isFinite(m.gpsLng),
  );
  // 시각을 아는 것들 중 가장 이른 것 → 없으면 고른 순서의 첫 장.
  // 못 읽는 시각(`Date.parse` NaN)은 **정렬에 끼우지 않는다** — 지어낸 순서를 만들지 않는다.
  const timed = located
    .map((m) => ({ m, t: m.takenAt ? Date.parse(m.takenAt) : Number.NaN }))
    .filter((x) => !Number.isNaN(x.t))
    .sort((a, b) => a.t - b.t);
  const first = timed[0]?.m ?? located[0];
  const exif = metas.find((m) => m.tzSource === 'exif' && m.tzOffsetMin !== null);
  return {
    coord: first ? { lat: first.gpsLat as number, lng: first.gpsLng as number } : null,
    coordCount: located.length,
    exifOffsetMin: exif?.tzOffsetMin ?? null,
  };
}

/**
 * 「사진 위치에서 가져왔다」는 근거 한 줄. **좌표가 없으면 빈 문자열**(§8 침묵이 정상).
 *
 * 시각 쪽(`guessOccurredAt`의 `label`)과 **같은 어휘**를 쓴다 — 같은 성격의 추측이 화면에서
 * 다른 말투로 나오면 사용자는 둘을 다른 것으로 읽는다(§7 사용자 대면 대칭).
 */
export function photoPlaceLabel(hint: PhotoHint): string {
  if (!hint.coord) return '';
  const many = hint.coordCount > 1 ? ` (${hint.coordCount}장 중 가장 이른 사진)` : '';
  return `📷 사진 위치에서 · ${hint.coord.lat.toFixed(5)}, ${hint.coord.lng.toFixed(5)}${many}`;
}
