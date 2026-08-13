// app/playbook.ts — 앱 화면과 같은 설치 안내를 HTML/Markdown 파일로 만든다.
// 화면과 문서가 INSTALLER_GUIDES를 함께 읽으므로 Android·Windows 안내가 갈라지지 않는다.

import { INSTALLER_GUIDES } from './installers';
import { CHANGELOG, DEVELOPER } from './changelog';

export const PLAYBOOK_VERSION = CHANGELOG[0].version;
const APP_NAME = DEVELOPER.appName;

export function playbookFilename(ext: 'html' | 'md'): string {
  return `${APP_NAME.replace(/\s+/g, '-')}-설치가이드-v${PLAYBOOK_VERSION}.${ext}`;
}

const INTRO =
  `이 문서는 ${APP_NAME} 앱 안에서 자동으로 만들어졌어요. 앱이 업데이트되면 이 가이드도 ` +
  `같은 버전으로 함께 바뀌므로 지금 보시는 순서가 늘 최신이에요.`;

export function buildPlaybookMarkdown(): string {
  const lines = [`# ${APP_NAME} 설치 가이드 (v${PLAYBOOK_VERSION})`, '', `> ${INTRO}`, ''];
  for (const guide of INSTALLER_GUIDES) {
    lines.push(`## ${guide.icon} ${guide.name} 설치`, '', guide.meta, '');
    guide.steps.forEach((step, index) => lines.push(`${index + 1}. **${step.title}** — ${step.desc}`));
    lines.push('', `**${guide.button}:** ${guide.url}`, '', '### 알아두면 좋은 것', '');
    guide.facts.forEach((fact) => lines.push(`- ${fact}`));
    lines.push('');
  }
  lines.push('---', '', `${APP_NAME} · 설치 가이드 v${PLAYBOOK_VERSION} · 앱에서 자동 생성`, '');
  return lines.join('\n');
}

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildPlaybookHtml(): string {
  const sections = INSTALLER_GUIDES.map((guide) => {
    const steps = guide.steps.map((step) => `<li><b>${esc(step.title)}</b><span>${esc(step.desc)}</span></li>`).join('');
    const facts = guide.facts.map((fact) => `<li>${esc(fact)}</li>`).join('');
    return `<section><h2>${guide.icon} ${esc(guide.name)} 설치</h2><p class="meta">${esc(guide.meta)}</p>` +
      `<ol>${steps}</ol><a class="dl" href="${esc(guide.url)}">⬇️ ${esc(guide.button)}</a>` +
      `<h3>알아두면 좋은 것</h3><ul>${facts}</ul></section>`;
  }).join('');
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(APP_NAME)} 설치 가이드 v${PLAYBOOK_VERSION}</title>
<style>
:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;padding:24px;background:#f4f6fb;color:#1c2430;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.65}.wrap{max-width:720px;margin:auto;padding:28px 24px;border-radius:18px;background:#fff;box-shadow:0 8px 30px #14203c14}h1{margin:0}.intro,.meta{color:#657181}section{margin-top:24px;padding-top:8px;border-top:1px solid #e8edf4}ol{list-style:none;counter-reset:s;padding:0}ol li{counter-increment:s;position:relative;margin:8px 0;padding:12px 12px 12px 46px;border-radius:12px;background:#f7f9fc}ol li:before{content:counter(s);position:absolute;left:12px;top:12px;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;background:#2b6ccb;color:#fff;font-weight:700}ol b,ol span{display:block}ol span{color:#657181;font-size:.92rem}.dl{display:inline-block;padding:13px 20px;border-radius:12px;background:#2b6ccb;color:#fff;text-decoration:none;font-weight:700}footer{margin-top:26px;color:#8691a0;font-size:.8rem}@media(prefers-color-scheme:dark){body{background:#0e131b;color:#dfe6ef}.wrap{background:#161d27}.intro,.meta,ol span{color:#a7b2c0}section{border-color:#293442}ol li{background:#1d2733}}
</style></head><body><main class="wrap"><h1>${esc(APP_NAME)} 설치 가이드</h1><p class="intro">v${PLAYBOOK_VERSION} · ${esc(INTRO)}</p>${sections}<footer>${esc(APP_NAME)} · 설치 가이드 v${PLAYBOOK_VERSION} · 앱에서 자동 생성</footer></main></body></html>`;
}
