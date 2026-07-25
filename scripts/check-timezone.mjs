// check-timezone.mjs — 시간대 정합 게이트(결함군 M-utc-slice, 2026-07-25).
//
// 왜: 타임라인 날짜 그룹이 `occurredAt.slice(0, 10)`으로 **UTC 날짜**를 뽑는 바람에,
// 한국(UTC+9) 새벽 06:48 기록이 **전날** 그룹에 묶였다. 시각 표시·발생 시각 입력·백업 파일명·
// 환율(사용일 기준)은 전부 로컬이라 화면 안에서 날짜가 어긋났고, 사용자가 "7월 15일 사용금액인데
// 왜 7월 16일 환율?"로 발견했다.
//
// **이 부류가 위험한 이유**: 우리 CI·샌드박스는 UTC라 두 방식이 같은 값을 내서 **유닛 테스트로는
// 구조적으로 안 보인다.** 그래서 게이트가 본 방어선이다. 두 층으로 막는다:
//   (A) 정적 — ISO 문자열을 잘라 날짜를 만드는 패턴 금지(domain/time.ts의 localDate를 쓰라)
//   (B) 동적 — 유닛 스위트를 **UTC가 아닌 시간대**에서도 돌려, 시간대 의존 가정을 실제로 깨본다
//
// 사용: node scripts/check-timezone.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

// UTC가 아닌 시간대 두 곳(동/서 양방향) — 부호가 다른 오프셋이라 한쪽으로만 치우친 가정도 깨진다.
const TZS = ['Asia/Seoul', 'Pacific/Honolulu'];

/** ISO 일시에서 날짜를 잘라내는 패턴. 날짜는 localDate()로만 만든다. */
const SLICE_DATE = /\.slice\(\s*0\s*,\s*10\s*\)/;
/** 이 줄은 날짜가 아니라는 명시적 예외(해시 등). 남용 방지를 위해 줄 단위로만 허용. */
const OPT_OUT = /not-a-date/;

// 서사(prose) 데이터 파일 — 코드가 아니라 "무슨 일이 있었는지"를 적은 기록이다.
// 금지 패턴을 **설명하는 문장**이 게이트를 울리면 안 된다(오탐). 같은 근본형이 두 번 재발해
// (연구노트 seq32 마커 충돌 → seq38 여기) 체계적으로 제외한다: 이 파일들엔 날짜 파생 로직이 없다.
const PROSE_FILES = new Set(['src/app/researchLog.ts', 'src/app/changelog.ts']);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** 주석을 걷어내고 **코드 부분만** 남긴다(계약을 설명하는 주석까지 잡지 않도록). */
function codePart(line) {
  const t = line.trim();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return ''; // 통째 주석 줄
  const i = line.indexOf('//');
  return i >= 0 ? line.slice(0, i) : line; // 뒤 주석 제거(앞의 코드는 그대로 검사)
}

/** 소스 텍스트에서 위반 줄을 찾는다(순수 — 자체검사가 이걸 직접 호출). */
export function findSliceViolations(text, label) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    if (SLICE_DATE.test(codePart(line)) && !OPT_OUT.test(line)) {
      out.push(`${label}:${i + 1}  ${line.trim()}`);
    }
  });
  return out;
}

// ── (A-self) 비공허 자체검사: 알려진 위반을 반드시 잡아야 한다 ──
(() => {
  const bad = findSliceViolations('const d = m.occurredAt.slice(0, 10);', 'fake.ts');
  if (bad.length !== 1) throw new Error('SELF-TEST 실패: ISO 절단 패턴을 못 잡음(게이트 공허).');
  const ok = findSliceViolations('const s = hex.slice(0, 10); // not-a-date', 'fake.ts');
  if (ok.length !== 0) throw new Error('SELF-TEST 실패: not-a-date 예외가 동작하지 않음.');
  const cmt = findSliceViolations('// 옛 코드는 occurredAt.slice(0, 10)을 썼다(설명 주석)', 'fake.ts');
  if (cmt.length !== 0) throw new Error('SELF-TEST 실패: 주석까지 위반으로 잡음(오탐).');
})();

// ── (A) 정적 검사 ──
const violations = [];
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  if (PROSE_FILES.has(rel)) continue; // 서사 기록 — 위 주석 참조
  violations.push(...findSliceViolations(readFileSync(file, 'utf8'), rel));
}
if (violations.length > 0) {
  console.error(
    'check-timezone: ISO 문자열을 잘라 날짜를 만들고 있음(UTC 날짜 — 사용자의 날짜가 아님).\n' +
      violations.map((v) => '  - ' + v).join('\n') +
      "\n  → domain/time.ts의 localDate(iso)를 쓰세요. 날짜가 아니면 줄 끝에 '// not-a-date' 주석.",
  );
  process.exit(1);
}

// ── (B) 동적 검사: UTC가 아닌 시간대에서 유닛 스위트 재실행 ──
for (const tz of TZS) {
  try {
    execSync('npm run -s test', { cwd: ROOT, stdio: 'pipe', env: { ...process.env, TZ: tz } });
  } catch (e) {
    console.error(`check-timezone: TZ=${tz} 에서 유닛 실패 — 시간대 의존 가정이 있습니다.`);
    if (e.stdout) process.stderr.write(e.stdout.toString().split('\n').slice(-40).join('\n'));
    process.exit(1);
  }
}

console.log(
  `check-timezone: OK — ISO 절단 0건(서사 파일 ${PROSE_FILES.size}개 제외) · 유닛이 ${TZS.join('·')} 시간대에서도 통과.`,
);
