// app/installers.ts — Android와 Windows 설치 파일을 한 화면에서 보여 주는 공통 계약.
// 플랫폼별 빌드 계약은 apk.ts와 windows-installer.yml에 두고, 사용자에게 보이는
// 이름·주소·순서·쉬운 설명은 이 파일에서 한 번만 조립한다.

import { APK_FACTS, APK_INSTALL_STEPS, APK_LATEST_URL, REPO_SLUG } from './apk';
import { APP_VERSION, LAST_MODIFIED } from './changelog';

export const WINDOWS_RELEASE_TAG = 'windows-latest';
export const WINDOWS_ASSET_NAME = 'Bugeon-Journey-Windows-x64-setup.exe';
export const WINDOWS_LATEST_URL =
  `https://github.com/${REPO_SLUG}/releases/download/${WINDOWS_RELEASE_TAG}/${WINDOWS_ASSET_NAME}`;

export type InstallerPlatform = 'android' | 'windows';

export interface InstallerGuide {
  platform: InstallerPlatform;
  icon: string;
  name: string;
  button: string;
  url: string;
  meta: string;
  steps: ReadonlyArray<{ title: string; desc: string }>;
  facts: ReadonlyArray<string>;
}

const WINDOWS_INSTALL_STEPS: InstallerGuide['steps'] = [
  {
    title: '「Windows 설치파일 받기」 버튼을 눌러요',
    desc: `${WINDOWS_ASSET_NAME} 파일이 받아져요. 이 주소는 그대로 두어도 언제나 최신 설치파일을 줘요.`,
  },
  {
    title: '받은 파일을 두 번 눌러요',
    desc: '브라우저 오른쪽 위의 다운로드 목록이나 「다운로드」 폴더에서 파일을 찾으면 돼요.',
  },
  {
    title: 'Windows가 한 번 더 물으면 확인해요',
    desc: '개인용 앱이라 파란 경고창이 나올 수 있어요. 「추가 정보」를 누른 뒤 「실행」을 누르세요.',
  },
  {
    title: '설치가 끝나면 앱을 열어요',
    desc: '시작 메뉴에서 Bugeon Journey를 찾아 열면 돼요. 새 버전을 덮어 설치해도 여행 기록은 지워지지 않아요.',
  },
];

const WINDOWS_FACTS: InstallerGuide['facts'] = [
  'Windows 10 또는 Windows 11의 64비트 컴퓨터에서 사용해요.',
  '설치파일 크기는 약 5MB예요. 실행할 때 필요한 WebView2가 없으면 Windows가 따로 준비할 수 있어요.',
  '버튼 주소는 고정이에요. 새 설치본이 나오면 같은 자리에 기계가 최신 파일을 넣어요.',
  '아직 Microsoft의 유료 서명을 붙이지 않은 개인용 앱이라 처음 설치할 때 Windows 경고가 보일 수 있어요.',
];

export const INSTALLER_GUIDES: ReadonlyArray<InstallerGuide> = [
  {
    platform: 'android',
    icon: '📱',
    name: '안드로이드',
    button: '안드로이드 앱(APK) 받기',
    url: APK_LATEST_URL,
    meta: `앱 v${APP_VERSION} · ${LAST_MODIFIED} 갱신`,
    steps: APK_INSTALL_STEPS,
    facts: APK_FACTS,
  },
  {
    platform: 'windows',
    icon: '🪟',
    name: 'Windows',
    button: 'Windows 설치파일 받기',
    url: WINDOWS_LATEST_URL,
    meta: `앱 v${APP_VERSION} · 약 5MB · ${LAST_MODIFIED} 갱신`,
    steps: WINDOWS_INSTALL_STEPS,
    facts: WINDOWS_FACTS,
  },
];

/** 현재 기기의 설치 버튼을 먼저 둔다. 알 수 없으면 Android를 먼저 보여 기존 흐름을 보존한다. */
export function preferredInstallerPlatform(userAgent: string): InstallerPlatform {
  return /windows/i.test(userAgent) ? 'windows' : 'android';
}

export function orderedInstallerGuides(userAgent: string): ReadonlyArray<InstallerGuide> {
  const preferred = preferredInstallerPlatform(userAgent);
  return [...INSTALLER_GUIDES].sort((a, b) => Number(b.platform === preferred) - Number(a.platform === preferred));
}
