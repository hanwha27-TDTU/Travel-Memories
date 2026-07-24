// gen-registry.mjs — 손으로 세던 카운트·목록을 SSOT에서 자동 생성한다(LESSONS §7).
//
// 발전원(SSOT) → src/app/registry.gen.ts(파생) → UI가 읽음. 손편집 금지.
// check-registry-gen 게이트가 "커밋본 == 재생성본"을 강제해 드리프트를 RED로 잡는다.
// 사용: node scripts/gen-registry.mjs  (파일 갱신) / --check (표준출력만, 게이트용)

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src/app/registry.gen.ts');

/** 문서 산문 카운트 마커를 심을 파일들(있는 것만). SSOT는 registry(collect()). */
export const DOC_FILES = ['docs/HANDOFF.md', 'README.md', 'CLAUDE.md'];

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

  return {
    gates,
    gateCount: gates.length,
    agentCount: countFiles('.claude/agents', '.md'),
    screenCount: countFiles('src/ui/screens', '.ts'),
    migrationCount: countFiles('supabase/migrations', '.sql'),
    changelogCount: (changelog.match(/version:\s*'/g) || []).length,
    researchCount: (research.match(/seq:\s*\d+/g) || []).length,
  };
}

/** 결정적 TS 파일 문자열(손편집 금지 헤더 포함). */
export function render(reg) {
  const gateLines = reg.gates.map((g) => `  '${g}',`).join('\n');
  return `// GENERATED — 손으로 편집하지 마세요. 재생성: node scripts/gen-registry.mjs
// SSOT: scripts/harness.mjs · .claude/agents/ · src/ui/screens/ · supabase/migrations/ · src/app/{changelog,researchLog}.ts
// check-registry-gen 게이트가 이 파일이 SSOT와 일치하는지(커밋본==재생성본) 검사합니다.

export const REGISTRY = {
  /** npm run harness가 도는 Required 게이트 이름(정본: scripts/harness.mjs). */
  gates: [
${gateLines}
  ] as const,
  gateCount: ${reg.gateCount},
  agentCount: ${reg.agentCount},
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
