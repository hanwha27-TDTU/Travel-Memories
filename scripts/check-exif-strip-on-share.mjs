// check-exif-strip-on-share.mjs — **밖으로 나가는 바이트에 EXIF/GPS가 실리지 않는가.**
//
// ── 왜 이 게이트가 뒤늦게 생겼나 (2026-07-27) ──────────────────────────
// `docs/PRIVACY.md:19`가 이렇게 적어 두었다:
//   *"업로드 시 EXIF GPS 처리를 확정한다: 앱 내부 저장은 보존, **공유·내보내기 산출물에서는
//     GPS 제거**. 이 계약은 `check-exif-strip-on-share` 게이트로 강제하며…"*
//
// **그런데 그 스크립트가 없었다.** 문서는 "게이트로 강제한다"고 말하는데 강제하는 것이 아무것도
// 없었다 — M-0034~0037이 반복해 배운 「이름이 있는 것과 불리는 것은 다르다」의 **문서판**이다.
//
// 그리고 더 중요한 것: 지금 GPS가 안 새는 이유는 **규율이 아니라 우연**이다.
// `compressForStorage`가 canvas로 재인코딩하기 때문에 EXIF가 **부작용으로** 사라진다.
// 누군가 "원본을 그대로 올리면 화질이 좋잖아"라며 한 줄만 바꾸면 그 순간 GPS가 서버로 간다.
// 이 게이트는 **그 우연을 계약으로 고정한다.**
//
// 검사하는 것(비공허하게):
//   A. 서버로 나가는 업로드는 **원본 blob을 인자로 받지 않는다** — canvas 파생본만 나간다.
//   B. 파생본을 만드는 곳은 canvas 재인코딩(`toBlob`)을 지난다 — 원본 바이트 복사가 아니다.
//   C. `PRIVACY.md`가 이 게이트 이름을 계속 부르고 있다(문서↔게이트 왕복).
//
// 검사하지 **않는** 것(정직한 경계): 공유 기능은 아직 없다(비타협 원칙 #3 — 승인 없는 공유 없음).
// 공유 경로가 생기면 이 파일에 검사를 **추가**해야 하고, §11 ①에 따라 그때 주입을 다시 한다.
//
// 사용: node scripts/check-exif-strip-on-share.mjs

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 업로드 호출이 **원본 blob**을 넘기고 있지 않은가. 넘기면 EXIF가 그대로 서버로 간다. */
export function uploadsOriginalBytes(src) {
  const bad = [];
  // `uploadDisplay(경로, X)`의 X가 원본을 가리키는 이름이면 위반.
  const RAW = /\b(originalBlob|original|file|rawFile|srcBlob)\b/;
  for (const m of src.matchAll(/uploadDisplay\(\s*([^)]*)\)/g)) {
    const args = m[1];
    const second = args.split(',')[1] ?? '';
    if (RAW.test(second)) bad.push(`uploadDisplay(…, ${second.trim()}) — 원본 바이트를 업로드한다(EXIF·GPS 동반)`);
  }
  return bad;
}

/** 파생본 생성이 canvas 재인코딩을 지나는가. 지나지 않으면 원본 메타가 살아남는다. */
export function derivesViaCanvas(src) {
  const bad = [];
  if (!/canvas\.toBlob\(/.test(src)) {
    bad.push('compress.ts가 canvas.toBlob()으로 재인코딩하지 않는다 — EXIF가 파생본에 남는다');
  }
  // 원본 Blob을 그대로 파생본으로 돌려주는 지름길이 생기면 잡는다.
  if (/return\s*\{\s*blob:\s*original\b/.test(src)) {
    bad.push('원본 Blob을 파생본으로 그대로 반환한다 — 재인코딩을 우회했다');
  }
  return bad;
}

/** 문서가 이 게이트를 계속 부르는가(왕복). 문서에서 사라지면 게이트만 남아 이유를 잃는다. */
export function privacyDocReferences(doc) {
  return /check-exif-strip-on-share/.test(doc) ? [] : ['docs/PRIVACY.md가 이 게이트를 더 이상 참조하지 않는다'];
}

// ── 자체검사: 알려진 실패를 주입해 RED를 확인한 뒤에만 믿는다(§4·§11) ──
(() => {
  const ok = "await remote.uploadDisplay(path, media.displayBlob);";
  if (uploadsOriginalBytes(ok).length !== 0) throw new Error('SELF-TEST 실패: 정상 업로드를 위반으로 잡음(오탐).');

  const bad = "await remote.uploadDisplay(path, media.originalBlob);";
  if (uploadsOriginalBytes(bad).length !== 1) throw new Error('SELF-TEST 실패: 원본 업로드를 못 잡음(게이트 공허).');

  const bad2 = "await remote.uploadDisplay(path, file);";
  if (uploadsOriginalBytes(bad2).length !== 1) throw new Error('SELF-TEST 실패: 원본 파일 업로드를 못 잡음.');

  if (derivesViaCanvas('const blob = await new Promise((r) => canvas.toBlob(r));').length !== 0) {
    throw new Error('SELF-TEST 실패: 정상 재인코딩을 위반으로 잡음(오탐).');
  }
  if (derivesViaCanvas('return { blob: original, width, height };').length !== 2) {
    throw new Error('SELF-TEST 실패: 재인코딩 우회를 못 잡음(게이트 공허).');
  }
  if (privacyDocReferences('아무 내용').length !== 1) throw new Error('SELF-TEST 실패: 문서 참조 소실을 못 잡음.');
})();

const read = (rel) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), 'utf8') : '');

const violations = [];
violations.push(...uploadsOriginalBytes(read('src/services/sync.ts')).map((v) => `src/services/sync.ts: ${v}`));
violations.push(...derivesViaCanvas(read('src/media/compress.ts')).map((v) => `src/media/compress.ts: ${v}`));
violations.push(...privacyDocReferences(read('docs/PRIVACY.md')));

if (violations.length > 0) {
  console.error(
    'check-exif-strip-on-share: 밖으로 나가는 바이트에 원본 메타(EXIF·GPS)가 실릴 수 있습니다.\n' +
      violations.map((v) => '  - ' + v).join('\n') +
      '\n  → 서버로는 **canvas 재인코딩 파생본만** 보냅니다(docs/PRIVACY.md).' +
      '\n     원본 화질이 필요하면 GPS를 명시적으로 제거하는 경로를 먼저 만드세요.',
  );
  process.exit(1);
}

console.log('check-exif-strip-on-share: OK — 업로드는 canvas 파생본만 · 재인코딩 우회 0 · 문서 참조 유지.');
