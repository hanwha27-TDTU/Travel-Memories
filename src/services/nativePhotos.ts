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

import { shellPlugin } from './capacitorShell';

/** 셸이 주입하는 브리지의 모양 — 플러그인(OriginalPhotosPlugin.java)과 1:1이다. */
interface OriginalPhotosBridge {
  pick(): Promise<{
    photos: Array<{
      name: string;
      data: string;
      /** setRequireOriginal 승격이 실제로 됐는가. */
      original: boolean;
      /** 승격이 안 됐다면 어느 단계에서였나("pre-Q"·"getMediaUri-null"·…). 됐으면 "". */
      reason: string;
    }>;
  }>;
}

/** 셸 안인가. 크롬에서는 null → 이 모듈 전체가 조용히 비켜선다. */
function bridge(): OriginalPhotosBridge | null {
  return shellPlugin<OriginalPhotosBridge>('OriginalPhotos');
}

// ─────────────────────────────────────────────────────────────────────────────
// 🔬 관측 창에 「이 바이트가 어느 문으로 들어왔나」를 준다 (2026-08-01 · M-0069)
// ─────────────────────────────────────────────────────────────────────────────
// 셸(v1.44)을 만들고 받은 첫 실기기 보고가 「아직 0/0」이었는데, 스크린샷만으로는
// **셸에서 돈 것인지 PWA에서 돈 것인지조차** 가릴 수 없었다(둘 다 주소창이 없다).
// 관측 창이 GPS 사실은 말하면서 **경로**를 말하지 않아 생긴 왕복이다 — 앱이 아는 것을
// 말하지 않으면 사람이 대신 나른다(§12). 그래서 여기서 경로 사실을 기록해 둔다.
// (「어느 환경인가」 자체는 capacitorShell.shellState()가 답한다 — 감지 규칙은 한 곳에만.)

/** 파일 이름 → 네이티브 문이 말한 사실. 같은 이름을 다시 고르면 최신 것으로 덮인다. */
const lastPick = new Map<string, { original: boolean; reason: string }>();

/**
 * 네이티브가 바이트를 못 준 장들 (T-021). **비어 있는 것이 정상**이고, 남아 있으면
 * 그만큼 사진이 안 들어온 것이다 — 개수가 0이라고 말하지 말고 이유를 보여주기 위한 자리다.
 */
const skipped: { name: string; reason: string }[] = [];

/** 이번 선택에서 바이트를 못 받은 장들. 화면이 「왜 안 들어왔는지」를 말할 때 읽는다. */
export function skippedPicks(): readonly { name: string; reason: string }[] {
  return skipped;
}

/**
 * 이 파일이 네이티브 문을 거쳤다면 그때의 사실을, 아니면 null.
 * null인데 shellState()가 'shell'이면 — 셸인데 시스템 선택기 경로로 들어온 것이다.
 */
export function pickedVia(name: string): { original: boolean; reason: string } | null {
  return lastPick.get(name) ?? null;
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
  skipped.length = 0; // 이번 선택의 사실만 담는다 — 지난 선택의 사유가 남으면 거짓이 된다
  const { photos } = await b.pick();
  if (photos.length > 0) {
    const dt = new DataTransfer();
    for (const f of input.files ? Array.from(input.files) : []) dt.items.add(f);
    for (const p of photos) {
      // 🔴 네이티브가 **바이트를 못 준 장**은 건너뛴다(T-021). 크기 상한·OOM에 걸리면
      //    플러그인이 `data: ''`와 사유를 준다. 이걸 그대로 통과시키면 0바이트 사진이
      //    파이프라인에 들어가 「사진이 있는데 열리지 않는」 상태가 된다 — 조용한 실패를
      //    새로 만드는 셈이다(§8). 사유는 남겨 관측 창이 사실을 말하게 한다.
      if (!p.data) {
        skipped.push({ name: p.name, reason: p.reason ?? '(사유 미보고)' });
        continue;
      }
      const file = b64ToFile(p.name, p.data);
      // File의 실제 이름으로 기록한다(빈 이름 폴백 뒤) — 관측 창이 이 이름으로 되찾는다.
      // 옛 APK의 플러그인은 reason을 안 보낸다 → undefined를 "모름"으로 뭉개지 않고 적는다.
      lastPick.set(file.name, { original: p.original === true, reason: p.reason ?? '(옛 플러그인 — reason 미보고)' });
      dt.items.add(file);
    }
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
