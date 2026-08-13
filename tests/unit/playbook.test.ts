// tests/unit/playbook.test.ts — 설치 가이드(플레이북) 문서의 계약을 잠근다.
//
// 사용자 지시(2026-08-02): 플레이북은 앱이 업데이트되면 같이 갱신되고(기계화), 버전은
// 앱 버전과 통일돼야 한다. 이 문서는 손 사본이 아니라 SSOT(apk.ts·changelog)에서 조립되므로
// 드리프트가 원리적으로 불가능하다 — 아래 유닛이 그 「불가능」을 실제로 강제한다(§7 3층).

import { describe, it, expect } from 'vitest';
import { buildPlaybookHtml, buildPlaybookMarkdown, playbookFilename, PLAYBOOK_VERSION } from '../../src/app/playbook';
import { APK_LATEST_URL } from '../../src/app/apk';
import { INSTALLER_GUIDES, WINDOWS_LATEST_URL } from '../../src/app/installers';
import { CHANGELOG, DEVELOPER } from '../../src/app/changelog';

const md = buildPlaybookMarkdown();
const html = buildPlaybookHtml();

describe('플레이북 버전은 앱 버전과 통일된다', () => {
  it('PLAYBOOK_VERSION === changelog 맨 앞(앱 버전)', () => {
    expect(PLAYBOOK_VERSION).toBe(CHANGELOG[0].version);
  });
  it('두 형식·파일이름 모두 그 버전을 담는다', () => {
    expect(md).toContain(`v${PLAYBOOK_VERSION}`);
    expect(html).toContain(`v${PLAYBOOK_VERSION}`);
    expect(playbookFilename('html')).toContain(`v${PLAYBOOK_VERSION}`);
    expect(playbookFilename('md')).toBe(`${DEVELOPER.appName.replace(/\s+/g, '-')}-설치가이드-v${PLAYBOOK_VERSION}.md`);
  });
});

describe('플레이북은 SSOT에서 조립된다(손 사본 아님)', () => {
  it('두 플랫폼의 모든 설치 단계 제목이 두 형식에 다 들어간다', () => {
    for (const s of INSTALLER_GUIDES.flatMap((guide) => guide.steps)) {
      expect(md).toContain(s.title);
      expect(html).toContain(s.title);
    }
  });
  it('두 플랫폼의 모든 「알아두면 좋은 것」 사실이 두 형식에 다 들어간다', () => {
    for (const f of INSTALLER_GUIDES.flatMap((guide) => guide.facts)) {
      expect(md).toContain(f);
      // HTML은 <>&를 이스케이프하므로, 그 글자가 없는 사실은 그대로 들어간다.
      if (!/[<>&]/.test(f)) expect(html).toContain(f);
    }
  });
  it('두 고정 다운로드 주소와 앱 이름을 담는다', () => {
    expect(md).toContain(APK_LATEST_URL);
    expect(html).toContain(APK_LATEST_URL);
    expect(md).toContain(WINDOWS_LATEST_URL);
    expect(html).toContain(WINDOWS_LATEST_URL);
    expect(md).toContain(DEVELOPER.appName);
    expect(html).toContain(DEVELOPER.appName);
  });
});

describe('🔴 전문 용어를 쓰지 않는다 — 초등학생 기준(주소는 제외)', () => {
  // apkGuide.test.ts와 같은 규율(§10 ③). URL엔 'releases'가 들어가므로 검사에서 뺀다.
  const strip = (s: string) => s.split(APK_LATEST_URL).join('').split(WINDOWS_LATEST_URL).join('');
  it('Markdown 산문에 개발 용어가 없다', () => {
    expect(strip(md)).not.toMatch(/아티팩트|artifact|CI|워크플로|사이드로드|딥링크|릴리스|release/i);
  });
  it('HTML 산문에 개발 용어가 없다', () => {
    expect(strip(html)).not.toMatch(/아티팩트|artifact|워크플로|사이드로드|딥링크|릴리스/);
  });
});

describe('HTML은 자체완결(외부 자원 없음)', () => {
  it('http(s) 외부 링크는 다운로드 주소뿐 — 스타일·폰트를 밖에서 불러오지 않는다', () => {
    const externals = html.match(/https?:\/\/[^\s"')]+/g) ?? [];
    for (const u of externals) expect([APK_LATEST_URL, WINDOWS_LATEST_URL]).toContain(u);
    expect(html).not.toMatch(/<link[^>]+stylesheet|<script/i);
  });
});
