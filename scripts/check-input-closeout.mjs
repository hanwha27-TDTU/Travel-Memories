// check-input-closeout.mjs — HRL-17: 비싼 불변 산출물 **앞**에 읽기 전용 입력 마감을 둔다.
//
// ── 왜 필요한가 ──────────────────────────────────────────────────────────────
// HRL-9(§18-E)는 산출물 **뒤**에 입력을 바꾸는 것을 막는다. 이 게이트는 그 **앞**을 맡는다.
// 번들·APK처럼 다시 만들기 비싼 산출물은 굽는 순간 그 시점의 입력을 굳히는데, 문서·원장·
// 생성물이 뒤늦게 바뀌면 산출물은 **신호 없이** 낡는다. 그래서 굽기 직전에 고정점을 세운다.
//
// ── 두 층이다 ────────────────────────────────────────────────────────────────
//  · 기본(하네스 게이트) — **원장이 온전한가**를 정적으로 판정한다. 싸고, 늘 돈다.
//  · `--run`(릴리스 단계) — 실제로 마감을 돌리고, 실행 **전후 트리 지문**을 비교해
//    「이 마감은 읽기 전용이다」라는 **주장 자체를 검증한다**(HRL-17).
//
// ── 🔴 모집단을 손으로 세지 않는다 ────────────────────────────────────────────
// 재생성 writer 전수는 **디렉터리에서 뽑아** 원장과 대조한다(HRL-1). 손으로 적은 목록은
// 틀리는 게 아니라 **자라지 않는다** — 새 `gen-*`이 생겨도 아무도 모르는 것이 이 부류의
// 전형적 결함이고, 그러면 마감 범위가 조용히 좁아진다. 그 자체를 실패로 낸다.
//
// 계약: exit 0 = 통과 · exit 1 = 위반. 판정은 **종료코드**로 한다(§18-A).

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = join(ROOT, 'schemas', 'release-profile.json');

/** 재생성 writer로 인정하는 이름꼴. 디렉터리가 모집단의 출처다(손목록 금지). */
const WRITER_RE = /^gen-[\w-]+\.mjs$/;

/**
 * check 명령에 **쓰기가 섞였는가**. 마감은 writer를 실행하지 않는다(HRL-17).
 *
 * 🔴 `gen-` 자체도 막는다 — `node scripts/gen-adapters.mjs --check` 같은 형태로 writer를
 * 「검사 모드」라 부르며 부르는 길을 열면, 그 플래그가 언젠가 조용히 쓰기로 돌아온다.
 */
const WRITE_HINT = /--write\b|\bscripts\/gen-[\w-]+\.mjs/;

export function discoverWriters(dir) {
  return readdirSync(dir).filter((f) => WRITER_RE.test(f)).sort();
}

/**
 * 원장이 온전한지 판정한다 — 순수 함수(자체검사가 부른다).
 *
 * @param writers 디렉터리에서 뽑은 실제 writer 파일명 목록
 * @param ledger  프로필의 regenerationLedger 항목 배열
 */
export function auditLedger(writers, ledger) {
  const errors = [];
  if (!Array.isArray(ledger) || !ledger.length) {
    errors.push('regenerationLedger가 비었다 — 마감 범위가 정의되지 않았다');
    return errors;
  }
  const listed = new Map();
  for (const entry of ledger) {
    const writer = typeof entry?.writer === 'string' ? entry.writer : '';
    if (!writer) { errors.push('원장 항목에 writer가 없다'); continue; }
    if (listed.has(writer)) errors.push(`원장에 중복된 writer: ${writer}`);
    listed.set(writer, entry);
  }
  // ① 디렉터리에 있는데 원장에 없다 = 마감 범위가 조용히 좁아진 것
  for (const file of writers) {
    if (!listed.has(`scripts/${file}`)) errors.push(`원장에 없는 재생성 writer: scripts/${file}`);
  }
  // ② 원장에 있는데 디렉터리에 없다 = 원장이 낡았다
  for (const writer of listed.keys()) {
    if (!writers.includes(writer.replace(/^scripts\//, ''))) errors.push(`원장에만 있고 실재하지 않는 writer: ${writer}`);
  }
  for (const [writer, entry] of listed) errors.push(...auditEntry(writer, entry));
  return errors;
}

/** 항목 하나의 계약: check가 있거나, **이유를 적은** 제외이거나. 이유 없는 제외는 결함이다(§7). */
function auditEntry(writer, entry) {
  const errors = [];
  const check = typeof entry?.check === 'string' ? entry.check.trim() : '';
  const reason = typeof entry?.excludedReason === 'string' ? entry.excludedReason.trim() : '';
  if (check && reason) errors.push(`${writer}는 check와 제외 이유를 동시에 가질 수 없다`);
  else if (!check && !reason) errors.push(`${writer}에 대응하는 읽기 전용 check가 없다 — 마감 범위가 좁아진다`);
  else if (check && WRITE_HINT.test(check)) errors.push(`${writer}의 check에 쓰기가 섞였다: ${check}`);
  return errors;
}

/**
 * 작업트리 지문 — 추적 파일은 **내용 해시**로, 미추적 파일은 **이름**으로 본다.
 *
 * 🔴 미추적을 이름만 보는 것은 의도적이다: 마감이 새 파일을 만들어 놓고 조용히 넘어가는 것을
 * 잡으면 충분하고, 로그·캐시 내용까지 해시하면 검사가 자기 소음에 걸린다.
 */
function fingerprint() {
  const tracked = git(['ls-files', '-s']);
  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  return { tracked, untracked };
}

function git(args) {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// ── 자체검사: 알려진 실패를 주입해 RED를 본 뒤에만 이 게이트를 신뢰한다(§4·§11) ──
const SELF = { pos: 0, neg: 0 };

export function selfTest() {
  const writers = ['gen-a.mjs', 'gen-b.mjs'];
  const ok = [
    { writer: 'scripts/gen-a.mjs', check: 'node scripts/check-a.mjs' },
    { writer: 'scripts/gen-b.mjs', excludedReason: '산출물 단계에서 도는 writer라 입력 마감 범위 밖이다' },
  ];
  if (auditLedger(writers, ok).length) throw new Error('SELF-TEST 실패: 정상 원장을 걸렀다(오탐)');
  SELF.neg = 1;

  const bad = [
    ['새 writer가 원장에 없음', ['gen-a.mjs', 'gen-b.mjs', 'gen-c.mjs'], ok, '원장에 없는 재생성 writer'],
    ['원장이 낡음', ['gen-a.mjs'], ok, '실재하지 않는 writer'],
    ['check도 이유도 없음', writers, [{ writer: 'scripts/gen-a.mjs' }, ok[1]], '읽기 전용 check가 없다'],
    ['check에 쓰기가 섞임', writers, [{ writer: 'scripts/gen-a.mjs', check: 'node scripts/gen-adapters.mjs' }, ok[1]], '쓰기가 섞였다'],
    ['--write 플래그', writers, [{ writer: 'scripts/gen-a.mjs', check: 'node scripts/check-a.mjs --write' }, ok[1]], '쓰기가 섞였다'],
    ['이유 없는 빈 제외', writers, [{ writer: 'scripts/gen-a.mjs', excludedReason: '   ' }, ok[1]], '읽기 전용 check가 없다'],
    ['원장이 빔', writers, [], '비었다'],
    ['중복 writer', writers, [...ok, ok[0]], '중복된 writer'],
  ];
  for (const [label, w, l, needle] of bad) {
    const errs = auditLedger(w, l);
    if (!errs.some((e) => e.includes(needle))) throw new Error(`SELF-TEST 실패: ${label}을(를) 놓쳤다`);
    SELF.pos += 1;
  }
}

selfTest();

const isMain = process.argv[1] && process.argv[1].endsWith('check-input-closeout.mjs');
if (isMain) {
  if (!existsSync(PROFILE)) fail([`릴리스 프로필이 없다: ${PROFILE}`]);
  const profile = JSON.parse(readFileSync(PROFILE, 'utf8'));
  const ledger = profile?.regenerationLedger;
  const writers = discoverWriters(join(ROOT, 'scripts'));
  const errors = auditLedger(writers, ledger);
  if (errors.length) fail(errors);

  const checks = ledger.filter((e) => e.check);
  const skipped = ledger.length - checks.length;

  if (process.argv.includes('--run')) runCloseout(checks);

  const mode = process.argv.includes('--run') ? '마감 실행' : '원장 검사만';
  console.log(
    `check-input-closeout: OK (${mode} · 자체검사 양성 ${SELF.pos}·음성 ${SELF.neg} · ` +
      `재생성 writer ${writers.length} · 읽기 전용 check ${checks.length} · 이유 있는 제외 ${skipped})`,
  );
  if (!process.argv.includes('--run')) {
    console.log('  ↳ 정직한 한계: 원장이 온전한지까지만 봅니다 — 마감을 **실제로 돌린 증거**는 `--run`입니다.');
  }
}

/** 마감 실행 — 읽기 전용 check를 돌리고 **전후 트리 지문**으로 「안 건드렸다」를 검증한다. */
function runCloseout(checks) {
  const before = fingerprint();
  const failures = [];
  for (const entry of checks) {
    const [cmd, ...args] = entry.check.split(/\s+/);
    try {
      execFileSync(cmd, args, { cwd: ROOT, stdio: 'pipe' });
    } catch (err) {
      failures.push(`${entry.writer}의 마감 check 실패(exit ${err?.status ?? '?'}): ${entry.check}`);
    }
  }
  const after = fingerprint();
  if (before.tracked !== after.tracked) failures.push('마감이 **추적 파일 내용을 바꿨다** — 읽기 전용이 아니다');
  if (before.untracked !== after.untracked) failures.push('마감이 **미추적 파일을 만들거나 지웠다** — 읽기 전용이 아니다');
  if (failures.length) fail(failures);
}

function fail(errors) {
  console.error('🔴 입력 마감 위반 (HRL-17):');
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error('');
  console.error('  마감은 비싼 산출물 **앞**의 고정점입니다. 범위가 좁아지면 산출물이 신호 없이 낡습니다.');
  process.exit(1);
}
