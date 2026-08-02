#!/usr/bin/env node
// check-apk-release-link — 「항상 최신 APK」 계약이 세 자리에서 같은가.
//
// 사용자 지시(2026-08-01): *"항상 최신 APK 파일도 다운로드 가능하게. 업데이트마다 APK 파일
// 갱신은 100퍼센트 놓치는 일 없게"* — 「놓치지 않음」은 기억이 아니라 기계여야 한다(§7 3층).
//
// 계약의 세 자리:
//   ① 워크플로(.github/workflows/android-apk.yml) — main이면 apk-latest 릴리스에 --clobber
//   ② 앱 상수(src/app/apk.ts) — 같은 태그의 고정 다운로드 주소
//   ③ 가이드 화면(src/ui/screens/guide.ts) — 상수를 import해서 쓴다(손으로 적은 URL 금지)
//
// 하나라도 조용히 갈라지면(단계 삭제·태그 변경·하드코딩 복제) 버튼이 낡은 APK를 주거나
// 죽은 링크가 된다 — 그 결함은 조용해서 비싸다(§9-B와 같은 부류).
//
// §4: 아래 셀프테스트가 알려진 실패 주입으로 먼저 RED를 확인한 뒤에만 실제 검사를 돈다.

import { readFileSync } from 'node:fs';

const WF_PATH = '.github/workflows/android-apk.yml';
const CONST_PATH = 'src/app/apk.ts';
const GUIDE_PATH = 'src/ui/screens/guide.ts';
const TAG = 'apk-latest';

/** ① 워크플로: 릴리스 갱신 단계가 온전한가. */
export function workflowProblems(text) {
  const p = [];
  if (!/permissions:\s*\n\s*contents:\s*write/.test(text)) {
    p.push('permissions.contents: write가 없다 — 릴리스 갱신이 권한 부족으로 실패한다');
  }
  if (!text.includes(`gh release upload ${TAG}`)) {
    p.push(`「gh release upload ${TAG}」 단계가 없다 — 최신 갱신 사슬이 끊겼다`);
  } else if (!/gh release upload apk-latest [^\n]*--clobber/.test(text)) {
    p.push('release upload에 --clobber가 없다 — 두 번째 갱신부터 조용히 실패한다');
  }
  if (!/if:\s*github\.ref == 'refs\/heads\/main'/.test(text)) {
    p.push('릴리스 단계에 main 조건이 없다 — 브랜치 빌드가 최신 자리를 덮어쓴다');
  }
  // 셸 업데이트 배너(§5-2)의 두 계약: versionCode 증가 + 릴리스 설명에 shell-version 마커.
  if (!/APP_VERSION_CODE=\$\{\{ github\.run_number \}\}/.test(text)) {
    p.push('assembleDebug에 -PAPP_VERSION_CODE=run_number가 없다 — versionCode가 안 늘어 앱이 새 셸을 감지 못 한다');
  }
  if (!/shell-version:/.test(text)) {
    p.push('릴리스 설명에 shell-version 마커가 없다 — 앱이 최신 build를 읽을 방법이 없다(함정 D)');
  }
  return p;
}

/** ② 앱 상수: 같은 태그·이 저장소·고정 자산 이름 + 셸 업데이트 감지 재료(API·파서)인가. */
export function constProblems(text) {
  const p = [];
  const tag = text.match(/APK_RELEASE_TAG = '([^']+)'/)?.[1];
  if (tag !== TAG) p.push(`APK_RELEASE_TAG가 '${TAG}'가 아니다: ${tag ?? '(없음)'}`);
  if (!text.includes('releases/download/')) {
    p.push('APK_LATEST_URL이 「releases/download/…」 형식이 아니다');
  }
  if (!/app-debug\.apk/.test(text)) p.push('APK_LATEST_URL의 자산 이름(app-debug.apk)이 없다');
  if (!/REPO_SLUG = 'hanwha27-TDTU\/Travel-Memories'/.test(text)) {
    p.push('REPO_SLUG가 이 저장소(hanwha27-TDTU/Travel-Memories)를 가리키지 않는다');
  }
  // 셸 업데이트 배너(§5-2)의 재료 — API 주소(자산이 아니라 릴리스 설명을 읽는 곳)와 파서.
  if (!text.includes('APK_RELEASE_API')) p.push('APK_RELEASE_API가 없다 — 셸이 새 APK를 감지할 경로가 없다(함정 D)');
  if (!/api\.github\.com\/repos\//.test(text)) p.push('APK_RELEASE_API가 api.github.com을 쓰지 않는다(자산 URL은 CORS로 막힘 — 함정 D)');
  if (!/export function parseShellBuild/.test(text)) p.push('parseShellBuild(shell-version 마커 파서)가 없다');
  return p;
}

/** ④ build.gradle: versionCode가 CI 주입(APP_VERSION_CODE)으로 증가하는가 — 배너 비교의 근거. */
export function gradleProblems(text) {
  const p = [];
  if (!/APP_VERSION_CODE/.test(text)) {
    p.push('versionCode가 APP_VERSION_CODE 주입을 안 쓴다 — 빌드마다 안 늘면 앱이 새 셸을 비교 못 한다');
  }
  return p;
}

/** ③ 가이드: 상수를 쓰고, 릴리스 URL을 손으로 다시 적지 않았는가(§7 SSOT). */
export function guideProblems(text) {
  const p = [];
  if (!text.includes('APK_LATEST_URL')) p.push('가이드가 APK_LATEST_URL 상수를 쓰지 않는다');
  if (text.includes('releases/download/')) {
    p.push('가이드에 손으로 적은 릴리스 URL이 있다 — 상수만 써야 한다(§7 손편집 중복 금지)');
  }
  return p;
}

// ── 셀프테스트 (§4 — 주입한 실패가 RED로 잡히는지 먼저 확인) ────────────────
const GOOD_WF = `permissions:\n  contents: write\njobs:\n  apk:\n    steps:\n      - run: ./gradlew assembleDebug --no-daemon -PAPP_VERSION_CODE=\${{ github.run_number }}\n      - name: r\n        if: github.ref == 'refs/heads/main'\n        run: |\n          gh release upload apk-latest "$APK" --clobber\n          gh release edit apk-latest --notes "x\n          <!-- shell-version: {\\"versionCode\\": \${{ github.run_number }}} -->"\n`;
const GOOD_CONST = `const REPO_SLUG = 'hanwha27-TDTU/Travel-Memories';\nexport const APK_RELEASE_TAG = 'apk-latest';\nexport const APK_LATEST_URL = \`https://github.com/\${REPO_SLUG}/releases/download/\${APK_RELEASE_TAG}/app-debug.apk\`;\nexport const APK_RELEASE_API = \`https://api.github.com/repos/\${REPO_SLUG}/releases/tags/\${APK_RELEASE_TAG}\`;\nexport function parseShellBuild(body) { return null; }\n`;
const GOOD_GUIDE = `import { APK_LATEST_URL } from '../../app/apk';\ndl.href = APK_LATEST_URL;\n`;
const GOOD_GRADLE = `versionCode project.hasProperty('APP_VERSION_CODE') ? APP_VERSION_CODE.toInteger() : 1\n`;

function selfTest() {
  const cases = [
    ['정상 워크플로는 통과', () => workflowProblems(GOOD_WF).length === 0],
    ['정상 상수는 통과', () => constProblems(GOOD_CONST).length === 0],
    ['정상 가이드는 통과', () => guideProblems(GOOD_GUIDE).length === 0],
    ['정상 gradle은 통과', () => gradleProblems(GOOD_GRADLE).length === 0],
    // 주입 실패들 — 실제로 일어날 수 있는 되돌림 각각이 RED인가.
    ['릴리스 단계 삭제 → RED', () => workflowProblems(GOOD_WF.replace(/gh release upload[^\n]*\n/, '')).length > 0],
    ['--clobber 삭제 → RED', () => workflowProblems(GOOD_WF.replace(' --clobber', '')).length > 0],
    ['main 조건 삭제 → RED', () => workflowProblems(GOOD_WF.replace(/ *if: github[^\n]*\n/, '')).length > 0],
    ['쓰기 권한 삭제 → RED', () => workflowProblems(GOOD_WF.replace(/permissions:\n  contents: write\n/, '')).length > 0],
    ['versionCode 주입 삭제 → RED', () => workflowProblems(GOOD_WF.replace(/ -PAPP_VERSION_CODE=\$\{\{ github\.run_number \}\}/, '')).length > 0],
    ['shell-version 마커 삭제 → RED', () => workflowProblems(GOOD_WF.replace(/shell-version:/, 'x:')).length > 0],
    ['상수 태그 변경 → RED', () => constProblems(GOOD_CONST.replaceAll('apk-latest', 'apk-v2')).length > 0],
    ['REPO_SLUG 변경 → RED', () => constProblems(GOOD_CONST.replace('hanwha27-TDTU/Travel-Memories', 'x/y')).length > 0],
    ['APK_RELEASE_API 삭제 → RED', () => constProblems(GOOD_CONST.replace(/export const APK_RELEASE_API[^\n]*\n/, '')).length > 0],
    ['parseShellBuild 삭제 → RED', () => constProblems(GOOD_CONST.replace(/export function parseShellBuild[^\n]*\n/, '')).length > 0],
    ['gradle versionCode 주입 삭제 → RED', () => gradleProblems('versionCode 1\n').length > 0],
    ['가이드 하드코딩 URL → RED', () => guideProblems(GOOD_GUIDE + `a.href = 'https://github.com/x/y/releases/download/apk-latest/app-debug.apk';\n`).length > 0],
    ['가이드가 상수 미사용 → RED', () => guideProblems('const x = 1;').length > 0],
  ];
  const failed = cases.filter(([, fn]) => !fn());
  if (failed.length) {
    console.error('check-apk-release-link: 셀프테스트 실패 — 게이트 자체가 공허하다(§4).');
    for (const [name] of failed) console.error(`  ✗ ${name}`);
    process.exit(2);
  }
}

selfTest();
if (process.argv.includes('--selftest')) {
  console.log('check-apk-release-link: 셀프테스트 통과');
  process.exit(0);
}

const GRADLE_PATH = 'android-shell/android/app/build.gradle';
const problems = [
  ...workflowProblems(readFileSync(WF_PATH, 'utf8')).map((m) => `${WF_PATH}: ${m}`),
  ...constProblems(readFileSync(CONST_PATH, 'utf8')).map((m) => `${CONST_PATH}: ${m}`),
  ...guideProblems(readFileSync(GUIDE_PATH, 'utf8')).map((m) => `${GUIDE_PATH}: ${m}`),
  ...gradleProblems(readFileSync(GRADLE_PATH, 'utf8')).map((m) => `${GRADLE_PATH}: ${m}`),
];

if (problems.length) {
  console.error('check-apk-release-link: 「항상 최신 APK」 계약이 갈라졌다.');
  for (const m of problems) console.error(`  ✗ ${m}`);
  process.exit(1);
}
console.log('check-apk-release-link: OK — 워크플로·상수·가이드가 같은 고정 주소 계약을 지킨다.');
