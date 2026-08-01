// services/nativePhotos.ts — **셸 안에서만 열리는 문**: 위치가 살아 있는 원본으로 사진 고르기.
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 (ADR-0036 · 2026-08-01)
// ─────────────────────────────────────────────────────────────────────────────
// 안드로이드 10+는 사진을 앱에 넘길 때 EXIF 위치를 지운다(ACCESS_MEDIA_LOCATION 없으면).
// 크롬은 그 권한을 요청하지 않으므로 **PWA는 원리적으로 못 뚫는다** — 실측 3종으로 확정됐다
// (갤러리·파일 선택기 0/0 · ZIP만 생존 · 해시가 채팅 사본과 동일. photo-storage-dev §0-C).
//
// 그래서 Capacitor 셸(android-shell/)이 생겼고, 셸의 네이티브 코드는 사진 고르기 **하나**다.
// 이 파일은 그 문의 웹 쪽 절반이다:
//
//   셸 안   → [📷 사진 추가]가 네이티브 선택기를 부른다(원본 바이트 · 위치 생존)
//   크롬    → 브리지가 없으므로 **아무것도 바뀌지 않는다**(기존 input 그대로)
//
// 🔴 받은 바이트는 **기존 input에 주입**한다 — 새 처리 경로를 만들지 않는다(§7 2층).
// 그래야 미리보기·EXIF 읽기·🔬 관측 창·압축·저장이 전부 기존 문을 그대로 지난다.
// 두 번째 파이프라인을 만들면 그 순간부터 한쪽이 낡는다(M-0060이 정확히 그 형태였다).

/** 셸이 주입하는 브리지의 모양 — 플러그인(OriginalPhotosPlugin.java)과 1:1이다. */
interface OriginalPhotosBridge {
  pick(): Promise<{ photos: Array<{ name: string; data: string; original: boolean }> }>;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  Plugins?: { OriginalPhotos?: OriginalPhotosBridge };
}

/** 셸 안인가. 크롬에서는 undefined → 이 모듈 전체가 조용히 비켜선다. */
function bridge(): OriginalPhotosBridge | null {
  if (typeof window === 'undefined') return null; // 유닛(Node)·SSR — 셸일 리 없다
  const cap = (window as Window & { Capacitor?: CapacitorGlobal }).Capacitor;
  if (!cap?.isNativePlatform?.()) return null;
  return cap.Plugins?.OriginalPhotos ?? null;
}

/**
 * base64 → File. 순수(브라우저 전역만) — 유닛이 직접 돌린다.
 *
 * MIME은 **일부러 비워 둔다**: `readPhotoMeta`가 바이트를 직접 판별한다(M-0067 — 선택기의
 * MIME 주장을 믿지 않는 것이 이 경로의 규율이고, 여기서 지어내면 그 규율을 다시 어긴다).
 */
export function b64ToFile(name: string, b64: string): File {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name || 'photo.jpg');
}

/**
 * 네이티브 선택기로 고른 사진들을 **기존 input에 덧붙이고** change를 쏜다.
 *
 * @returns 셸 밖(크롬)이면 false — 호출부는 아무것도 안 해도 된다(기존 경로가 그대로 돈다).
 */
export async function pickIntoInput(input: HTMLInputElement): Promise<boolean> {
  const b = bridge();
  if (!b) return false;
  const { photos } = await b.pick();
  if (photos.length > 0) {
    const dt = new DataTransfer();
    for (const f of input.files ? Array.from(input.files) : []) dt.items.add(f);
    for (const p of photos) dt.items.add(b64ToFile(p.name, p.data));
    input.files = dt.files;
    // 기존 파이프라인(buildPickPreview.render)이 듣는 그 이벤트다 — 여기서 끝, 나머지는 기존 문.
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return true;
}

/**
 * 사진 입력칸을 셸에 잇는다 — 생성 폼·편집 폼이 **같은 문**을 지난다(§7).
 *
 * capture 단계에서 가로채는 이유: input.click()은 label 경유·[🖼️ 갤러리에서]의
 * `wireAltPick` 경유 등 여러 길로 온다. 셸 안에서는 **어느 길로 와도** 시스템 선택기 대신
 * 네이티브 문이 열려야 한다 — 셸에서 시스템 선택기를 열면 위치가 지워진 사본이 오고,
 * 그 결함은 조용하다(이 조용함이 나흘 걸렸다).
 */
export function wireNativeIntake(input: HTMLInputElement): void {
  input.addEventListener(
    'click',
    (e) => {
      if (!bridge()) return; // 크롬 — 손대지 않는다
      e.preventDefault();
      void pickIntoInput(input);
    },
    true,
  );
}
