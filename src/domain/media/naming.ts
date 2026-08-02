// domain/media/naming.ts — **사람이 알아볼 수 있는 이름**의 단일 진실원.
//
// 왜 한 곳인가(§7): 같은 규칙이 두 곳에서 필요하다 — ZIP 백업 안의 폴더·파일명과 R2 객체 키.
// 예전엔 ZIP 쪽에만 있었고 R2는 UUID를 그대로 썼다. 두 번째 자리가 생기는 순간이 **손으로
// 두 번 구현할 것인가**를 정하는 순간이고, 이 저장소는 그 선택에서 세 번 드리프트를 겪었다.
// 그래서 규칙은 여기 하나뿐이고 두 쓰임새가 이걸 지난다.
//
// ── 사용자 요구(2026-07-27) ───────────────────────────────────────────
// *"서버내 폴더명은 여행제목명으로 하고 저장파일명도 '날짜_시간_여행제목_고유식별아이디'로
//   할 수 있어요? 사진 구별이 안되서"* — Cloudflare 콘솔에서 UUID만 보여 어느 사진인지
// 알 수 없었다. 앱이 자기 저장소를 사람이 읽을 수 있게 정리하지 않아 생긴 부담이다(§12).
//
// ── 왜 id를 **전부** 넣는가(줄이면 안 되는 이유) ──────────────────────
// 사용자는 "앞 5자리"를 원했지만 그럴 수 없다. **영구삭제하면 서버 행이 사라져 `storage_path`를
// 물어볼 곳이 없다.** 그때 남은 파일이 어느 사진이었는지 아는 방법은 **파일 이름뿐**이고,
// 그게 「영구삭제 후 남은 사진 파일」 정리가 서 있는 근거다(M-0029). 5자리로는 id를 복원할 수
// 없다 — 접두 일치로 추측해야 하는데, 대조할 행이 이미 없으므로 추측할 대상조차 없다.
// 그래서 하이픈만 뺀 32자를 **뒤에** 붙인다: 읽는 순서는 사람 것이 앞, 기계 것이 뒤.
//
// ── 왜 폴더에 여행 id 8자를 붙이는가 ──────────────────────────────────
//  · 제목이 같은 여행 둘이 **한 폴더에 섞이지 않는다.**
//  · **제목을 바꿔도 폴더가 갈라지지 않는다** — id는 안 변하므로 폴더도 안 변한다.
// 그래도 `제주여행__c9ff5188`은 목록에서 그냥 읽힌다. ZIP 백업이 이미 쓰던 규칙이다.

/** 객체 키·ZIP 경로에서 위험한 문자를 걷어낸다. 잘라내되 **빈 문자열은 만들지 않는다**(호출부가 대체어를 준다). */
export function fsSafe(s: string, max = 40): string {
  return (s || '')
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/\s+/g, '_')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, max)
    .trim();
}

/** id에서 하이픈을 뺀 소문자 hex. 32자(uuid) 또는 그보다 짧게 자른 접두. */
function hex(id: string, len = 32): string {
  return id.replace(/-/g, '').toLowerCase().slice(0, len);
}

/**
 * 바이트 객체를 **동기화 작업마다 새 키**로 격리한다(M-0087).
 *
 * DB의 OCC가 stale 행을 거절해도 R2 PUT은 되돌릴 수 없다. 같은 `storagePath`를 먼저 덮으면
 * 메타데이터는 최신인데 바이트만 옛 판인 분리 상태가 된다. 그래서 operation id를 파일명에
 * 넣되, Edge Function이 영구삭제 때 엔티티 id를 계속 읽을 수 있도록 **마지막 `__id32`는
 * 그대로 유지**한다. 재시도는 같은 op 키를 쓰므로 멱등이고, 다음 편집은 이전 op 토큰을
 * 교체하므로 이름이 끝없이 길어지지 않는다.
 */
export function operationStoragePath(currentPath: string, entityId: string, operationId: string): string {
  const entity = hex(entityId);
  const operation = hex(operationId);
  if (entity.length !== 32 || operation.length !== 32) {
    throw new Error('동기화 바이트 키에는 UUID 엔티티/작업 id가 필요합니다.');
  }

  const slash = currentPath.lastIndexOf('/');
  const folder = slash >= 0 ? currentPath.slice(0, slash + 1) : '';
  const file = slash >= 0 ? currentPath.slice(slash + 1) : currentPath;
  const dot = file.lastIndexOf('.');
  if (dot <= 0 || dot === file.length - 1) throw new Error('동기화 바이트 키에 확장자가 없습니다.');

  const stem = file.slice(0, dot);
  const ext = file.slice(dot);
  const currentSuffix = new RegExp(`(?:__op_[0-9a-f]{32})?__${entity}$`, 'i');
  const stableStem = currentSuffix.test(stem) ? stem.replace(currentSuffix, '') : stem;
  return `${folder}${stableStem}__op_${operation}__${entity}${ext}`;
}

/**
 * 여행 폴더명: `제주여행__c9ff5188`.
 *
 * **제목이 바뀌어도 이 값은 안 바뀐다** — 뒷자리가 id에서 오기 때문이다. 그래서 여행 이름을
 * 고쳐도 이미 올라간 사진이 흩어지지 않는다(R2에는 '이름 바꾸기'가 없어서, 흩어지면 복사·
 * 되읽기·삭제라는 최고 위험 연산으로만 되돌릴 수 있다 — `sync-offline-dev` §2-B).
 */
export function tripFolderName(title: string | null | undefined, tripId: string): string {
  const base = fsSafe(title || '', 60) || '여행';
  return `${base}__${hex(tripId, 8)}`;
}

/** ISO → { date:'YYYYMMDD', time:'HHMM' }. **사용자 로컬 시각** 기준(check-timezone 대상). 파싱 불가면 0으로. */
export function stampFromISO(iso: string | null | undefined): { date: string; time: string } {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return { date: '00000000', time: '0000' };
  const d = new Date(t);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return {
    date: `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`,
    time: `${p(d.getHours())}${p(d.getMinutes())}`,
  };
}

/**
 * **R2 객체 이름**(확장자 제외): `20260716_1432_제주여행__<하이픈 뺀 32자>`.
 *
 * 뒤 32자는 장식이 아니라 **계약**이다 — `mediaIdOfKey`(Edge Function)가 이걸 되읽어 어느
 * 사진인지 판정한다. 그 둘이 어긋나면 멀쩡한 사진이 「설명할 수 없는 파일」로 보이고, 앱은
 * 그걸 문제로 띄운다. 두 함수는 **다른 배포 단위**(브라우저 / Deno)에 살아서 손으로 맞출 수
 * 없으므로, `tests/unit/mediaNaming.test.ts`가 **왕복**으로 잠근다.
 */
export function mediaObjectName(
  takenAt: string | null | undefined,
  tripTitle: string | null | undefined,
  mediaId: string,
): string {
  const { date, time } = stampFromISO(takenAt);
  const t = fsSafe(tripTitle || '', 30) || '사진';
  return `${date}_${time}_${t}__${hex(mediaId)}`;
}

/**
 * 백업 ZIP 안의 사진 파일명(확장자·용도 제외): `날짜_시간_제목__id8`.
 *
 * R2 이름과 **일부러 다르다**: ZIP은 사람이 탐색기로 열어 보는 것이라 짧아야 하고, 복원은
 * `trip.json`의 경로로 되읽으므로 id 전체가 필요 없다. R2는 그 반대다(위 머리말 참조).
 * 서로 다른 이유를 여기 적어 두는 것이, 다음 사람이 "왜 안 통일했지?" 하고 통일하는 것을 막는다.
 */
export function photoFileBase(
  takenAt: string | null | undefined,
  title: string,
  mediaId: string,
): string {
  const { date, time } = stampFromISO(takenAt);
  const t = fsSafe(title, 30) || '사진';
  return `${date}_${time}_${t}__${hex(mediaId, 8)}`;
}

/**
 * **R2 오디오 객체 이름**(확장자 제외) — 사진(`mediaObjectName`)과 **같은 모양**이다.
 *
 * 왜 같아야 하나(§7 사용자 대면 대칭): 사용자는 Cloudflare 콘솔에서 두 종류를 **한 폴더 안에
 * 나란히** 본다. 여기서 규칙이 갈리면 "왜 소리만 이름이 다르지?"가 되고, 그건 이 파일이
 * 애초에 생긴 이유(UUID만 보여 무엇인지 몰랐던 문제)를 소리에서만 되풀이하는 것이다.
 *
 * 뒤 32자는 여기서도 **계약**이다 — `mediaIdOfKey`(Edge Function)가 이걸 되읽어 어느 소리인지
 * 판정한다. 사진과 똑같은 이유로 자르지 않는다(영구삭제하면 대조할 행이 사라진다 — M-0029).
 * 다른 것은 기본 이름(`소리`)과 확장자뿐이다.
 */
export function audioObjectName(
  recordedAt: string | null | undefined,
  tripTitle: string | null | undefined,
  audioId: string,
): string {
  const { date, time } = stampFromISO(recordedAt);
  const t = fsSafe(tripTitle || '', 30) || '소리';
  return `${date}_${time}_${t}__${hex(audioId)}`;
}

/**
 * 녹음 MIME → 파일 확장자. **Edge Function의 `AUDIO_EXTS`와 같은 목록이어야 한다** —
 * 앱이 `.webm`으로 올리는데 함수가 그 확장자를 거부하면 소리는 영영 서버에 못 간다.
 * `tests/unit/audioNaming.test.ts`가 그 목록을 대조한다.
 *
 * 모르는 형식은 `bin`이 아니라 **`webm`으로 떨어뜨리지 않는다** — 거짓 확장자를 붙이면
 * 재생기가 잘못된 디코더를 고른다. 대신 null을 돌려 **업로드하지 않는다**(로컬엔 그대로 남고
 * 진단이 「서버에 없는 소리」로 말한다 — 모르는 것을 아는 척하지 않는다, 비타협 원칙 #4).
 */
export const AUDIO_EXTS = ['webm', 'm4a', 'ogg', 'mp3', 'wav'] as const;

export function audioExt(mime: string): string | null {
  const m = (mime || '').toLowerCase();
  if (m.includes('webm')) return 'webm';
  // iOS Safari는 `audio/mp4`로 준다 — 파일 확장자는 `.m4a`가 관례다(재생기 호환이 가장 넓다).
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('ogg') || m.includes('opus')) return 'ogg';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('wav')) return 'wav';
  return null;
}

/**
 * 백업 ZIP 안의 **오디오 노트** 파일명(확장자 제외): `날짜_시간_제목__id8`.
 *
 * 사진(`photoFileBase`)과 **같은 모양**이다 — 사용자는 탐색기에서 두 종류를 나란히 본다.
 * 여기서 규칙이 갈리면 "왜 소리만 이름이 다르지?"가 되고, 그건 §7 「사용자 대면 대칭」 위반이다.
 *
 * ⚠️ 이 함수가 뒤늦게 생긴 이유(2026-07-27, 사용자 지적): 오디오를 붙이며 이름을 **손으로
 * 조립**했다 — `` `${stampFromISO(a.recordedAt)}_${a.id.slice(0,8)}` ``. `stampFromISO`는
 * **객체**를 돌려주는데 문자열처럼 썼고, 실제로 만들어진 이름은 **`[object Object]_a1b2c3d4`**였다.
 * 여행 제목도 빠졌다. 왕복 유닛은 같은 키로 넣고 꺼내니 **그 이름으로도 통과**했다(공허).
 * 이름 규칙은 이 파일 **한 곳**에서 온다 — 손으로 조립하지 마라(§1-D).
 */
export function audioFileBase(
  recordedAt: string | null | undefined,
  title: string,
  audioId: string,
): string {
  const { date, time } = stampFromISO(recordedAt);
  const t = fsSafe(title, 30) || '소리';
  return `${date}_${time}_${t}__${hex(audioId, 8)}`;
}
