#!/usr/bin/env node
// Android·Windows의 「항상 최신 설치파일」 계약을 한 번에 검사한다.
// 파일명은 기존 하네스 등록과 호환하려고 유지한다.
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');

export function androidWorkflowProblems(text) {
  const p = [];
  if (!/permissions:\s*\n\s*contents:\s*write/.test(text)) p.push('Android 릴리스 쓰기 권한이 없다');
  if (!/gh release upload apk-latest [^\n]*--clobber/.test(text)) p.push('apk-latest --clobber 업로드가 없다');
  if (!/if:\s*github\.ref == 'refs\/heads\/main'/.test(text)) p.push('Android 릴리스 main 조건이 없다');
  if (!/APP_VERSION_CODE=\$\{\{ github\.run_number \}\}/.test(text)) p.push('Android versionCode 증가 주입이 없다');
  if (!/shell-version:/.test(text)) p.push('Android shell-version 마커가 없다');
  return p;
}

export function windowsWorkflowProblems(text) {
  const p = [];
  if (!/permissions:\s*\n\s*contents:\s*write/.test(text)) p.push('Windows 릴리스 쓰기 권한이 없다');
  if (!/gh release upload \$tag \$exe \$sha --clobber/.test(text)) p.push('windows-latest --clobber 업로드가 없다');
  if (!/\$tag = 'windows-latest'/.test(text)) p.push('Windows 고정 태그가 없다');
  if (!/Bugeon-Journey-Windows-x64-setup\.exe/.test(text)) p.push('Windows 고정 자산 이름이 없다');
  if (!/github\.ref == 'refs\/heads\/main'/.test(text)) p.push('Windows 릴리스 main 조건이 없다');
  if (!/Get-FileHash[\s\S]*gh release download[\s\S]*Get-FileHash/.test(text)) p.push('Windows 업로드 read-back 해시 검증이 없다');
  if (!/npm run windows:build/.test(text)) p.push('Windows 전용 빌드 명령을 쓰지 않는다');
  return p;
}

export function constantsProblems(apk, installers) {
  const p = [];
  if (!/APK_RELEASE_TAG = 'apk-latest'/.test(apk) || !/app-debug\.apk/.test(apk)) p.push('Android 고정 주소 계약이 없다');
  if (!/APK_RELEASE_API/.test(apk) || !/export function parseShellBuild/.test(apk)) p.push('Android 셸 업데이트 감지 계약이 없다');
  if (!/WINDOWS_RELEASE_TAG = 'windows-latest'/.test(installers)) p.push('Windows 고정 태그 상수가 없다');
  if (!/WINDOWS_ASSET_NAME = 'Bugeon-Journey-Windows-x64-setup\.exe'/.test(installers)) p.push('Windows 고정 자산 상수가 없다');
  if (!/WINDOWS_LATEST_URL[\s\S]*releases\/download/.test(installers)) p.push('Windows 고정 다운로드 주소가 없다');
  if (!/APK_LATEST_URL/.test(installers)) p.push('통합 설치 목록이 Android 고정 주소를 읽지 않는다');
  return p;
}

export function guideProblems(text) {
  const p = [];
  if (!/orderedInstallerGuides/.test(text)) p.push('가이드가 통합 설치 목록을 쓰지 않는다');
  if (!/label: '설치파일 다운로드'/.test(text)) p.push('통합 설치파일 카드가 없다');
  if (/github\.com\/.+releases\/download/.test(text)) p.push('가이드가 다운로드 주소를 손으로 복제했다');
  return p;
}

function selfTest() {
  const goodAndroid = `permissions:\n  contents: write\nif: github.ref == 'refs/heads/main'\n-PAPP_VERSION_CODE=\${{ github.run_number }}\ngh release upload apk-latest "$APK" --clobber\nshell-version:`;
  const goodWindows = `permissions:\n  contents: write\nif: github.ref == 'refs/heads/main'\n$tag = 'windows-latest'\nnpm run windows:build\nBugeon-Journey-Windows-x64-setup.exe\nGet-FileHash\ngh release upload $tag $exe $sha --clobber\ngh release download\nGet-FileHash`;
  const goodApk = `APK_RELEASE_TAG = 'apk-latest'; app-debug.apk; APK_RELEASE_API; export function parseShellBuild(){}`;
  const goodInstallers = `APK_LATEST_URL; WINDOWS_RELEASE_TAG = 'windows-latest'; WINDOWS_ASSET_NAME = 'Bugeon-Journey-Windows-x64-setup.exe'; WINDOWS_LATEST_URL = releases/download`;
  const goodGuide = `orderedInstallerGuides(); label: '설치파일 다운로드'`;
  const checks = [
    androidWorkflowProblems(goodAndroid).length === 0,
    windowsWorkflowProblems(goodWindows).length === 0,
    constantsProblems(goodApk, goodInstallers).length === 0,
    guideProblems(goodGuide).length === 0,
    androidWorkflowProblems(goodAndroid.replace(' --clobber', '')).length > 0,
    windowsWorkflowProblems(goodWindows.replace('gh release download', 'download removed')).length > 0,
    constantsProblems(goodApk, goodInstallers.replace('windows-latest', 'windows-old')).length > 0,
    guideProblems('const empty = true').length > 0,
  ];
  if (checks.some((v) => !v)) {
    console.error('check-apk-release-link: 셀프테스트 실패 — 알려진 결함을 잡지 못합니다.');
    process.exit(2);
  }
}

selfTest();
if (process.argv.includes('--selftest')) {
  console.log('check-apk-release-link: Android·Windows 실패 주입 셀프테스트 통과');
  process.exit(0);
}

const problems = [
  ...androidWorkflowProblems(read('.github/workflows/android-apk.yml')).map((p) => `Android: ${p}`),
  ...windowsWorkflowProblems(read('.github/workflows/windows-installer.yml')).map((p) => `Windows: ${p}`),
  ...constantsProblems(read('src/app/apk.ts'), read('src/app/installers.ts')).map((p) => `상수: ${p}`),
  ...guideProblems(read('src/ui/screens/guide.ts')).map((p) => `가이드: ${p}`),
];
if (problems.length) {
  console.error(`check-apk-release-link: 설치파일 계약 위반 ${problems.length}건\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('check-apk-release-link: OK — Android·Windows 워크플로·고정 주소·통합 가이드가 일치합니다.');
