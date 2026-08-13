#!/usr/bin/env node
// check-version-ssot — **버전을 말하는 자리가 전부 한 정본에서 파생되는가.**
//
// 🔴 왜(2026-08-13 · 외부 리뷰 지적 → 실측 확인): 앱은 v2.29인데
//    **안드로이드 앱 정보는 1.0**, `package.json`은 **0.0.0**, 그런데 `PROJECT_SPEC`은
//    *"package.json이 버전 SSOT"*라고 적고 있었다. 세 곳이 서로 다른 말을 했다.
//
// 🔴 이건 헌법 §18-I가 **바로 그날 적은** 근본형이다 — *"자동으로 갱신되는 값 바로 옆에
//    사람이 적는 값이 있으면 그 수동 값은 반드시 밀린다."* `build.gradle`에서
//    `versionCode`는 CI가 주입하는데 **바로 아랫줄** `versionName`은 손으로 박혀 있었다.
//    그리고 §18-I는 *"형제를 전수로 세라 — 대개 혼자 있지 않다"*고도 적었는데,
//    그 조항을 쓴 판에서 형제를 안 훑었다. 그래서 이 게이트가 대신 훑는다.
//
// 무엇을 판정하나:
//  A) `registry.gen.ts`의 `appVersion`이 changelog 맨 앞 항목과 같은가(생성물 드리프트).
//  B) 안드로이드 `versionName`이 **주입받는 형태**인가 — 숫자 리터럴로 박혀 있으면 위반.
//  C) APK 워크플로가 `APP_VERSION_NAME`을 **실제로 넘기는가**(선언이 아니라 명령).
//  D) 지시문서가 `package.json`을 버전 정본이라고 **말하지 않는가**(그 문장이 사고의 출발이었다).
//
// 🔴 왜 `package.json`의 `0.0.0`을 위반으로 잡지 않나: 그건 **밀리는 값이 아니라 죽은 값**이다.
//    아무도 안 읽고 릴리스마다 바뀌지도 않는다. 위반으로 잡으면 릴리스마다 손댈 자리를
//    **하나 더 만드는** 셈이라 §18-I가 없애려는 것을 늘린다. 대신 D로 「정본이라 부르지 마라」를 막는다.
//
// 가정하는 세계(§18-G): 없음 — 작업트리 파일만 읽는다.
// 종료코드: 0 통과 · 1 위반 · 2 전제 미충족(대상 파일 없음 · 자체검사 실패).

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSelfTest } from './gate-selftest-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHANGELOG = 'src/app/changelog.ts';
const REGISTRY = 'src/app/registry.gen.ts';
const GRADLE = 'android-shell/android/app/build.gradle';
const APK_WF = '.github/workflows/android-apk.yml';

/** changelog 맨 앞 항목의 버전 — 이 저장소의 버전 정본. */
export function ssotVersion(src) {
  return /version: '([\d.]+)'/.exec(src)?.[1] ?? null;
}

/** 생성물이 심어 둔 앱 버전. */
export function registryVersion(src) {
  return /appVersion:\s*'([\d.]+)'/.exec(src)?.[1] ?? null;
}

/**
 * 안드로이드 `versionName`이 **주입받는 형태**인가.
 *
 * 🔴 「숫자를 손으로 박은 것」만 위반이다. 로컬 대체값(`'0.0-local'` 같은 비-버전 문자열)은
 *    괜찮다 — 배포본과 헷갈릴 수 없기 때문이다.
 */
export function gradleVersionNameProblems(src) {
  const m = /versionName\s+(.+)/.exec(src);
  if (!m) return ['build.gradle에서 versionName 줄을 찾지 못했습니다.'];
  const line = m[1].trim();
  if (!/APP_VERSION_NAME/.test(line)) {
    return [`versionName이 주입받지 않고 박혀 있습니다: ${line} — CI가 정본에서 넘기게 하세요.`];
  }
  const literal = /:\s*'([^']*)'/.exec(line)?.[1] ?? '';
  if (/^\d+(\.\d+)*$/.test(literal)) {
    return [`로컬 대체값이 버전처럼 보입니다('${literal}') — 배포본과 헷갈립니다. '0.0-local' 같은 값을 쓰세요.`];
  }
  return [];
}

/** 워크플로가 그 값을 **실제로 넘기는가**(주석에 적힌 말이 아니라 명령). */
export function workflowInjects(src) {
  return /-PAPP_VERSION_NAME/.test(src);
}

/** 지시문서가 `package.json`을 버전 정본이라 부르는가 — 그 문장이 이 사고의 출발이었다. */
export function docsClaimPackageJsonIsSsot(text) {
  return /`?package\.json`?\s*(의\s*)?version\s*[—-]\s*손편집 금지/.test(text);
}

runSelfTest('check-version-ssot', () => {
  // ── 잡아야 하는 것 ──
  if (gradleVersionNameProblems(`versionName "1.0"`).length !== 1) throw new Error('SELF-TEST 실패: 박아 둔 versionName을 못 잡았다.');
  if (gradleVersionNameProblems(`versionName project.hasProperty('APP_VERSION_NAME') ? APP_VERSION_NAME : '1.0'`).length !== 1) {
    throw new Error('SELF-TEST 실패: 버전처럼 보이는 로컬 대체값을 못 잡았다.');
  }
  if (workflowInjects('gradlew assembleDebug -PAPP_VERSION_CODE=1')) throw new Error('SELF-TEST 실패: 안 넘기는데 넘긴다고 봤다.');
  if (!docsClaimPackageJsonIsSsot('| 버전 | 현재 앱 버전 | `package.json` version — 손편집 금지, 빌드 시 주입 |')) {
    throw new Error('SELF-TEST 실패: 문서의 잘못된 SSOT 주장을 못 잡았다.');
  }
  // ── 잡으면 안 되는 것(오탐 금지) ──
  if (gradleVersionNameProblems(`versionName project.hasProperty('APP_VERSION_NAME') ? APP_VERSION_NAME : '0.0-local'`).length !== 0) {
    throw new Error('SELF-TEST 실패: 올바른 주입 형태를 위반으로 봤다.');
  }
  if (!workflowInjects('-PAPP_VERSION_NAME="$APP_VERSION_NAME"')) throw new Error('SELF-TEST 실패: 넘기는데 못 봤다.');
  if (docsClaimPackageJsonIsSsot('`package.json`의 version은 정본이 아니다')) {
    throw new Error('SELF-TEST 실패: 정정된 문장을 위반으로 오탐한다.');
  }
  // ── 파서 ──
  if (ssotVersion("version: '2.29',") !== '2.29') throw new Error('SELF-TEST 실패: 정본 버전을 못 읽었다.');
  if (registryVersion("appVersion: '2.29',") !== '2.29') throw new Error('SELF-TEST 실패: 생성물 버전을 못 읽었다.');
  if (ssotVersion('버전 없음') !== null) throw new Error('SELF-TEST 실패: 없는 버전을 읽었다고 했다.');
});

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain && process.argv.includes('--selftest')) {
  console.log('check-version-ssot: 셀프테스트 통과 (잡아야 할 것 4 · 잡으면 안 되는 것 3 · 파서 3)');
  process.exit(0);
}

if (isMain) {
  const read = (rel) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), 'utf8') : null);
  const changelog = read(CHANGELOG);
  const registry = read(REGISTRY);
  if (changelog === null || registry === null) {
    console.error(`check-version-ssot: ${CHANGELOG} 또는 ${REGISTRY}가 없습니다 — 재지 못했습니다.`);
    process.exit(2);
  }

  const ssot = ssotVersion(changelog);
  if (!ssot) {
    console.error(`check-version-ssot: ${CHANGELOG}에서 버전을 읽지 못했습니다 — 정본을 확보하지 못했습니다.`);
    process.exit(2);
  }

  const problems = [];

  // A) 생성물 드리프트
  const reg = registryVersion(registry);
  if (reg !== ssot) problems.push(`${REGISTRY}의 appVersion(${reg})이 정본(${ssot})과 다릅니다 — node scripts/gen-registry.mjs로 재생성하세요.`);

  // B) 안드로이드가 주입받는 형태인가
  const gradle = read(GRADLE);
  if (gradle === null) problems.push(`${GRADLE}이 없습니다 — 안드로이드 버전을 재지 못했습니다.`);
  else problems.push(...gradleVersionNameProblems(gradle).map((p) => `${GRADLE}: ${p}`));

  // C) 워크플로가 실제로 넘기는가
  const wf = read(APK_WF);
  if (wf === null) problems.push(`${APK_WF}이 없습니다 — 주입을 재지 못했습니다.`);
  else if (!workflowInjects(wf)) problems.push(`${APK_WF}: -PAPP_VERSION_NAME을 넘기지 않습니다 — build.gradle이 주입을 기다리는데 아무도 안 줍니다.`);

  // D) 문서가 틀린 정본을 가리키는가
  for (const doc of ['docs/PROJECT_SPEC.md']) {
    const text = read(doc);
    if (text && docsClaimPackageJsonIsSsot(text)) {
      problems.push(`${doc}: package.json을 버전 정본이라 적고 있습니다 — 정본은 ${CHANGELOG}입니다.`);
    }
  }

  if (problems.length) {
    console.error('check-version-ssot: **버전을 말하는 자리가 갈라져 있습니다**.');
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error(`  → 정본은 ${CHANGELOG} 맨 앞 항목입니다. 나머지는 전부 거기서 파생시키세요(§18-I).`);
    process.exit(1);
  }

  console.log(
    `check-version-ssot: 정본 v${ssot} — 생성물·안드로이드 주입·워크플로·문서가 전부 일치합니다.`,
  );
  console.log(
    `    ↳ 정직한 한계: **파생되는 배선**만 봅니다 — 실제 APK가 그 값을 달고 나왔는지는 못 봅니다(빌드 산출물은 이 저장소에 없습니다).` +
      ` \`package.json\`의 0.0.0은 **일부러 안 잡습니다** — 죽은 값이라, 잡으면 릴리스마다 손댈 자리를 하나 더 만듭니다.`,
  );
}
