import { describe, expect, it } from 'vitest';
import {
  INSTALLER_GUIDES,
  WINDOWS_ASSET_NAME,
  WINDOWS_LATEST_URL,
  WINDOWS_RELEASE_TAG,
  orderedInstallerGuides,
  preferredInstallerPlatform,
} from '../../src/app/installers';
import { APP_VERSION, LAST_MODIFIED } from '../../src/app/changelog';

describe('통합 설치파일 안내', () => {
  it('Android와 Windows를 형제로 모두 제공한다', () => {
    expect(INSTALLER_GUIDES.map((guide) => guide.platform)).toEqual(['android', 'windows']);
  });

  it('Windows는 고정 태그와 고정 자산 이름을 쓴다', () => {
    expect(WINDOWS_RELEASE_TAG).toBe('windows-latest');
    expect(WINDOWS_ASSET_NAME).toBe('Bugeon-Journey-Windows-x64-setup.exe');
    expect(WINDOWS_LATEST_URL).toBe(
      `https://github.com/hanwha27-TDTU/Travel-Memories/releases/download/${WINDOWS_RELEASE_TAG}/${WINDOWS_ASSET_NAME}`,
    );
  });

  it('현재 Windows 기기에서는 Windows 버튼을 먼저 둔다', () => {
    expect(preferredInstallerPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
    expect(orderedInstallerGuides('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')[0]?.platform).toBe('windows');
    expect(orderedInstallerGuides('Mozilla/5.0 (Linux; Android 15)')[0]?.platform).toBe('android');
  });

  it('버전과 날짜는 changelog 정본에서 따라온다', () => {
    for (const guide of INSTALLER_GUIDES) {
      expect(guide.meta).toContain(`v${APP_VERSION}`);
      expect(guide.meta).toContain(LAST_MODIFIED);
    }
  });

  it('초등학생 안내에 개발 배포 용어가 없다', () => {
    const prose = INSTALLER_GUIDES.flatMap((guide) => [
      guide.button,
      ...guide.steps.flatMap((step) => [step.title, step.desc]),
      ...guide.facts,
    ]).join(' ');
    expect(prose).not.toMatch(/아티팩트|artifact|CI|워크플로|사이드로드|딥링크|릴리스|release/i);
  });
});
