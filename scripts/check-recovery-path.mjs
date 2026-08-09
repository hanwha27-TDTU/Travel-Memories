// check-recovery-path.mjs — 머지 뒤 결함을 발견했을 때 **고치기 전에** 수습 경로를 정한다.
//
// ── 왜 필요한가 ──────────────────────────────────────────────────────────────
// 결함을 발견하면 손이 먼저 나간다. 그런데 무엇을 고치느냐에 따라 옳은 순서가 다르다.
//
//   · 빌드에 **안** 들어가는 것(문서·게이트·워크플로) → 고치고 배포. 재빌드가 필요 없다.
//   · 빌드에 **들어가는** 것(앱 런타임)              → 배포 먼저, 수정은 다음 판.
//                                                     지금 고치면 검증된 산출물이 무효가 된다.
//   · **사용자 기록에 닿는** 것(저장·복원·동기화·삭제) → 되돌리고 고친다.
//
// 🔴 **세 번째가 앞의 둘을 뒤집는다.** 화면 결함은 기다릴 수 있지만 **유실된 기록은 안 기다린다.**
// 섞이면 데이터가 이긴다. 그래서 판정은 「가장 무거운 갈래」로 수렴한다.
//
// ── 이 게이트의 비공허 축 ────────────────────────────────────────────────────
// 🔴 **세 경로를 전부 낼 수 있어야 판정기다.** 갈래 하나가 실제 저장소에서 한 번도 안 나오면
// 그 갈래는 선언만 있고 죽은 것이다 — 그런 판정기는 어느 날 조용히 두 갈래짜리가 된다.
// 그래서 추적 파일 전수를 실제로 흘려 보내 **세 갈래가 모두 비어 있지 않은지** 확인한다.
//
// 계약: exit 0 = 통과 · exit 1 = 위반. 판정은 종료코드로 한다(§18-A).

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROUTES = Object.freeze(['revert-and-fix', 'deploy-then-fix-next', 'deploy-now']);

/**
 * glob 하나를 정규식으로. `**`는 경로 구분자를 넘고, `*`는 안 넘는다.
 *
 * 🔴 첫 판은 치환을 이어 붙여 만들었다가 **`supabase/migrations/` 밑 파일을 하나도 못 잡았다**
 * (끝의 `**`를 「디렉터리 경계」로만 읽었다). 자체검사가 그 자리에서 잡았다 — 갈래 판정기가
 * 조용히 두 갈래짜리가 될 뻔한 자리다. 그래서 치환 대신 **한 글자씩 읽는다.**
 */
export function globToRe(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } // `**/` — 디렉터리 0개 이상
        else { out += '.*'; i += 1; } // 끝의 `**` — 그 아래 **파일까지** 전부
      } else out += '[^/]*'; // `*` — 한 칸 안에서만
    } else if ('.+^${}()|[]\\'.includes(c)) out += `\\${c}`;
    else out += c;
  }
  return new RegExp(`^${out}$`);
}

/**
 * 경로 하나의 수습 경로를 정한다 — 순수 함수(자체검사가 부른다).
 *
 * 순서가 곧 우선순위다: userData가 먼저 걸리면 나머지는 보지 않는다(위 🔴).
 */
export function routeFor(path, classes) {
  const order = [
    ['userData', classes?.userData],
    ['appRuntime', classes?.appRuntime],
    ['outsideBuild', classes?.outsideBuild],
  ];
  for (const [name, cls] of order) {
    for (const glob of cls?.globs ?? []) {
      if (globToRe(glob).test(path)) return { klass: name, route: cls.route };
    }
  }
  return { klass: 'unclassified', route: null };
}

// ── 자체검사(§4) ─────────────────────────────────────────────────────────────
const SELF = { pos: 0, neg: 0 };
const CLASSES = {
  userData: { route: 'revert-and-fix', globs: ['src/services/sync.ts', 'src/domain/*/rowmap.ts', 'supabase/migrations/**'] },
  appRuntime: { route: 'deploy-then-fix-next', globs: ['src/**', 'index.html'] },
  outsideBuild: { route: 'deploy-now', globs: ['docs/**', 'scripts/**'] },
};

export function selfTest() {
  const must = [
    // 🔴 이 세 줄이 이 게이트의 핵심이다 — 같은 `src/` 밑인데 갈래가 다르다.
    ['src/services/sync.ts', 'revert-and-fix', '동기화는 데이터다 — src 밑이어도 앱 런타임으로 내려가면 안 된다'],
    ['src/domain/media/rowmap.ts', 'revert-and-fix', 'rowmap은 서버 왕복 형식이다'],
    ['supabase/migrations/0029_x.sql', 'revert-and-fix', 'migration은 ** 를 넘어 깊은 경로도 잡아야 한다'],
    ['src/ui/screens/home.ts', 'deploy-then-fix-next', '화면은 빌드에 들어간다'],
    ['index.html', 'deploy-then-fix-next', '셸도 빌드에 들어간다'],
    ['docs/CONSTITUTION.md', 'deploy-now', '문서는 재빌드가 필요 없다'],
    ['scripts/harness.mjs', 'deploy-now', '게이트도 빌드 밖이다'],
  ];
  for (const [path, expected, why] of must) {
    const got = routeFor(path, CLASSES).route;
    if (got !== expected) throw new Error(`SELF-TEST 실패: ${path} → ${got} (기대 ${expected}) — ${why}`);
    SELF.pos += 1;
  }
  // 🔴 우선순위를 뒤집으면 잡히는가 — userData를 뒤로 보내면 sync.ts가 앱 런타임으로 샌다.
  const flipped = { userData: CLASSES.appRuntime, appRuntime: CLASSES.userData, outsideBuild: CLASSES.outsideBuild };
  if (routeFor('src/services/sync.ts', flipped).route === 'revert-and-fix') {
    throw new Error('SELF-TEST 실패: 우선순위를 뒤집었는데도 같은 답이 나왔다 — 순서를 안 보고 있다');
  }
  SELF.pos += 1;
  // 분류 밖은 조용히 통과시키지 않는다.
  if (routeFor('untracked/thing.bin', CLASSES).route !== null) throw new Error('SELF-TEST 실패: 미분류를 갈래로 반올림했다');
  SELF.neg = 1;
}

selfTest();

const isMain = process.argv[1] && process.argv[1].endsWith('check-recovery-path.mjs');
if (isMain) {
  const profile = JSON.parse(readFileSync(join(ROOT, 'schemas', 'release-profile.json'), 'utf8'));
  const classes = profile?.changeClasses;
  const problems = [];
  if (!classes) problems.push('changeClasses가 프로필에 없다 — 판정 기준이 없다');

  // 🔴 세 갈래가 **실제 저장소에서** 전부 나오는가. 손목록이 아니라 추적 파일 전수를 흘린다.
  const tracked = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .filter(Boolean);
  const hits = Object.fromEntries(ROUTES.map((r) => [r, 0]));
  const unclassified = [];
  for (const path of tracked) {
    const { route } = routeFor(path, classes);
    if (route) hits[route] += 1;
    else unclassified.push(path);
  }
  for (const route of ROUTES) {
    if (!hits[route]) problems.push(`갈래 '${route}'가 실제 파일 ${tracked.length}개 중 하나도 안 나온다 — 선언만 있고 죽은 갈래다`);
  }

  if (process.argv.length > 2 && !process.argv[2].startsWith('--')) {
    // 사람이 물을 때: 이 파일을 고치면 어느 경로인가.
    for (const path of process.argv.slice(2)) {
      const { klass, route } = routeFor(path, classes);
      const meaning = route ? classes[klass].meaning : '분류 밖 — 이 저장소가 아직 판정하지 않는 경로입니다';
      console.log(`${path}\n  → ${route ?? '판정 불가'} · ${meaning}`);
    }
    process.exit(0);
  }

  if (problems.length) {
    console.error('🔴 수습 경로 판정기가 판정할 수 없습니다:');
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log(
    `check-recovery-path: OK (자체검사 양성 ${SELF.pos}·음성 ${SELF.neg} · 추적 ${tracked.length}개 · ` +
      `되돌림 ${hits['revert-and-fix']} · 다음판 ${hits['deploy-then-fix-next']} · 즉시배포 ${hits['deploy-now']} · 세 갈래 모두 비어 있지 않음)`,
  );
  console.log(`  ↳ 정직한 한계: 분류 밖 ${unclassified.length}개는 **판정하지 않습니다** — 갈래로 반올림하지 않습니다(§8).`);
}
