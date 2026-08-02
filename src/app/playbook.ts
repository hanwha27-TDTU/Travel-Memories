// app/playbook.ts — **앱 설치 가이드(플레이북)를 내려받을 수 있게 문서로 만든다.**
//
// 사용자 지시(2026-08-02): *"앱 가이드 내에 APK 설치 플레이북을 다운로드 받을 수 있게.
// 업데이트되면 같이 업데이트되도록 기계화. 다른 앱들도 그대로 재현할 수 있는 수준으로.
// 플레이북 버전관리는 앱 버전과 통일."*
//
// 🔴 **드리프트가 원리적으로 불가능하게 만든다(§7).** 이 문서는 손으로 쓴 사본이 아니라,
//    화면 가이드가 쓰는 **바로 그 SSOT**(`apk.ts`의 설치 순서·사실 + `changelog.ts`의 버전)에서
//    실행 시점에 조립된다. 그래서:
//      · 앱이 업데이트되면(설치 순서·문구·버전이 바뀌면) 이 문서도 **자동으로** 그대로 바뀐다.
//      · 버전은 changelog 맨 앞(앱 버전)에서 오므로 **앱 버전과 항상 통일**된다.
//      · 앱 고유 부분(이름·주소)만 주입되므로, 같은 셸 구조를 쓰는 **다른 앱도 그대로 재현**한다.
//    유닛(playbook.test.ts)이 「버전이 앱 버전과 같은가·모든 단계가 들어갔는가·전문용어가
//    섞이지 않았는가」를 잠근다 — 조항이 아니라 기계가 통일을 강제한다.

import { APK_LATEST_URL, APK_INSTALL_STEPS, APK_FACTS } from './apk';
import { CHANGELOG, DEVELOPER } from './changelog';

/** 플레이북 버전 = 앱 버전(changelog 맨 앞). 별도로 적지 않는다 — 그 순간 두 진실이 생긴다. */
export const PLAYBOOK_VERSION = CHANGELOG[0].version;

/** 앱 이름(SSOT) — 다른 앱으로 재현할 때 여기만 바뀌면 문서 전체가 따라온다. */
const APP_NAME = DEVELOPER.appName;

/** 내려받을 때의 파일 이름. 버전이 이름에 박혀 어느 버전 가이드인지 파일만 봐도 안다. */
export function playbookFilename(ext: 'html' | 'md'): string {
  const slug = APP_NAME.replace(/\s+/g, '-');
  return `${slug}-설치가이드-v${PLAYBOOK_VERSION}.${ext}`;
}

const INTRO =
  `이 문서는 ${APP_NAME} 앱 안에서 자동으로 만들어졌어요. 앱이 업데이트되면 이 가이드도 ` +
  `같은 버전으로 함께 갱신돼요 — 그래서 지금 보시는 순서가 늘 최신이에요.`;

const WHY =
  '휴대폰(안드로이드)은 사진을 웹 화면에 넘길 때 사진에 담긴 장소를 지워서 넘겨요. ' +
  '그래서 웹으로만 쓰면 사진의 장소가 안 들어와요. 앱으로 설치하면 장소가 살아 있는 ' +
  '원본 그대로 받을 수 있어요. (컴퓨터에서는 웹으로 쓰셔도 장소가 살아요.)';

const REUSE_NOTE =
  '이 가이드의 내려받기 주소는 고정이라 언제 눌러도 항상 최신 앱이 받아져요. ' +
  '즐겨찾기해 두거나, 이 문서를 다른 사람·다른 기기에 그대로 전달해도 돼요.';

/** 순서·사실 데이터를 한 곳에서 꺼낸다(두 형식이 같은 재료를 쓰게). */
function parts() {
  return {
    steps: APK_INSTALL_STEPS.map((s, i) => ({ n: i + 1, title: s.title, desc: s.desc })),
    facts: [...APK_FACTS],
    url: APK_LATEST_URL,
    version: PLAYBOOK_VERSION,
    appName: APP_NAME,
  };
}

/** Markdown — 가장 단순·이식성 최고. 다른 앱/사람이 그대로 복사해 재현하기 좋다. */
export function buildPlaybookMarkdown(): string {
  const { steps, facts, url, version, appName } = parts();
  const lines: string[] = [];
  lines.push(`# ${appName} 설치 가이드 (v${version})`, '');
  lines.push(`> ${INTRO}`, '');
  lines.push('## 앱을 왜 따로 설치하나요', '', WHY, '');
  lines.push('## 설치 순서 (한 번만 하면 돼요)', '');
  for (const s of steps) lines.push(`${s.n}. **${s.title}** — ${s.desc}`);
  lines.push('', `**최신 앱 내려받기:** ${url}`, '');
  lines.push('## 알아두면 좋은 것', '');
  for (const f of facts) lines.push(`- ${f}`);
  lines.push('', '## 다른 기기·다른 사람에게', '', REUSE_NOTE, '');
  lines.push('---', '', `${appName} · 설치 가이드 v${version} · 이 문서는 앱에서 자동 생성되었습니다.`, '');
  return lines.join('\n');
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 자체완결 HTML — 한 파일로 예쁘게 렌더되고 오프라인에서도 열린다(외부 자원 없음). */
export function buildPlaybookHtml(): string {
  const { steps, facts, url, version, appName } = parts();
  const stepsHtml = steps
    .map((s) => `<li><b>${esc(s.title)}</b><span>${esc(s.desc)}</span></li>`)
    .join('');
  const factsHtml = facts.map((f) => `<li>${esc(f)}</li>`).join('');
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(appName)} 설치 가이드 v${version}</title>
<style>
  :root{color-scheme:light dark}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;
    line-height:1.65;color:#1c2430;background:#f4f6fb;padding:24px}
  .wrap{max-width:680px;margin:0 auto;background:#fff;border-radius:18px;padding:28px 24px;
    box-shadow:0 8px 30px rgba(20,30,60,.08)}
  h1{font-size:1.5rem;margin:0 0 4px}
  .ver{display:inline-block;font-size:.8rem;font-weight:700;color:#0b5;background:#e7f8ef;
    border-radius:999px;padding:2px 10px;margin-bottom:14px}
  .intro{color:#5a6675;font-size:.95rem;margin:0 0 20px}
  h2{font-size:1.1rem;margin:26px 0 10px;padding-top:14px;border-top:1px solid #eef1f6}
  ol.steps{list-style:none;counter-reset:s;padding:0;margin:0}
  ol.steps li{counter-increment:s;position:relative;padding:12px 12px 12px 46px;margin:8px 0;
    background:#f7f9fc;border-radius:12px}
  ol.steps li::before{content:counter(s);position:absolute;left:12px;top:12px;width:24px;height:24px;
    border-radius:50%;background:#2b6ccb;color:#fff;font-weight:700;font-size:.85rem;
    display:flex;align-items:center;justify-content:center}
  ol.steps b{display:block;margin-bottom:2px}
  ol.steps span{color:#5a6675;font-size:.92rem}
  .dl{display:inline-block;margin:6px 0 4px;padding:13px 20px;background:#2b6ccb;color:#fff;
    font-weight:700;border-radius:12px;text-decoration:none}
  .dl small{display:block;font-weight:400;font-size:.75rem;opacity:.85;word-break:break-all}
  ul.facts{padding-left:18px;margin:0}
  ul.facts li{margin:8px 0;color:#38424f}
  footer{margin-top:26px;padding-top:14px;border-top:1px solid #eef1f6;color:#8a95a3;font-size:.8rem}
  @media (prefers-color-scheme:dark){
    body{background:#0e131b;color:#dfe6ef}.wrap{background:#161d27;box-shadow:none}
    .intro,ol.steps span{color:#9aa7b6}.ver{background:#0d3324;color:#5fd6a0}
    ol.steps li{background:#1d2733}h2{border-color:#232d3a}ul.facts li{color:#c4ceda}
    footer{border-color:#232d3a}
  }
</style></head><body><div class="wrap">
  <h1>${esc(appName)} 설치 가이드</h1>
  <div class="ver">v${version}</div>
  <p class="intro">${esc(INTRO)}</p>
  <h2>앱을 왜 따로 설치하나요</h2>
  <p>${esc(WHY)}</p>
  <h2>설치 순서 (한 번만 하면 돼요)</h2>
  <ol class="steps">${stepsHtml}</ol>
  <a class="dl" href="${esc(url)}">⬇️ 최신 앱 내려받기<small>${esc(url)}</small></a>
  <h2>알아두면 좋은 것</h2>
  <ul class="facts">${factsHtml}</ul>
  <h2>다른 기기·다른 사람에게</h2>
  <p>${esc(REUSE_NOTE)}</p>
  <footer>${esc(appName)} · 설치 가이드 v${version} · 이 문서는 앱에서 자동 생성되었습니다.</footer>
</div></body></html>
`;
}
