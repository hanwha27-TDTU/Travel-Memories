// check-bytes-upload-symmetry.mjs — **바이트를 올릴지 말지를 손으로 판정하지 않는가.**
//
// ── 왜 이 게이트가 생겼나 (2026-08-01 · M-0059, 사용자 실기기) ────────────────
// 사진과 소리의 업로드 조건이 **손으로 따로 쓰여 있었고, 갈라졌다**:
//
//   소리: if (audio.deletedAt === null || !audio.storagePath)   ← 2026-07-28에 고침(M-0046)
//   사진: if (media.deletedAt === null)                          ← 안 고침
//
// 결과: **휴지통 사진의 바이트는 어떤 경로로도 서버에 다시 올라가지 못했다.** 진단은
// 「서버에 없는 사진 3개」를 정확히 짚고 복구 버튼까지 줬는데, 눌러도 업로드를 건너뛰고
// **행만** 다시 쓴 뒤 op을 지웠다 — 그리고 사용자에게 *"3건을 다시 올렸어요"*라고 말했다.
//
// §7이 요구하는 3층 중 ②(구조)는 `mustUploadBytes` 공용 함수가 놓았다. 이 게이트가 ③이다:
// **다음 형제가 그 문을 우회해 자기 조건을 쓰는 것**을 막는다. 조항과 구조만으로는 안 지켜진다는
// 것이 이 저장소의 관측된 사실이다(M-0006·M-0033·M-0042·M-0059가 전부 같은 형태였다).
//
// 검사하는 것(비공허하게):
//   A. 바이트를 올리는 호출(`upload…(`)을 감싸는 `if`는 **`mustUploadBytes(`를 지난다.**
//      손으로 쓴 `if (x.deletedAt === null)` 바로 뒤의 업로드는 RED.
//   B. 바이트를 가진 도메인 수(`hasRemoteBytes: true`)만큼 `mustUploadBytes(` 호출이 있다.
//      새 형제가 생겼는데 문을 안 지나면 개수가 어긋나 RED.
//
// 검사하지 **않는** 것(정직한 경계): 판정 자체가 옳은지는 정적으로 못 본다.
// 그 층은 `tests/unit/reuploadMissingBytes.test.ts`(순수 4건 + 실제 push 왕복 6건)가 맡는다.
//
// 사용: node scripts/check-bytes-upload-symmetry.mjs

import { readFileSync } from 'node:fs';

const SYNC = 'src/services/sync.ts';
const PURGE = 'src/services/purge.ts';

/**
 * 업로드 호출을 감싼 `if` 조건을 뽑는다. 반환: [{ cond, call }].
 *
 * 방향이 중요하다 — **업로드 호출을 먼저 찾고 거꾸로 올라간다.** 처음엔 `if`부터 훑어
 * 본문을 봤는데, 여는 중괄호 다음의 줄바꿈에서 본문이 끊겨 **아무것도 못 잡았다**(자체검사가
 * 그 자리에서 RED를 냈다 — §4가 없었다면 공허한 채로 통과했을 게이트다).
 */
export function uploadGuards(text) {
  const out = [];
  const re = /\bremote\.(upload[A-Za-z]*)\s*\(/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 400), m.index);
    // 가장 가까운 `if (…) {` — 여러 개면 마지막(= 바로 감싼 것).
    const conds = [...before.matchAll(/if\s*\(([\s\S]*?)\)\s*\{/g)];
    const last = conds[conds.length - 1];
    if (last) out.push({ cond: last[1], call: m[1], before });
  }
  return out;
}

/** 손으로 판정한 자리를 찾는다. 반환이 비면 통과. */
export function findHandRolledGuards(text) {
  return uploadGuards(text)
    .filter(
      (g) =>
        !g.cond.includes('mustUploadBytes(') &&
        !(
          g.cond.trim() === 'uploadsBytes' &&
          /const\s+uploadsBytes\s*=\s*mustUploadBytes\s*\(/.test(g.before)
        ),
    )
    .map((g) => `remote.${g.call}(…)를 감싼 조건이 공용 문을 안 지납니다 — \`if (${g.cond.trim()})\``);
}

/** `hasRemoteBytes: true`인 도메인 수를 센다(손으로 적지 않는다 — 등록부에서 뽑는다). */
export function countByteDomains(purgeText) {
  return (purgeText.match(/hasRemoteBytes:\s*true/g) ?? []).length;
}

/** 공용 문을 지나는 호출 수. */
export function countGateCalls(text) {
  return (text.match(/mustUploadBytes\s*\(/g) ?? []).length;
}

/** DB OCC보다 먼저 올리는 바이트가 작업별 불변 키를 쓰는 도메인 목록(M-0087). */
export function operationFencedDomains(text) {
  return new Set(
    [...text.matchAll(/operationStoragePath\s*\(\s*stablePath\s*,\s*(media|audio|video)\.id\s*,/g)].map((m) => m[1]),
  );
}

// ── 자체검사(§4: 알려진 실패를 주입해 RED를 확인한 뒤에만 이 게이트를 믿는다) ──
function selfTest() {
  const fails = [];
  const ok = `    if (mustUploadBytes(media, false)) {\n      const up = await remote.uploadDisplay(path, b);\n`;
  if (findHandRolledGuards(ok).length !== 0) fails.push('정상 코드를 위반으로 봤다(오탐)');

  const named = `    const uploadsBytes = mustUploadBytes(media, false);\n    if (uploadsBytes) {\n      const up = await remote.uploadDisplay(path, b);\n`;
  if (findHandRolledGuards(named).length !== 0) fails.push('공용 판정을 이름 붙인 정상 코드를 위반으로 봤다(오탐)');

  const old = `    if (media.deletedAt === null) {\n      const up = await remote.uploadDisplay(path, b);\n`;
  if (findHandRolledGuards(old).length === 0) fails.push('옛 조건(deletedAt === null)을 못 잡았다');

  const sneaky = `    if (a.deletedAt === null || !a.storagePath) {\n      const up = await remote.upload(path, b);\n`;
  if (findHandRolledGuards(sneaky).length === 0) fails.push('손으로 쓴 두 갈래 조건을 못 잡았다');

  // 업로드가 없는 if는 걸리지 않는다(오탐 방지).
  const unrelated = `    if (x.deletedAt === null) {\n      await remote.upsert(row);\n`;
  if (findHandRolledGuards(unrelated).length !== 0) fails.push('업로드가 없는 조건을 위반으로 봤다(오탐)');

  if (countByteDomains('hasRemoteBytes: true,\nhasRemoteBytes: false,\nhasRemoteBytes: true,') !== 2) {
    fails.push('바이트 도메인 수를 잘못 셌다');
  }
  if (countGateCalls('mustUploadBytes(a, true) mustUploadBytes (b, false)') !== 2) {
    fails.push('공용 문 호출 수를 잘못 셌다');
  }
  const fenced = operationFencedDomains(
    'operationStoragePath(stablePath, media.id, op) operationStoragePath(stablePath, audio.id, op) operationStoragePath(stablePath, video.id, op)',
  );
  if (fenced.size !== 3 || !fenced.has('media') || !fenced.has('audio') || !fenced.has('video')) {
    fails.push('사진·소리·영상 작업별 바이트 fence를 잘못 센다');
  }
  if (operationFencedDomains('const path = stablePath;').size !== 0) {
    fails.push('같은 키 덮어쓰기를 작업별 fence로 잘못 본다');
  }
  return fails;
}

const selfFails = selfTest();
if (selfFails.length > 0) {
  console.error('check-bytes-upload-symmetry: **자체검사 실패** — 이 게이트를 믿을 수 없습니다(§4).');
  for (const f of selfFails) console.error(`  ✗ ${f}`);
  // 자체검사 실패는 **위반이 아니라** 「이 게이트를 믿을 수 없다」이다 → exit 2(§18-G).
  process.exit(2);
}

const sync = readFileSync(SYNC, 'utf8');
const problems = findHandRolledGuards(sync).map((p) => `${SYNC}: ${p}`);

const domains = countByteDomains(readFileSync(PURGE, 'utf8'));
const calls = countGateCalls(sync);
if (calls !== domains) {
  problems.push(
    `${SYNC}: 바이트를 가진 도메인은 ${domains}개인데 공용 문(mustUploadBytes)을 지나는 곳은 ${calls}곳입니다` +
      ' — 새 형제가 문을 안 지나면 그 자료는 조용히 안 올라갑니다(M-0059).',
  );
}

const fenced = operationFencedDomains(sync);
if (fenced.size !== domains) {
  problems.push(
    `${SYNC}: 바이트 도메인은 ${domains}개인데 operationStoragePath 작업별 fence를 지나는 도메인은 ` +
      `${[...fenced].join(', ') || '0개'}입니다 — 같은 R2 키를 먼저 덮으면 DB OCC가 바이트를 보호하지 못합니다(M-0087).`,
  );
}

if (problems.length > 0) {
  console.error('check-bytes-upload-symmetry: **바이트 업로드 판정이 갈라져 있습니다**(§7).');
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('  → 판정은 src/sync/merge.ts의 `mustUploadBytes` **한 곳**에서만 합니다.');
  process.exit(1);
}

console.log(
  `check-bytes-upload-symmetry: OK — 바이트 도메인 ${domains}개가 공용 업로드 문+작업별 불변 키를 지납니다(자체검사 9건 포함).`,
);
