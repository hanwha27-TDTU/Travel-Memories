#!/usr/bin/env node
// check-node-version.mjs — **Node 판은 한 곳에서만 정한다.**
//
// 왜 생겼나(2026-07-26, 배포 2회 연속 실패):
//   `check-fn-size.mjs`가 `fs.globSync`(Node 22+)를 썼다. 로컬은 Node 22라 통과했고,
//   워크플로는 `node-version: '20'`을 **숫자로 박아** 두어서 CI에서만 죽었다.
//   그것도 "검사가 실패"한 게 아니라 **게이트가 실행조차 못 하고 SyntaxError로 죽었다** —
//   harness가 FAIL을 내므로 그 뒤 모든 배포가 막힌다. 돌지 못하는 게이트는 없는 게이트보다 나쁘다.
//
//   더 나쁜 건 **아무도 몰랐다**는 것이다. 병합 후 배포 결과를 확인하지 않아 빨간불이 두 번
//   쌓였다. 그래서 규칙이 둘 생겼다: ① Node 판은 SSOT ② 병합 후 배포 결론을 확인한다.
//
// 이 게이트가 잠그는 것:
//   ① `.nvmrc`가 있고 순수 메이저 판이다 (SSOT)
//   ② node를 세팅하는 워크플로는 **숫자를 박지 않고** `node-version-file: '.nvmrc'`를 쓴다
//   ③ `package.json`의 `engines.node` 하한이 `.nvmrc`와 같다
//
// 못 잡는 것: "이 API가 그 Node에 있는가"는 못 본다. 그건 **CI가 같은 판으로 도는 것**이
//   답이고, 이 게이트는 그 전제를 지킨다.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 워크플로 본문에서 하드코딩된 node-version을 찾는다(주석은 제외). */
export function hardcodedNodeVersions(yml) {
  return [...yml.replace(/^\s*#.*$/gm, '').matchAll(/node-version:\s*['"]?([\w.]+)/g)].map((m) => m[1]);
}

/** 워크플로가 `.nvmrc`를 참조하는가. */
export function usesVersionFile(yml) {
  return /node-version-file:\s*['"]?\.nvmrc/.test(yml);
}

/** `>=22` / `>=20.19` 같은 하한에서 메이저만 뽑는다. 형식이 낯설면 null. */
export function engineMajor(range) {
  const m = /^>=\s*(\d+)/.exec(String(range ?? '').trim());
  return m ? m[1] : null;
}

export function audit({ nvmrc, engines, workflows }) {
  const problems = [];
  if (nvmrc === null) {
    problems.push('.nvmrc가 없습니다 — Node 판의 SSOT를 만드세요(예: 22).');
    return problems;
  }
  if (!/^\d+$/.test(nvmrc.trim())) {
    problems.push(`.nvmrc가 "${nvmrc.trim()}" 입니다 — 메이저 판 하나만 적으세요(예: 22).`);
    return problems;
  }
  const major = nvmrc.trim();

  const em = engineMajor(engines);
  if (em === null) {
    problems.push('package.json의 engines.node가 없거나 ">=N" 형식이 아닙니다 — 하한을 선언하세요.');
  } else if (em !== major) {
    problems.push(`engines.node(>=${em})와 .nvmrc(${major})가 다릅니다 — 판은 한 곳에서만 정합니다.`);
  }

  for (const [name, yml] of workflows) {
    if (!/setup-node/.test(yml)) continue;
    const hard = hardcodedNodeVersions(yml);
    if (hard.length) {
      problems.push(`${name}: node-version을 '${hard.join("', '")}'로 박았습니다 — node-version-file: '.nvmrc'를 쓰세요.`);
    } else if (!usesVersionFile(yml)) {
      problems.push(`${name}: setup-node를 쓰는데 .nvmrc를 참조하지 않습니다 — 판이 암묵적이면 언젠가 어긋납니다.`);
    }
  }
  return problems;
}

// ── 비공허 자체검사 ─────────────────────────────────────────────────────────
let selfTestCount = 0;
{
  const okWf = [['ci.yml', "steps:\n  - uses: actions/setup-node@v4\n    with:\n      node-version-file: '.nvmrc'\n"]];
  const base = { nvmrc: '22\n', engines: '>=22', workflows: okWf };
  const cases = [
    { name: '전부 맞으면 정상', input: base, clean: true },
    {
      name: '워크플로에 판을 숫자로 박으면 검출(원래 결함이 정확히 이 형태)',
      input: { ...base, workflows: [['ci.yml', "- uses: actions/setup-node@v4\n  with:\n    node-version: '20'\n"]] },
      clean: false,
    },
    {
      name: 'setup-node를 쓰는데 .nvmrc를 안 보면 검출',
      input: { ...base, workflows: [['ci.yml', '- uses: actions/setup-node@v4\n']] },
      clean: false,
    },
    { name: '.nvmrc가 없으면 검출', input: { ...base, nvmrc: null }, clean: false },
    { name: '.nvmrc가 메이저 하나가 아니면 검출', input: { ...base, nvmrc: 'lts/*\n' }, clean: false },
    { name: 'engines가 없으면 검출', input: { ...base, engines: undefined }, clean: false },
    { name: 'engines와 .nvmrc가 다르면 검출', input: { ...base, engines: '>=20' }, clean: false },
    {
      name: 'setup-node를 안 쓰는 워크플로는 검사 대상이 아니다(오탐 방지)',
      input: { ...base, workflows: [['pages.yml', 'jobs:\n  deploy:\n    steps:\n      - uses: actions/deploy-pages@v4\n']] },
      clean: true,
    },
    {
      name: '주석 속 node-version 언급은 세지 않는다(오탐 방지)',
      input: {
        ...base,
        workflows: [['ci.yml', "  # 예전에는 node-version: '20' 이었다\n  - uses: actions/setup-node@v4\n    with:\n      node-version-file: '.nvmrc'\n"]],
      },
      clean: true,
    },
  ];
  const broken = cases.filter((c) => (audit(c.input).length === 0) !== c.clean);
  if (broken.length) {
    console.error(`check-node-version: 셀프테스트 실패 — 게이트가 공허함: ${broken.map((c) => c.name).join(', ')}`);
    process.exit(2);
  }
  selfTestCount = cases.length;
}

const WF_DIR = join(ROOT, '.github/workflows');
const workflows = existsSync(WF_DIR)
  ? readdirSync(WF_DIR)
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => [f, readFileSync(join(WF_DIR, f), 'utf8')])
  : [];
const nvmrcPath = join(ROOT, '.nvmrc');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const problems = audit({
  nvmrc: existsSync(nvmrcPath) ? readFileSync(nvmrcPath, 'utf8') : null,
  engines: pkg.engines?.node,
  workflows,
});
if (problems.length) {
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('check-node-version: Node 판이 여러 곳에서 따로 정해지고 있습니다.');
  process.exit(1);
}
console.log(`check-node-version: OK (셀프테스트 ${selfTestCount}건 · .nvmrc=${readFileSync(nvmrcPath, 'utf8').trim()} · 워크플로 ${workflows.length}개)`);
