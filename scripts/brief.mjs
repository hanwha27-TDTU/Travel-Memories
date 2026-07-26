// brief.mjs — **착수 브리핑.** 코딩을 시작하기 전에 이걸 먼저 돌린다.
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 (사용자 제안 2026-07-26)
// ─────────────────────────────────────────────────────────────────────────────
// "적어놓고 어기는 이유는 읽지 않기 때문이죠. 그래서 아예 모든 코딩 시작 전 스킬문서부터
//  정독하고, 정독 과정에서 오류나 모순이 있으면 그것부터 정리하고 시작하면 되지 않을까요?"
//
// 맞다. 그런데 **절반만 맞다** — 그리고 그 차이가 이 스크립트의 모양을 정한다.
//
//  · 맞는 절반: 오늘 오버레이 잘림 사고(가로 태블릿) 때 `ui-responsive-dev/SKILL.md`는
//    **있었고 나는 app.css를 고치기 전에 읽지 않았다.**
//  · 빠진 절반: 읽었어도 못 막았다. 그 문서 어디에도 `vh`/`dvh`·오버레이 스크롤 얘기가
//    **없었다.** 문서에 구멍이 있었다.
//  · 더 중요한 반례: M-0012에서 나는 CLAUDE.md §7("형제 목록을 손으로 세지 말고
//    등록부/디렉터리에서 뽑는다")을 **직접 쓰고 같은 커밋에서 어겼다.** 읽음은 그때 최대치였다.
//    실패한 것은 읽기가 아니라 **적용**이었다 — 산문에 동의하고 넘어갔지, 그 절차가 요구하는
//    *산출물*(형제 목록)을 실제로 만들지 않았다.
//
// 그래서 이 스크립트는 두 가지를 **강제로 산출물로 만든다**:
//   ① 이 변경에 필수인 스킬 문서 목록 (읽을 것을 고르는 일을 기억에 맡기지 않는다)
//   ② 형제 목록 — 디렉터리에서 **기계가 뽑는다** (§7이 요구하는 바로 그 산출물)
// 그리고 ③ 이 영역에서 과거에 낸 실수를 같이 띄운다 — 같은 자리에서 두 번 넘어지지 않게.
//
// 사용:
//   node scripts/brief.mjs                  # 지금 작업 트리의 변경 파일 기준
//   node scripts/brief.mjs src/ui/dom.ts …  # 앞으로 고칠 파일을 직접 지정

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 경로 → 필수 스킬 문서. **이 표가 SSOT다** — 어느 문서를 읽을지 기억에 맡기지 않는다.
 * `check-skill-routing` 게이트가 "src의 모든 영역이 표에 걸리는가"를 검사한다.
 */
export const SKILL_ROUTES = [
  { match: /^src\/ui\/(styles|theme|toast|dom)/, skill: 'ui-responsive-dev' },
  { match: /^src\/ui\/screens\//, skill: 'ui-responsive-dev' },
  { match: /^src\/ui\/(photoEditor|editor)/, skill: 'photo-editor-dev' },
  { match: /^src\/media\//, skill: 'photo-editor-dev' },
  { match: /^src\/ui\/panels\/(verdict|diagnostics)/, skill: 'diagnostics-dev' },
  { match: /^src\/services\/(diagnostics|envReport|storeState)/, skill: 'diagnostics-dev' },
  // deviceId는 진단이 읽지만 **동기화 push 경로에 값을 찍는다** — 규율은 그쪽이 더 무겁다.
  { match: /^src\/app\/deviceId/, skill: 'sync-offline-dev' },
  { match: /^src\/app\/errorLog/, skill: 'diagnostics-dev' },
  { match: /^src\/domain\/integrity/, skill: 'diagnostics-dev' },
  { match: /^src\/services\/(sync|autoSync|purge|trips|moments|media|expenses)\.ts/, skill: 'sync-offline-dev' },
  { match: /^src\/(sync|offline)\//, skill: 'sync-offline-dev' },
  { match: /^src\/domain\/\w+\/rowmap/, skill: 'sync-offline-dev' },
  { match: /^src\/services\/(backup|zip)/, skill: 'backup-restore-dev' },
  { match: /^src\/services\/(fx|expenses)/, skill: 'expense-fx-dev' },
  { match: /^src\/domain\/expense\//, skill: 'expense-fx-dev' },
  { match: /^src\/(services\/geocode|domain\/place)/, skill: 'map-place-dev' },
  { match: /^src\/ui\/screens\/mapView/, skill: 'map-place-dev' },
  { match: /^src\/services\/(supabase|auth|r2)/, skill: 'supabase-security-dev' },
  { match: /^supabase\//, skill: 'supabase-security-dev' },
  { match: /^scripts\//, skill: 'gates-mechanization-dev' },
  { match: /^src\/app\/(registry|blueprint|gates|hashchain)/, skill: 'gates-mechanization-dev' },
  { match: /^src\/app\/router/, skill: 'ui-responsive-dev' },
  { match: /^src\/domain\/moment\//, skill: 'sync-offline-dev' },
  { match: /^src\/services\/storage/, skill: 'diagnostics-dev' },
];

/** 스킬 문서가 필요 없는 영역 — **이유를 반드시 적는다**(이유 없는 제외는 결함, §7). */
export const NO_SKILL_REQUIRED = new Map([
  ['src/main.ts', '진입점 배선만 — 규율은 각 모듈 문서가 갖는다'],
  ['src/domain/time.ts', '순수 날짜 함수. 규율은 check-timezone 게이트가 직접 강제한다'],
  ['src/domain/registry.ts', '데이터 선언만 — 파생물은 gen-registry가 만든다'],
  ['src/app/changelog.ts', '사용자 대면 이력 데이터. 규율은 파일 머리주석에 있다'],
  ['src/app/researchLog.ts', '연구 기록 데이터 — 코드 규율 없음'],
  ['src/app/selfEval.ts', '자기평가 데이터 — check-self-eval이 직접 강제한다'],
  // *.gen.ts는 **손으로 고치는 파일이 아니다.** 읽을 문서는 그 생성기 쪽에 있고,
  // 드리프트는 짝 게이트가 막는다(정독 대상은 생성기이지 산출물이 아니다).
  ['src/app/registry.gen.ts', '자동 생성 — gen-registry.mjs가 SSOT, check-registry-gen이 강제'],
  ['src/app/platformMap.gen.ts', '자동 생성 — gen-platform-map.mjs가 코드에서 실측, check-platform-map이 강제'],
]);

export function skillsFor(paths) {
  const out = new Map();
  for (const p of paths) {
    for (const r of SKILL_ROUTES) {
      if (r.match.test(p)) {
        if (!out.has(r.skill)) out.set(r.skill, []);
        out.get(r.skill).push(p);
      }
    }
  }
  return out;
}

/** §7이 요구하는 산출물 — 형제 목록을 **디렉터리에서 뽑는다**(손으로 세지 않는다). */
export function siblingsOf(path) {
  const dir = join(ROOT, dirname(path));
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.(ts|mjs|css|sql)$/.test(f))
    .map((f) => join(dirname(path), f))
    .filter((f) => f !== path);
}

function changedPaths() {
  try {
    const out = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' });
    return out
      .split('\n')
      .map((l) => l.slice(3).trim())
      .filter(Boolean)
      .filter((p) => !p.endsWith('/'));
  } catch {
    return [];
  }
}

/** 이 영역에서 과거에 낸 실수 — 같은 자리에서 두 번 넘어지지 않게. */
function pastMistakes(paths) {
  const file = join(ROOT, 'docs/records/coding-mistakes.md');
  if (!existsSync(file)) return [];
  const src = readFileSync(file, 'utf8');
  const bases = paths.map((p) => p.split('/').pop().replace(/\.\w+$/, ''));
  const out = [];
  for (const block of src.split(/\n## /).slice(1)) {
    const title = block.split('\n')[0];
    if (bases.some((b) => b.length > 3 && block.includes(b))) out.push(title);
  }
  return out;
}

// ── 실행 ────────────────────────────────────────────────────────────────────
// ⚠️ 이 파일은 라우팅 표(SKILL_ROUTES)의 SSOT라 `check-skill-routing`이 import한다.
// 가드가 없으면 게이트를 돌릴 때마다 브리핑 전문이 출력돼 게이트 결과가 묻힌다(실제로 그랬다).
const isMain = process.argv[1] && process.argv[1].endsWith('brief.mjs');
if (!isMain) {
  // 표만 제공하고 조용히 끝낸다.
} else {
const argv = process.argv.slice(2);
const paths = (argv.length ? argv : changedPaths()).map((p) => relative(ROOT, join(ROOT, p)));

if (!paths.length) {
  console.log('변경 파일이 없습니다. 고칠 파일을 인자로 주세요: node scripts/brief.mjs src/ui/dom.ts');
  process.exit(0);
}

console.log('\n═══ 착수 브리핑 ═══\n');
console.log(`대상 파일 ${paths.length}개:`);
for (const p of paths) console.log(`  · ${p}`);

const skills = skillsFor(paths);
console.log('\n① 먼저 정독할 스킬 문서 (기억이 아니라 라우팅 표에서 뽑음):');
if (!skills.size) {
  const unrouted = paths.filter((p) => !NO_SKILL_REQUIRED.has(p));
  if (unrouted.length) {
    console.log('  ⚠️ 해당 문서를 찾지 못했습니다. 라우팅 표(SKILL_ROUTES)에 빠진 영역일 수 있어요 —');
    console.log('     그 자체가 결함이니 표를 먼저 고치세요.');
  } else {
    console.log('  (문서 불필요 영역 — NO_SKILL_REQUIRED에 이유가 적혀 있습니다)');
  }
} else {
  for (const [skill, hits] of skills) {
    const f = `.claude/skills/${skill}/SKILL.md`;
    const lines = existsSync(join(ROOT, f)) ? readFileSync(join(ROOT, f), 'utf8').split('\n').length : 0;
    console.log(`  📖 ${f}  (${lines}줄)  ← ${hits.join(', ')}`);
  }
  console.log('\n  정독 중 **문서와 코드가 어긋나거나 규칙이 빠져 있으면 그것부터 고친다.**');
  console.log('  (오늘의 사고: ui-responsive-dev에 vh/dvh·오버레이 스크롤 규칙이 아예 없었다 —');
  console.log('   읽었어도 못 막았을 구멍이었고, 그 구멍을 메우는 게 이 단계의 진짜 일이다.)');
}

console.log('\n② 형제 목록 (§7 — 손으로 세지 않고 디렉터리에서 뽑음):');
for (const p of paths) {
  const sib = siblingsOf(p);
  if (!sib.length) continue;
  console.log(`  ${p}`);
  console.log(`    형제 ${sib.length}: ${sib.map((s) => s.split('/').pop()).join(', ')}`);
}
console.log('\n  → 이 변경이 형제 전부에 걸려야 하는가? 아니라면 **제외 이유를 코드에 남긴다.**');
console.log('  → 다음 형제가 자동으로 따라오는가? 아니라면 구조(2층)가 빠진 것이다.');

const mistakes = pastMistakes(paths);
if (mistakes.length) {
  console.log('\n③ 이 영역에서 과거에 낸 실수:');
  for (const m of mistakes.slice(0, 6)) console.log(`  ⚠️ ${m}`);
}

console.log('\n④ 착수 전 자문(CLAUDE.md §0 5W1H · §7 · §8):');
console.log('  · 왜   — 북극성("기억과 의미를 다시 찾아준다")을 더 잘 이루는가?');
console.log('  · 어디서 — 이 사실의 SSOT는 어디인가? 손편집 중복을 만들고 있지 않은가?');
console.log('  · 어떻게 — 검증 경로는? 알려진 실패를 주입해 RED를 확인할 수 있는가?');
console.log('');
}
