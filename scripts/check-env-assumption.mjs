// check-env-assumption.mjs — 게이트가 **자기가 사는 세계**를 가정하는 것을 막는다(헌법 §18-G).
//
// ── 왜 이 게이트가 있는가 (M-0135) ───────────────────────────────────────────
// 2026-08-09, 로컬 하네스가 **전부 초록**인 커밋이 CI에서 죽었다. 범인은 내가 그날 만든
// `check-review-tier`였고, 하는 일은 한 줄이었다 — `git diff origin/main...HEAD`.
// 로컬에는 `origin/main`이 있다. `actions/checkout`의 얕은 체크아웃에는 **없다.**
//
// 🔴 **로컬 하네스는 이 부류를 원리적으로 못 잡는다 — 자기가 사는 세계에서 도니까.**
// 그래서 조항(1층)이나 「조심하자」로는 절대 안 지켜진다. 세계를 **실제로 비워서 돌려 보는**
// 층이 있어야 한다. 이 게이트가 그 층이다.
//
// ── 무엇이 정확히 결함이었나 ─────────────────────────────────────────────────
// 「전제가 없다」와 「위반을 찾았다」가 **같은 종료코드(1)**로 나갔다. 하네스는 그것을
// FAIL로 적었고, 그 문장은 거짓이었다 — 게이트는 판정한 게 아니라 **죽었다.**
// 이 저장소의 계약은 이미 셋으로 갈라져 있다(harness 머리말):
//     exit 0 = 통과 · exit 1 = 재보고 위반 찾음 · exit 2 = 전제 미충족(SKIP)
// 죽음은 그 셋 중 어느 것도 아니다. 그래서 **크래시 흔적(스택 트레이스)**을 직접 본다.
//
// ── 세 층 (§7) ───────────────────────────────────────────────────────────────
//  ① 조항  — 헌법 §18-G
//  ② 구조  — `GATE_WORLD` 원장: 게이트마다 **가정하는 세계**를 한 곳에 적는다(빈 문자열 허용).
//            원장에 없는 게이트는 RED이므로 **다음 형제가 자동으로 따라온다.**
//  ③ 기계  — 이 파일의 **빈 세계 시연**: 원격 기준가지와 빌드 산출물이 없는 임시 사본에서
//            싼 게이트를 전부 한 번 돌린다. 선언은 산문이고, 이건 측정이다.
//
// 계약: exit 0 = 통과 · exit 1 = 위반. 판정은 종료코드로 한다(§18-A).

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordKeys, recordValues } from './check-gate-promise.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 🔴 **세계 어휘는 동결이다.** 자유 서술로 두면 「음... 환경 좀 탐」 같은 값이 들어오고,
 * 그 순간 원장은 소음이 된다. 새 세계가 필요하면 여기에 **벗기는 방법과 함께** 추가한다.
 *
 * `strippable`이 참인 것만 아래 빈 세계가 실제로 벗긴다. 나머지는 **선언으로만 안다** —
 * 그 사실을 판정문에 적는다(§8: 모르는 것은 '확인 불가'이지 통과가 아니다).
 */
export const WORLDS = Object.freeze({
  baseRef: { strippable: true, what: '원격 기준 가지(origin/main) — 얕은 체크아웃에는 없다' },
  dist: { strippable: true, what: '빌드 산출물(dist/) — build 전에는 없다' },
  globalSkills: { strippable: false, what: '전역 스킬 설치본 — runner에는 없다' },
  network: { strippable: false, what: '바깥 네트워크 — 샌드박스·오프라인에서는 없다' },
  browser: { strippable: false, what: '브라우저 바이너리 — 설치해야 있다' },
  runtimeEnv: { strippable: false, what: '운영 환경변수·시크릿 — 포크·로컬에는 없다' },
});

/**
 * 빈 세계에서 **안 돌리는** 게이트와 그 이유. 🔴 이유 없는 제외는 결함이다(§7).
 * `slow: true`와 `node scripts/*.mjs`가 아닌 항목은 아래 `probeTargets`가 규칙으로 거른다 —
 * 여기 적는 것은 그 규칙으로 안 걸러지는 **개별 예외**뿐이고, 지금은 둘이다.
 */
export const PROBE_EXCLUDE = Object.freeze({
  'check-input-closeout': '실행 전후 트리 지문을 뜨는 게이트라 임시 사본에서 재면 원본이 아니라 사본을 재게 된다(대상이 바뀌면 그건 다른 측정이다)',
  'check-env-assumption': '자기 자신 — 빈 세계 안에서 또 빈 세계를 만들면 재귀한다',
});

/** node가 **삼키지 못한 예외**를 뱉었는가. 스택 프레임 한 줄이면 충분하다. */
export function crashed(stderr) {
  return /^\s+at\s+\S+/m.test(String(stderr ?? ''));
}

/**
 * 한 게이트의 빈 세계 결과를 판정한다 — 순수 함수(자체검사가 가짜 결과로 부른다).
 *
 * @param declared   원장이 이 게이트에 적어 둔 세계 이름들
 * @param barren     `{ status, stderr }` — 빈 세계에서 실제로 돌린 결과
 * @param homeStatus 같은 게이트를 **집(작업 저장소)**에서 돌린 종료코드. 빈 세계가 빨간불일
 *                   때만 잰다(평소엔 0건이라 공짜다).
 *
 * 🔴 **집에서도 빨간불이면 이 게이트의 일이 아니다.** 첫 판은 그걸 안 물어서, 내가 아직
 * 재생성을 안 돌린 게이트 셋을 *"빈 세계에서 결과가 달라졌다"*고 **거짓으로** 지목했다.
 * 그 문장은 사람을 엉뚱한 곳으로 보낸다(§10 ③ · 전달 결함).
 */
export function verdictOf(name, declared, barren, homeStatus = 0) {
  if (crashed(barren.stderr)) {
    return `${name}: 빈 세계에서 **죽었다**(예외가 스택째 나왔다) — 전제가 없으면 판정하지 말고 exit 2로 「확인 불가」를 말해야 한다. 로컬 초록·CI 빨강이 이 형태다(M-0135)`;
  }
  if (![0, 1, 2].includes(barren.status)) {
    return `${name}: 계약 밖 종료코드 ${barren.status} — 0(통과)·1(위반)·2(전제 미충족) 셋뿐이다`;
  }
  if (barren.status === 0) return null;
  if (homeStatus !== 0) return null; // 집에서도 빨간불 — 세계 탓이 아니다(그 게이트가 스스로 보고한다)
  const strippedDecl = declared.filter((w) => WORLDS[w]?.strippable);
  if (!strippedDecl.length) {
    return `${name}: 집에서는 초록인데 빈 세계에서 exit ${barren.status} — 원장에 가정한 세계가 없다. GATE_WORLD에 ${Object.entries(WORLDS).filter(([, v]) => v.strippable).map(([k]) => k).join('·')} 중 무엇에 기대는지 적으세요`;
  }
  return null;
}

/** 원장 자체의 결함(누락·어휘 밖·유령)을 본다 — 순수 함수. */
export function ledgerProblems(gateNames, worlds) {
  const problems = [];
  for (const name of gateNames) {
    const raw = worlds[name];
    if (raw === undefined) {
      problems.push(`${name}: GATE_WORLD에 세계 선언이 없다 — 아무것도 가정하지 않으면 빈 문자열('')을 적으세요(빈칸과 「아직 안 봤다」는 다른 말이다)`);
      continue;
    }
    for (const word of String(raw).split(/\s+/).filter(Boolean)) {
      if (!WORLDS[word]) problems.push(`${name}: 어휘 밖 세계 '${word}' — 동결 어휘는 ${Object.keys(WORLDS).join('·')}입니다`);
    }
  }
  for (const name of Object.keys(worlds)) {
    if (!gateNames.includes(name)) problems.push(`${name}: GATE_WORLD에 있으나 원장(harness)에 없는 게이트다(지운 게이트?)`);
  }
  return problems;
}

/** harness 등록부에서 빈 세계에 넣을 게이트만 고른다 — 규칙으로 거르고, 예외는 이유와 함께. */
export function probeTargets(entries, exclude = PROBE_EXCLUDE) {
  return entries
    .filter((g) => !g.slow && /^node scripts\/[\w-]+\.mjs$/.test(g.cmd) && !(g.name in exclude))
    .map((g) => g.name);
}

// ── 빈 세계 ──────────────────────────────────────────────────────────────────

/**
 * 추적 파일을 **작업트리 그대로** 옮긴 임시 사본을 만든다. HEAD가 아니라 지금 고치고 있는
 * 판을 재야 한다 — 안 그러면 방금 만든 게이트는 이 검사를 영원히 안 받는다.
 *
 * 🔴 **벗길 것만 벗긴다.** 첫 판은 `git init`만 하고 끝냈고, 그래서 추적 파일이 **0개인**
 * 세계가 됐다 — `actions/checkout`이 만드는 세계와 딴판이다. 그 위에서 나온 빨간불은
 * 「CI에서 깨진다」가 아니라 **「내가 만든 이상한 세계에서 깨진다」**였다(오탐은 빡빡한
 * 게이트가 아니라 **틀린 게이트**다 · §11 ③). 그래서 얕은 체크아웃과 같은 모양으로 세운다:
 *
 *   있는 것: 작업트리 · 추적 색인 · HEAD 커밋 1개 · node_modules
 *   없는 것: **origin/\*** (remote 없음) · **dist/** (추적 대상이 아니라 안 따라온다)
 */
export function buildBarrenWorld(root) {
  const dir = mkdtempSync(join(tmpdir(), 'barren-world-'));
  // 🔴 `--others --exclude-standard`가 없으면 **아직 커밋 안 한 새 게이트가 통째로 빠진다.**
  // 그런데 이 검사가 가장 필요한 순간이 바로 그때다 — M-0135는 *그날 만든* 게이트에서 났다.
  // (무시 목록은 그대로 따르므로 `dist/`·`node_modules/`는 여전히 안 따라온다.)
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, maxBuffer: 1 << 26 })
    .toString().split('\0').filter(Boolean);
  for (const file of files) {
    mkdirSync(join(dir, dirname(file)), { recursive: true });
    copyFileSync(join(root, file), join(dir, file));
  }
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git(['init', '-q']);
  git(['config', 'user.email', 'barren@example.invalid']);
  git(['config', 'user.name', 'barren']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['add', '-A']);
  git(['commit', '-q', '--no-verify', '-m', 'barren world']);
  // node_modules는 세계가 아니라 **연장**이다(CI도 `npm ci`로 갖춰 준다). 벗기면 전부가
  // "모듈 없음"으로 죽어 이 검사는 아무것도 못 본다.
  if (existsSync(join(root, 'node_modules'))) symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return { dir, fileCount: files.length };
}

/** 게이트 하나를 어느 세계에서 돌린다(동기 — 카나리아·집 재측정처럼 드문 자리에서만). */
export function runGate(dir, name) {
  const r = spawnSync('node', [`scripts/${name}.mjs`], { cwd: dir, encoding: 'utf8', timeout: 120_000 });
  return { status: r.status ?? -1, stderr: `${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}` };
}

/**
 * 🔴 **빈 세계의 게이트들은 병렬이 기본이다**(§18-C). 서로의 결과를 입력으로 쓰지 않고,
 * 같은 자원을 쓰지도 않는다(각자 읽기 전용으로 사본을 볼 뿐이다) — 줄 세울 이유가 없다.
 *
 * 첫 판은 55개를 줄 세웠고 편집 루프가 6초에서 16초가 됐다. *"낭비되는 시간의 대부분은
 * 대기가 아니라 **병렬로 할 수 있는 것을 줄 세운 것**"* — 내가 방금 심은 조항을 내 코드가
 * 어기고 있었다. 🔴 **합류(join) 뒤에 보고한다**: 하나가 빨간불이어도 나머지를 끝까지 정산한다.
 */
export async function runGatesInParallel(dir, names, limit) {
  const width = limit ?? Math.max(2, Math.min(8, (cpus().length || 4) - 1));
  const out = new Map();
  let next = 0;
  const worker = async () => {
    while (next < names.length) {
      const name = names[next++];
      out.set(name, await new Promise((resolve) => {
        const p = spawn('node', [`scripts/${name}.mjs`], { cwd: dir, timeout: 120_000 });
        let stderr = '';
        p.stderr.on('data', (c) => { stderr += c; });
        p.stdout.on('data', () => {}); // 흘려보내지 않으면 파이프가 차서 멈춘다
        p.on('error', (e) => resolve({ status: -1, stderr: `${stderr}\n${e.message}` }));
        p.on('close', (code) => resolve({ status: code ?? -1, stderr }));
      }));
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return out;
}

// ── 자체검사: 알려진 실패를 주입해 RED를 본 뒤에만 신뢰한다(§4·§11) ──────────
const SELF = { pos: 0, neg: 0 };

export function selfTest() {
  // ① 원장 판정
  const names = ['check-a', 'check-b'];
  if (ledgerProblems(names, { 'check-a': '', 'check-b': 'baseRef dist' }).length) throw new Error('SELF-TEST 실패: 정상 원장을 걸렀다(오탐)');
  SELF.neg += 1;
  const ledgerBad = [
    ['선언 누락', names, { 'check-a': '' }, '세계 선언이 없다'],
    ['어휘 밖', names, { 'check-a': '', 'check-b': '인터넷' }, '어휘 밖 세계'],
    ['유령 항목', names, { 'check-a': '', 'check-b': '', 'check-ghost': '' }, '원장(harness)에 없는'],
  ];
  for (const [label, n, w, needle] of ledgerBad) {
    if (!ledgerProblems(n, w).some((p) => p.includes(needle))) throw new Error(`SELF-TEST 실패: ${label}을(를) 놓쳤다`);
    SELF.pos += 1;
  }

  // ② 빈 세계 판정 — **가짜 결과**로 먼저 문법을 못박는다.
  const ok = [
    ['정상', [], { status: 0, stderr: '' }, 0],
    ['선언한 SKIP', ['baseRef'], { status: 2, stderr: '' }, 0],
    // 🔴 게이트가 **스스로 잡은 오류를 출력**하는 것은 죽음이 아니다 — 스택 프레임이 없다.
    ['잡아서 찍은 오류문', ['dist'], { status: 1, stderr: 'Error: 위반 3건\n' }, 0],
    // 🔴 **실제 오탐**(2026-08-09): 집에서도 빨간불인 게이트를 세계 탓으로 지목했다.
    ['집에서도 빨간불', [], { status: 1, stderr: '' }, 1],
  ];
  for (const [label, d, r, home] of ok) {
    if (verdictOf('g', d, r, home)) throw new Error(`SELF-TEST 실패: 오탐 — ${label}`);
    SELF.neg += 1;
  }
  const barrenBad = [
    ['크래시', [], { status: 1, stderr: "file:///x/check-y.mjs:12\nError: boom\n    at file:///x/check-y.mjs:12:9\n" }, 0, '죽었다'],
    ['집이 빨간불이어도 죽음은 죽음', [], { status: 1, stderr: '    at foo (bar.mjs:1:1)' }, 1, '죽었다'],
    ['계약 밖 종료코드', ['baseRef'], { status: 7, stderr: '' }, 0, '계약 밖 종료코드'],
    ['선언 없는 실패', [], { status: 1, stderr: '' }, 0, '원장에 가정한 세계가 없다'],
    ['벗기지 못하는 세계만 선언', ['network'], { status: 1, stderr: '' }, 0, '원장에 가정한 세계가 없다'],
  ];
  for (const [label, d, r, home, needle] of barrenBad) {
    if (!String(verdictOf('g', d, r, home)).includes(needle)) throw new Error(`SELF-TEST 실패: ${label}을(를) 놓쳤다`);
    SELF.pos += 1;
  }

  // ③ 제외 규칙 — slow·비-node 항목이 실제로 빠지는가(모집단이 조용히 넓어지면 이 검사가 느려져 죽는다).
  const targets = probeTargets([
    { name: 'typecheck', cmd: 'npm run -s typecheck' },
    { name: 'check-x', cmd: 'node scripts/check-x.mjs' },
    { name: 'check-slow', cmd: 'node scripts/check-slow.mjs', slow: true },
    { name: 'check-skip', cmd: 'node scripts/check-skip.mjs' },
  ], { 'check-skip': '이유' });
  if (targets.join() !== 'check-x') throw new Error(`SELF-TEST 실패: 제외 규칙이 틀렸다 — ${targets.join()}`);
  SELF.pos += 1;
}

selfTest();

const isMain = process.argv[1] && process.argv[1].endsWith('check-env-assumption.mjs');
if (isMain) {
  const { readFileSync } = await import('node:fs');
  const harness = readFileSync(join(ROOT, 'scripts/harness.mjs'), 'utf8');
  const entries = [...harness.matchAll(/\{\s*(slow:\s*true,\s*)?name:\s*'([^']+)',\s*cmd:\s*'([^']+)'/g)]
    .map((m) => ({ slow: Boolean(m[1]), name: m[2], cmd: m[3] }));
  const gateNames = entries.map((g) => g.name);
  const gatesTs = readFileSync(join(ROOT, 'src/app/gates.ts'), 'utf8');
  const worlds = recordValues(gatesTs, 'GATE_WORLD');
  for (const key of recordKeys(gatesTs, 'GATE_WORLD')) if (!(key in worlds)) worlds[key] = '';

  const problems = ledgerProblems(gateNames, worlds);
  // 🔴 원장이 깨진 채로 빈 세계를 돌리지 않는다 — 모집단이 틀린 측정은 초록이 나도 뜻이 없다(§4).
  if (!problems.length) {
    const targets = probeTargets(entries);
    const { dir, fileCount } = buildBarrenWorld(ROOT);
    try {
      // 🔴 비공허 증명: 이 판정기가 **실제로 빨간불을 내는지**를 같은 빈 세계에서 시연한다.
      // 셀프테스트의 가짜 결과와 달리, 여기서는 진짜 node가 진짜로 죽는다.
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      writeFileSync(join(dir, 'scripts/__probe-canary.mjs'), "import {execFileSync} from 'node:child_process';\nexecFileSync('git',['rev-parse','origin/main'],{stdio:'pipe'});\n");
      const canary = verdictOf('__probe-canary', [], runGate(dir, '__probe-canary'));
      if (!canary) {
        console.error('🔴 빈 세계가 공허합니다 — origin/main을 잡는 카나리아가 살아 돌아왔습니다. 세계를 안 벗긴 것입니다.');
        process.exit(1);
      }
      rmSync(join(dir, 'scripts/__probe-canary.mjs'));

      let homeRed = 0;
      const results = await runGatesInParallel(dir, targets);
      for (const name of targets) {
        const declared = String(worlds[name] ?? '').split(/\s+/).filter(Boolean);
        const barren = results.get(name) ?? { status: -1, stderr: '결과가 없습니다' };
        // 🔴 빈 세계가 빨간불일 때**만** 집에서 다시 잰다. 평소엔 0건이라 공짜이고,
        // 그 한 번이 「세계 탓」과 「이 게이트가 원래 빨간불」을 가른다.
        const homeStatus = barren.status === 0 ? 0 : runGate(ROOT, name).status;
        if (barren.status !== 0 && homeStatus !== 0) homeRed += 1;
        const verdict = verdictOf(name, declared, barren, homeStatus);
        if (verdict) problems.push(verdict);
      }
      if (!problems.length) {
        const unstrippable = Object.entries(WORLDS).filter(([, v]) => !v.strippable).map(([k]) => k);
        console.log(
          `check-env-assumption: OK (자체검사 양성 ${SELF.pos}·음성 ${SELF.neg} · 게이트 ${gateNames.length}개 세계 선언 완비 · 빈 세계에서 ${targets.length}개 실연 · 추적파일 ${fileCount}개 사본)`,
        );
        console.log(`  ↳ 벗긴 세계: baseRef·dist (카나리아로 실제 벗겨졌음을 확인)${homeRed ? ` · ${homeRed}개는 집에서도 빨간불이라 이 검사의 대상이 아니었습니다` : ''}`);
        console.log(`  ↳ 확인 불가: ${unstrippable.join('·')}는 벗기지 못해 **재지 않았습니다** — 원장 선언으로만 압니다.`);
        console.log(`  ↳ 정직한 한계: 빈 세계는 게이트가 **죽지 않는지**까지만 봅니다. 판정 내용이 옳은지는 보지 못합니다.`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  if (problems.length) {
    console.error('🔴 게이트가 자기가 사는 세계를 가정합니다 — 로컬 초록·CI 빨강의 형태입니다(헌법 §18-G):');
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(1);
  }
}
