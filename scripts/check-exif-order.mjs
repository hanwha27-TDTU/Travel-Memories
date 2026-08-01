// check-exif-order.mjs — **EXIF를 압축·편집보다 먼저 읽는가.**
//
// ── 왜 이 게이트가 뒤늦게 생겼나 (2026-07-31 · 사용자 지적) ──────────────────
// 사용자가 물었다: *"처음에 업로드 때 아무런 변화를 주지 않은 상태에서 모든 정보를 불러와서
// 정보를 앱에 자동기입하고 그 이후 편집작업 들어가면 해결될 듯합니다."*
//
// 맞는 설계이고 **이미 그렇게 돼 있었다.** 그런데 확인해 보니 **그것을 지키는 기계가 없었다** —
// 비타협 원칙 §0이 *"사진 압축 **전에** 촬영시각·위치정보(EXIF)를 먼저 읽어 별도 저장한다"*고
// 못박아 두었는데, 강제하는 것은 **아무것도 없었다.** M-0051(문서가 게이트를 앞질러 있다)의
// 재발이고, 이 저장소가 가장 자주 넘어진 자리다.
//
// 이 순서가 깨지면 무슨 일이 나나: `compressForStorage`는 canvas 재인코딩이라 **EXIF를
// 통째로 버린다**(그건 의도된 것 — `check-exif-strip-on-share` 참조). 순서가 뒤집히면
// 촬영시각도 위치도 **영원히 사라지고**, 사용자는 그걸 「앱이 못 읽는다」로 겪는다.
// 되돌릴 수도 없다 — 원본은 사용자 기기에 있고 앱이 다시 물을 방법이 없다.
//
// 검사하는 것(비공허하게):
//   A. `addPhotoToMoment` 안에서 `readPhotoMeta(` 호출이 `compressForStorage(`보다 **앞**이다.
//   B. `readPhotoMeta`에 넘기는 것은 **원본 `file`**이다 — `editedBlob`이 아니다.
//   C. 고를 때(미리보기) 메타를 읽는 곳도 **편집기를 거치지 않은 파일**을 읽는다.
//   D. 🔴 **사진 입력칸의 기본 `accept`가 원본 보존 경로인가**(2026-08-01 · M-0064).
//      갤러리 선택기(`accept: 'image/*'`)로 고르면 안드로이드가 **위치를 지우고 넘긴다.**
//      그러면 A·B·C를 아무리 지켜도 **읽을 것이 애초에 없다** — 순서를 지키는 것과
//      원본을 받는 것은 다른 층이고, 이 저장소는 후자를 나흘 동안 놓쳤다.
//
// 검사하지 **않는** 것(정직한 경계): 런타임에 실제로 그 순서로 도는지는 정적으로 못 본다.
// 그 층은 라이브(`verify-editor-live`의 「발생 시각: EXIF가 있으면 그 시각을 사진에서 읽는다」)와
// 유닛(`tests/unit/exif.test.ts`)이 맡는다.
//
// 사용: node scripts/check-exif-order.mjs

import { readFileSync } from 'node:fs';

const MEDIA = 'src/services/media.ts';
const SCREEN = 'src/ui/screens/tripDetail.ts';

/** `addPhotoToMoment` 본문만 잘라낸다(다른 함수의 호출 순서에 속지 않게). */
export function sliceFunctionBody(text, name) {
  const start = text.indexOf(`export async function ${name}(`);
  if (start < 0) return null;
  const open = text.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return null;
}

/** 순서·인자 위반을 찾는다. 반환이 비면 통과. */
export function findOrderViolations(body) {
  const out = [];
  if (body === null) return ['addPhotoToMoment 본문을 찾지 못했습니다(이름이 바뀌었나요?)'];

  const readAt = body.indexOf('readPhotoMeta(');
  const compressAt = body.indexOf('compressForStorage(');
  if (readAt < 0) out.push('addPhotoToMoment이 readPhotoMeta를 부르지 않습니다 — EXIF를 아예 안 읽습니다(§0).');
  if (compressAt < 0) out.push('addPhotoToMoment이 compressForStorage를 부르지 않습니다(경로가 바뀌었나요?).');
  if (readAt >= 0 && compressAt >= 0 && readAt > compressAt) {
    out.push('🔴 압축이 EXIF 읽기보다 **먼저**입니다 — canvas 재인코딩이 EXIF를 버리므로 촬영시각·위치가 영원히 사라집니다(§0).');
  }

  // B. readPhotoMeta의 첫 인자가 원본 file인가
  const m = /readPhotoMeta\(\s*([A-Za-z_$][\w$]*)/.exec(body);
  if (m && m[1] !== 'file') {
    out.push(`🔴 readPhotoMeta에 원본이 아니라 \`${m[1]}\`을 넘깁니다 — 편집본에는 EXIF가 없습니다(§0).`);
  }
  return out;
}

/**
 * 🔴 사진 입력칸의 **기본** `accept`가 갤러리 선택기로 내려가 있지 않은가(M-0064).
 *
 * 라이브 검사도 이걸 재지만(`verify-editor-live`), 라이브는 **빠른 차선에서 건너뛴다.**
 * 이 결함의 값이 나흘이었으므로 **건너뛸 수 없는 층**에도 둔다(SKIP은 통과가 아니다 — §11).
 */
export function findGalleryDefaultViolations(text) {
  const out = [];
  const re = /(\w*[Pp]hoto\w*|input)\.accept\s*=\s*(?:(['"`])([^'"`]*)\2|(\w+))/g;
  let m;
  let seen = 0;
  while ((m = re.exec(text)) !== null) {
    seen += 1;
    const literal = m[3];
    // 상수로 넘긴 경우(`= ORIGINAL_ACCEPT`)는 그 상수의 정의가 진실이다 — 여기서 판정하지
    // 않는다. 이름을 잘못 고르는 것은 다음 줄의 「갤러리 상수」 검사가 잡는다.
    if (literal === undefined) {
      if (/GALLERY/i.test(m[4] ?? '')) {
        out.push(`\`${m[1]}.accept = ${m[4]}\` — 기본값이 갤러리 선택기입니다(M-0064).`);
      }
      continue;
    }
    // 사진이 아닌 형식이 하나라도 섞여야 안드로이드가 **파일 선택기**로 내려간다.
    if (!literal.includes('/octet-stream')) {
      out.push(
        `\`${m[1]}.accept = '${literal}'\` — 갤러리 선택기로 내려갑니다. 안드로이드가 **위치를 지우고 넘깁니다**(M-0064).`,
      );
    }
  }
  // 🔴 **대상 0에서 초록이 되지 않게**(§4). 지정을 하나도 못 찾았으면 이 검사는 공허하다.
  if (seen === 0) {
    out.push('사진 입력칸의 accept 지정을 하나도 찾지 못했습니다 — 이 검사가 공허합니다(이름이 바뀌었나요?).');
  }
  return out;
}

/** 고를 때 메타를 읽는 곳이 편집기 산출물을 읽고 있지 않은가. */
export function findPickViolations(text) {
  const out = [];
  const calls = [...text.matchAll(/readPhotoMeta\(\s*([A-Za-z_$][\w$]*)/g)].map((x) => x[1]);
  if (calls.length === 0) out.push('화면이 readPhotoMeta를 부르지 않습니다 — 고를 때 메타를 안 읽습니다.');
  for (const arg of calls) {
    if (/edit|result|blob|compressed/i.test(arg)) {
      out.push(`🔴 화면이 편집·압축 산출물(\`${arg}\`)에서 EXIF를 읽으려 합니다 — 거기엔 EXIF가 없습니다(§0).`);
    }
  }
  return out;
}

// ── 자체검사(§4: 알려진 실패를 주입해 RED를 확인한 뒤에만 이 게이트를 믿는다) ──
/**
 * E. 🔴 EXIF 읽기 창을 **손 매직넘버로 쓰지 않는가**(H-2 · 2026-08-01).
 *
 * 저장 경로(media.ts)와 🔬 관측 창(tripDetail.ts)이 서로 다른 크기(256KB vs 512KB)를 손으로
 * 썼더니, 그 사이에 EXIF가 앉은 사진에서 🔬는 "위치 있음 → 앱 결함"이라 말하고 저장은 좌표를
 * 못 봤다 — **앱이 스스로를 오신고**했다. 두 호출부가 `EXIF_HEAD_BYTES`(exif.ts SSOT)를 쓰면
 * 그 갈라짐이 불가능하다. 그래서 `slice(0, <숫자> * 1024)`처럼 손으로 쓴 EXIF 창을 금지한다.
 *
 * 정직한 경계: `slice(0, N)`의 모든 용례가 EXIF 창은 아니다(해시 앞부분 등). 그래서 대상을
 * **KB 단위 리터럴 슬라이스**(`* 1024`)로 좁힌다 — EXIF 창은 KB 규모이고, 바이트 몇 개짜리
 * 슬라이스(마커 스캔)는 걸리지 않는다.
 */
export function findExifWindowViolations(text) {
  const out = [];
  const re = /\.slice\(\s*0\s*,\s*(\d+)\s*\*\s*1024\s*\)/g;
  let m;
  while ((m = re.exec(text))) {
    out.push(`EXIF 창을 손 매직넘버(${m[1]}KB)로 씁니다 — exif.ts의 EXIF_HEAD_BYTES를 쓰세요(H-2).`);
  }
  return out;
}

function selfTest() {
  const fails = [];
  const ok = `{ const meta = await readPhotoMeta(file, zone); const x = await compressForStorage(editedBlob ?? file); }`;
  if (findOrderViolations(ok).length !== 0) fails.push('정상 코드를 위반으로 봤다(오탐)');

  const swapped = `{ const x = await compressForStorage(editedBlob ?? file); const meta = await readPhotoMeta(file, zone); }`;
  if (findOrderViolations(swapped).length === 0) fails.push('순서를 뒤집었는데 못 잡았다');

  const wrongArg = `{ const meta = await readPhotoMeta(editedBlob, zone); const x = await compressForStorage(file); }`;
  if (findOrderViolations(wrongArg).length === 0) fails.push('편집본에서 EXIF를 읽는데 못 잡았다');

  const missing = `{ const x = await compressForStorage(file); }`;
  if (findOrderViolations(missing).length === 0) fails.push('EXIF를 아예 안 읽는데 못 잡았다');

  if (findPickViolations('readPhotoMeta(f, zone)').length !== 0) fails.push('정상 픽 호출을 위반으로 봤다(오탐)');
  if (findPickViolations('readPhotoMeta(editedFile, zone)').length === 0) fails.push('편집본에서 픽 메타를 읽는데 못 잡았다');

  // D — 기본 accept
  if (findGalleryDefaultViolations("photoInput.accept = ORIGINAL_ACCEPT;").length !== 0) {
    fails.push('상수로 쓴 정상 accept를 위반으로 봤다(오탐)');
  }
  if (findGalleryDefaultViolations("photoInput.accept = 'image/*';").length === 0) {
    fails.push("기본이 갤러리 선택기(image/*)인데 못 잡았다");
  }
  if (findGalleryDefaultViolations("input.accept = 'image/*,application/octet-stream';").length !== 0) {
    fails.push('원본 보존 accept를 위반으로 봤다(오탐)');
  }
  if (findGalleryDefaultViolations('const x = 1;').length === 0) {
    fails.push('accept 지정이 아예 없는데 「공허」라고 말하지 않았다');
  }
  if (findGalleryDefaultViolations('photoInput.accept = GALLERY_ACCEPT;').length === 0) {
    fails.push('기본값을 갤러리 상수로 돌려놨는데 못 잡았다');
  }

  // E — EXIF 창 손 매직넘버
  if (findExifWindowViolations('const buf = await f.slice(0, EXIF_HEAD_BYTES).arrayBuffer();').length !== 0) {
    fails.push('상수로 쓴 EXIF 창을 위반으로 봤다(오탐)');
  }
  if (findExifWindowViolations('const buf = await f.slice(0, 512 * 1024).arrayBuffer();').length === 0) {
    fails.push('EXIF 창을 512*1024 매직넘버로 쓰는데 못 잡았다');
  }
  if (findExifWindowViolations('file.slice(0, 256 * 1024)').length === 0) {
    fails.push('EXIF 창을 256*1024 매직넘버로 쓰는데 못 잡았다');
  }
  if (findExifWindowViolations('buf.slice(2, 6)').length !== 0) {
    fails.push('바이트 몇 개짜리 마커 슬라이스를 EXIF 창으로 오인했다(오탐)');
  }

  return fails;
}

const selfFails = selfTest();
if (selfFails.length > 0) {
  console.error('check-exif-order: **자체검사 실패** — 이 게이트를 믿을 수 없습니다(§4).');
  for (const f of selfFails) console.error(`  ✗ ${f}`);
  process.exit(1);
}

const screenText = readFileSync(SCREEN, 'utf8');
const mediaText = readFileSync(MEDIA, 'utf8');
const problems = [
  ...findOrderViolations(sliceFunctionBody(mediaText, 'addPhotoToMoment')).map((p) => `${MEDIA}: ${p}`),
  ...findPickViolations(screenText).map((p) => `${SCREEN}: ${p}`),
  ...findGalleryDefaultViolations(screenText).map((p) => `${SCREEN}: ${p}`),
  ...findExifWindowViolations(mediaText).map((p) => `${MEDIA}: ${p}`),
  ...findExifWindowViolations(screenText).map((p) => `${SCREEN}: ${p}`),
];

if (problems.length > 0) {
  console.error('check-exif-order: **사진 인테이크 계약 위반**(비타협 원칙 §0).');
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('  → 순서(A·B·C): 압축은 EXIF를 버립니다 — 그 뒤에 읽으면 촬영시각·위치가 **영원히** 사라집니다.');
  console.error('  → 기본 경로(D): 갤러리 선택기로 고르면 안드로이드가 위치를 지우고 넘깁니다 — 읽을 것이 애초에 없습니다(M-0064).');
  process.exit(1);
}

console.log(
  'check-exif-order: OK — EXIF를 압축·편집 **전에**, **원본에서** 읽고, 사진 입력칸의 기본 경로가 **원본 보존**입니다(자체검사 10건 포함).',
);
