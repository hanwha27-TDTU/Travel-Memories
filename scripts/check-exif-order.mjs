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

  return fails;
}

const selfFails = selfTest();
if (selfFails.length > 0) {
  console.error('check-exif-order: **자체검사 실패** — 이 게이트를 믿을 수 없습니다(§4).');
  for (const f of selfFails) console.error(`  ✗ ${f}`);
  process.exit(1);
}

const problems = [
  ...findOrderViolations(sliceFunctionBody(readFileSync(MEDIA, 'utf8'), 'addPhotoToMoment')).map((p) => `${MEDIA}: ${p}`),
  ...findPickViolations(readFileSync(SCREEN, 'utf8')).map((p) => `${SCREEN}: ${p}`),
];

if (problems.length > 0) {
  console.error('check-exif-order: **EXIF를 압축보다 먼저 읽지 않습니다**(비타협 원칙 §0).');
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('  → 압축(canvas 재인코딩)은 EXIF를 버립니다. 그 뒤에 읽으면 촬영시각·위치가 **영원히** 사라집니다.');
  process.exit(1);
}

console.log('check-exif-order: OK — EXIF를 압축·편집 **전에**, **원본에서** 읽습니다(자체검사 6건 포함).');
