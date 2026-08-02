// tests/unit/apkGuide.test.ts — 앱 내 APK 설치 안내(SSOT: src/app/apk.ts).
//
// 이 문장들은 전부 사용자에게 나간다(§10 ③). 특히 두 계약을 잠근다:
//   ① 주소는 고정 릴리스 형식 하나뿐이다 — 워크플로와의 대조는 check-apk-release-link가 한다.
//   ② 안내는 **초등학생도 이해할 수 있어야** 한다(사용자 지시 2026-08-01) — 개발 용어가
//      섞이면 RED. 조항만으로는 다음 편집에서 또 섞인다(§7 — 관측된 사실이다).

import { describe, it, expect } from 'vitest';
import { APK_LATEST_URL, APK_RELEASE_TAG, APK_RELEASE_API, APK_INSTALL_STEPS, APK_FACTS, parseShellBuild } from '../../src/app/apk';

describe('셸 업데이트 감지 (§5-2 · 함정 D)', () => {
  it('API는 자산이 아니라 릴리스 설명을 읽는 api.github.com 주소다(CORS로 막히지 않는 유일 경로)', () => {
    expect(APK_RELEASE_API).toBe(
      `https://api.github.com/repos/hanwha27-TDTU/Travel-Memories/releases/tags/${APK_RELEASE_TAG}`,
    );
  });
  it('CI가 심는 마커 형식에서 versionCode를 뽑는다', () => {
    expect(parseShellBuild('앞말\n<!-- shell-version: {"versionCode": 42} -->')).toBe(42);
    expect(parseShellBuild('<!-- shell-version: {"versionCode": 7, "x": 1} -->')).toBe(7);
  });
  it('마커가 없거나(옛 릴리스) 깨졌으면 null — 모르면 배너를 띄우지 않는다', () => {
    expect(parseShellBuild('최신 빌드: abc1234 · 2026-08-02')).toBeNull();
    expect(parseShellBuild('<!-- shell-version: {broken -->')).toBeNull();
    expect(parseShellBuild('<!-- shell-version: {"versionCode": "x"} -->')).toBeNull();
    expect(parseShellBuild('')).toBeNull();
  });
});

describe('APK 고정 주소', () => {
  it('릴리스 고정 형식 그대로다(태그가 주소 안에 있다)', () => {
    expect(APK_LATEST_URL).toBe(
      `https://github.com/hanwha27-TDTU/Travel-Memories/releases/download/${APK_RELEASE_TAG}/app-debug.apk`,
    );
    expect(APK_RELEASE_TAG).toBe('apk-latest');
  });
});

describe('설치 안내 — 초등학생 기준(사용자 지시)', () => {
  const all = [
    ...APK_INSTALL_STEPS.flatMap((s) => [s.title, s.desc]),
    ...APK_FACTS,
  ].join(' ');

  it('단계가 비어 있지 않고 각 단계에 제목·설명이 다 있다', () => {
    expect(APK_INSTALL_STEPS.length).toBeGreaterThanOrEqual(4);
    for (const s of APK_INSTALL_STEPS) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.desc.length).toBeGreaterThan(0);
    }
  });

  it('🔴 개발 용어를 쓰지 않는다 — 아티팩트·CI·워크플로·사이드로드·딥링크·릴리스', () => {
    expect(all).not.toMatch(/아티팩트|artifact|CI|워크플로|사이드로드|딥링크|릴리스|release/i);
  });

  it('경고 화면을 만나도 멈추지 않게 — 「무시하고 설치」까지 말해 준다', () => {
    expect(all).toContain('무시하고 설치');
  });

  it('덮어 설치해도 기록이 안 지워진다는 사실을 말해 준다(설치를 겁내지 않게)', () => {
    expect(all).toContain('지워지지 않아요');
  });

  it('🔴 「항상 최신」 사실을 말해 준다 — 버튼 주소가 고정이고 기계가 갈아 끼운다는 것', () => {
    expect(all).toMatch(/항상 최신|언제 눌러도/);
  });
});
