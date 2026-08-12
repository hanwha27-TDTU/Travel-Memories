// gen-registry.mjs — 손으로 세던 카운트·목록을 SSOT에서 자동 생성한다(LESSONS §7).
//
// 발전원(SSOT) → src/app/registry.gen.ts(파생) → UI가 읽음. 손편집 금지.
// check-registry-gen 게이트가 "커밋본 == 재생성본"을 강제해 드리프트를 RED로 잡는다.
// 사용: node scripts/gen-registry.mjs  (파일 갱신) / --check (표준출력만, 게이트용)

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
// 🔴 검출 로직을 **다시 구현하지 않는다**(§2 — 손편집 중복 자체가 결함). 게이트와 생성기가
//    같은 함수를 쓰므로, 판정이 갈라질 수 없다. `check-gate-control`은 import에서 검사를
//    돌지 않도록 `isMain` 가드를 갖고 있다.
import {
  gateScripts,
  stripComments,
  hasControl,
  declaresSelftest,
  declaresSelfCheckExit,
} from './check-gate-control.mjs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src/app/registry.gen.ts');

/**
 * 문서 산문 카운트 마커를 심을 파일들(있는 것만). SSOT는 registry(collect()).
 *
 * 🔴 어댑터(`CLAUDE.md`·`AGENTS.md`)는 **여기 넣지 않는다.** 그 두 파일의 마커 사이는
 * `docs/CONSTITUTION.md`에서 생성되므로, 마커를 심어야 할 자리는 **정본 하나**다.
 * 어댑터에 직접 심으면 한쪽(DOC_FILES에 든 쪽)만 갱신돼 두 AI가 다른 숫자를 읽는다 — §14가
 * 막으려는 바로 그 상태다. 어댑터의 값은 `check-adapter-parity`가 글자 단위로 보증한다.
 */
export const DOC_FILES = ['docs/HANDOFF.md', 'README.md', 'docs/CONSTITUTION.md', 'docs/AGENT_REGISTRY.md'];

/** 마커: <!--reg:KEY-->값<!--/reg-->. KEY는 registry 카운트 키. */
const MARKER_RE = /<!--reg:(\w+)-->(.*?)<!--\/reg-->/g;

/** text 안의 모든 마커를 [{key, value, ok, expected}]로. reg가 있으면 대조도 채운다. */
export function findMarkers(text, reg) {
  const out = [];
  for (const m of text.matchAll(MARKER_RE)) {
    const key = m[1];
    const value = m[2];
    const known = reg ? Object.prototype.hasOwnProperty.call(reg, key) : true;
    const expected = reg && known ? String(reg[key]) : null;
    out.push({ key, value, known, expected, ok: reg ? known && value === expected : true });
  }
  return out;
}

/** 마커 값을 reg 카운트로 다시 심는다(순수). 알 수 없는 KEY는 그대로 둔다. */
export function patchMarkers(text, reg) {
  return text.replace(MARKER_RE, (whole, key) =>
    Object.prototype.hasOwnProperty.call(reg, key)
      ? `<!--reg:${key}-->${String(reg[key])}<!--/reg-->`
      : whole,
  );
}

/** SSOT들에서 카운트·목록을 실측한다. */
export function collect() {
  const harness = readFileSync(join(ROOT, 'scripts/harness.mjs'), 'utf8');
  const gates = [...harness.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]);

  const countFiles = (dir, ext) =>
    readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(ext)).length;

  const changelog = readFileSync(join(ROOT, 'src/app/changelog.ts'), 'utf8');
  const research = readFileSync(join(ROOT, 'src/app/researchLog.ts'), 'utf8');

  // 최신 버전 = CHANGELOG의 첫 항목(changelog.ts의 APP_VERSION과 같은 사실).
  // 여기서 파생하는 이유: 홈 화면이 버전 한 줄 때문에 CHANGELOG 전문(80KB)을 첫 로드에
  // 끌고 오지 않게 하려면 changelog.ts를 정적으로 import하면 안 된다. 손편집 중복이
  // 아니라 생성물이므로 check-registry-gen이 드리프트를 RED로 잡는다.
  const appVersion = changelog.match(/version:\s*'([^']+)'/)?.[1] ?? '';
  if (!appVersion) throw new Error('gen-registry: changelog.ts에서 최신 version을 찾지 못했습니다.');

  // 에이전트 정의 목록 — 파일명이 아니라 **내용**으로 고른다(README·잡파일 제외).
  const agentDir = join(ROOT, '.claude/agents');
  const agents = readdirSync(agentDir)
    .filter((f) => f.endsWith('.md'))
    .filter((f) => {
      const t = readFileSync(join(agentDir, f), 'utf8');
      return /^---[\s\S]*?^name:\s*\S/m.test(t) && /^---[\s\S]*?^description:\s*\S/m.test(t);
    })
    .map((f) => f.replace(/\.md$/, ''))
    .sort();

  // 게이트의 **대조군 현황**(§4). 앱의 「개발자 정보」가 이 값을 그대로 비춘다 —
  // 🔴 앱은 게이트가 **실제로 돌았는지 볼 수 없다.** 여기 있는 것은 저장소에 적힌 계약이고,
  //    화면도 그렇게 말해야 한다(§8 — 앱이 판정하는 척하면 그 초록이 거짓이 된다).
  const gateControl = gateScripts(harness)
    .filter((g) => existsSync(join(ROOT, g.script)))
    .map((g) => {
      const code = stripComments(readFileSync(join(ROOT, g.script), 'utf8'));
      return {
        name: g.name,
        control: hasControl(code),
        runnable: declaresSelftest(code),
        cleanExit: declaresSelfCheckExit(code),
      };
    });

  return {
    gates,
    gateCount: gates.length,
    gateControl,
    gateControlCount: gateControl.filter((g) => g.control).length,
    gateRunnableCount: gateControl.filter((g) => g.runnable).length,
    gateCleanExitCount: gateControl.filter((g) => g.cleanExit).length,
    appVersion,
    // 🔴 **이름이 아니라 행동으로 판정한다**(gates 헌장 §2-I). 예전엔 `.md` 확장자만 세서
    // `README.md`가 에이전트 1개로 잡혔고, 가이드 화면이 **28개**라고 말했다(실제 27개).
    // 기계화됐다는 이유로 아무도 그 숫자를 의심하지 않았다 — 형제인 skillCount는 이미
    // 「실제 SKILL.md만 센다」로 행동 판정을 하고 있었는데 여기만 빠져 있었다(§7 비대칭).
    // 판정 기준: frontmatter에 `name:`과 `description:`이 둘 다 있는 파일 = 에이전트 정의.
    agents,
    agentCount: agents.length,
    /** `docs/AGENT_REGISTRY.md`의 논리 역할 행 수(정본). 가이드가 「139개」를 손으로 적지 않게. */
    logicalRoleCount: (readFileSync(join(ROOT, 'docs/AGENT_REGISTRY.md'), 'utf8')
      .match(/^\| *\d+ *\|/gm) ?? []).length,
    // 디렉터리 수가 아니라 실제 SKILL.md 수를 센다(빈 폴더·잡파일에 흔들리지 않게).
    skillCount: readdirSync(join(ROOT, '.claude/skills'), { withFileTypes: true }).filter(
      (d) => d.isDirectory() && existsSync(join(ROOT, '.claude/skills', d.name, 'SKILL.md')),
    ).length,
    screenCount: countFiles('src/ui/screens', '.ts'),
    migrationCount: countFiles('supabase/migrations', '.sql'),
    changelogCount: (changelog.match(/version:\s*'/g) || []).length,
    researchCount: (research.match(/seq:\s*\d+/g) || []).length,
  };
}

/** 결정적 TS 파일 문자열(손편집 금지 헤더 포함). */
export function render(reg) {
  const gateLines = reg.gates.map((g) => `  '${g}',`).join('\n');
  const agentLines = reg.agents.map((a) => `  '${a}',`).join('\n');
  const controlLines = reg.gateControl
    .map((g) => `    { name: '${g.name}', control: ${g.control}, runnable: ${g.runnable}, cleanExit: ${g.cleanExit} },`)
    .join('\n');
  return `// GENERATED — 손으로 편집하지 마세요. 재생성: node scripts/gen-registry.mjs
// SSOT: scripts/harness.mjs · .claude/{agents,skills}/ · src/ui/screens/ · supabase/migrations/ · src/app/{changelog,researchLog}.ts
// check-registry-gen 게이트가 이 파일이 SSOT와 일치하는지(커밋본==재생성본) 검사합니다.

export const REGISTRY = {
  /** npm run harness가 도는 Required 게이트 이름(정본: scripts/harness.mjs). */
  gates: [
${gateLines}
  ] as const,
  gateCount: ${reg.gateCount},
  /**
   * 게이트의 **대조군 현황**(§4). 세 축 — 대조군 보유 · 밖에서 돌려 볼 수 있음 ·
   * 실패를 판정(exit 2)으로 알림.
   *
   * 🔴 **이것은 「검사가 통과했다」가 아니다.** 앱은 게이트가 실제로 돌았는지 **볼 수 없다**
   *    (CI는 앱 밖이다 · diagGroups의 ERRORS-GATE-HEALTH). 여기 있는 값은 **저장소에 적힌
   *    계약**이고, 화면도 반드시 그렇게 말해야 한다 — 앱이 판정하는 척하면 그 초록이 거짓이 된다(§8).
   */
  gateControl: [
${controlLines}
  ] as const,
  gateControlCount: ${reg.gateControlCount},
  gateRunnableCount: ${reg.gateRunnableCount},
  gateCleanExitCount: ${reg.gateCleanExitCount},
  /** 최신 앱 버전(정본: src/app/changelog.ts의 첫 항목). 첫 로드 화면은 이걸 읽는다. */
  appVersion: '${reg.appVersion}',
  /** 에이전트 정의 이름(정본: .claude/agents/ — frontmatter가 있는 파일만). */
  agents: [
${agentLines}
  ] as const,
  agentCount: ${reg.agentCount},
  /** docs/AGENT_REGISTRY.md의 논리 역할 수. 가이드가 손으로 「139개」를 적지 않게. */
  logicalRoleCount: ${reg.logicalRoleCount},
  skillCount: ${reg.skillCount},
  screenCount: ${reg.screenCount},
  migrationCount: ${reg.migrationCount},
  changelogCount: ${reg.changelogCount},
  researchCount: ${reg.researchCount},
} as const;
`;
}

// 직접 실행 시: --check면 표준출력, 아니면 파일 갱신.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const reg = collect();
  const out = render(reg);
  if (process.argv.includes('--check')) {
    process.stdout.write(out);
  } else {
    writeFileSync(OUT, out);
    console.log('gen-registry: src/app/registry.gen.ts 갱신됨.');
    for (const rel of DOC_FILES) {
      const path = join(ROOT, rel);
      if (!existsSync(path)) continue;
      const before = readFileSync(path, 'utf8');
      const after = patchMarkers(before, reg);
      if (before !== after) {
        writeFileSync(path, after);
        console.log(`gen-registry: ${rel} 카운트 마커 갱신됨.`);
      }
    }
  }
}
