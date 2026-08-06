// hook-verify-exit.mjs — PreToolUse(Bash): **검증 명령을 파이프에 넣는 것**을 막는다(헌법 §18-A).
//
// ── 왜 훅인가 ────────────────────────────────────────────────────────────────
// 이 규율은 **파일이 아니라 내가 치는 명령**에서 깨진다. 게이트는 커밋된 파일만 보므로
// 원리적으로 못 잡는다 — 강제는 훅이 한다(헌법 S-09).
//
// ── 무엇이 문제인가 ──────────────────────────────────────────────────────────
// 파이프라인의 종료코드는 **마지막 명령의 것**이다.
//
//     npm run harness 2>&1 | grep -E "FAIL|모든 게이트"     ← grep의 종료코드다
//
// harness가 **실패해도** grep이 한 줄만 찾으면 `0`이 나온다. 판정의 근거가 되는 값이
// 판정하는 명령에서 나오지 않는다.
//
// 🔴 **이건 관념이 아니다**: 2026-08-06 세션에서 이 형태를 수십 번 썼다. 출력 문자열을
// 눈으로 읽어서 살았지, **종료코드로 판정한 적이 없다.** 초록을 보고 싶은 사람과
// 초록을 만들어 주는 파이프가 만나면 그 검사는 정보가 없다.
//
// ── 계약 ─────────────────────────────────────────────────────────────────────
//  · 입력: stdin JSON `{tool_name, tool_input:{command}}`
//  · exit 0 = 통과 · exit 2 = 차단(stderr가 Claude에게 전달된다)
//  · **판정 불가는 통과시킨다** — 훅이 깨져서 모든 명령이 막히면 그게 더 큰 사고다
//    (`hook-secret-guard.mjs`와 같은 자세 · §2-D).

/**
 * 종료코드로 판정해야 하는 명령들. 이름이 아니라 **하는 일**로 고른다.
 *
 * 🔴 **줄 맨 앞(또는 `;`·`&&`·`(` 바로 뒤)에 올 때만** 명령으로 본다. 산문 속에 인용된 같은
 * 글자를 명령으로 읽으면 오탐이 나고, **오탐은 빡빡한 훅이 아니라 틀린 훅**이다(§11 ③).
 */
const VERIFY = [
  /^npm\s+run\s+(harness|gates|live|build|test)\b/,
  /^npx?\s+vitest\b/,
  /^npx?\s+tsc\b/,
  /^node\s+scripts\/(check|verify)-[\w-]+\.mjs/,
];

/**
 * 이 파이프 뒤쪽은 **종료코드를 삼키지 않는다**고 볼 수 있는가.
 *
 * `tee`는 앞 명령의 출력을 그대로 흘리고 종료코드도 자기 것이지만, 적어도 **출력을 자르지
 * 않는다**. 그래도 판정은 여전히 tee의 것이므로 허용하지 않는다 — 예외를 만들면
 * 「이건 괜찮겠지」가 늘어난다(§7: 예외는 이유와 함께 등록하거나 아예 두지 않는다).
 */
const SAFE_TAIL = [
  // `; echo "EXIT=$?"` 처럼 **종료코드를 실제로 묻는** 형태는 파이프가 아니다.
  /\|\|/, // `cmd || echo` — 논리연산자는 종료코드를 본다
  /&&/, //  `cmd && echo` — 같음
];

/**
 * 산문 줄인가 — 히어독·문서 본문이 명령 문자열에 섞여 들어온다.
 *
 * 🔴 이 판정은 **실제 오탐에서 나왔다**(2026-08-06): ADR 본문의 한 줄
 * (이 규율을 *설명하는* 문장)이 차단당해, **규율을 적는 일 자체를 규율이 막았다.**
 * 게다가 훅이 Bash를 막으니 **자기 수리 경로까지 막혔다** — Write/Edit로 고쳐야 했다.
 * HRL-3의 *"합성이 아니라 실제 역사로 교정하라"*가 정확히 이 자리다.
 */
function isProse(line) {
  if (/^[-*>#]/.test(line)) return true; // 목록·인용·주석
  if (line.includes('**')) return true; // 마크다운 강조
  if (line.startsWith('//')) return true; // 코드 주석
  return false;
}

/** 명령 줄을 실행 단위로 쪼갠다 — `a; b && c`에서 각 조각이 **무엇으로 시작하는지** 본다. */
function segments(head) {
  return head
    .split(/;|&&|\|\||\(/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** 명령 문자열에서 「검증 명령을 파이프에 넣었는가」를 판정한다 — 순수 함수(자체검사가 부른다). */
export function pipesVerification(command) {
  if (typeof command !== 'string' || !command) return null;
  // 줄 단위로 본다: 여러 줄 스크립트에서 어느 줄이 문제인지 말해 줘야 고칠 수 있다.
  for (const raw of command.split('\n')) {
    const line = raw.trim();
    if (!line || isProse(line)) continue;
    // 파이프가 없으면 이 규율의 대상이 아니다.
    const pipe = line.indexOf('|');
    if (pipe < 0) continue;
    if (SAFE_TAIL.some((re) => re.test(line))) continue;
    for (const seg of segments(line.slice(0, pipe))) {
      const hit = VERIFY.find((re) => re.test(seg));
      if (hit) return { line, matched: String(hit) };
    }
  }
  return null;
}

// ── 셀프테스트: 알려진 실패를 주입해 잡히는지 확인한 뒤에만 훅을 신뢰한다(§4) ──
// 개수는 **손으로 세지 않는다** — 사례를 늘리고 문구를 안 고치면 그 순간 거짓말이 된다(§2).
const SELF_COUNTS = { must: 0, mustNot: 0 };

export function selfTest() {
  const must = [
    'npm run harness 2>&1 | grep -E "FAIL"',
    'npm run gates | tail -5',
    'npx vitest run tests/unit/x.test.ts 2>&1 | grep -E "Tests"',
    'node scripts/check-fn-size.mjs 2>&1 | tail -3',
    'npm run build 2>&1 | tail -1',
  ];
  const mustNot = [
    'npm run harness > run.log 2>&1; echo "EXIT=$?"; tail -20 run.log',
    'git status --porcelain | wc -l', // 검증 명령이 아니다
    'grep -rn "x" src/ | head -5', // 조사용 파이프는 자유다
    'npm run harness && echo ok', // 종료코드를 본다
    'npm run gates || echo failed', // 종료코드를 본다
    '# npm run harness | grep x', // 주석
    // 🔴 **실제 역사**(2026-08-06 · HRL-3): 아래 두 줄은 ADR·주석 본문이었고 차단당했다.
    //    규율을 적는 문장을 그 규율이 막으면, 다음 사람은 규율을 안 적는다.
    '- 근거가 된 실측: npm run harness | grep 을 수십 번 썼다',
    '  · 예: npm run harness | grep FAIL 은 쓰지 마라',
    'echo "npm run harness | grep" >> notes.md', // 문자열 안에 든 것은 실행이 아니다
  ];
  for (const c of must) {
    if (!pipesVerification(c)) throw new Error(`SELF-TEST 실패: 잡아야 할 것을 놓쳤다 — ${c}`);
  }
  for (const c of mustNot) {
    if (pipesVerification(c)) throw new Error(`SELF-TEST 실패: 오탐 — ${c}`);
  }
  SELF_COUNTS.must = must.length;
  SELF_COUNTS.mustNot = mustNot.length;
}

selfTest();
if (process.argv.includes('--self-test')) {
  console.log(`hook-verify-exit: 자체검사 통과(양성 ${SELF_COUNTS.must} · 음성 ${SELF_COUNTS.mustNot}) — 훅이 실제로 빨간불을 낸다.`);
  process.exit(0);
}

// 🔴 **훅 본체는 「직접 실행」일 때만 돈다.** 아래는 stdin을 끝까지 읽으므로, 이 파일을
// `import`한 유닛·다른 스크립트가 **영원히 멈춘다**(실제로 겪었다 — 조사용 스크립트가 걸렸다).
// 판정은 순수 함수(`pipesVerification`)로 뽑혀 있으니 검사는 그것만 부르면 된다.
const isMain = process.argv[1] && process.argv[1].endsWith('hook-verify-exit.mjs');
if (!isMain) {
  // 표만 제공하고 조용히 끝낸다.
} else {

// ── 훅 본체 ─────────────────────────────────────────────────────────────────
let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;

let hit = null;
try {
  const cmd = (JSON.parse(raw) ?? {})?.tool_input?.command;
  hit = pipesVerification(cmd);
} catch {
  process.exit(0); // 판정 불가는 통과 — 훅이 깨져서 모든 명령이 막히면 그게 더 큰 사고다
}

if (!hit) process.exit(0);

console.error(
  [
    '🔴 검증 명령을 파이프에 넣었습니다 — 파이프라인의 종료코드는 **마지막 명령의 것**입니다(헌법 §18-A).',
    `   문제 줄: ${hit.line}`,
    '',
    '   검사가 실패해도 뒤쪽 명령(grep·tail·head)이 성공하면 종료코드는 0입니다.',
    '   그러면 판정의 근거가 되는 값이 **판정하는 명령에서 나오지 않습니다.**',
    '',
    '   이렇게 쓰세요:',
    '     npm run harness > /tmp/run.log 2>&1; echo "EXIT=$?"; tail -20 /tmp/run.log',
    '   또는 종료코드를 실제로 보는 형태:',
    '     npm run harness && echo OK || echo FAILED',
  ].join('\n'),
);
process.exit(2);
}
